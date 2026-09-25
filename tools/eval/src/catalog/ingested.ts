// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The `ingested` catalog source: the fault catalog init extracted from the
// manual PDF and stored in Postgres, read back as role `eval` so the same
// scenarios can score it against the reference one — the ablation that keeps
// extraction quality measurable.
//
// It reads what the backend's own `loadCatalog` reads, in the same way, so the
// in-process retriever ranks the catalog production ranks:
//
// - only the **active document**, the one whose latest ingest run succeeded,
//   since a failed re-ingestion leaves an empty document row behind;
// - its causes from `app.v_catalog_entries`, each validated as a contracts
//   `catalog-entry`; an entry that does not validate is dropped and named in a
//   warning, as the backend drops it, rather than failing the run;
// - its conditions from `app.catalog_conditions`, each with its symptom
//   sentences — the one-sentence `symptom` first, then the wordings of
//   `symptoms[]`, blanks and repeats dropped — in the `EvalCondition` shape
//   the `reference` and `file:` sources give.
//
// Everything runs inside one read-only transaction, so the four statements see
// one snapshot and none of them can write. The connection string carries the
// eval role's password; it goes to the driver and nowhere else.

import { createHash } from "node:crypto";

import { validate } from "@fdp/contracts";
import pg from "pg";

import { createLogger } from "../log.ts";
import type { Logger } from "../log.ts";
import type { CatalogEntry, EvalCondition } from "./types.ts";

/** The document whose latest ingest run succeeded, as the backend's retrieval picks it. */
export const ACTIVE_DOCUMENT_SQL = `
  SELECT d.id, d.name, d.sha256
    FROM app.ingest_runs AS r
    JOIN app.manual_documents AS d ON d.id = r.document_id
   WHERE r.status = 'succeeded'
   ORDER BY coalesce(r.finished_wall_ts, r.started_wall_ts) DESC, r.id DESC
   LIMIT 1`;

/** Every cause of one document, in the `catalog-entry` shape. */
export const ENTRIES_SQL = `
  SELECT v.fault_id, v.entry
    FROM app.v_catalog_entries AS v
   WHERE v.document_id = $1
   ORDER BY v.fault_id`;

/** Every condition of one document, with the symptom columns the retrieval query reads. */
export const CONDITIONS_SQL = `
  SELECT c.condition_id, c.title, c.symptom, c.symptoms
    FROM app.catalog_conditions AS c
   WHERE c.document_id = $1
   ORDER BY c.condition_id`;

