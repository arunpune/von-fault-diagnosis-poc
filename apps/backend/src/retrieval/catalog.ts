// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The fault catalog, as retrieval reads it.
 *
 * Init writes the catalog into seven normalised tables; `app.v_catalog_entries`
 * puts a cause back together in the `catalog-entry` shape the contracts define,
 * which is the shape a {@link Candidate} carries all the way to the decision
 * sheet. This module is the one place that reads it.
 *
 * Two things the view deliberately does not carry come along beside the
 * entries, because the query builder needs them and nothing else does: the
 * symptom sentences of each condition (a cause's own `conditions[]` carries the
 * title but not the sentences) and the titles of the controller alarms, so an
 * event's `active_alarms` can enter the query as words rather than as codes.
 *
 * A condition's sentences are its one-sentence `symptom` — what the operator
 * sees, and the one wording the manual's source writes — followed by the further
 * wordings of `symptoms[]`, the order `app.catalog_conditions.tsv` indexes
 * them in. Every source reads them the same way ({@link conditionSymptoms}),
 * so the query the evaluation searches with is the one production does.
 *
 * Only the **active document** is read: the manual whose latest ingest run
 * succeeded. A failed re-ingestion leaves an empty document row
 * behind, and retrieval must keep answering from the manual that did work.
 *
 * Nothing here is a hot path — the loader is wrapped in a 60-second cache —
 * so the four statements stay four statements instead of one join that
 * would multiply the entry JSON by the number of conditions.
 */

import { ALARMS, validate } from "@fdp/contracts";
import type { Alarm, CatalogEntry } from "@fdp/contracts";

import { query, queryOne, type Queryable } from "../db/pool.ts";

/** How long a loaded catalog is reused before the tables are read again. */
export const CATALOG_CACHE_TTL_MS = 60_000;

/** One condition of the fault-finding tables, with the symptoms it lists. */
export interface CatalogCondition {
  readonly condition_id: string;
  readonly title: string;
  /** The symptom sentences of the condition: `symptom`, then `symptoms[]`. */
  readonly symptoms: readonly string[];
  readonly alarm_codes: readonly string[];
}

/**
 * A condition as a catalog read without the database carries it: the eval's
 * `reference`, `file:` and ingested sources (docs/evaluation.md).
 */
export type ConditionText = Pick<CatalogCondition, "condition_id" | "title" | "symptoms">;

/**
 * The symptom sentences of one condition: the one-sentence `symptom` first,
 * then the further wordings of `symptoms[]`, blanks and repeats dropped.
 */
export function conditionSymptoms(
  symptom: string | null | undefined,
  symptoms: readonly string[] | null | undefined,
): string[] {
  const sentences = [symptom ?? "", ...(symptoms ?? [])].map((sentence) => sentence.trim());
  return [...new Set(sentences.filter((sentence) => sentence !== ""))];
}

/** An entry `app.v_catalog_entries` produced that is not a `catalog-entry`. */
export interface InvalidCatalogEntry {
  /** The `fault_id` column of the view, which is outside the JSON document. */
  readonly fault_id: string;
  /** What the contract validator objected to, one line per issue. */
  readonly issues: readonly string[];
}

/** The catalog of one manual document, as the three retrieval stages read it. */
export interface Catalog {
  /** The active document, or `null` when nothing has been ingested yet. */
  readonly documentId: number | null;
  /** Every cause, in `fault_id` order so two loads are the same list. */
  readonly entries: readonly CatalogEntry[];
  /** Conditions by `condition_id`; the query builder reads the event's. */
  readonly conditions: ReadonlyMap<string, CatalogCondition>;
  /** Alarm titles by code, so `active_alarms` can enter the query as words. */
  readonly alarmTitles: ReadonlyMap<string, string>;
  /** Rows the view produced that do not validate; the caller logs them. */
  readonly invalid: readonly InvalidCatalogEntry[];
}

/** A catalog with nothing in it: no manual has been ingested. */
export const EMPTY_CATALOG: Catalog = Object.freeze({
  documentId: null,
  entries: [],
  conditions: new Map(),
  alarmTitles: new Map(),
  invalid: [],
});

/**
 * The document whose latest ingest run succeeded.
 *
 * `finished_wall_ts` is null while a run is in flight, so the ordering falls
 * back to the start instant, and the identity breaks a tie between two runs
 * that finished inside the same clock tick.
 */
export const ACTIVE_DOCUMENT_SQL = `
  SELECT r.document_id
    FROM app.ingest_runs AS r
   WHERE r.status = 'succeeded'
   ORDER BY coalesce(r.finished_wall_ts, r.started_wall_ts) DESC, r.id DESC
   LIMIT 1`;

const ENTRIES_SQL = `
  SELECT v.fault_id, v.entry
    FROM app.v_catalog_entries AS v
   WHERE v.document_id = $1
   ORDER BY v.fault_id`;

const CONDITIONS_SQL = `
  SELECT c.condition_id, c.title, c.symptom, c.symptoms, c.alarm_codes
    FROM app.catalog_conditions AS c
   WHERE c.document_id = $1
   ORDER BY c.condition_id`;

const ALARMS_SQL = `
  SELECT a.code, a.title
    FROM app.catalog_alarms AS a
   WHERE a.document_id = $1
   ORDER BY a.code`;

/** The active document's identity, or `null` when no run has succeeded. */
export async function activeDocumentId(db: Queryable): Promise<number | null> {
  const row = await queryOne<{ document_id: string | number }>(db, ACTIVE_DOCUMENT_SQL);
  if (row === undefined) return null;
  return typeof row.document_id === "number" ? row.document_id : Number(row.document_id);
}

