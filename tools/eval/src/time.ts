// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Two clocks meet in the harness and must never be confused.
//
// The *message* clock is the contracts' `iso_ts` — UTC, millisecond
// precision, a literal `Z` — and belongs to @fdp/contracts, which is why
// `toIsoMs` and `parseIsoMs` are re-exported here rather than rewritten.
//
// The *dataset* clock is the second column of the MetroPT-3 CSV,
// `2020-02-01 00:00:00`: fixed width, no zone and no sub-second part. The file
// is read as UTC (docs/dataset.md), so `parseCsvTs` is the single place that
// assumption is written down.

import { parseIsoMs, simMinutesBetween } from "@fdp/contracts";

export { parseIsoMs, toIsoMs } from "@fdp/contracts";

/** The fixed-width shape of the CSV's `timestamp` column. */
export const CSV_TS_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Anything the harness accepts as an instant: epoch milliseconds, a Date or an `iso_ts`. */
export type Instant = number | Date | string;

/**
 * Parses one MetroPT-3 `timestamp` field into epoch milliseconds, UTC.
 *
 * @throws TypeError when the field does not have the dataset's fixed-width shape, and
 * RangeError when it has the shape but names no instant. JavaScript rolls an out-of-range
 * day over instead of rejecting it — `2020-02-30 00:00:00` would become 1 March — so the
 * parsed instant is formatted again and compared with the input.
 */
export function parseCsvTs(text: string): number {
  if (!CSV_TS_PATTERN.test(text)) {
    throw new TypeError(`not a MetroPT-3 timestamp: ${JSON.stringify(text)}`);
  }
  const milliseconds = Date.parse(`${text.replace(" ", "T")}Z`);
  if (Number.isNaN(milliseconds)) {
    throw new RangeError(`MetroPT-3 timestamp names no instant: ${text}`);
  }
  if (formatCsvTs(milliseconds) !== text) {
    throw new RangeError(`MetroPT-3 timestamp names no instant: ${text}`);
  }
  return milliseconds;
}

/** Formats epoch milliseconds back into the dataset clock, for error messages and slice bounds. */
export function formatCsvTs(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Minutes from `from` to `to`, negative when `to` is earlier and never rounded.
 *
 * It is `simMinutesBetween` of @fdp/contracts widened to epoch milliseconds, which is what
 * `parseCsvTs` returns, so replay code can measure a window without converting first.
 */
export function minutesBetween(from: Instant, to: Instant): number {
  return simMinutesBetween(asDate(from), asDate(to));
}

/** An `Instant` as a Date; an `iso_ts` string is validated on the way (`parseIsoMs`). */
export function asDate(value: Instant): Date {
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") return parseIsoMs(value);
  return value;
}