/** What the reads need of a database connection; `pg.Client` satisfies it. */
export interface Queryable {
  query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** The manual the catalog was extracted from. */
export interface IngestedDocument {
  readonly name: string;
  readonly sha256: string;
}

/** A view row that is not a `catalog-entry`, with what the validator objected to. */
export interface InvalidEntry {
  readonly fault_id: string;
  readonly issues: readonly string[];
}

/** The ingested catalog, as `loadCatalog` in `src/config.ts` consumes it. */
export interface IngestedCatalog {
  readonly entries: readonly CatalogEntry[];
  readonly conditions: readonly EvalCondition[];
  /** SHA-256 of the entries sorted by `fault_id`, each written with its keys sorted. */
  readonly sha256: string;
  readonly source: "ingested";
  /** The active document, or `null` when no ingest run has succeeded. */
  readonly document: IngestedDocument | null;
  /** Rows the view produced that do not validate; dropped, as the backend drops them. */
  readonly invalid: readonly InvalidEntry[];
}

interface DocumentRow {
  readonly id: string | number;
  readonly name: string;
  readonly sha256: string;
}

interface EntryRow {
  readonly fault_id: string;
  readonly entry: unknown;
}

interface ConditionRow {
  readonly condition_id: string;
  readonly title: string;
  readonly symptom: string | null;
  readonly symptoms: readonly string[] | null;
}

/** Code-point order, the same in every locale, so a digest never depends on the machine. */
function byCodePoint(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** JSON with every object's keys sorted, so the same catalog always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => byCodePoint(left, right))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The digest of a catalog: its entries sorted by `fault_id`, as canonical JSON. */
export function catalogSha256(entries: readonly CatalogEntry[]): string {
  const sorted = [...entries].sort((left, right) => byCodePoint(left.fault_id, right.fault_id));
  return createHash("sha256").update(canonicalJson(sorted)).digest("hex");
}

/**
 * A condition's symptom sentences: the one-sentence `symptom`, then the wordings of `symptoms[]`,
 * blanks and repeats dropped — the reading of the backend's `conditionSymptoms`.
 */
export function conditionSentences(
  symptom: string | null | undefined,
  symptoms: readonly string[] | null | undefined,
): string[] {
  const sentences = [symptom ?? "", ...(symptoms ?? [])].map((sentence) => sentence.trim());
  return [...new Set(sentences.filter((sentence) => sentence !== ""))];
}

/**
 * Reads the active document's catalog through a connection the caller holds.
 *
 * The caller owns the transaction; `loadIngestedCatalog` wraps this in a read-only one.
 */
export async function readIngestedCatalog(db: Queryable): Promise<IngestedCatalog> {
  const document = (await db.query<DocumentRow>(ACTIVE_DOCUMENT_SQL)).rows[0];
  if (document === undefined) {
    return {
      entries: [],
      conditions: [],
      sha256: catalogSha256([]),
      source: "ingested",
      document: null,
      invalid: [],
    };
  }
  const documentId = Number(document.id);
  const entryRows = (await db.query<EntryRow>(ENTRIES_SQL, [documentId])).rows;
  const conditionRows = (await db.query<ConditionRow>(CONDITIONS_SQL, [documentId])).rows;

  const entries: CatalogEntry[] = [];
  const invalid: InvalidEntry[] = [];
  for (const row of entryRows) {
    const result = validate("catalog-entry", row.entry);
    if (result.ok) entries.push(result.value);
    else invalid.push({ fault_id: row.fault_id, issues: result.errors.map((error) => error.text) });
  }

  return {
    entries,
    conditions: conditionRows.map((row) => ({
      condition_id: row.condition_id,
      title: row.title,
      symptoms: conditionSentences(row.symptom, row.symptoms),
    })),
    sha256: catalogSha256(entries),
    source: "ingested",
    document: { name: document.name, sha256: document.sha256 },
    invalid,
  };
}

/**
 * Runs `work` inside one read-only transaction on a fresh connection, and always closes it.
 *
 * `BEGIN TRANSACTION READ ONLY` makes PostgreSQL refuse any write the work might attempt, whatever
 * the role's grants, so a reader built on this cannot change the database it measures.
 */
export async function withReadOnlyTransaction<T>(
  dbUrl: string,
  work: (db: Queryable) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    try {
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}

/**
 * The `ingested` catalog source: `app.v_catalog_entries` and `app.catalog_conditions` of the
 * active document, read as the role the URL names (`eval`).
 *
 * @param dbUrl the eval role's connection string, `--db-url`.
 * @param options the logger the dropped entries are reported to.
 * @throws whatever the driver throws when the database cannot be reached or read.
 */
export async function loadIngestedCatalog(
  dbUrl: string,
  options: { readonly log?: Logger } = {},
): Promise<IngestedCatalog> {
  const catalog = await withReadOnlyTransaction(dbUrl, readIngestedCatalog);
  const log = options.log ?? createLogger();
  if (catalog.document === null) {
    log.warn("the database holds no succeeded ingest run; the ingested catalog is empty");
  } else {
    log.info("ingested catalog", {
      document: catalog.document.name,
      document_sha256: catalog.document.sha256,
      entries: catalog.entries.length,
      conditions: catalog.conditions.length,
      sha256: catalog.sha256,
    });
  }
  if (catalog.invalid.length > 0) {
    log.warn("ingested catalog entries dropped: they are not catalog-entry documents", {
      fault_ids: catalog.invalid.map((entry) => entry.fault_id),
    });
  }
  return catalog;
}
