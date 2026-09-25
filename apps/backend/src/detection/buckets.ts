// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Numbers become words here: code computes, the model judges.
 *
 * Nothing downstream of this file sees a series. A value becomes a
 * {@link Level} by where it sits in its first-month band — for an analog
 * signal, no finer than its instrument resolves — a slope becomes a
 * {@link Trend} by how fast it moves against a per-kind threshold, and an
 * elapsed time becomes a {@link Duration}. The three words travel together as
 * one bucket string — `"far above normal; flat; about an hour"` — which
 * `decision/state.ts` splits again, so the runtime and `tools/eval` feed the
 * model from exactly the same sentence.
 *
 * The internal words are finer than the contract's: `rising_sharply` and
 * `rising` are one `rising` on the wire, because `common.schema.json` pins the
 * enum every consumer reads. {@link toContractLevel} and
 * {@link toContractTrend} are the only places that narrowing happens.
 */

import type { AmbientBucket, LevelBucket, MachineMode, TrendBucket } from "@fdp/contracts";

import {
  DIGITAL_NORMAL_SHARE,
  DIGITAL_RARE_SHARE,
  FIRST_MONTH_ANALOG_BANDS,
  FIRST_MONTH_CYCLE_BANDS,
  FIRST_MONTH_DIGITAL_SHARE,
  SENSOR_ACCURACY,
  type Band,
  type BandedMode,
  type CycleMetric,
  type MeasuredAnalogRole,
} from "./baseline.ts";
import { ANALOG_ROLES, DIGITAL_ROLES, type DigitalRole, type SignalRole } from "./signals.ts";
import type { Duration, Level, Trend } from "./types.ts";

/** Ambient temperature boundaries in °C. */
export const AMBIENT_COLD_C = 10;
export const AMBIENT_WARM_C = 25;
export const AMBIENT_HOT_C = 32;

/** Duration boundaries in seconds. */
export const DURATION_BOUNDARIES_S = [60, 1800, 7200, 43_200, 129_600] as const;

/** How far a value must move per window to count as moving at all, by kind. */
export const TREND_THRESHOLDS = {
  /** bar per minute. */
  pressure: { move: 0.05, sharp: 0.3 },
  /** °C per hour. */
  temperature: { move: 2, sharp: 6 },
  /**
   * A per minute. Only the moving threshold is given; `sharp` is set at
   * 1 A/min, which crosses the whole loaded band (5.19–6.25 A) inside a
   * minute and is therefore a step, not a drift.
   */
  current: { move: 0.2, sharp: 1 },
  /** A digital moves or it does not; any change over the window is a move. */
  digital: { move: Number.MIN_VALUE, sharp: Number.POSITIVE_INFINITY },
} as const satisfies Record<string, { move: number; sharp: number }>;

/** Which set of thresholds a role's slope is read against. */
const ROLE_TREND_KIND: Readonly<Record<SignalRole, keyof typeof TREND_THRESHOLDS>> = {
  tp2: "pressure",
  tp3: "pressure",
  h1: "pressure",
  dv_pressure: "pressure",
  reservoirs: "pressure",
  oil_temperature: "temperature",
  motor_current: "current",
  ambient_temperature: "temperature",
  comp: "digital",
  dv_electric: "digital",
  towers: "digital",
  mpg: "digital",
  lps: "digital",
  pressure_switch: "digital",
  oil_level: "digital",
  caudal_impulses: "digital",
};

/**
 * A standard deviation this many band widths wide reads as `erratic`,
 * unless the sensor's accuracy is wider still (see {@link erraticSpread}).
 */
export const ERRATIC_BAND_WIDTHS = 3;

/** Transitions in one window above which a digital reads as `erratic`. */
export const ERRATIC_TRANSITIONS = 4;

/** What else the trend of one signal depends on. */
export interface TrendContext {
  /** The state the window was measured in; an unknown state has no band. */
  readonly mode?: MachineMode;
  /** The standard deviation over the last five minutes, for `erratic`. */
  readonly stdDev?: number;
  /** The frozen guard holds: the logger repeats itself, the signal is `stuck`. */
  readonly frozen?: boolean;
  /** Transitions of a digital inside its window. */
  readonly transitions?: number;
}

const ANALOG_SET = new Set<string>(ANALOG_ROLES);
const DIGITAL_SET = new Set<string>(DIGITAL_ROLES);

