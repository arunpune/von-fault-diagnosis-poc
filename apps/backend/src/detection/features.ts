// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The feature frame and the observations.
 *
 * The engine takes samples in sim order and keeps the smallest window that
 * answers every question the frame asks — two hours, because the oil trend needs
 * them — with no assumption about the spacing between samples: every window is
 * keyed by `sim_ts` and every rate is per minute or per hour, never per
 * sample. It owns nothing else: the machine state and
 * the guards come from `state.ts`, the cycles from `cycles.ts`, the bands from
 * `baseline.ts` and the words from `buckets.ts`.
 *
 * It deliberately does not import `ingest/`. The ring buffer there serves the
 * chart API and holds a week of samples in typed arrays; detection needs two
 * hours of a handful of signals and must run identically inside `tools/eval`,
 * where no ring exists.
 *
 * A frame is recomputed when the machine changes state and on every sim-minute
 * boundary, so `since` has minute resolution — which is all the
 * duration words need.
 */

import type { MachineMode, Observation as ContractObservation, Sample } from "@fdp/contracts";

import {
  FIRST_MONTH_CYCLE_BANDS,
  createRollingBaseline,
  ruleThreshold,
  type CycleMetric,
  type RollingBaseline,
} from "./baseline.ts";
import {
  ambientBucket,
  cycleLevel,
  duration,
  level,
  toContractLevel,
  toContractTrend,
  trend,
} from "./buckets.ts";
import {
  createCycleTracker,
  median,
  slopePerMinute,
  type CycleTracker,
  type Point,
} from "./cycles.ts";
import {
  analogValue,
  digitalValue,
  SIGNAL_ROLES,
  type SignalRole,
  type SignalRoles,
} from "./signals.ts";
import { createDecayByHours, type DecayByHours } from "./quiet-hours.ts";
import { createGuardTracker, machineMode, type GuardTracker } from "./state.ts";
import { BEHAVIOUR_IDS } from "./types.ts";
import type {
  BehaviourFeature,
  BehaviourId,
  ByHours,
  CurrentRun,
  Cycle,
  Duration,
  FeatureFrame,
  Guards,
  Level,
  Observation,
  ResetReason,
  SignalFeature,
  Stat,
  Trend,
} from "./types.ts";

/** How far back the engine keeps samples: the oil trend's two hours plus slack. */
export const WINDOW_MS = 2 * 3_600_000 + 60_000;

/** A hard cap on the retained samples, whatever the replay speed. */
export const MAX_WINDOW_SAMPLES = 8192;

/** The window a value and its spread are read over. */
export const VALUE_WINDOW_S = 60;

/** The window a pressure or a current slope is read over. */
export const SLOPE_WINDOW_S = 300;

/** The window a temperature trend is read over. */
export const TEMPERATURE_WINDOW_S = 7200;

/** The temperature trend needs this many samples to mean anything. */
export const TEMPERATURE_MIN_SAMPLES = 60;

/** The oil minimum is taken over this window. */
export const OIL_MIN_WINDOW_S = 1800;

/** The cycle rate is measured over this window. */
export const CYCLE_RATE_WINDOW_S = 7200;

/** The reservoir difference is a median over this window. */
export const RESERVOIR_WINDOW_S = 300;

/** Dryer purge pressure above this is the drain-side leak of signature A. */
export const DV_PRESSURE_HIGH_BAR = 0.5;

/** Cycles the tower-pulse counter looks back over. */
export const TOWER_PULSE_LOOKBACK_CYCLES = 3;

/** Cycles the frame's medians are taken over. */
export const CYCLE_MEDIAN_CYCLES = 5;

/** A slope needs at least this many points, whatever window it covers. */
const MIN_SLOPE_POINTS = 3;

/** The window an observed start peak covers: the first seconds of the run. */
export const START_PEAK_OBSERVATION_WINDOW_S = 30;

/**
 * What the run in progress says about the separator, or undefined while it has
 * not cut out yet and the question does not apply.
 */
