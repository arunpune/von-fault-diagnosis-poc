// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stages 2 and 3 of the fused search, and the fusion itself.
 *
 * Both database stages answer the same question — "which causes does this
 * query point at?" — and both answer it with a ranked list of `fault_id`s, so
 * the fusion below never has to know which index produced a number.
 *
 * ## Mapping a chunk to a cause
 *
 * A chunk is a piece of the manual, not a cause. Init's `0008` migration sets
 * `chunks.fault_id` on the rows it builds out of a troubleshooting table, which
 * is the exact link; a prose chunk has no such id and reaches a cause through
 * the section it came from — `chunks.section_ref` equal to the cause's
 * `manual_ref.section`, or nested below it. The column is feature-detected at
 * startup ({@link detectChunkLink}) because a database may predate `0008`;
 * the section path is then the only one.
 *
 * ## Determinism
 *
 * An HNSW index is a graph whose traversal may reorder near-equal neighbours,
 * which would make the same event produce a different candidate order on a
 * second run. Below {@link EXACT_SEARCH_MAX_CHUNKS} rows the vector stage
 * therefore turns index scans off inside its own transaction and lets the
 * planner read the table, which is exact and, at this size, no slower. Every
 * ordering in this file breaks its ties on `fault_id` ascending.
 */

import { query, withTx, type Pool, type Queryable } from "../db/pool.ts";
import { compareIds } from "./catalog.ts";

/** The constant of reciprocal rank fusion. */
export const RRF_K = 60;

/** How many chunks the vector stage looks at before mapping them to causes. */
export const VECTOR_NEIGHBOURS = 20;

/**
 * Below this many chunks the vector stage runs exactly rather than through the
 * HNSW graph, so two runs of the same query return the same order.
 */
export const EXACT_SEARCH_MAX_CHUNKS = 5000;

/** One cause with the score a stage gave it. */
export interface ScoredCause {
  readonly fault_id: string;
  readonly score: number;
}

/** Which link a chunk reaches a cause through (init's `0008`, or the section). */
export type ChunkLink = "fault_id" | "section_ref";

/** Whether `app.chunks.fault_id` exists in this database. */
export const CHUNK_LINK_SQL = `
  SELECT 1
    FROM information_schema.columns
   WHERE table_schema = 'app' AND table_name = 'chunks' AND column_name = 'fault_id'`;

/**
 * Feature-detect init's `0008` columns once, at startup.
 *
 * The migration has landed, so this is a safety net rather than a branch the
 * stack takes: a database restored from a volume that predates it still
 * answers, through section prefixes alone.
 */
export async function detectChunkLink(db: Queryable): Promise<ChunkLink> {
  const rows = await query<{ "?column?": number }>(db, CHUNK_LINK_SQL);
  return rows.length > 0 ? "fault_id" : "section_ref";
}

/**
 * The join condition between `app.chunks ch` and `app.catalog_causes ca`.
 *
 * `left(…)` rather than `LIKE`: a section reference is manual text and may hold
 * an underscore or a percent sign, which `LIKE` would read as a wildcard.
 */
function chunkJoin(link: ChunkLink): string {
  const section =
    "(ch.section_ref IS NOT NULL AND ca.manual_section IS NOT NULL" +
    " AND (ch.section_ref = ca.manual_section" +
    " OR left(ch.section_ref, length(ca.manual_section) + 1) = ca.manual_section || '.'))";
  if (link === "section_ref") return section;
  return `(ch.fault_id IS NOT NULL AND ch.fault_id = ca.fault_id) OR (ch.fault_id IS NULL AND ${section})`;
}

/**
 * Stage 2: `websearch_to_tsquery` over the two catalog indexes and the chunks.
 *
 * `$2` is {@link fullTextQuery} of the query sentence, never the sentence
 * itself: see there for why every word is joined with `or`.
 *
 * The three sources are unioned and reduced with `max`, so a cause named by its
 * own row, by its condition and by a chunk of its section scores as the best of
 * the three rather than three times. `ts_rank_cd` is comparable across the
 * three `tsvector`s because they are built by the same `to_tsvector('english',
 * …)`, which is what lets the union stay unweighted.
 */
function fullTextSql(link: ChunkLink): string {
  return `
  WITH q AS (SELECT websearch_to_tsquery('english', $2) AS query),
  hits AS (
    SELECT ca.fault_id, ts_rank_cd(ca.tsv, q.query) AS score
      FROM app.catalog_causes AS ca, q
     WHERE ca.document_id = $1 AND ca.tsv @@ q.query
    UNION ALL
    SELECT ca.fault_id, ts_rank_cd(co.tsv, q.query) AS score
      FROM app.catalog_conditions AS co
      JOIN app.catalog_condition_causes AS cc ON cc.condition_pk = co.id
      JOIN app.catalog_causes AS ca ON ca.id = cc.cause_pk, q
     WHERE co.document_id = $1 AND co.tsv @@ q.query
    UNION ALL
    SELECT ca.fault_id, ts_rank_cd(ch.tsv, q.query) AS score
      FROM app.chunks AS ch
      JOIN app.catalog_causes AS ca
        ON ca.document_id = ch.document_id AND (${chunkJoin(link)}), q
     WHERE ch.document_id = $1 AND ch.tsv @@ q.query)
  SELECT fault_id, max(score)::float8 AS score
    FROM hits
   GROUP BY fault_id
  HAVING max(score) > 0
   ORDER BY score DESC, fault_id ASC
   LIMIT $3`;
}

/**
 * Stage 3: the nearest chunks by cosine distance, mapped to their causes.
 *
 * The neighbours are taken first and mapped afterwards:
 * the index answers "which twenty pieces of the manual read most like this
 * query", and a cause scores as its best piece.
 */