/** True when the role is read as a number rather than as a boolean. */
export function isAnalogRole(role: SignalRole): boolean {
  return ANALOG_SET.has(role);
}

/**
 * Where `value` sits in a band: p5…p95 is normal, p1…p5 and p95…p99 are one
 * step out, beyond them is `far_*`. The cycle metrics and derived
 * behaviours read their band as it is; an analog signal reads it through
 * {@link resolvableBand}.
 */
export function levelInBand(band: Band, value: number): Level {
  if (value < band.p1) return "far_below_normal";
  if (value < band.p5) return "below_normal";
  if (value <= band.p95) return "normal";
  if (value <= band.p99) return "above_normal";
  return "far_above_normal";
}

/**
 * The first-month band of an analog signal as its instrument can tell it
 * apart: every edge moves outwards by the
 * sensor's accuracy, so a reading is above or below normal only when it
 * leaves p5…p95 by more than one accuracy unit, and far from normal only when
 * it passes p1 or p99 by more than one.
 */
function resolvableBand(role: MeasuredAnalogRole, mode: BandedMode): Band {
  const band = FIRST_MONTH_ANALOG_BANDS[role][mode];
  const accuracy = SENSOR_ACCURACY[role];
  return {
    p1: band.p1 - accuracy,
    p5: band.p5 - accuracy,
    p50: band.p50,
    p95: band.p95 + accuracy,
    p99: band.p99 + accuracy,
  };
}

/**
 * The 5-minute standard deviation above which an analog signal is `erratic`:
 * {@link ERRATIC_BAND_WIDTHS} widths of its first-month band, but never
 * less than the sensor's accuracy, so a spread the instrument cannot resolve
 * is never erratic.
 */
function erraticSpread(role: MeasuredAnalogRole, mode: BandedMode): number {
  const band = FIRST_MONTH_ANALOG_BANDS[role][mode];
  return Math.max(ERRATIC_BAND_WIDTHS * (band.p95 - band.p5), SENSOR_ACCURACY[role]);
}

/** The level of a cycle metric or derived behaviour. */
export function cycleLevel(metric: CycleMetric, value: number): Level {
  return levelInBand(FIRST_MONTH_CYCLE_BANDS[metric], value);
}

/**
 * The level of one signal in one state.
 *
 * An analog signal is read against its first-month band widened by the
 * sensor's accuracy ({@link resolvableBand}). Digitals have no percentiles,
 * so their level comes from how often the first month showed that value in
 * that state: a value seen in at least a fifth of those samples is ordinary,
 * one seen in fewer than one in a thousand is far from it (see
 * {@link FIRST_MONTH_DIGITAL_SHARE}).
 *
 * With an unknown state there is no band to compare against and the level is
 * `normal`: detection says nothing rather than inventing a deviation.
 */
export function level(role: SignalRole, mode: MachineMode, value: number): Level {
  if (mode === "unknown") return "normal";
  const banded: BandedMode = mode;

  if (role === "ambient_temperature") return ambientLevel(value);
  if (DIGITAL_SET.has(role)) {
    const share = FIRST_MONTH_DIGITAL_SHARE[role as DigitalRole][banded];
    const seen = value >= 0.5 ? share : 1 - share;
    if (seen >= DIGITAL_NORMAL_SHARE) return "normal";
    const rare = seen < DIGITAL_RARE_SHARE;
    if (value >= 0.5) return rare ? "far_above_normal" : "above_normal";
    return rare ? "far_below_normal" : "below_normal";
  }
  return levelInBand(resolvableBand(role as MeasuredAnalogRole, banded), value);
}

/**
 * The ambient temperature has no recorded band — the recording has no ambient
 * column at all — so its level is read off the same
 * boundaries as {@link ambientBucket}.
 */
function ambientLevel(celsius: number): Level {
  if (celsius < AMBIENT_COLD_C) return "below_normal";
  if (celsius <= AMBIENT_WARM_C) return "normal";
  if (celsius <= AMBIENT_HOT_C) return "above_normal";
  return "far_above_normal";
}

/**
 * How a signal is moving.
 *
 * `slope` is per minute for a pressure or a current and per hour for a
 * temperature — the units the trend thresholds are stated in. For a
 * digital it is the signed change of the 0/1 value over the window, so any
 * non-zero value is a transition in that direction.
 */
