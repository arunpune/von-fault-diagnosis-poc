// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Number, money, id and label formatting. Every readout goes through these so a pressure always
// shows two decimals, a cost never rounds a real decision to zero and an id is always cut the
// same way. English formatting is fixed ("en-US"): the UI is English only, and a readout must
// not change shape with the viewer's locale.

import type { ManualReference } from "@/api/types";

const LOCALE = "en-US";

/** Shown wherever a value is absent or not a finite number. */
export const NO_VALUE = "—";

/** Fixed decimals per unit, so live readouts do not jitter. */
const DECIMALS_BY_UNIT: Readonly<Record<string, number>> = {
  bar: 2,
  "bar/min": 2,
  degC: 1,
  "°C": 1,
  A: 2,
  "1/h": 1,
  s: 0,
};

/** Unit spellings of the signal registry and how they read on screen. */
const UNIT_LABELS: Readonly<Record<string, string>> = {
  degC: "°C",
  bool: "",
};

/** Up to this many decimals, trailing zeros trimmed, for a unit without a fixed precision. */
const DEFAULT_MAX_DECIMALS = 2;

/** Costs keep six decimals so a decision billed at $0.000126 stays visible. */
const USD_DECIMALS = 6;

const SHORT_ID_LENGTH = 6;

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(minDecimals: number, maxDecimals: number): Intl.NumberFormat {
  const key = `${minDecimals}:${maxDecimals}`;
  let format = numberFormats.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: minDecimals,
      maximumFractionDigits: maxDecimals,
    });
    numberFormats.set(key, format);
  }
  return format;
}

/** A registry unit as it reads next to a number: `degC` is °C, a digital state has none. */
export function unitLabel(unit: string | null | undefined): string {
  if (unit === null || unit === undefined) {
    return "";
  }
  return UNIT_LABELS[unit] ?? unit;
}

/** A number with thousands separators and the given decimals. */
export function fmtNumber(value: number, decimals: number): string {
  return numberFormat(decimals, decimals).format(value);
}

/**
 * A measured value with its unit: pressures with two decimals, temperatures with one, currents
 * with two; a digital state reads on or off. Absent or non-finite values read "—".
 */
export function fmtValue(value: number | boolean | null | undefined, unit?: string | null): string {
  if (value === null || value === undefined) {
    return NO_VALUE;
  }
  if (typeof value === "boolean" || unit === "bool") {
    return value === true || value === 1 ? "on" : "off";
  }
  if (!Number.isFinite(value)) {
    return NO_VALUE;
  }
  const decimals = unit === null || unit === undefined ? undefined : DECIMALS_BY_UNIT[unit];
  const text =
    decimals === undefined
      ? numberFormat(0, DEFAULT_MAX_DECIMALS).format(value)
      : fmtNumber(value, decimals);
  const label = unitLabel(unit);
  return label === "" ? text : `${text} ${label}`;
}

/** US dollars with up to six decimals, trailing zeros trimmed down to cents: `$0.000077`. */
export function fmtUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) {
    return NO_VALUE;
  }
  const [whole = "0", fraction = ""] = Math.abs(usd).toFixed(USD_DECIMALS).split(".");
  const cents = fraction.replace(/0+$/, "").padEnd(2, "0");
  const sign = usd < 0 ? "−" : "";
  return `${sign}$${fmtNumber(Number(whole), 0)}.${cents}`;
}

/** A 0–1 fraction as a whole percentage: `fmtPct(0.913)` is "91 %". */
export function fmtPct(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) {
    return NO_VALUE;
  }
  return `${Math.round(fraction * 100)} %`;
}

/** A token count with thousands separators: "74,892". */
export function fmtTokens(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count)) {
    return NO_VALUE;
  }
  return fmtNumber(Math.round(count), 0);
}

/** A replay speed as the controls show it: "600×". */
export function fmtSpeed(speed: number): string {
  return `${fmtNumber(speed, 0)}×`;
}

/** The last six characters of an id; the full id belongs in a `title` beside it. */
export function shortId(id: string): string {
  return id.length <= SHORT_ID_LENGTH ? id : id.slice(-SHORT_ID_LENGTH);
}

/** A snake_case identifier as a sentence-case phrase: "dryer_purge_pressure" → "Dryer purge pressure". */
export function humanize(identifier: string): string {
  const words = identifier.replace(/[_-]+/g, " ").trim();
  return words === "" ? words : words.charAt(0).toUpperCase() + words.slice(1);
}

function pageRange(reference: ManualReference): string | null {
  const first = reference.page ?? reference.page_start;
  if (first === undefined) {
    return null;
  }
  const last = reference.page === undefined ? reference.page_end : undefined;
  return last === undefined || last === first ? `p. ${first}` : `pp. ${first}–${last}`;
}

/** A manual reference as the sheets cite it: "§8.3 Low line pressure, p. 41". */
export function fmtManualRef(reference: ManualReference): string {
  const section =
    reference.title === undefined
      ? `§${reference.section}`
      : `§${reference.section} ${reference.title}`;
  const pages = pageRange(reference);
  return pages === null ? section : `${section}, ${pages}`;
}