function runH1ReturnS(run: CurrentRun | undefined, nowMs: number): number | undefined {
  if (run?.cutout_sim_ts === undefined) return undefined;
  if (run.h1_return_s !== undefined) return run.h1_return_s;
  return Math.max(0, (nowMs - Date.parse(run.cutout_sim_ts)) / 1000);
}

/** What one sample did. */
export interface FeatureUpdate {
  readonly mode: MachineMode;
  readonly guards: Guards;
  /** Set when this sample recomputed the frame (state change or sim minute). */
  readonly frame: FeatureFrame | undefined;
  /** Set when this sample closed a cycle. */
  readonly closed: Cycle | undefined;
  /** Set when this sample cleared the windows. */
  readonly reset: ResetReason | undefined;
}

/** The numeric half of detection, for one stream of samples. */
export interface FeatureEngine {
  /** Fold one sample in; samples arrive in sim order. */
  push(sample: Sample): FeatureUpdate;
  /** The most recent frame, or undefined before the first one. */
  frame(): FeatureFrame | undefined;
  /** The closed cycles of this segment. */
  cycles(): readonly Cycle[];
  /** The rolling baseline, so the rules can read a median directly. */
  baseline(): RollingBaseline;
  /** Clear every window; the next frame starts from nothing. */
  reset(reason: ResetReason): void;
}

export interface FeatureEngineOptions {
  readonly roles: SignalRoles;
  /**
   * Whether an episode is open right now. Cycles closed inside one do not
   * feed the rolling baseline, so a leak cannot raise its own threshold.
   * The default is "no episode", which is what `tools/eval` and
   * the unit tests want.
   */
  readonly insideEpisode?: () => boolean;
}

interface WindowSample {
  readonly simTsMs: number;
  readonly mode: MachineMode;
  readonly values: Partial<Record<SignalRole, number>>;
  readonly alarms: readonly string[];
}

interface LevelSince {
  level: Level;
  sinceMs: number;
}