export function trend(role: SignalRole, slope: number, context: TrendContext = {}): Trend {
  if (context.frozen === true) return "stuck";

  const kind = ROLE_TREND_KIND[role];
  if (kind === "digital") {
    if ((context.transitions ?? 0) >= ERRATIC_TRANSITIONS) return "erratic";
    if (slope > 0) return "rising";
    if (slope < 0) return "falling";
    return "flat";
  }

  // The ambient temperature is the simulator's own signal and has no recorded
  // band, so it is never called erratic.
  if (
    context.stdDev !== undefined &&
    context.mode !== undefined &&
    context.mode !== "unknown" &&
    role !== "ambient_temperature"
  ) {
    if (context.stdDev > erraticSpread(role as MeasuredAnalogRole, context.mode)) return "erratic";
  }

  const { move, sharp } = TREND_THRESHOLDS[kind];
  if (Math.abs(slope) < move) return "flat";
  if (slope >= sharp) return "rising_sharply";
  if (slope <= -sharp) return "falling_sharply";
  return slope > 0 ? "rising" : "falling";
}

/** How long something has lasted, in words. */
export function duration(ms: number): Duration {
  const seconds = Math.max(0, ms) / 1000;
  const [minute, halfHour, twoHours, twelveHours, dayAndAHalf] = DURATION_BOUNDARIES_S;
  if (seconds < minute) return "seconds";
  if (seconds < halfHour) return "minutes";
  if (seconds < twoHours) return "about_an_hour";
  if (seconds < twelveHours) return "several_hours";
  if (seconds < dayAndAHalf) return "about_a_day";
  return "days";
}

/** The ambient bucket of a temperature in °C. */
export function ambientBucket(celsius: number | undefined): AmbientBucket {
  if (celsius === undefined || !Number.isFinite(celsius)) return "unknown";
  if (celsius < AMBIENT_COLD_C) return "cold";
  if (celsius <= AMBIENT_WARM_C) return "mild";
  if (celsius <= AMBIENT_HOT_C) return "warm";
  return "hot";
}

const LEVELS: readonly Level[] = [
  "far_below_normal",
  "below_normal",
  "normal",
  "above_normal",
  "far_above_normal",
];

const TRENDS: readonly Trend[] = [
  "rising_sharply",
  "rising",
  "flat",
  "falling",
  "falling_sharply",
  "stuck",
  "erratic",
];

const DURATIONS: readonly Duration[] = [
  "seconds",
  "minutes",
  "about_an_hour",
  "several_hours",
  "about_a_day",
  "days",
];

/** The three words, as one sentence fragment. */
export function bucketString(level: Level, trend: Trend, since: Duration): string {
  return [level, trend, since].map(words).join("; ");
}

/** What {@link bucketString} wrote, read back. */
export function parseBucket(bucket: string): { level: Level; trend: Trend; since: Duration } {
  const parts = bucket.split(";").map((part) => part.trim());
  if (parts.length !== 3) {
    throw new Error(`parseBucket: "${bucket}" is not "<level>; <trend>; <since>"`);
  }
  const [levelWords, trendWords, sinceWords] = parts as [string, string, string];
  return {
    level: lookup(LEVELS, levelWords, "level"),
    trend: lookup(TRENDS, trendWords, "trend"),
    since: lookup(DURATIONS, sinceWords, "duration"),
  };
}

/** The contract's coarser level enum (`common.schema.json`). */
export function toContractLevel(value: Level): LevelBucket {
  switch (value) {
    case "far_below_normal":
      return "far_below";
    case "below_normal":
      return "below";
    case "normal":
      return "normal";
    case "above_normal":
      return "above";
    case "far_above_normal":
      return "far_above";
  }
}

/** The contract's coarser trend enum; `*_sharply` is plain movement on the wire. */
export function toContractTrend(value: Trend): TrendBucket {
  switch (value) {
    case "rising_sharply":
    case "rising":
      return "rising";
    case "falling_sharply":
    case "falling":
      return "falling";
    case "flat":
      return "flat";
    case "stuck":
      return "stuck";
    case "erratic":
      return "erratic";
  }
}

/** `far_above_normal` → `far above normal`. */
function words(value: string): string {
  return value.replaceAll("_", " ");
}

function lookup<T extends string>(vocabulary: readonly T[], text: string, what: string): T {
  const match = vocabulary.find((value) => words(value) === text);
  if (match === undefined) throw new Error(`parseBucket: "${text}" is not a ${what}`);
  return match;
}
