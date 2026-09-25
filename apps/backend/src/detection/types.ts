// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The vocabulary of `detection/`.
 *
 * Detection turns a stream of samples into words: a machine state, a handful
 * of guards, closed cycles, one feature frame and the observations the
 * decision backend reads. Everything the modules of this directory hand each
 * other is declared here, so the rules and the decision state builder
 * have one file to read.
 *
 * Two vocabularies meet in this file and must not be confused:
 *
 *   * the **internal** words — {@link Level}, {@link Trend}, {@link Duration} —
 *     are the ones `buckets.ts` defines, and they are finer than the
 *     contract's: `rising_sharply` and `rising` are two internal words for one
 *     contract `rising`;
 *   * the **contract** words are the enums of `common.schema.json`
 *     (`level_bucket`, `trend_bucket`, `ambient_bucket`). Everything that
 *     leaves the process is one of those; `buckets.ts` maps internal to
 *     contract, never the other way round.
 */

import type { MachineMode, SeverityLevel } from "@fdp/contracts";

import type { SignalRole } from "./signals.ts";

export type { MachineMode } from "@fdp/contracts";

/** Why the windows were cleared. */
export type ResetReason = "discontinuity" | "frozen" | "startup";

/**
 * The four conditions that run before any rule.
 *
 * `discontinuity` is an event — true on the one sample that follows the jump —
 * while the other three are states that hold for as long as their condition
 * does.
 */
export interface Guards {
  /** The sample follows a gap, a jump or a restart. */
  readonly discontinuity: boolean;
  /** The logger repeated the same five analog values for at least 60 samples. */
  readonly frozen: boolean;
  /** The motor is off and the line is vented: a depot stop, not a fault. */
  readonly parked: boolean;
  /** Fewer than 30 samples since the last reset. */
  readonly warmup: boolean;
}

/**
 * One closed load cycle: cut-in to the next cut-in.
 *
 * A metric is undefined when the cycle did not hold enough samples to compute
 * it — a cycle cut short by a gap keeps the fields it can support and no more.
 */
export interface Cycle {
  readonly cutin_sim_ts: string;
  readonly cutin_sim_ts_ms: number;
  /** When the machine left `loaded`. */
  readonly cutout_sim_ts: string;
  readonly cutout_sim_ts_ms: number;
  /** The next cut-in, which is what closed this cycle. */
  readonly end_sim_ts_ms: number;
  readonly loaded_s: number;
  readonly unloaded_s: number;
  readonly off_s: number;
  readonly nonloaded_s: number;
  /** Cut-in to cut-in; `3600 / period_s` is the cycle's own rate per hour. */
  readonly period_s: number;
  readonly cutin_tp3: number | undefined;
  readonly cutout_tp3: number | undefined;
  /** The loaded run ended at the cut-out pressure (tp3 ≥ 9.8 bar). */
  readonly cut_out_reached: boolean;
  /** Least-squares fall of tp3 over the non-loaded interval, positive downwards. */
  readonly decay_bar_per_min: number | undefined;
  /** Least-squares rise of tp3 over the loaded run, positive upwards. */
  readonly rise_bar_per_min: number | undefined;
  readonly tp2_minus_tp3_loaded: number | undefined;
  readonly motor_current_loaded: number | undefined;
  readonly start_current_peak: number | undefined;
  readonly dv_pressure_loaded: number | undefined;
  readonly dv_pressure_loaded_max: number | undefined;
  /** The dryer pulsed its tower over for at least 20 s within 120 s of cut-in. */
  readonly towers_pulse: boolean;
  /** Seconds after cut-out until the separator pressure came back to the line. */
  readonly h1_return_s: number | undefined;
  readonly oil_max: number | undefined;
}

/** The cycle in progress. */
export interface CurrentRun {
  readonly mode: MachineMode;
  readonly mode_since_sim_ts: string;
  readonly mode_for_s: number;
  /** Undefined until the first cut-in of the segment. */
  readonly cutin_sim_ts: string | undefined;
  /** Undefined while the run is still loaded. */
  readonly cutout_sim_ts: string | undefined;
  readonly loaded_s: number;
  readonly nonloaded_s: number;
  readonly cutin_tp3: number | undefined;
  readonly cutout_tp3: number | undefined;
  readonly start_current_peak: number | undefined;
  readonly towers_pulse: boolean;
  /** Undefined while the separator has not come back to the line yet. */
  readonly h1_return_s: number | undefined;
  readonly samples: number;
}

/** Where a value sits in its first-month band. */
export type Level =
  "far_below_normal" | "below_normal" | "normal" | "above_normal" | "far_above_normal";

/** How a value is moving over its window. */
export type Trend =
  "rising_sharply" | "rising" | "flat" | "falling" | "falling_sharply" | "stuck" | "erratic";

/** How long a situation has lasted. */
export type Duration =
  "seconds" | "minutes" | "about_an_hour" | "several_hours" | "about_a_day" | "days";

/** What the number behind an observation is. */
export type Stat = "last" | "median" | "min" | "max" | "slope" | "rate" | "duration" | "flag";

/**
 * A per-cycle behaviour over the last day, judged apart in the unit's quiet
 * hours and in the other, busy hours (`quiet-hours.ts`).
 *
 * Each level is read against the same first-month band as the behaviour's
 * own level; `undefined` means too few cycles of that kind to say.
 */