/** The engine for one stream of samples. */
export function createFeatureEngine(options: FeatureEngineOptions): FeatureEngine {
  const { roles } = options;
  const insideEpisode = options.insideEpisode ?? ((): boolean => false);

  const guardTracker: GuardTracker = createGuardTracker(roles);
  const cycleTracker: CycleTracker = createCycleTracker(roles);
  const rolling: RollingBaseline = createRollingBaseline();
  // The last day's decay by hour class outlives the guards' resets and ages
  // out by sim time instead (`quiet-hours.ts`): a gap does not unmake a cycle
  // measured before it, and the gaps fall mostly in the quiet hours.
  const decayByHours: DecayByHours = createDecayByHours();

  let window: WindowSample[] = [];
  let lastMode: MachineMode = "unknown";
  let modeSinceMs: number | undefined;
  let lastMinute: number | undefined;
  let guards: Guards = { discontinuity: false, frozen: false, parked: false, warmup: true };
  let current: FeatureFrame | undefined;

  const levelSince = new Map<string, LevelSince>();
  let lpsSinceMs: number | undefined;
  let oilLowSinceMs: number | undefined;
  let caudalLastValue: number | undefined;
  let caudalChangedMs: number | undefined;
  let dvConsecutive = 0;

  function clearWindows(): void {
    window = [];
    cycleTracker.reset();
    rolling.reset();
    levelSince.clear();
    modeSinceMs = undefined;
    lastMinute = undefined;
    lpsSinceMs = undefined;
    oilLowSinceMs = undefined;
    caudalLastValue = undefined;
    caudalChangedMs = undefined;
    dvConsecutive = 0;
    current = undefined;
  }

  function read(sample: Sample): Partial<Record<SignalRole, number>> {
    const values: Partial<Record<SignalRole, number>> = {};
    for (const role of SIGNAL_ROLES) {
      const binding = roles[role];
      if (binding.analog) {
        const value = analogValue(sample, binding);
        if (value !== undefined) values[role] = value;
      } else {
        const value = digitalValue(sample, binding);
        if (value !== undefined) values[role] = value ? 1 : 0;
      }
    }
    return values;
  }

  /** The samples of the window no older than `seconds` before `nowMs`. */
  function since(nowMs: number, seconds: number): WindowSample[] {
    const fromMs = nowMs - seconds * 1000;
    const first = window.findIndex((entry) => entry.simTsMs >= fromMs);
    return first === -1 ? [] : window.slice(first);
  }

  function seriesOf(samples: readonly WindowSample[], role: SignalRole, baseMs: number): Point[] {
    const points: Point[] = [];
    for (const entry of samples) {
      const value = entry.values[role];
      if (value !== undefined) points.push({ t: (entry.simTsMs - baseMs) / 1000, v: value });
    }
    return points;
  }

  function valuesOf(
    samples: readonly WindowSample[],
    role: SignalRole,
    mode?: MachineMode,
  ): number[] {
    const values: number[] = [];
    for (const entry of samples) {
      if (mode !== undefined && entry.mode !== mode) continue;
      const value = entry.values[role];
      if (value !== undefined) values.push(value);
    }
    return values;
  }

  function latest(role: SignalRole): number | undefined {
    for (let index = window.length - 1; index >= 0; index -= 1) {
      const value = (window[index] as WindowSample).values[role];
      if (value !== undefined) return value;
    }
    return undefined;
  }

  function standardDeviation(values: readonly number[]): number | undefined {
    if (values.length < 2) return undefined;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  function transitionsOf(samples: readonly WindowSample[], role: SignalRole): number {
    let transitions = 0;
    let previous: number | undefined;
    for (const entry of samples) {
      const value = entry.values[role];
      if (value === undefined) continue;
      if (previous !== undefined && value !== previous) transitions += 1;
      previous = value;
    }
    return transitions;
  }

  /** Remember when a level last changed, so `since` is a real duration. */
  function sinceSeconds(key: string, value: Level, nowMs: number): number {
    const held = levelSince.get(key);
    if (held === undefined || held.level !== value) {
      levelSince.set(key, { level: value, sinceMs: nowMs });
      return 0;
    }
    return (nowMs - held.sinceMs) / 1000;
  }

  function signalFeature(role: SignalRole, nowMs: number, mode: MachineMode): SignalFeature {
    const binding = roles[role];
    const valueWindow = since(nowMs, VALUE_WINDOW_S);
    const last = latest(role);

    if (!binding.analog) {
      const value = last ?? 0;
      const points = seriesOf(valueWindow, role, nowMs);
      const first = points[0];
      const final = points[points.length - 1];
      const minutes = first === undefined || final === undefined ? 0 : (final.t - first.t) / 60;
      const slope =
        minutes === 0 || first === undefined || final === undefined
          ? 0
          : (final.v - first.v) / minutes;
      const levelValue = level(role, mode, value);
      return {
        role,
        signal_id: binding.signal_id,
        label: binding.label,
        unit: binding.unit,
        stat: "last",
        value,
        level: levelValue,
        trend: trend(role, slope, {
          mode,
          frozen: guards.frozen,
          transitions: transitionsOf(valueWindow, role),
        }),
        since_s: sinceSeconds(role, levelValue, nowMs),
        window_s: VALUE_WINDOW_S,
      };
    }

    const temperature = binding.kind === "temperature";
    const slopeWindowS = temperature ? TEMPERATURE_WINDOW_S : SLOPE_WINDOW_S;
    const slopeSamples = since(nowMs, slopeWindowS);
    const points = seriesOf(slopeSamples, role, nowMs);
    const minPoints = temperature ? TEMPERATURE_MIN_SAMPLES : MIN_SLOPE_POINTS;
    const perMinute = slopePerMinute(points, minPoints);
    // A temperature is read per hour, everything else per minute.
    const slope = perMinute === undefined ? 0 : temperature ? perMinute * 60 : perMinute;

    const ambient = role === "ambient_temperature";
    const windowValues = valuesOf(valueWindow, role);
    const value = ambient ? (last ?? 0) : (median(windowValues) ?? last ?? 0);
    const levelValue = level(role, mode, value);

    return {
      role,
      signal_id: binding.signal_id,
      label: binding.label,
      unit: binding.unit,
      stat: ambient ? "last" : "median",
      value,
      level: levelValue,
      trend: trend(role, slope, {
        mode,
        frozen: guards.frozen,
        stdDev: standardDeviation(valuesOf(since(nowMs, SLOPE_WINDOW_S), role)),
      }),
      since_s: sinceSeconds(role, levelValue, nowMs),
      window_s: ambient ? 0 : VALUE_WINDOW_S,
    };
  }

  /**
   * The trend of a per-cycle behaviour.
   *
   * The trend thresholds are stated per minute or per hour and say nothing
   * about a value measured once per cycle, so the comparison is relative: a
   * quarter above the median of the preceding cycles is a rise, half again as
   * much is a sharp one, and the mirror fractions fall. It is unit-free, which
   * is what a set of behaviours in seconds, bar per minute and amperes needs.
   */
  function behaviourTrend(value: number | undefined, previous: readonly number[]): Trend {
    const reference = median(previous);
    if (value === undefined || reference === undefined || reference === 0) return "flat";
    const ratio = value / reference;
    if (ratio >= 2) return "rising_sharply";
    if (ratio >= 1.25) return "rising";
    if (ratio <= 0.5) return "falling_sharply";
    if (ratio <= 0.8) return "falling";
    return "flat";
  }

  /**
   * The level of a flag: reaching cut-out is what every healthy cycle does, so
   * a 1 is `normal` and a 0 is as far from the first month as a flag can be.
   * `cut_out_reached` is the one behaviour with no percentile band —
   * `FIRST_MONTH_CYCLE_BANDS` has nothing to interpolate for a boolean.
   */
  function flagLevel(value: number): Level {
    return value >= 0.5 ? "normal" : "far_below_normal";
  }

  function behaviour(
    id: BehaviourId,
    input: {
      label: string;
      unit: string;
      stat: Stat;
      /** The band the value is read against; a flag has none and uses {@link flagLevel}. */
      metric: CycleMetric | "flag";
      value: number | undefined;
      history: readonly number[];
      windowS: number;
      nowMs: number;
      /** The last day by hour class; only the idle decay carries one. */
      byHours?: ByHours;
    },
  ): BehaviourFeature {
    const levelValue =
      input.value === undefined
        ? "normal"
        : input.metric === "flag"
          ? flagLevel(input.value)
          : cycleLevel(input.metric, input.value);
    return {
      id,
      label: input.label,
      unit: input.unit,
      stat: input.stat,
      value: input.value,
      level: levelValue,
      trend: behaviourTrend(input.value, input.history),
      since_s: sinceSeconds(id, levelValue, input.nowMs),
      window_s: input.windowS,
      ...(input.byHours === undefined ? {} : { by_hours: input.byHours }),
    };
  }

  /** The cut-ins of the last two hours, oldest first. */
  function recentCutIns(nowMs: number): number[] {
    const fromMs = nowMs - CYCLE_RATE_WINDOW_S * 1000;
    const times = cycleTracker
      .cycles()
      .map((cycle) => cycle.cutin_sim_ts_ms)
      .filter((time) => time >= fromMs);
    const open = cycleTracker.current()?.cutin_sim_ts;
    if (open !== undefined) {
      const openMs = Date.parse(open);
      if (openMs >= fromMs && !times.includes(openMs)) times.push(openMs);
    }
    return times.sort((left, right) => left - right);
  }

  function computeFrame(nowMs: number, mode: MachineMode, alarms: readonly string[]): FeatureFrame {
    const cycles = cycleTracker.cycles();
    const lastCycles = cycles.slice(-CYCLE_MEDIAN_CYCLES);
    const run = cycleTracker.current();
    const medians = rolling.medians();

    const modeSince = modeSinceMs ?? nowMs;
    const modeForS = (nowMs - modeSince) / 1000;

    const towers = latest("towers");
    const tp3Slope = slopePerMinute(
      seriesOf(since(nowMs, SLOPE_WINDOW_S), "tp3", nowMs),
      MIN_SLOPE_POINTS,
    );

    const cutIns = recentCutIns(nowMs);
    const first = cutIns[0];
    const final = cutIns[cutIns.length - 1];
    const cyclesPerHour =
      cutIns.length >= 2 && first !== undefined && final !== undefined && final > first
        ? ((cutIns.length - 1) * 3_600_000) / (final - first)
        : undefined;

    const loadedRunThreshold = ruleThreshold("loaded_run_s", medians.loaded_run_s);
    const decayThreshold = ruleThreshold("decay_bar_per_min", medians.decay_bar_per_min);

    let fastDecaysInRow = 0;
    for (let index = cycles.length - 1; index >= 0; index -= 1) {
      const decay = (cycles[index] as Cycle).decay_bar_per_min;
      if (decay === undefined || decay <= decayThreshold) break;
      fastDecaysInRow += 1;
    }

    const oilWindow = since(nowMs, OIL_MIN_WINDOW_S);
    const oilValues = valuesOf(oilWindow, "oil_temperature");
    const oilTrendPerMinute = slopePerMinute(
      seriesOf(since(nowMs, TEMPERATURE_WINDOW_S), "oil_temperature", nowMs),
      TEMPERATURE_MIN_SAMPLES,
    );

    const loadedMinute = since(nowMs, VALUE_WINDOW_S).filter((entry) => entry.mode === "loaded");
    const differences: number[] = [];
    for (const entry of loadedMinute) {
      const tp2 = entry.values.tp2;
      const tp3 = entry.values.tp3;
      if (tp2 !== undefined && tp3 !== undefined) differences.push(tp2 - tp3);
    }

    const reservoirDifferences: number[] = [];
    for (const entry of since(nowMs, RESERVOIR_WINDOW_S)) {
      const reservoirs = entry.values.reservoirs;
      const tp3 = entry.values.tp3;
      if (reservoirs !== undefined && tp3 !== undefined)
        reservoirDifferences.push(reservoirs - tp3);
    }

    const towersMissing = cycles
      .slice(-TOWER_PULSE_LOOKBACK_CYCLES)
      .filter((cycle) => !cycle.towers_pulse).length;

    const lastClosed = cycles[cycles.length - 1];
    // Seconds since the last cut-out until the separator came back up to the
    // line. While the run in progress has cut out and h1 is still down, the
    // elapsed time is the answer so far — a lower bound that grows — because
    // `separator_not_venting` asks "has it come back up yet", and a
    // separator that never comes back up would otherwise leave the field
    // undefined for ever and the rule silent.
    const h1ReturnS = runH1ReturnS(run, nowMs) ?? lastClosed?.h1_return_s;

    const ambientC = latest("ambient_temperature");
    const loadedRunS = mode === "loaded" ? modeForS : undefined;

    const signals = {} as Record<SignalRole, SignalFeature>;
    for (const role of SIGNAL_ROLES) signals[role] = signalFeature(role, nowMs, mode);

    const windowFrom = window[0]?.simTsMs ?? nowMs;

    return {
      sim_ts: new Date(nowMs).toISOString(),
      sim_ts_ms: nowMs,
      window: {
        from_sim_ts: new Date(windowFrom).toISOString(),
        to_sim_ts: new Date(nowMs).toISOString(),
        samples: window.length,
      },
      mode,
      mode_since_sim_ts: new Date(modeSince).toISOString(),
      mode_for_s: modeForS,
      dryer_tower: towers === undefined ? null : towers >= 0.5 ? 2 : 1,
      loaded_run_s: loadedRunS,
      tp3_slope_bar_per_min: tp3Slope,
      cycles_per_hour: cyclesPerHour,
      loaded_run_median_s: median(lastCycles.map((cycle) => cycle.loaded_s)),
      off_median_s: median(lastCycles.map((cycle) => cycle.off_s)),
      decay_median: median(
        lastCycles
          .map((cycle) => cycle.decay_bar_per_min)
          .filter((value): value is number => value !== undefined),
      ),
      long_runs_in_last5: lastCycles.filter((cycle) => cycle.loaded_s > loadedRunThreshold).length,
      fast_decays_in_row: fastDecaysInRow,
      dv_pressure_loaded_consecutive_gt: dvConsecutive,
      oil_c: latest("oil_temperature"),
      oil_30min_min_c: oilValues.length === 0 ? undefined : Math.min(...oilValues),
      oil_trend_c_per_h: oilTrendPerMinute === undefined ? undefined : oilTrendPerMinute * 60,
      motor_current_loaded_a: median(valuesOf(loadedMinute, "motor_current")),
      tp2_minus_tp3_loaded: median(differences),
      towers_pulse_missing_cycles: towersMissing,
      h1_return_s: h1ReturnS,
      reservoirs_minus_tp3: median(reservoirDifferences),
      lps_active_s: lpsSinceMs === undefined ? 0 : (nowMs - lpsSinceMs) / 1000,
      oil_level_low_s: oilLowSinceMs === undefined ? 0 : (nowMs - oilLowSinceMs) / 1000,
      caudal_stuck_s: caudalChangedMs === undefined ? 0 : (nowMs - caudalChangedMs) / 1000,
      ambient_c: ambientC,
      ambient_bucket: ambientBucket(ambientC),
      active_alarms: alarms,
      signals,
      rolling: medians,
      guards,
      behaviours: computeBehaviours(nowMs, cycles, loadedRunS, tp3Slope, cyclesPerHour),
    };
  }

  function computeBehaviours(
    nowMs: number,
    cycles: readonly Cycle[],
    loadedRunS: number | undefined,
    tp3Slope: number | undefined,
    cyclesPerHour: number | undefined,
  ): Readonly<Record<BehaviourId, BehaviourFeature>> {
    const history = cycles.slice(-(CYCLE_MEDIAN_CYCLES + 1), -1);
    const newest = cycles[cycles.length - 1];
    const run = cycleTracker.current();
    const runPeriodS = run?.mode === "loaded" ? (loadedRunS ?? 0) : 0;

    const rateHistory = history
      .filter((cycle) => cycle.period_s > 0)
      .map((cycle) => 3600 / cycle.period_s);

    // A run in progress that is already longer than any first-month run has
    // not reached cut-out, whatever the last closed cycle did.
    const runningLong =
      loadedRunS !== undefined && loadedRunS > FIRST_MONTH_CYCLE_BANDS.loaded_s.p99;
    const cutOutReached = runningLong
      ? 0
      : newest === undefined
        ? undefined
        : newest.cut_out_reached
          ? 1
          : 0;

    return {
      load_cycle_rate: behaviour("load_cycle_rate", {
        label: "Load cycle rate",
        unit: "per_hour",
        stat: "rate",
        metric: "cycles_per_hour",
        value: cyclesPerHour,
        history: rateHistory,
        windowS: CYCLE_RATE_WINDOW_S,
        nowMs,
      }),
      loaded_run_duration: behaviour("loaded_run_duration", {
        label: "Loaded run duration",
        unit: "s",
        stat: "duration",
        metric: "loaded_s",
        value: loadedRunS ?? newest?.loaded_s,
        history: history.map((cycle) => cycle.loaded_s),
        windowS: loadedRunS ?? newest?.period_s ?? 0,
        nowMs,
      }),
      unloaded_pressure_decay: behaviour("unloaded_pressure_decay", {
        label: "Pressure decay while not delivering",
        unit: "bar/min",
        stat: "slope",
        metric: "decay_bar_per_min",
        value: newest?.decay_bar_per_min,
        history: history
          .map((cycle) => cycle.decay_bar_per_min)
          .filter((value): value is number => value !== undefined),
        windowS: newest?.nonloaded_s ?? 0,
        nowMs,
        byHours: decayByHours.levels(nowMs),
      }),
      cut_out_reached: behaviour("cut_out_reached", {
        label: "Loaded run reaches cut-out",
        unit: "bool",
        stat: "flag",
        metric: "flag",
        value: cutOutReached,
        history: history.map((cycle) => (cycle.cut_out_reached ? 1 : 0)),
        windowS: runningLong ? runPeriodS : (newest?.period_s ?? 0),
        nowMs,
      }),
      pressure_rise_while_loaded: behaviour("pressure_rise_while_loaded", {
        label: "Pressure rise while loaded",
        unit: "bar/min",
        stat: "slope",
        metric: "rise_bar_per_min",
        value: loadedRunS !== undefined ? tp3Slope : newest?.rise_bar_per_min,
        history: history
          .map((cycle) => cycle.rise_bar_per_min)
          .filter((value): value is number => value !== undefined),
        windowS: loadedRunS !== undefined ? SLOPE_WINDOW_S : (newest?.loaded_s ?? 0),
        nowMs,
      }),
      start_current_peak: behaviour("start_current_peak", {
        label: "Motor current peak at start",
        unit: "A",
        stat: "max",
        metric: "start_current_peak",
        value: run?.start_current_peak ?? newest?.start_current_peak,
        history: history
          .map((cycle) => cycle.start_current_peak)
          .filter((value): value is number => value !== undefined),
        windowS: START_PEAK_OBSERVATION_WINDOW_S,
        nowMs,
      }),
    };
  }

  return {
    push(sample: Sample): FeatureUpdate {
      const simTsMs = Date.parse(sample.sim_ts);
      if (Number.isNaN(simTsMs)) {
        throw new Error(`detection: sample ${String(sample.seq)} carries no readable sim_ts`);
      }

      // A sample that does not carry the state tags keeps the state it had:
      // `unknown` only ever reaches the frame before the first readable one.
      const readMode = machineMode(sample, roles);
      const mode = readMode === "unknown" ? lastMode : readMode;

      const guardUpdate = guardTracker.push(sample, mode, simTsMs);
      guards = guardUpdate.guards;
      if (guardUpdate.reset !== undefined) clearWindows();

      if (modeSinceMs === undefined || mode !== lastMode) modeSinceMs = simTsMs;

      const values = read(sample);
      window.push({ simTsMs, mode, values, alarms: sample.alarms });
      const oldest = simTsMs - WINDOW_MS;
      while (
        window.length > 0 &&
        ((window[0] as WindowSample).simTsMs < oldest || window.length > MAX_WINDOW_SAMPLES)
      ) {
        window.shift();
      }

      const closed = cycleTracker.push(sample, mode, simTsMs);
      if (closed !== undefined) {
        rolling.add(closed, insideEpisode());
        // Every cycle, episode or not: the fault's own cycles are the evidence
        // here, and the reference they are read against is the first month's.
        decayByHours.add(closed);
      }

      updateRuns(simTsMs, values, mode);

      const minute = Math.floor(simTsMs / 60_000);
      const boundary = lastMinute === undefined || minute !== lastMinute;
      const transition = mode !== lastMode;
      let frame: FeatureFrame | undefined;
      if (boundary || transition || guardUpdate.reset !== undefined) {
        frame = computeFrame(simTsMs, mode, sample.alarms);
        current = frame;
      }
      lastMinute = minute;
      lastMode = mode;

      return { mode, guards, frame, closed, reset: guardUpdate.reset };
    },

    frame(): FeatureFrame | undefined {
      return current;
    },

    cycles(): readonly Cycle[] {
      return cycleTracker.cycles();
    },

    baseline(): RollingBaseline {
      return rolling;
    },

    reset(reason: ResetReason): void {
      guardTracker.reset(reason);
      clearWindows();
      // A caller's reset starts a new stream, unlike a guard's reset inside
      // one, so the day history goes too.
      decayByHours.clear();
      lastMode = "unknown";
    },
  };

  /** The run lengths of the frame that no other module tracks. */
  function updateRuns(
    simTsMs: number,
    values: Partial<Record<SignalRole, number>>,
    mode: MachineMode,
  ): void {
    const lps = values.lps;
    if (lps !== undefined) {
      if (lps >= 0.5) lpsSinceMs = lpsSinceMs ?? simTsMs;
      else lpsSinceMs = undefined;
    }

    // `oil_level_ok` is true when the level is fine: the sensor on this unit
    // reads in reverse and the manual's tag semantics already account for it.
    const oilLevelOk = values.oil_level;
    if (oilLevelOk !== undefined) {
      if (oilLevelOk < 0.5) oilLowSinceMs = oilLowSinceMs ?? simTsMs;
      else oilLowSinceMs = undefined;
    }

    const caudal = values.caudal_impulses;
    if (caudal !== undefined) {
      if (caudalLastValue === undefined || caudal !== caudalLastValue) caudalChangedMs = simTsMs;
      caudalLastValue = caudal;
    }

    const dv = values.dv_pressure;
    if (mode === "loaded" && dv !== undefined && dv > DV_PRESSURE_HIGH_BAR) dvConsecutive += 1;
    else dvConsecutive = 0;
  }
}

/**
 * Every signal and every derived behaviour of one frame, in words.
 *
 * The caller decides which of them reach the model — the decision state keeps
 * the ones that are not `normal`/`flat` plus the ones a candidate names — but
 * the message carries all of them, so the UI and `tools/eval` see the whole
 * picture.
 */
export function observations(frame: FeatureFrame, roles: SignalRoles): Observation[] {
  const list: Observation[] = [];
  for (const role of SIGNAL_ROLES) {
    const feature = frame.signals[role];
    list.push({
      signal_id: feature.signal_id,
      label: feature.label,
      level: feature.level,
      trend: feature.trend,
      since: duration(feature.since_s * 1000),
      stat: feature.stat,
      value: feature.value,
      unit: roles[role].unit,
      window_s: Math.round(feature.window_s),
      mode: frame.mode,
    });
  }

  for (const id of BEHAVIOUR_IDS) {
    const feature = frame.behaviours[id];
    if (feature.value === undefined) continue;
    list.push({
      signal_id: id,
      label: feature.label,
      level: feature.level,
      trend: feature.trend,
      since: duration(feature.since_s * 1000),
      stat: feature.stat,
      value: feature.value,
      unit: feature.unit,
      window_s: Math.round(feature.window_s),
      mode: frame.mode,
      ...(feature.by_hours === undefined ? {} : { by_hours: feature.by_hours }),
    });
  }
  return list;
}

/**
 * One observation as the `suspect-event` schema carries it.
 *
 * The contract's observation is `{ signal, level, trend, since?, value?,
 * unit?, by_hours? }` with `additionalProperties: false`, so the internal
 * `stat`, `window_s`, `label` and `mode` stay inside detection and the finer
 * internal words narrow to the contract enums. `since` travels as the duration
 * words themselves, which is what {@link bucketStringOf} joins for the
 * decision state builder. `by_hours` travels only when detection has it, and a
 * kind of hour with too few cycles to read travels as `unknown`.
 */
export function toContractObservation(observation: Observation): ContractObservation {
  const byHours = observation.by_hours;
  return {
    signal: observation.signal_id,
    level: toContractLevel(observation.level),
    trend: toContractTrend(observation.trend),
    since: observation.since.replaceAll("_", " "),
    value: observation.value,
    unit: observation.unit,
    ...(byHours === undefined ? {} : { by_hours: toContractByHours(byHours) }),
  };
}

/** The quiet-hours and busy-hours levels as contract words; a kind not seen is `unknown`. */
export function toContractByHours(byHours: ByHours): NonNullable<ContractObservation["by_hours"]> {
  return {
    quiet: byHours.quiet === undefined ? "unknown" : toContractLevel(byHours.quiet),
    busy: byHours.busy === undefined ? "unknown" : toContractLevel(byHours.busy),
  };
}

/** The `"<level>; <trend>; <since>"` sentence of one observation. */
export function bucketStringOf(observation: {
  level: Level;
  trend: Trend;
  since: Duration;
}): string {
  return [observation.level, observation.trend, observation.since]
    .map((word) => word.replaceAll("_", " "))
    .join("; ");
}