/**
 * Read the whole catalog of the active document.
 *
 * An entry that does not validate is dropped rather than thrown on: one cause
 * the extraction mangled must not take the other thirty-eight with it, and the
 * caller gets the list of what was dropped so the failure is visible in a log
 * line instead of in a silently shorter candidate list.
 */
export async function loadCatalog(db: Queryable): Promise<Catalog> {
  const documentId = await activeDocumentId(db);
  if (documentId === null) return EMPTY_CATALOG;

  const [entryRows, conditionRows, alarmRows] = await Promise.all([
    query<{ fault_id: string; entry: unknown }>(db, ENTRIES_SQL, [documentId]),
    query<{
      condition_id: string;
      title: string;
      symptom: string | null;
      symptoms: string[] | null;
      alarm_codes: string[] | null;
    }>(db, CONDITIONS_SQL, [documentId]),
    query<{ code: string; title: string }>(db, ALARMS_SQL, [documentId]),
  ]);

  const entries: CatalogEntry[] = [];
  const invalid: InvalidCatalogEntry[] = [];
  for (const row of entryRows) {
    const result = validate("catalog-entry", row.entry);
    if (result.ok) entries.push(result.value);
    else invalid.push({ fault_id: row.fault_id, issues: result.errors.map((error) => error.text) });
  }

  const conditions = new Map<string, CatalogCondition>();
  for (const row of conditionRows) {
    conditions.set(row.condition_id, {
      condition_id: row.condition_id,
      title: row.title,
      symptoms: conditionSymptoms(row.symptom, row.symptoms),
      alarm_codes: row.alarm_codes ?? [],
    });
  }

  const alarmTitles = new Map<string, string>();
  for (const row of alarmRows) alarmTitles.set(row.code, row.title);

  return { documentId, entries, conditions, alarmTitles, invalid };
}

/**
 * A catalog built without a database, for the tests and the eval harness.
 *
 * The conditions are recovered from the entries' own `conditions[]`, which
 * carry the titles and the alarm codes but not the symptom sentences: those
 * live in the catalog document's condition table, as they live in
 * `app.catalog_conditions`, so a caller that has the table passes it as
 * `conditions`. A listed condition brings its sentences and its own
 * title (the entries' title when its own is blank); one no entry names still
 * enters, so an event keyed on it reads its words. Without the list every
 * condition has no sentence, as before.
 *
 * The alarm titles come from the contracts' alarm registry, which is
 * generated from the same manual source init extracts `app.catalog_alarms`
 * from, so an event's `active_alarms` read the same words with or without a
 * database. `createCatalogRetriever` runs on exactly this.
 */
export function catalogFromEntries(
  entries: readonly CatalogEntry[],
  alarms: readonly Pick<Alarm, "code" | "title">[] = ALARMS,
  conditions: readonly ConditionText[] = [],
): Catalog {
  const byId = new Map<string, CatalogCondition>();
  for (const entry of entries) {
    for (const condition of entry.conditions) {
      const known = byId.get(condition.condition_id);
      const codes = new Set<string>([...(known?.alarm_codes ?? []), ...condition.alarms]);
      byId.set(condition.condition_id, {
        condition_id: condition.condition_id,
        title: condition.title,
        symptoms: [],
        alarm_codes: [...codes].sort(),
      });
    }
  }
  for (const condition of conditions) {
    const known = byId.get(condition.condition_id);
    const title = condition.title.trim() === "" ? known?.title : condition.title;
    byId.set(condition.condition_id, {
      condition_id: condition.condition_id,
      title: title ?? condition.title,
      symptoms: conditionSymptoms(undefined, condition.symptoms),
      alarm_codes: known?.alarm_codes ?? [],
    });
  }
  const sorted = [...entries].sort((left, right) => compareIds(left.fault_id, right.fault_id));
  const alarmTitles = new Map(alarms.map((alarm) => [alarm.code, alarm.title]));
  return { documentId: null, entries: sorted, conditions: byId, alarmTitles, invalid: [] };
}

/** Ascending `fault_id`, the tie-breaker every ordering in retrieval uses. */
export function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** What `createPgRetriever` calls once per decision to get the catalog. */
export interface CatalogLoader {
  load(): Promise<Catalog>;
}

/** What {@link createCachedCatalogLoader} needs; the clock is injectable. */
export interface CachedCatalogLoaderOptions {
  readonly db: Queryable;
  /** Milliseconds a loaded catalog is reused; {@link CATALOG_CACHE_TTL_MS}. */
  readonly ttlMs?: number;
  /** Monotonic-enough clock, injected so a test can move time without waiting. */
  readonly now?: () => number;
}

/**
 * {@link loadCatalog} behind a 60-second cache.
 *
 * Concurrent callers share one in-flight read: a decision burst must not open
 * four connections to answer the same four statements. A failed read is not
 * cached — the next caller tries again — but a cached catalog older than the
 * TTL is kept when the refresh fails, because answering from a slightly stale
 * catalog beats answering with nothing while the database is briefly away.
 */
export function createCachedCatalogLoader(options: CachedCatalogLoaderOptions): CatalogLoader {
  const ttlMs = options.ttlMs ?? CATALOG_CACHE_TTL_MS;
  const now = options.now ?? Date.now;

  let cached: Catalog | undefined;
  let loadedAt = 0;
  let inFlight: Promise<Catalog> | undefined;

  return {
    async load(): Promise<Catalog> {
      if (cached !== undefined && now() - loadedAt < ttlMs) return cached;
      if (inFlight !== undefined) return inFlight;

      const read = loadCatalog(options.db)
        .then((catalog) => {
          cached = catalog;
          loadedAt = now();
          return catalog;
        })
        .catch((error: unknown) => {
          if (cached !== undefined) return cached;
          throw error;
        })
        .finally(() => {
          inFlight = undefined;
        });

      inFlight = read;
      return read;
    },
  };
}
