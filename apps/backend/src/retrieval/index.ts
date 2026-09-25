// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retrieval: from one suspect event to at most six causes
 * (docs/manual.md#chunks-embeddings-and-retrieval).
 *
 * The decision backend is asked to choose, not to search, so its list has to be
 * short, complete enough to contain the answer, and always long enough to make
 * a choice a choice. Three searches run over the same event and are fused:
 *
 * 1. **the catalog match** — how much of each cause's declared signature the
 *    machine is actually showing (`match.ts`, shared with the rules twin);
 * 2. **full text** — `websearch_to_tsquery` over the catalog and the manual
 *    chunks (`hybrid.ts`);
 * 3. **vectors** — the same query embedded and searched against the chunk
 *    embeddings (`hybrid.ts`, `embedder.ts`).
 *
 * Reciprocal rank fusion (`k = 60`) puts the three lists together, because the
 * three scores are not on one scale and normalising them would invent a
 * weighting nobody measured. Ranks are comparable; scores are not.
 *
 * Three rules then shape the list, and all three exist to protect the decision
 * rather than the ranking. The causes the manual files under the condition the
 * event named come first, in fused order, and the rest follow in fused order:
 * the manual's fault-finding table is "condition → possible causes", so a
 * possible cause of the very symptom that fired is never left off the sheet for
 * a cause the manual does not list under it. The list never drops below three
 * entries, so `none_of_these` is always competing against something. And the
 * best-ranked benign cause inside the top twelve is always carried into the
 * list, because the hardest negative of this project — a busy plant that looks
 * exactly like a leak — is only refusable if the innocent explanation is on the
 * sheet at all.
 */

import { ALARMS } from "@fdp/contracts";
import type { CatalogEntry, SuspectEvent } from "@fdp/contracts";

import type { Pool, Queryable } from "../db/pool.ts";
import {
  catalogFromEntries,
  compareIds,
  createCachedCatalogLoader,
  type Catalog,
  type CatalogLoader,
  type ConditionText,
} from "./catalog.ts";
import type { Embedder } from "./embedder.ts";
import { toVectorLiteral } from "./embedder.ts";
import {
  countChunks,
  detectChunkLink,
  rankedIds,
  rrf,
  searchFullText,
  searchVector,
  EXACT_SEARCH_MAX_CHUNKS,
  type ChunkLink,
  type ScoredCause,
} from "./hybrid.ts";
import { matchContextOf, scoreSignalMoves } from "./match.ts";
import { buildQuery } from "./query.ts";
import { lexemes } from "./text.ts";
import type { Candidate, ObservedBuckets, RetrievalScores } from "./types.ts";

/** At most this many causes reach the decision backend. */
export const MAX_CANDIDATES = 6;

/** Fewer than this and the Choice has no alternative to `none_of_these`. */
export const MIN_CANDIDATES = 3;

/**
 * How deep the list — the condition's causes first, then the rest, each in
 * fused order — is searched for the benign cause that must be kept.
 */
export const BENIGN_WINDOW = 12;

/** Stage 1 bonus for a cause listed under the condition the event named. */
export const CONDITION_BONUS = 0.15;

/** Stage 1 bonus for a cause listed under one of the co-occurring conditions. */
export const CO_SYMPTOM_BONUS = 0.05;

/** How many causes the full-text stage returns before the fusion. */
export const FULL_TEXT_LIMIT = 20;

/** What the pipeline holds. */
export interface Retriever {
  retrieve(event: SuspectEvent): Promise<Candidate[]>;
}

/** What each stage gave one cause, before the fusion. */
export interface StageScores {
  readonly catalog: number;
  readonly text: number;
  readonly vector: number;
}

const NO_SCORES: StageScores = { catalog: 0, text: 0, vector: 0 };

/** Whether the manual files `entry` under `condition`. */
function filedUnder(entry: CatalogEntry, condition: string): boolean {
  return entry.conditions.some((listed) => listed.condition_id === condition);
}

/**
 * Stage 1: how much of each cause's signature the machine is showing.
 *
 * The two bonuses are part of this score rather than of the
 * fusion: reciprocal ranks live around `1/61`, so a `+0.15` added after the
 * fusion would not be a nudge but an override, and the bonus is defined
 * against the stage-1 score. A cause the manual files under the very condition
 * that fired starts ahead of one that merely shares a movement, which is what
 * the number is for.
 *
 * The observations are matched in the event's own mode, the context the rules
 * twin passes for the same event.
 */
export function scoreCatalogStage(
  entries: readonly CatalogEntry[],
  event: SuspectEvent,
  observed: readonly ObservedBuckets[],
): Map<string, number> {
  const context = matchContextOf(event);
  const coSymptoms = new Set(event.co_symptoms);
  const scores = new Map<string, number>();
  for (const entry of entries) {
    let score = scoreSignalMoves(observed, entry.signal_moves, context).score;
    if (filedUnder(entry, event.symptom_key)) score += CONDITION_BONUS;
    if (entry.conditions.some((condition) => coSymptoms.has(condition.condition_id))) {
      score += CO_SYMPTOM_BONUS;
    }
    scores.set(entry.fault_id, score);
  }
  return scores;
}

/** A stage's scores as a map, for the assembly below. */
function scoreMap(scored: readonly ScoredCause[]): Map<string, number> {
  return new Map(scored.map((entry) => [entry.fault_id, entry.score]));
}

/** One cause of the fused list, with its fused score. */
interface Ranked {
  readonly entry: CatalogEntry;
  readonly rrf: number;
}

/**
 * The fused list with the causes the manual files under `condition` first.
 *
 * A stable partition: each part keeps its fused order, so the ranking still
 * decides which of the condition's causes lead and, when the manual lists more
 * than six under one condition, which of them fit.
 *
 * Why a partition rather than a larger bonus: stage 1's `+0.15` moves a cause
 * up one of the fused lists only, and reciprocal rank fusion dilutes it. A
 * possible cause of the symptom whose own words share little with the query,
 * or whose moves are not showing yet (stage 1 at the bonus alone), then fuses
 * below causes the manual files under no condition the machine is showing, and
 * a cause can top the catalog match and still lose its seat to a poor text
 * rank. No weight closes that without inventing one; the manual's own grouping
 * does.
 */
function conditionFirst(fused: readonly Ranked[], condition: string): Ranked[] {
  const under = fused.filter((item) => filedUnder(item.entry, condition));
  const rest = fused.filter((item) => !filedUnder(item.entry, condition));
  return [...under, ...rest];
}

/**
 * Fuse the three stages and cut the list to what the decision backend reads.
 *
 * `condition` is the event's `symptom_key`: the causes the manual files under
 * it come first ({@link conditionFirst}). Without it the list is in fused
 * order, as a caller with no event (a test of the fusion alone) expects.
 *
 * Pure, so `index.test.ts` can prove the list rules — the condition's causes
 * first, at most six, at least three, the benign cause kept — without a
 * database, an embedder or a catalog behind it.
 */
export function assembleCandidates(
  entries: readonly CatalogEntry[],
  stages: ReadonlyMap<string, StageScores>,
  condition?: string,
): Candidate[] {
  const byId = new Map(entries.map((entry) => [entry.fault_id, entry]));
  const scored = [...stages].filter(([faultId]) => byId.has(faultId));

  const fused = rrf([
    rankedIds(scored.map(([fault_id, score]) => ({ fault_id, score: score.catalog }))),
    rankedIds(scored.map(([fault_id, score]) => ({ fault_id, score: score.text }))),
    rankedIds(scored.map(([fault_id, score]) => ({ fault_id, score: score.vector }))),
  ]);

  const inFusedOrder: Ranked[] = [];
  for (const { fault_id, rrf: score } of fused) {
    const entry = byId.get(fault_id);
    if (entry !== undefined) inFusedOrder.push({ entry, rrf: score });
  }
  // Stage 1 gives every cause filed under the condition at least its +0.15, so
  // all of them are in the fused list and the partition reaches each one.
  const ordered = condition === undefined ? inFusedOrder : conditionFirst(inFusedOrder, condition);

  // Every cause any stage scored is already in the fused list, so the causes
  // that fill it scored nothing anywhere and tie on the catalog match; they are
  // taken in `fault_id` order, which keeps the list deterministic. The
  // fill exists so the Choice has an alternative to `none_of_these`, and a weak
  // alternative is still one the model can refuse.
  if (ordered.length < MIN_CANDIDATES) {
    const present = new Set(ordered.map((item) => item.entry.fault_id));
    const fill = entries
      .filter((entry) => !present.has(entry.fault_id))
      .sort((left, right) => compareIds(left.fault_id, right.fault_id))
      .slice(0, MIN_CANDIDATES - ordered.length);
    for (const entry of fill) ordered.push({ entry, rrf: 0 });
  }

  // The benign cause is searched in the list as ordered, so a benign cause the
  // manual files under the event's condition is found before one it does not.
  const head = ordered.slice(0, MAX_CANDIDATES);
  if (!head.some((item) => item.entry.benign)) {
    const benign = ordered.slice(0, BENIGN_WINDOW).find((item) => item.entry.benign);
    if (benign !== undefined && head.length > 0) head[head.length - 1] = benign;
  }

  return head.map((item) => ({
    ...item.entry,
    retrieval: scoresOf(stages.get(item.entry.fault_id) ?? NO_SCORES, item.rrf),
  }));
}

function scoresOf(stage: StageScores, fused: number): RetrievalScores {
  return { catalog: stage.catalog, text: stage.text, vector: stage.vector, rrf: fused };
}

/** Merge the three stages into one map, keyed by `fault_id`. */
function mergeStages(
  entries: readonly CatalogEntry[],
  catalog: ReadonlyMap<string, number>,
  text: ReadonlyMap<string, number>,
  vector: ReadonlyMap<string, number>,
): Map<string, StageScores> {
  const merged = new Map<string, StageScores>();
  for (const entry of entries) {
    const id = entry.fault_id;
    merged.set(id, {
      catalog: catalog.get(id) ?? 0,
      text: text.get(id) ?? 0,
      vector: vector.get(id) ?? 0,
    });
  }
  return merged;
}

/**
 * The signal-move sentences of an entry.
 *
 * `signal_moves_text` when the catalog filled it; otherwise the `text` each
 * move carries. The catalog init extracts from the realistic manual leaves
 * `signal_moves_text` empty on every cause and keeps the sentences on the
 * moves, and the keyword stand-in must read them on either catalog.
 */
export function moveSentences(entry: CatalogEntry): readonly string[] {
  if (entry.signal_moves_text.length > 0) return entry.signal_moves_text;
  return entry.signal_moves.flatMap((move) => (move.text === undefined ? [] : [move.text]));
}

/** Everything of a catalog entry a keyword search may match. */
function entryText(entry: CatalogEntry): string {
  return [
    entry.name,
    entry.summary,
    entry.remedy,
    ...moveSentences(entry),
    ...entry.checks,
    ...entry.conditions.map((condition) => condition.title),
  ].join(" ");
}

/** An entry's lexemes, computed once per entry object: the catalog does not change. */
const ENTRY_LEXEMES = new WeakMap<CatalogEntry, ReadonlySet<string>>();

function entryLexemes(entry: CatalogEntry): ReadonlySet<string> {
  let found = ENTRY_LEXEMES.get(entry);
  if (found === undefined) {
    found = lexemes(entryText(entry));
    ENTRY_LEXEMES.set(entry, found);
  }
  return found;
}

/**
 * The stand-in for the full-text stage when there is no database.
 *
 * The share of the query's lexemes the entry also uses, 0…1: how much of what
 * the event says this cause's text says too. Both sides are read as
 * `to_tsvector('english', …)` reads them ({@link lexemes}: stop words dropped,
 * words stemmed), so `the` and `while` match nothing and `rises` meets
 * `rising`. It is deliberately not divided by the entry's length —
 * `ts_rank_cd`, which it stands in for, does not normalise by length either,
 * and a cosine over the two vocabularies would punish exactly the entries the
 * manual describes most thoroughly.
 */
export function keywordOverlap(queryWords: ReadonlySet<string>, entry: CatalogEntry): number {
  if (queryWords.size === 0) return 0;
  const entryWords = entryLexemes(entry);
  let shared = 0;
  for (const word of queryWords) if (entryWords.has(word)) shared += 1;
  return shared / queryWords.size;
}

/** What {@link createCatalogRetriever} reads besides the entries. */
export interface CatalogRetrieverOptions {
  /**
   * The catalog document's condition table, with each condition's symptom
   * sentences, which the entries do not carry. Without it the query
   * has the condition's title but none of its symptoms.
   */
  readonly conditions?: readonly ConditionText[];
}

/**
 * The database-free retriever: stage 1 and a keyword overlap.
 *
 * It is what the unit tests and `tools/eval` run on `tools/eval/fixtures/
 * catalog.json`, and it is deliberately the same assembly as the production
 * one — the same query, the same fusion, the same three list rules — with two
 * stages instead of three, so a candidate list that surprises in evaluation
 * can be reproduced without PostgreSQL. The same query means the condition's
 * symptom sentences too, so the evaluation passes the document's condition
 * table as `conditions`, as production reads `app.catalog_conditions`.
 */
export function createCatalogRetriever(
  entries: readonly CatalogEntry[],
  options: CatalogRetrieverOptions = {},
): Retriever {
  const catalog = catalogFromEntries(entries, ALARMS, options.conditions);
  return {
    retrieve(event: SuspectEvent): Promise<Candidate[]> {
      const query = buildQuery(event, catalog);
      const stage1 = scoreCatalogStage(catalog.entries, event, query.expectedMoves);
      const queryWords = lexemes(query.text);
      const text = new Map(
        catalog.entries.map((entry) => [entry.fault_id, keywordOverlap(queryWords, entry)]),
      );
      const stages = mergeStages(catalog.entries, stage1, text, new Map());
      return Promise.resolve(assembleCandidates(catalog.entries, stages, event.symptom_key));
    },
  };
}

/** What `createPgRetriever` is composed from. */
export interface PgRetrieverOptions {
  /** The diagnosis pool; `app_rw` may read the catalog and the chunks. */
  readonly pool: Pool;
  /** The query embedder (`embedder.ts`). */
  readonly embedder: Embedder;
  /** The catalog behind its 60-second cache; built from `pool` by default. */
  readonly catalogLoader?: CatalogLoader;
}

/** What the two database stages need to know about the active document. */
interface DocumentPlan {
  readonly link: ChunkLink;
  readonly exact: boolean;
}

/**
 * The production retriever.
 *
 * The catalog is cached for a minute, and the two facts the SQL depends on —
 * whether `app.chunks.fault_id` exists and whether the document is small enough
 * for an exact vector search — are resolved once per document and kept
 * with it. A re-ingestion produces a new document id, which is what invalidates
 * them.
 *
 * A stage that fails fails the retrieval: a candidate list silently built from
 * two stages instead of three would look like a ranking and be a different
 * one, so the error reaches the caller instead of a shorter list. A catalog
 * that belongs to no ingested document — nothing ingested yet, or a loader
 * serving a fixed list — gives stages 2 and 3 nothing to search, and the
 * catalog match alone ranks it.
 */
export function createPgRetriever(options: PgRetrieverOptions): Retriever {
  const loader = options.catalogLoader ?? createCachedCatalogLoader({ db: options.pool });
  // Only the active document is ever searched, so one plan is kept: a new
  // document id replaces it, and a failed resolution is forgotten.
  let known: { readonly documentId: number; readonly plan: Promise<DocumentPlan> } | undefined;

  function planFor(documentId: number): Promise<DocumentPlan> {
    if (known?.documentId === documentId) return known.plan;
    const plan = documentPlan(options.pool, documentId).catch((error: unknown) => {
      if (known?.plan === plan) known = undefined;
      throw error;
    });
    known = { documentId, plan };
    return plan;
  }

  return {
    async retrieve(event: SuspectEvent): Promise<Candidate[]> {
      const catalog: Catalog = await loader.load();
      const query = buildQuery(event, catalog);
      const stage1 = scoreCatalogStage(catalog.entries, event, query.expectedMoves);

      if (catalog.documentId === null || catalog.entries.length === 0) {
        return assembleCandidates(
          catalog.entries,
          mergeStages(catalog.entries, stage1, new Map(), new Map()),
          event.symptom_key,
        );
      }

      const plan = await planFor(catalog.documentId);
      const context = { documentId: catalog.documentId, link: plan.link };

      const [text, vector] = await Promise.all([
        searchFullText(options.pool, context, query.text, FULL_TEXT_LIMIT),
        embedAndSearch(options, context, plan, query.text),
      ]);

      const stages = mergeStages(catalog.entries, stage1, scoreMap(text), scoreMap(vector));
      return assembleCandidates(catalog.entries, stages, event.symptom_key);
    },
  };
}

/** The vector stage, which is skipped when the query has nothing to embed. */
async function embedAndSearch(
  options: PgRetrieverOptions,
  context: { readonly documentId: number; readonly link: ChunkLink },
  plan: DocumentPlan,
  text: string,
): Promise<ScoredCause[]> {
  if (text.trim() === "") return [];
  const [vector] = await options.embedder.embed([text]);
  if (vector === undefined) return [];
  return searchVector(options.pool, context, toVectorLiteral(vector), { exact: plan.exact });
}

/** Resolve the two per-document facts the SQL depends on. */
async function documentPlan(db: Queryable, documentId: number): Promise<DocumentPlan> {
  const [link, chunks] = await Promise.all([detectChunkLink(db), countChunks(db, documentId)]);
  return { link, exact: chunks < EXACT_SEARCH_MAX_CHUNKS };
}
