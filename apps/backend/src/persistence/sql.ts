// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The small conversions every repository of this module shares.
 *
 * Values cross the driver in two directions. Going in, a `jsonb` parameter is
 * sent as its JSON text and an optional value as SQL `NULL`; coming out, a
 * `timestamptz` arrives as a `Date` and is handed on in the contracts' one
 * timestamp format. Keeping both here means no repository formats a date or
 * serialises a document its own way.
 */

import { toIsoMs } from "@fdp/contracts";

/**
 * A value as a `jsonb` parameter: its JSON text.
 *
 * `undefined` is sent as the JSON `null` document, which a `NOT NULL jsonb`
 * column accepts: the column records that there was nothing, rather than
 * refusing the row.
 */
export function jsonb(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** An optional document as a `jsonb` parameter, or SQL `NULL` when there is none. */
export function jsonbOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** A `timestamptz` the driver decoded, as an `iso_ts`. */
export function iso(value: Date): string {
  return toIsoMs(value);
}

/** An optional `timestamptz`, as an `iso_ts` or `null`. */
export function isoOrNull(value: Date | null): string | null {
  return value === null ? null : toIsoMs(value);
}

/** A canonical UUID, the only form a `uuid` column is compared with. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a string can be cast to `uuid`.
 *
 * A route hands a path segment or a query value straight to a repository; a
 * string that is not a UUID can match no row, so the repository answers "none"
 * without sending a statement the server would refuse with a cast error.
 */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