function vectorSql(link: ChunkLink): string {
  // `fault_id` is only selected where it exists: a database that predates init's
  // 0008 has no such column, and naming it would fail the whole statement.
  const linkColumns = link === "fault_id" ? "ch.fault_id, ch.section_ref" : "ch.section_ref";
  return `
  WITH nearest AS (
    SELECT ch.id, ch.document_id, ${linkColumns},
           (ch.embedding <=> $2::vector) AS distance
      FROM app.chunks AS ch
     WHERE ch.document_id = $1 AND ch.embedding IS NOT NULL
     ORDER BY ch.embedding <=> $2::vector, ch.id
     LIMIT $3)
  SELECT ca.fault_id, max(1 - ch.distance)::float8 AS score
    FROM nearest AS ch
    JOIN app.catalog_causes AS ca
      ON ca.document_id = ch.document_id AND (${chunkJoin(link)})
   GROUP BY ca.fault_id
   ORDER BY score DESC, fault_id ASC`;
}

/** How many chunks the active document holds; decides the exact-search rule. */
export async function countChunks(db: Queryable, documentId: number): Promise<number> {
  const rows = await query<{ chunks: string | number }>(
    db,
    "SELECT count(*) AS chunks FROM app.chunks WHERE document_id = $1",
    [documentId],
  );
  const value = rows[0]?.chunks ?? 0;
  return typeof value === "number" ? value : Number(value);
}

/** What both database stages need to know about the document they search. */
export interface HybridContext {
  readonly documentId: number;
  readonly link: ChunkLink;
}

/** The operator word of `websearch_to_tsquery`, which must not be searched for. */
const WEBSEARCH_OR = "or";

/**
 * Shorter words are dropped: a lone letter is what `stripDigits` leaves of a
 * panel label such as `P4`, and it matches nothing the manual indexes.
 */
const MIN_SEARCH_WORD_LENGTH = 2;

/**
 * The query sentence as a `websearch_to_tsquery` input that matches any word.
 *
 * `websearch_to_tsquery` joins unquoted words with `&`, so the sentence itself
 * would ask for a chunk holding all forty-odd words at once — no chunk does, and
 * the stage would never contribute. Joining the distinct words with `or` asks
 * for any of them instead and leaves the ranking to `ts_rank_cd`, which rewards
 * a text for how many of the words it holds and how close together they sit.
 * Only letters survive, so a quote, a minus sign or a stray `or` in the
 * sentence cannot turn into a phrase, a negation or an operator; stop words are
 * dropped by the `english` configuration itself.
 */
export function fullTextQuery(text: string): string {
  const words = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    if (word.length >= MIN_SEARCH_WORD_LENGTH && word !== WEBSEARCH_OR) words.add(word);
  }
  return [...words].join(` ${WEBSEARCH_OR} `);
}

/** Stage 2, ranked, at most `limit` causes. */
export async function searchFullText(
  db: Queryable,
  context: HybridContext,
  text: string,
  limit: number,
): Promise<ScoredCause[]> {
  const search = fullTextQuery(text);
  if (search === "") return [];
  const rows = await query<{ fault_id: string; score: number }>(db, fullTextSql(context.link), [
    context.documentId,
    search,
    limit,
  ]);
  return rows.map((row) => ({ fault_id: row.fault_id, score: Number(row.score) }));
}

/**
 * Stage 3, ranked.
 *
 * `exact` runs the search in a transaction with index scans disabled, which is
 * the determinism rule above; the setting is `LOCAL`, so it dies with the
 * transaction and never leaks onto the pooled connection.
 */
export async function searchVector(
  pool: Pool,
  context: HybridContext,
  vector: string,
  options: { readonly exact: boolean; readonly neighbours?: number },
): Promise<ScoredCause[]> {
  const params = [context.documentId, vector, options.neighbours ?? VECTOR_NEIGHBOURS];
  const sql = vectorSql(context.link);
  const rows = await withTx(pool, async (client) => {
    if (options.exact) await client.query("SET LOCAL enable_indexscan = off");
    return query<{ fault_id: string; score: number }>(client, sql, params);
  });
  return rows.map((row) => ({ fault_id: row.fault_id, score: Number(row.score) }));
}

/** One fused entry: the identity and the score the list is ordered by. */
export interface FusedCause {
  readonly fault_id: string;
  readonly rrf: number;
}

/**
 * Reciprocal rank fusion of any number of ranked lists.
 *
 * Every list contributes `1 / (k + rank)` to the ids it holds, with `rank`
 * starting at 1, so an id that is second everywhere beats one that is first in
 * a single list and absent from the others. `k = 60` is the usual
 * constant: it flattens the head enough that rank 1 and rank 2 are not an order of
 * magnitude apart.
 *
 * Pure, and deterministic down to the tie: equal scores are ordered by
 * `fault_id` ascending, so two runs over the same lists are the same
 * list.
 */
export function rrf(lists: readonly (readonly string[])[], k: number = RRF_K): FusedCause[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores]
    .map(([fault_id, score]) => ({ fault_id, rrf: score }))
    .sort((left, right) =>
      right.rrf !== left.rrf ? right.rrf - left.rrf : compareIds(left.fault_id, right.fault_id),
    );
}

/** A stage's scores as the ranked list the fusion reads; zero scores drop out. */
export function rankedIds(scored: readonly ScoredCause[]): string[] {
  return [...scored]
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score !== left.score
        ? right.score - left.score
        : compareIds(left.fault_id, right.fault_id),
    )
    .map((entry) => entry.fault_id);
}
