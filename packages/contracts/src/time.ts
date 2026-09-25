// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The one time format of this system: UTC, millisecond precision, a literal `Z`. Go writes
// `2006-01-02T15:04:05.000Z` and Python `strftime('%Y-%m-%dT%H:%M:%S.') + ms + 'Z'`; the fixtures
// pin the format for all three.

/** The `iso_ts` pattern of `common.schema.json`, repeated here so `parseIsoMs` can reject early. */
export const ISO_MS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const MS_PER_MINUTE = 60_000;

/**
 * Formats an instant as an `iso_ts` string.
 *
 * @throws RangeError when the date is invalid or falls outside the four-digit year range that
 * `iso_ts` allows (`Date.prototype.toISOString` then uses the expanded `±YYYYYY` form).
 */
export function toIsoMs(date: Date): string {
  const text = date.toISOString();
  if (!ISO_MS_PATTERN.test(text)) {
    throw new RangeError(`not representable as an iso_ts timestamp: ${text}`);
  }
  return text;
}

/**
 * Parses an `iso_ts` string.
 *
 * @throws TypeError when the string does not match the `iso_ts` pattern, and RangeError when it
 * matches but names no instant. JavaScript rolls an out-of-range day over instead of rejecting
 * it — `2026-02-30T00:00:00.000Z` becomes 2 March — so the parsed date is formatted again and
 * compared with the input.
 */
export function parseIsoMs(text: string): Date {
  if (!ISO_MS_PATTERN.test(text)) {
    throw new TypeError(`not an iso_ts timestamp: ${JSON.stringify(text)}`);
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) {
    throw new RangeError(`iso_ts timestamp names no instant: ${text}`);
  }
  return date;
}

function instant(value: Date | string): number {
  return typeof value === "string" ? parseIsoMs(value).getTime() : value.getTime();
}

/**
 * Simulated minutes from `from` to `to`, negative when `to` is earlier.
 *
 * The result is not rounded: a caller that needs whole minutes rounds them itself.
 */
export function simMinutesBetween(from: Date | string, to: Date | string): number {
  return (instant(to) - instant(from)) / MS_PER_MINUTE;
}
