// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * What "normal" means.
 *
 * Two baselines, because one is not enough. The **first month** (2020-02-01 →
 * 2020-02-28, 214,850 rows, no frozen block) is the reference the manual
 * talks about: its per-state percentiles are the constants below, each one
 * citing the table it comes from in `data/metropt3-first-month-stats.json`,
 * which `scripts/data/metropt3_stats.py` computes. They never move, so the
 * words a technician reads mean the same thing in February and in July.
 *
 * A **rolling** baseline sits beside it for the four metrics that drift with
 * the season — a normal July already cycles twice as often as February and
 * loses pressure twice as fast. Rule thresholds are
 * `max(absolute, k × rolling)`: the rolling term stops every
 * summer day from firing, the absolute floor stops a leak that grows over days
 * from raising its own baseline, and the cap of 2 × the first-month median,
 * together with the exclusion of cycles inside an open episode, limits how far
 * the rolling term can be dragged.
 *
 * Beside the bands sits what the instruments themselves can resolve, from the
 * manual's `machine.yaml`: a first-month band narrower than its sensor's
 * accuracy would otherwise turn sensor noise into a deviation.
 *
 * In-sample warning: these thresholds were chosen while looking at the
 * labelled failure windows, so every MetroPT-3 score is reported as in-sample
 * and tuning runs on the `dev` split, never on the core-10.
 */

import type { MachineMode } from "@fdp/contracts";

import type { AnalogRole, DigitalRole } from "./signals.ts";
import type { Cycle, RollingMedians } from "./types.ts";

/** The `baseline_ref` every suspect event carries. */
export const BASELINE_REF = "metropt3-first-month-2020-02";

