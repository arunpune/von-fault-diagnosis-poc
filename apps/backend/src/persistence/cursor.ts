// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keyset cursors for the newest-first lists.
 *
 * `api-events` and `api-decisions` page with an opaque `next_cursor`. Behind
 * it sits the key of the last row a page returned — its `sim_ts` and its
 * surrogate `id` — and the next page asks for the rows strictly below that key
 * in `(sim_ts DESC, id DESC)` order. The pair is unique, so a page boundary
 * that falls between two rows of the same instant neither repeats nor skips
 * one, and rows inserted while a reader pages through never shift what it
 * sees below the key (an `OFFSET` would).
 *
 * The instant is carried at the database's own precision. `timestamptz` holds
 * microseconds and a JavaScript `Date` only milliseconds, so the key is read
 * as text by {@link CURSOR_TS_SQL} rather than through a `Date`: a row written
 * with sub-millisecond precision would otherwise sort just above a truncated
 * key and fall out of the list.
 *
 * The encoding is base64url of a two-element JSON array, which the client
 * treats as an opaque token. {@link decodeCursor} accepts only what
 * {@link encodeCursor} produces and throws {@link InvalidCursorError} for
 * anything else, so a tampered or stale token becomes a 400 rather than a
 * database error.
 */

/** Rows a page carries when the caller does not say. */
export const DEFAULT_PAGE_LIMIT = 50;

/** The most rows one page carries, whatever the caller asks for. */
export const MAX_PAGE_LIMIT = 200;

/**
 * The SQL expression that reads a row's `sim_ts` as the cursor's text form:
 * UTC, microseconds, a literal `Z`. It is a constant, never built from input.
 */
export const CURSOR_TS_SQL =
  "to_char(sim_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')";

/** The key of one row in `(sim_ts DESC, id DESC)` order. */
export interface CursorKey {
  /** `sim_ts` at microsecond precision, as {@link CURSOR_TS_SQL} writes it. */
  readonly simTs: string;
  /** The row's `bigint` surrogate key, in decimal; a string so no digit is lost. */
  readonly id: string;
}

/** One page of a newest-first list, in the shape `api-events` and `api-decisions` share. */
export interface Page<T> {
  readonly items: T[];
  /** The token of the next page; `null` on the last one. */
  readonly next_cursor: string | null;
}

/** Thrown for a cursor this module did not produce. */
export class InvalidCursorError extends Error {
  constructor(reason: string) {
    super(`invalid cursor: ${reason}`);
    this.name = "InvalidCursorError";
  }
}

/** The shape of the base64url alphabet, without padding. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** {@link CURSOR_TS_SQL}'s output: a UTC instant with six fraction digits. */
const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** A positive `bigint` in decimal, without a sign or leading zeros. */
const ROW_ID = /^[1-9]\d{0,18}$/;

/** The largest value of a PostgreSQL `bigint`. */
const MAX_BIGINT = 9_223_372_036_854_775_807n;

/** The opaque token of one row's key. */
export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify([key.simTs, key.id]), "utf8").toString("base64url");
}

/** The key behind a token {@link encodeCursor} produced; throws {@link InvalidCursorError} otherwise. */
export function decodeCursor(cursor: string): CursorKey {
  if (!BASE64URL.test(cursor)) throw new InvalidCursorError("not a base64url token");

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError("not a token this API issued");
  }

  if (!Array.isArray(decoded) || decoded.length !== 2) {
    throw new InvalidCursorError("not a token this API issued");
  }
  const [simTs, id] = decoded as unknown[];
  if (typeof simTs !== "string" || !CURSOR_TS.test(simTs) || Number.isNaN(Date.parse(simTs))) {
    throw new InvalidCursorError("the instant is malformed");
  }
  if (typeof id !== "string" || !ROW_ID.test(id) || BigInt(id) > MAX_BIGINT) {
    throw new InvalidCursorError("the row key is malformed");
  }
  return { simTs, id };
}

/** The limits of one list: what a caller gets unasked and the most it may ask for. */
export interface LimitBounds {
  readonly fallback: number;
  readonly max: number;
}

const PAGE_BOUNDS: LimitBounds = { fallback: DEFAULT_PAGE_LIMIT, max: MAX_PAGE_LIMIT };

/**
 * A requested row count as one the statement accepts: the fallback when it is
 * absent or not a number, otherwise truncated and clamped to `1…max`.
 */
export function clampLimit(limit: number | undefined, bounds: LimitBounds = PAGE_BOUNDS): number {
  if (limit === undefined || !Number.isFinite(limit)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(1, Math.trunc(limit)));
}

/**
 * A row of a paged statement: its key columns beside whatever it carries.
 *
 * Both are selected under names no table column has. An output column called
 * `id` would shadow the table's `id` in `ORDER BY` — PostgreSQL resolves a bare
 * name there against the select list first — and the text form would then
 * sort `"10"` before `"9"` while the `WHERE` bound still compared numbers.
 */
export interface KeyedRow {
  /** The row's `id`, selected as `id::text AS cursor_id`. */
  readonly cursor_id: string;
  /** The row's `sim_ts`, selected as {@link CURSOR_TS_SQL} `AS cursor_ts`. */
  readonly cursor_ts: string;
}

/**
 * One page out of the rows a statement returned for `LIMIT limit + 1`.
 *
 * The extra row is the proof that another page exists; it is dropped, and the
 * cursor is the key of the last row the page keeps.
 */
export function toPage<Row extends KeyedRow, Item>(
  rows: readonly Row[],
  limit: number,
  item: (row: Row) => Item,
): Page<Item> {
  const kept = rows.slice(0, limit);
  const last = kept.at(-1);
  const more = rows.length > limit && last !== undefined;
  return {
    items: kept.map(item),
    next_cursor: more ? encodeCursor({ simTs: last.cursor_ts, id: last.cursor_id }) : null,
  };
}

/**
 * The three statement parameters of a page's lower bound: the key's instant
 * and id, both `null` on the first page, and the row count to fetch (one more
 * than the page, see {@link toPage}).
 */
export function pageParams(
  before: string | undefined,
  limit: number,
): [string | null, string | null, number] {
  if (before === undefined) return [null, null, limit + 1];
  const key = decodeCursor(before);
  return [key.simTs, key.id, limit + 1];
}