export interface ByHours {
  readonly quiet: Level | undefined;
  readonly busy: Level | undefined;
}

/**
 * One signal or derived behaviour, as detection reads it.
 *
 * `label`, `value` and `unit` are for the ticket and the UI; the decision
 * backend sees `level`, `trend` and `since`.
 */
export interface Observation {
  readonly signal_id: string;
  readonly label: string;
  readonly level: Level;
  readonly trend: Trend;
  readonly since: Duration;
  readonly stat: Stat;
  readonly value: number;
  readonly unit: string;
  readonly window_s: number;
  readonly mode: MachineMode;
  /** Only on `unloaded_pressure_decay`, once the last day holds enough cycles. */
  readonly by_hours?: ByHours;
}

/**
 * One signal of the feature frame.
 *
 * The frame carries the whole register map, not only the signals the rules
 * read, because `observations()` emits one observation per
 * role and must read them all from the frame alone.
 */
export interface SignalFeature {
  readonly role: SignalRole;
  readonly signal_id: string;
  readonly label: string;
  readonly unit: string;
  readonly stat: Stat;
  /** Digitals are 0 or 1, so one field carries both kinds. */
  readonly value: number;
  readonly level: Level;
  readonly trend: Trend;
  /** How long the level has held, in sim seconds. */
  readonly since_s: number;
  readonly window_s: number;
}

/**
 * The derived behaviours of the manual's signal registry.
 *
 * They are observations like any signal: the catalog's `signal_moves` name
 * them, so retrieval and the decision backend read them the same way.
 */
export const BEHAVIOUR_IDS = [
  "load_cycle_rate",
  "loaded_run_duration",
  "unloaded_pressure_decay",
  "cut_out_reached",
  "pressure_rise_while_loaded",
  "start_current_peak",
] as const;

export type BehaviourId = (typeof BEHAVIOUR_IDS)[number];

/** One derived behaviour of the frame, bucketed like a signal. */
export interface BehaviourFeature {
  readonly id: BehaviourId;
  readonly label: string;
  readonly unit: string;
  readonly stat: Stat;
  /** Undefined until the window or the cycle history can answer. */
  readonly value: number | undefined;
  readonly level: Level;
  readonly trend: Trend;
  readonly since_s: number;
  readonly window_s: number;
  /** The quiet-hours and busy-hours levels (`quiet-hours.ts`); decay only. */
  readonly by_hours?: ByHours;
}

/** The medians of the rolling baselines the thresholds scale with. */
export interface RollingMedians {
  readonly decay_bar_per_min: number | undefined;
  readonly cycles_per_hour: number | undefined;
  readonly loaded_run_s: number | undefined;
  readonly off_s: number | undefined;
}

/**
 * Everything a rule may read.
 *
 * A field is `undefined` when its window is too short to answer — never a
 * zero, so a rule that compares a missing value against a threshold does not
 * fire on an empty window.
 */
export interface FeatureFrame {
  readonly sim_ts: string;
  readonly sim_ts_ms: number;
  /** The samples the frame was computed from. */
  readonly window: {
    readonly from_sim_ts: string;
    readonly to_sim_ts: string;
    readonly samples: number;
  };

  readonly mode: MachineMode;
  readonly mode_since_sim_ts: string;
  readonly mode_for_s: number;
  /** 1 or 2 from the `towers` signal, null before the first sample carries it. */
  readonly dryer_tower: 1 | 2 | null;

  readonly loaded_run_s: number | undefined;
  readonly tp3_slope_bar_per_min: number | undefined;

  readonly cycles_per_hour: number | undefined;

  readonly loaded_run_median_s: number | undefined;
  readonly off_median_s: number | undefined;
  readonly decay_median: number | undefined;
  readonly long_runs_in_last5: number;
  readonly fast_decays_in_row: number;

  readonly dv_pressure_loaded_consecutive_gt: number;

  readonly oil_c: number | undefined;
  readonly oil_30min_min_c: number | undefined;
  readonly oil_trend_c_per_h: number | undefined;

  readonly motor_current_loaded_a: number | undefined;
  readonly tp2_minus_tp3_loaded: number | undefined;

  readonly towers_pulse_missing_cycles: number;
  readonly h1_return_s: number | undefined;

  readonly reservoirs_minus_tp3: number | undefined;

  readonly lps_active_s: number;
  readonly oil_level_low_s: number;
  readonly caudal_stuck_s: number;

  readonly ambient_c: number | undefined;
  readonly ambient_bucket: "cold" | "mild" | "warm" | "hot" | "unknown";
  readonly active_alarms: readonly string[];

  /** Every signal in register order, bucketed. */
  readonly signals: Readonly<Record<SignalRole, SignalFeature>>;
  /** The six derived behaviours, bucketed the same way. */
  readonly behaviours: Readonly<Record<BehaviourId, BehaviourFeature>>;
  /** The rolling medians the drift-prone thresholds scale with. */
  readonly rolling: RollingMedians;
  readonly guards: Guards;
}

/** One firing rule; the registry itself lives in `rules/`. */
export interface RuleHit {
  readonly rule_id: string;
  readonly symptom_key: string;
  readonly severity_hint: SeverityLevel;
  readonly since_sim_ts: string;
  readonly value?: number;
  readonly threshold?: number;
  readonly unit?: string;
  /** One plain sentence; the ticket carries it verbatim as evidence. */
  readonly detail: string;
}