/** A first-month percentile band; `normal` is p5 … p95. */
export interface Band {
  readonly p1: number;
  readonly p5: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

/** The three states a band is measured in; `unknown` has no band. */
export type BandedMode = Exclude<MachineMode, "unknown">;

/** The analog roles the recording has a column for; the ambient one is synthetic. */
export type MeasuredAnalogRole = Exclude<AnalogRole, "ambient_temperature">;

/**
 * Per-state percentiles of every recorded analog signal, first month.
 *
 * Source: `first_month.columns.<column>.<state>` of
 * `data/metropt3-first-month-stats.json`. n is 13,031 loaded, 48,717 unloaded
 * and 153,102 off rows.
 */
export const FIRST_MONTH_ANALOG_BANDS: Readonly<
  Record<MeasuredAnalogRole, Readonly<Record<BandedMode, Band>>>
> = {
  // TP2, discharge pressure: vented whenever the compressor is not loaded.
  tp2: {
    loaded: { p1: 0.0112, p5: 5.173, p50: 9.392, p95: 10.356, p99: 10.462 },
    unloaded: { p1: -0.024, p5: -0.02, p50: -0.01, p95: -0.008, p99: -0.006 },
    off: { p1: -0.016, p5: -0.014, p50: -0.012, p95: -0.008, p99: -0.008 },
  },
  // TP3, line pressure: the saw-tooth between cut-in 8.05 and cut-out 10.03.
  tp3: {
    loaded: { p1: 7.962, p5: 8.048, p50: 9.106, p95: 10.028, p99: 10.1074 },
    unloaded: { p1: 8.56, p5: 9.054, p50: 9.674, p95: 10.022, p99: 10.104 },
    off: { p1: 8.072, p5: 8.124, p50: 8.72, p95: 9.424, p99: 9.534 },
  },
  // H1, separator discharge: equal to the line unless the compressor is loaded.
  h1: {
    loaded: { p1: -0.028, p5: -0.024, p50: -0.014, p95: -0.008, p99: 0.0542 },
    unloaded: { p1: 8.508, p5: 9.03, p50: 9.658, p95: 10.014, p99: 10.096 },
    off: { p1: 8.06, p5: 8.112, p50: 8.706, p95: 9.408, p99: 9.518 },
  },
  // DV_pressure, dryer purge: just below zero in every state; 0.6–2.5 bar is
  // the dryer-side leak of signature A.
  dv_pressure: {
    loaded: { p1: -0.024, p5: -0.022, p50: -0.018, p95: -0.014, p99: -0.012 },
    unloaded: { p1: -0.024, p5: -0.022, p50: -0.018, p95: -0.014, p99: -0.01 },
    off: { p1: -0.024, p5: -0.022, p50: -0.018, p95: -0.014, p99: -0.012 },
  },
  // Reservoirs: tracks the line to within a couple of millibar.
  reservoirs: {
    loaded: { p1: 7.964, p5: 8.05, p50: 9.106, p95: 10.026, p99: 10.104 },
    unloaded: { p1: 8.5623, p5: 9.0576, p50: 9.676, p95: 10.022, p99: 10.104 },
    off: { p1: 8.076, p5: 8.128, p50: 8.722, p95: 9.426, p99: 9.536 },
  },
  // Oil temperature: a normal summer day already reaches p95 71–76 °C, which
  // is why the oil rules use absolute thresholds and not this band alone.
  oil_temperature: {
    loaded: { p1: 46.4, p5: 48.725, p50: 55.175, p95: 60.4125, p99: 63.25 },
    unloaded: { p1: 47.25, p5: 51.575, p50: 58.4, p95: 63.625, p99: 65.725 },
    off: { p1: 47.625, p5: 50.05, p50: 56.325, p95: 60.2, p99: 62.175 },
  },
  // Motor current: about 6 A loaded, not the 7 A of the dataset description.
  motor_current: {
    loaded: { p1: 4.7675, p5: 5.19, p50: 6.005, p95: 6.25, p99: 6.3175 },
    unloaded: { p1: 3.65, p5: 3.68, p50: 3.7725, p95: 3.955, p99: 4.0325 },
    off: { p1: 0.0325, p5: 0.035, p50: 0.0375, p95: 0.04, p99: 0.0425 },
  },
};

/**
 * What each analog instrument can resolve, in the signal's own unit.
 *
 * Source: `sensors[].accuracy` of `manual/spec/machine.yaml`. A percent
 * accuracy is a share of the instrument's range span (`range.max −
 * range.min`), so the five pressure transducers of −1…16 bar resolve 0.5 % of
 * 17 bar. As with the bands, the numbers are transcribed and the YAML is never
 * read at runtime; `baseline.test.ts` reads the file back and
 * compares.
 *
 * `buckets.ts` widens every analog level band by this much and never calls a
 * spread narrower than it erratic. The ambient entry completes the table but
 * widens nothing: the ambient Level is read off fixed word boundaries, not off a band.
 */
export const SENSOR_ACCURACY: Readonly<Record<AnalogRole, number>> = {
  // discharge_pressure: pressure transducer, −1…16 bar, 0.5 % → 0.005 × 17 bar.
  tp2: 0.085,
  // line_pressure: pressure transducer, −1…16 bar, 0.5 %.
  tp3: 0.085,
  // separator_discharge_pressure: pressure transducer, −1…16 bar, 0.5 %.
  h1: 0.085,
  // dryer_purge_pressure: pressure transducer, −1…16 bar, 0.5 % — over ten times
  // the 8 mbar its first-month band spans in every state.
  dv_pressure: 0.085,
  // reservoir_pressure: pressure transducer, −1…16 bar, 0.5 %.
  reservoirs: 0.085,
  // oil_temperature: resistance thermometer, −20…120 °C, 1 °C.
  oil_temperature: 1,
  // motor_current: current transformer, 0…20 A, 2 % → 0.02 × 20 A.
  motor_current: 0.4,
  // ambient_temperature: resistance thermometer, −20…60 °C, 1 °C.
  ambient_temperature: 1,
};

/**
 * How often each digital read true per state in the first month.
 *
 * Source: the `mean` of `first_month.columns.<column>.<state>`; a digital is
 * stored as 0/1, so the mean is the share of samples that read true. A boolean
 * has no percentile band, so `buckets.ts` reads a level off these shares:
 * a value seen in at least a fifth of the first-month samples of that state is
 * normal, one seen in fewer than one in a thousand is far from normal.
 *
 * `towers` while loaded is the interesting row: the dryer pulses its tower
 * over during every loaded run, so both values are ordinary there (mean 0.501)
 * while a 0 in any other state is not.
 */
export const FIRST_MONTH_DIGITAL_SHARE: Readonly<
  Record<DigitalRole, Readonly<Record<BandedMode, number>>>
> = {
  comp: { loaded: 0, unloaded: 1, off: 1 },
  dv_electric: { loaded: 1, unloaded: 0, off: 0 },
  towers: { loaded: 0.501, unloaded: 1, off: 1 },
  mpg: { loaded: 0, unloaded: 1, off: 1 },
  lps: { loaded: 0.0001, unloaded: 0, off: 0 },
  pressure_switch: { loaded: 0.996, unloaded: 0.9977, off: 1 },
  oil_level: { loaded: 1, unloaded: 1, off: 1 },
  caudal_impulses: { loaded: 1, unloaded: 1, off: 1 },
};

/** A value this common in the first month is ordinary (`buckets.ts`). */
export const DIGITAL_NORMAL_SHARE = 0.2;

/** A value rarer than this was never really seen; `far_*` rather than `above`. */
export const DIGITAL_RARE_SHARE = 0.001;

/** The cycle metrics and derived behaviours that carry a first-month band. */
export type CycleMetric =
  | "loaded_s"
  | "unloaded_s"
  | "off_s"
  | "nonloaded_s"
  | "cutin_tp3"
  | "cutout_tp3"
  | "decay_bar_per_min"
  | "rise_bar_per_min"
  | "motor_current_loaded"
  | "start_current_peak"
  | "tp2_minus_tp3_loaded"
  | "dv_pressure_loaded"
  | "towers_pulse_s"
  | "cycles_per_hour";

/**
 * Per-cycle percentiles of the first month.
 *
 * Source: `first_month.cycles.<metric>` of the statistics JSON (1,134 clean
 * cycles). Three rows are derived rather than
 * read, because the generator does not publish them; each says how.
 */
export const FIRST_MONTH_CYCLE_BANDS: Readonly<Record<CycleMetric, Band>> = {
  // cycles.loaded_s — median 109 s, max 248 s.
  loaded_s: { p1: 99, p5: 99, p50: 109, p95: 129, p99: 149 },
  // cycles.unloaded_s — the fixed run-on timer, about seven minutes.
  unloaded_s: { p1: 392.6, p5: 406, p50: 407, p95: 417, p99: 417 },
  // cycles.off_s — 13 of 1,134 cycles have no off phase at all.
  off_s: { p1: 131, p5: 417, p50: 1329, p95: 2041, p99: 2191 },
  // cycles.nonloaded_s — cut-out to the next cut-in.
  nonloaded_s: { p1: 417, p5: 793, p50: 1744, p95: 2458, p99: 2617 },
  // cycles.cutin_tp3_bar — the controller loads below 8.2 bar.
  cutin_tp3: { p1: 7.846, p5: 7.9593, p50: 8.05, p95: 8.07, p99: 8.0793 },
  // cycles.cutout_tp3_bar.
  cutout_tp3: { p1: 9.92, p5: 9.9433, p50: 10.034, p95: 10.122, p99: 10.1407 },
  // cycles.drop_rate_nonloaded_bar_per_min — July normal is 0.11–0.16, which
  // is why `fast_decay` also scales with the rolling median.
  decay_bar_per_min: { p1: 0.0442, p5: 0.0482, p50: 0.069, p95: 0.1491, p99: 0.288 },
  // Derived: the build-up rate a cycle implies, (cutout − cutin) / loaded_s,
  // pairing each percentile with the one that makes the rate extreme
  // (p1 = slowest: lowest cut-out, highest cut-in, longest run). The
  // recording's median is about 1.1 bar/min.
  rise_bar_per_min: { p1: 0.7412, p5: 0.8713, p50: 1.0921, p95: 1.3107, p99: 1.3907 },
  // cycles.motor_current_loaded_A.
  motor_current_loaded: { p1: 4.7675, p5: 5.19, p50: 6.005, p95: 6.25, p99: 6.3175 },
  // Derived: the recording has no start-peak percentiles. p1 and p5 are the
  // loaded p5 and p50 (a start that barely peaks), p95 is the highest current
  // of the first month (8.2925 A, cycles.motor_current_loaded_A.max) and p99
  // the manual's start-peak rating of 9.5 A; p50 is their
  // midpoint. A peak above p99 is one the manual itself calls abnormal.
  start_current_peak: { p1: 5.19, p5: 6.005, p50: 7.25, p95: 8.2925, p99: 9.5 },
  // cycles.tp2_minus_tp3_loaded_bar — the low percentiles are the first
  // samples of a run, before the discharge side has built up.
  tp2_minus_tp3_loaded: { p1: -8.036, p5: -2.87, p50: 0.322, p95: 0.42, p99: 0.438 },
  // cycles.dv_pressure_loaded_bar.
  dv_pressure_loaded: { p1: -0.024, p5: -0.022, p50: -0.018, p95: -0.014, p99: -0.012 },
  // cycles.towers0_per_cycle_s — the changeover pulse after cut-in.
  towers_pulse_s: { p1: 40, p5: 40, p50: 60, p95: 60, p99: 80 },
  // Derived: cycles.cycles_per_day divided by 24, because the frame measures
  // the rate over a window and not cycle by cycle. The February mean is 41.6
  // cycles a day, 1.97 an hour; a normal June–August day runs
  // at 3.0–3.9 an hour and therefore reads above this band on purpose — the
  // words stay first-month-relative, the rules scale with the rolling median.
  cycles_per_hour: { p1: 1.125, p5: 1.1979, p50: 1.75, p95: 2.1646, p99: 2.3604 },
};

/** The first month's own cycle rate, `first_month.cycles.cycles_per_hour`. */
export const FIRST_MONTH_CYCLES_PER_HOUR = 1.968;

/**
 * How many load cycles began in each hour of the day over the first month,
 * index 0 being 00:00–00:59 of the data clock.
 *
 * Source: `first_month.cycles.cycles_by_hour_of_day_total` of the statistics
 * JSON (1,165 cycles over 28 days, counted by the hour of their cut-in on the
 * dataset clock the replay keeps). Each cycle delivers the same
 * volume, cut-in to cut-out, so the count is how much air the plant drew in
 * that hour of the day. `quiet-hours.ts` reads the unit's quiet hours off it.
 */
export const FIRST_MONTH_CYCLES_BY_HOUR: readonly number[] = [
  33, 25, 23, 22, 28, 54, 50, 62, 54, 57, 48, 55, 55, 51, 57, 61, 67, 65, 56, 53, 46, 51, 45, 47,
];

/** The metrics that also get a rolling baseline. */
export type RollingMetric = "decay_bar_per_min" | "cycles_per_hour" | "loaded_run_s" | "off_s";

/** Absolute floors of the rules that scale with a rolling median. */
export const ABSOLUTE_THRESHOLD: Readonly<Record<RollingMetric, number>> = {
  decay_bar_per_min: 0.25,
  cycles_per_hour: 5,
  loaded_run_s: 200,
  // The off phase is the one threshold with no rolling term; the
  // median of the last five cycles is compared with this floor directly.
  off_s: 250,
};

/** How far above the rolling median a rule fires. */
export const ROLLING_FACTOR: Readonly<Record<RollingMetric, number>> = {
  decay_bar_per_min: 2.0,
  cycles_per_hour: 1.8,
  loaded_run_s: 1.5,
  off_s: 1.0,
};

/** Each metric's first-month median; a rolling median is capped at twice this value. */
export const ROLLING_CAP_BASE: Readonly<Record<RollingMetric, number>> = {
  decay_bar_per_min: FIRST_MONTH_CYCLE_BANDS.decay_bar_per_min.p50,
  cycles_per_hour: FIRST_MONTH_CYCLES_PER_HOUR,
  loaded_run_s: FIRST_MONTH_CYCLE_BANDS.loaded_s.p50,
  off_s: FIRST_MONTH_CYCLE_BANDS.off_s.p50,
};

/**
 * The threshold a rule compares against: `max(absolute, k × rolling)`.
 * Without a rolling median the absolute floor stands alone.
 */
export function ruleThreshold(metric: RollingMetric, rolling: number | undefined): number {
  const absolute = ABSOLUTE_THRESHOLD[metric];
  if (rolling === undefined) return absolute;
  return Math.max(absolute, ROLLING_FACTOR[metric] * rolling);
}

/** How long the rolling window reaches back, in sim hours. */
export const ROLLING_WINDOW_H = 48;

/** Fewer closed cycles than this and the rolling median stays undefined. */
export const ROLLING_MIN_CYCLES = 20;

/** The median of the recent closed cycles, capped and episode-free. */
export interface RollingBaseline {
  /** Take one closed cycle; cycles inside an open episode are dropped. */
  add(cycle: Cycle, insideEpisode: boolean): void;
  /** The capped median, or undefined below {@link ROLLING_MIN_CYCLES} cycles. */
  median(metric: RollingMetric): number | undefined;
  /** Every metric at once, for the feature frame. */
  medians(): RollingMedians;
  /** Cycles inside the window. */
  size(): number;
  /** A new segment starts: the window holds nothing. */
  reset(): void;
}

interface RollingEntry {
  readonly endSimTsMs: number;
  readonly values: Readonly<Partial<Record<RollingMetric, number>>>;
}

/** A rolling baseline over the last {@link ROLLING_WINDOW_H} sim hours. */
export function createRollingBaseline(
  options: { windowSimHours?: number; minCycles?: number } = {},
): RollingBaseline {
  const windowMs = (options.windowSimHours ?? ROLLING_WINDOW_H) * 3_600_000;
  const minCycles = options.minCycles ?? ROLLING_MIN_CYCLES;
  let entries: RollingEntry[] = [];

  function valuesOf(cycle: Cycle): Partial<Record<RollingMetric, number>> {
    const values: Partial<Record<RollingMetric, number>> = {
      loaded_run_s: cycle.loaded_s,
      off_s: cycle.off_s,
    };
    if (cycle.decay_bar_per_min !== undefined) values.decay_bar_per_min = cycle.decay_bar_per_min;
    if (cycle.period_s > 0) values.cycles_per_hour = 3600 / cycle.period_s;
    return values;
  }

  function sorted(metric: RollingMetric): number[] {
    const values: number[] = [];
    for (const entry of entries) {
      const value = entry.values[metric];
      if (value !== undefined) values.push(value);
    }
    return values.sort((left, right) => left - right);
  }

  function cappedMedian(metric: RollingMetric): number | undefined {
    const values = sorted(metric);
    if (values.length < minCycles) return undefined;
    const middle = values.length >> 1;
    const upper = values[middle] as number;
    const value = values.length % 2 === 1 ? upper : ((values[middle - 1] as number) + upper) / 2;
    // The cap is what keeps a leak that grows over days from lifting its own
    // threshold out of reach.
    return Math.min(value, 2 * ROLLING_CAP_BASE[metric]);
  }

  return {
    add(cycle: Cycle, insideEpisode: boolean): void {
      if (insideEpisode) return;
      entries.push({ endSimTsMs: cycle.end_sim_ts_ms, values: valuesOf(cycle) });
      const oldest = cycle.end_sim_ts_ms - windowMs;
      entries = entries.filter((entry) => entry.endSimTsMs >= oldest);
    },

    median: cappedMedian,

    medians(): RollingMedians {
      return {
        decay_bar_per_min: cappedMedian("decay_bar_per_min"),
        cycles_per_hour: cappedMedian("cycles_per_hour"),
        loaded_run_s: cappedMedian("loaded_run_s"),
        off_s: cappedMedian("off_s"),
      };
    },

    size(): number {
      return entries.length;
    },

    reset(): void {
      entries = [];
    },
  };
}
