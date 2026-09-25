// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Sim time and wall time. Sim time is the data's clock: the recording's timestamps read as UTC,
// always shown in UTC and never converted to the viewer's zone, so "5 Jun 2020 09:48" means the
// same row everywhere. Wall time is when something happened on the viewer's side of the demo (a
// cost ledger row, a system alert) and is shown in the local zone with the zone named. Intl is
// enough; no date library.

import { NO_VALUE } from "@/lib/format";

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;
/** The largest distance from the epoch a JavaScript Date can hold. */
const MAX_DATE_MS = 8.64e15;

/** Epoch milliseconds of an ISO instant; NaN when the text is not one. */
export function parseIso(iso: string): number {
  return Date.parse(iso);
}

/** Epoch milliseconds as the contracts' `iso_ts`: UTC, millisecond precision, a literal Z. */
export function toIsoMs(ms: number): string {
  return new Date(ms).toISOString();
}

function toMs(value: number | string): number {
  return typeof value === "number" ? value : parseIso(value);
}

/** The ISO text of a valid instant, or null. */
function isoOf(value: number | string): string | null {
  const ms = toMs(value);
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? toIsoMs(ms) : null;
}

/** A sim instant as the clock shows it: "2020-06-05 09:48:20" (UTC). */
export function fmtSim(value: number | string): string {
  const iso = isoOf(value);
  return iso === null ? NO_VALUE : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/**
 * A sim instant as an axis tick: "09:48", or "06-05 09:48" when the axis spans more than one UTC
 * day (see `spansUtcDays`).
 */
export function fmtSimShort(value: number | string, withDate = false): string {
  const iso = isoOf(value);
  if (iso === null) {
    return NO_VALUE;
  }
  const time = iso.slice(11, 16);
  return withDate ? `${iso.slice(5, 10)} ${time}` : time;
}

/** True when two sim instants fall on different UTC days, so ticks need the date. */
export function spansUtcDays(from: number | string, to: number | string): boolean {
  const first = isoOf(from);
  const last = isoOf(to);
  return first !== null && last !== null && first.slice(0, 10) !== last.slice(0, 10);
}

function unitPair(big: number, bigUnit: string, small: number, smallUnit: string): string {
  return small === 0 ? `${big} ${bigUnit}` : `${big} ${bigUnit} ${small} ${smallUnit}`;
}

/**
 * A length of time in its two largest units, the smaller one dropped when zero: "2 h 14 min",
 * "1 d 3 h", "45 s". `unit` says whether `value` counts milliseconds (the default) or seconds.
 */
export function fmtDuration(value: number, unit: "ms" | "s" = "ms"): string {
  if (!Number.isFinite(value) || value < 0) {
    return NO_VALUE;
  }
  const total = Math.round(unit === "ms" ? value / MS_PER_SECOND : value);
  if (total < SECONDS_PER_MINUTE) {
    return `${total} s`;
  }
  if (total < SECONDS_PER_HOUR) {
    const minutes = Math.floor(total / SECONDS_PER_MINUTE);
    return unitPair(minutes, "min", total % SECONDS_PER_MINUTE, "s");
  }
  if (total < SECONDS_PER_DAY) {
    const hours = Math.floor(total / SECONDS_PER_HOUR);
    const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    return unitPair(hours, "h", minutes, "min");
  }
  const days = Math.floor(total / SECONDS_PER_DAY);
  const hours = Math.floor((total % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
  return unitPair(days, "d", hours, "h");
}

const wallFormats = new Map<string, Intl.DateTimeFormat>();

function wallFormat(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let format = wallFormats.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    wallFormats.set(key, format);
  }
  return format;
}

/**
 * A wall-clock instant in the viewer's zone, zone named: "2026-06-05 11:41:12 GMT+2". `timeZone`
 * overrides the viewer's zone (tests pin it).
 */
export function fmtWall(value: number | string, timeZone?: string): string {
  const ms = toMs(value);
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) {
    return NO_VALUE;
  }
  const parts = new Map<Intl.DateTimeFormatPartTypes, string>();
  for (const { type, value: text } of wallFormat(timeZone).formatToParts(ms)) {
    parts.set(type, text);
  }
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.get(type) ?? "";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  const time = `${part("hour")}:${part("minute")}:${part("second")}`;
  return `${date} ${time} ${part("timeZoneName")}`;
}
