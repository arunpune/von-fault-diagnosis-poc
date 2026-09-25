// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The load cycle and its metrics.
 *
 * A cycle runs from one cut-in to the next: the compressor loads, line
 * pressure rises to cut-out, the motor keeps running unloaded for the run-on
 * timer, the machine stops, and the pressure falls until the next cut-in. Most
 * of what distinguishes a leaking machine from a healthy one is a number of
 * this shape — how fast the pressure falls afterwards, how long the run was,
 * whether it reached cut-out at all — so the tracker computes them once here
 * and the rules read them from the feature frame.
 *
 * Time is attributed interval by interval, each interval to the state of the
 * sample that opened it, because the recording's step is 9–13 s and not the
 * nominal 10 s: a cycle's `loaded_s + unloaded_s + off_s` is
 * therefore exactly its `period_s`.
 */

import type { MachineMode, Sample } from "@fdp/contracts";

import { analogValue, digitalValue, type SignalRoles } from "./signals.ts";
import type { Cycle, CurrentRun } from "./types.ts";

/** A loaded run that ends at or above this pressure reached cut-out. */
export const CUT_OUT_BAR = 9.8;

/** The decay slope needs at least this many samples to mean anything. */
export const MIN_DECAY_SAMPLES = 6;

/** The rise slope over a loaded run; a normal run is about eleven samples. */
export const MIN_RISE_SAMPLES = 3;

/** The start peak is the highest current in the first seconds of a loaded run. */
export const START_PEAK_WINDOW_S = 30;

/** The dryer pulses its tower over within this long after cut-in. */
export const TOWER_PULSE_WINDOW_S = 120;

/** A tower pulse shorter than this is a blip, not a changeover. */
export const TOWER_PULSE_MIN_S = 20;

/** The separator has vented when h1 is back within this of the line. */
export const H1_RETURN_MARGIN_BAR = 0.3;

/** Cycles kept per segment. */
export const MAX_CYCLES = 50;

/** One point of a series, in sim seconds and the signal's own unit. */
export interface Point {
  readonly t: number;
  readonly v: number;
}

/**
 * The least-squares slope of `points` per minute, or undefined below
 * `minPoints` or when every point shares one instant.
 */
export function slopePerMinute(points: readonly Point[], minPoints: number): number | undefined {
  if (points.length < minPoints) return undefined;
  let sumT = 0;
  let sumV = 0;
  for (const point of points) {
    sumT += point.t;
    sumV += point.v;
  }
  const meanT = sumT / points.length;
  const meanV = sumV / points.length;
  let covariance = 0;
  let variance = 0;
  for (const point of points) {
    covariance += (point.t - meanT) * (point.v - meanV);
    variance += (point.t - meanT) ** 2;
  }
  if (variance === 0) return undefined;
  return (covariance / variance) * 60;
}

/** The median of `values`, or undefined when there are none. */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  const upper = sorted[middle] as number;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[middle - 1] as number) + upper) / 2;
}

/** What the tracker collects while a cycle is open. */
interface OpenCycle {
  cutinSimTsMs: number;
  cutinTp3: number | undefined;
  loadedS: number;
  unloadedS: number;
  offS: number;
  cutoutSimTsMs: number | undefined;
  cutoutTp3: number | undefined;
  lastLoadedTp3: number | undefined;
  risePoints: Point[];
  decayPoints: Point[];
  tp2MinusTp3: number[];
  motorCurrent: number[];
  dvPressure: number[];
  startPeak: number | undefined;
  towerLowS: number;
  towersPulse: boolean;
  h1ReturnS: number | undefined;
  oilMax: number | undefined;
}

/** The cycle tracker of one stream. */
export interface CycleTracker {
  /**
   * Fold one sample in, in sim order; returns the cycle this sample closed.
   */
  push(sample: Sample, mode: MachineMode, simTsMs: number): Cycle | undefined;
  /** The closed cycles of this segment, oldest first, at most {@link MAX_CYCLES}. */
  cycles(): readonly Cycle[];
  /** The cycle in progress, or undefined before the first sample. */
  current(): CurrentRun | undefined;
  /** Drop the cycles and the open one: a new segment starts. */
  reset(): void;
}

/** A cycle tracker for one stream of samples. */
export function createCycleTracker(roles: SignalRoles, maxCycles = MAX_CYCLES): CycleTracker {
  let closed: Cycle[] = [];
  let open: OpenCycle | undefined;
  let lastMode: MachineMode = "unknown";
  let lastSimTsMs: number | undefined;
  let modeSinceMs: number | undefined;
  let samples = 0;

  function openCycle(simTsMs: number, tp3: number | undefined): OpenCycle {
    return {
      cutinSimTsMs: simTsMs,
      cutinTp3: tp3,
      loadedS: 0,
      unloadedS: 0,
      offS: 0,
      cutoutSimTsMs: undefined,
      cutoutTp3: undefined,
      lastLoadedTp3: tp3,
      risePoints: [],
      decayPoints: [],
      tp2MinusTp3: [],
      motorCurrent: [],
      dvPressure: [],
      startPeak: undefined,
      towerLowS: 0,
      towersPulse: false,
      h1ReturnS: undefined,
      oilMax: undefined,
    };
  }

  function close(cycle: OpenCycle, endSimTsMs: number): Cycle | undefined {
    if (cycle.cutoutSimTsMs === undefined) return undefined;
    const cutoutTp3 = cycle.cutoutTp3;
    return {
      cutin_sim_ts: new Date(cycle.cutinSimTsMs).toISOString(),
      cutin_sim_ts_ms: cycle.cutinSimTsMs,
      cutout_sim_ts: new Date(cycle.cutoutSimTsMs).toISOString(),
      cutout_sim_ts_ms: cycle.cutoutSimTsMs,
      end_sim_ts_ms: endSimTsMs,
      loaded_s: round(cycle.loadedS),
      unloaded_s: round(cycle.unloadedS),
      off_s: round(cycle.offS),
      nonloaded_s: round(cycle.unloadedS + cycle.offS),
      period_s: round((endSimTsMs - cycle.cutinSimTsMs) / 1000),
      cutin_tp3: cycle.cutinTp3,
      cutout_tp3: cutoutTp3,
      cut_out_reached: cutoutTp3 !== undefined && cutoutTp3 >= CUT_OUT_BAR,
      // Positive downwards: a leak makes the number grow, whichever way the
      // pressure moves.
      decay_bar_per_min: negate(slopePerMinute(cycle.decayPoints, MIN_DECAY_SAMPLES)),
      rise_bar_per_min: slopePerMinute(cycle.risePoints, MIN_RISE_SAMPLES),
      tp2_minus_tp3_loaded: median(cycle.tp2MinusTp3),
      motor_current_loaded: median(cycle.motorCurrent),
      start_current_peak: cycle.startPeak,
      dv_pressure_loaded: median(cycle.dvPressure),
      dv_pressure_loaded_max:
        cycle.dvPressure.length === 0 ? undefined : Math.max(...cycle.dvPressure),
      towers_pulse: cycle.towersPulse,
      h1_return_s: cycle.h1ReturnS,
      oil_max: cycle.oilMax,
    };
  }

  return {
    push(sample: Sample, mode: MachineMode, simTsMs: number): Cycle | undefined {
      const tp3 = analogValue(sample, roles.tp3);
      const oil = analogValue(sample, roles.oil_temperature);
      samples += 1;
      if (modeSinceMs === undefined || mode !== lastMode) modeSinceMs = simTsMs;

      // 1. The interval that ends at this sample belongs to the state that
      //    opened it, and to the cycle that was open then.
      if (open !== undefined && lastSimTsMs !== undefined) {
        const seconds = (simTsMs - lastSimTsMs) / 1000;
        if (lastMode === "loaded") open.loadedS += seconds;
        else if (lastMode === "unloaded") open.unloadedS += seconds;
        else if (lastMode === "off") open.offS += seconds;
      }

      // 2. Transitions.
      let finished: Cycle | undefined;
      if (mode === "loaded" && lastMode !== "loaded") {
        if (open !== undefined) {
          finished = close(open, simTsMs);
          if (finished !== undefined) {
            closed.push(finished);
            if (closed.length > maxCycles) closed = closed.slice(closed.length - maxCycles);
          }
        }
        open = openCycle(simTsMs, tp3);
      } else if (mode !== "loaded" && lastMode === "loaded" && open !== undefined) {
        open.cutoutSimTsMs = simTsMs;
        open.cutoutTp3 = open.lastLoadedTp3;
      }

      // 3. This sample's contribution to the open cycle.
      if (open !== undefined) {
        if (oil !== undefined)
          open.oilMax = open.oilMax === undefined ? oil : Math.max(open.oilMax, oil);

        if (mode === "loaded" && open.cutoutSimTsMs === undefined) {
          const sinceCutInS = (simTsMs - open.cutinSimTsMs) / 1000;
          if (tp3 !== undefined) {
            open.risePoints.push({ t: sinceCutInS, v: tp3 });
            open.lastLoadedTp3 = tp3;
            const tp2 = analogValue(sample, roles.tp2);
            if (tp2 !== undefined) open.tp2MinusTp3.push(tp2 - tp3);
          }
          const current = analogValue(sample, roles.motor_current);
          if (current !== undefined) {
            open.motorCurrent.push(current);
            if (sinceCutInS <= START_PEAK_WINDOW_S) {
              open.startPeak =
                open.startPeak === undefined ? current : Math.max(open.startPeak, current);
            }
          }
          const dv = analogValue(sample, roles.dv_pressure);
          if (dv !== undefined) open.dvPressure.push(dv);

          // The changeover pulse: `towers` low for at least 20 s inside the
          // first two minutes of the run.
          if (sinceCutInS <= TOWER_PULSE_WINDOW_S) {
            if (digitalValue(sample, roles.towers) === false) {
              open.towerLowS += lastSimTsMs === undefined ? 0 : (simTsMs - lastSimTsMs) / 1000;
              if (open.towerLowS >= TOWER_PULSE_MIN_S) open.towersPulse = true;
            } else {
              open.towerLowS = 0;
            }
          }
        }

        if (open.cutoutSimTsMs !== undefined) {
          const sinceCutOutS = (simTsMs - open.cutoutSimTsMs) / 1000;
          if (tp3 !== undefined) open.decayPoints.push({ t: sinceCutOutS, v: tp3 });
          if (open.h1ReturnS === undefined && tp3 !== undefined) {
            const h1 = analogValue(sample, roles.h1);
            if (h1 !== undefined && h1 >= tp3 - H1_RETURN_MARGIN_BAR)
              open.h1ReturnS = round(sinceCutOutS);
          }
        }
      }

      lastMode = mode;
      lastSimTsMs = simTsMs;
      return finished;
    },

    cycles(): readonly Cycle[] {
      return closed;
    },

    current(): CurrentRun | undefined {
      if (lastSimTsMs === undefined || modeSinceMs === undefined) return undefined;
      return {
        mode: lastMode,
        mode_since_sim_ts: new Date(modeSinceMs).toISOString(),
        mode_for_s: round((lastSimTsMs - modeSinceMs) / 1000),
        cutin_sim_ts: open === undefined ? undefined : new Date(open.cutinSimTsMs).toISOString(),
        cutout_sim_ts:
          open?.cutoutSimTsMs === undefined
            ? undefined
            : new Date(open.cutoutSimTsMs).toISOString(),
        loaded_s: open === undefined ? 0 : round(open.loadedS),
        nonloaded_s: open === undefined ? 0 : round(open.unloadedS + open.offS),
        cutin_tp3: open?.cutinTp3,
        cutout_tp3: open?.cutoutTp3,
        start_current_peak: open?.startPeak,
        towers_pulse: open?.towersPulse ?? false,
        h1_return_s: open?.h1ReturnS,
        samples,
      };
    },

    reset(): void {
      closed = [];
      open = undefined;
      lastMode = "unknown";
      lastSimTsMs = undefined;
      modeSinceMs = undefined;
      samples = 0;
    },
  };
}

/** Seconds to the millisecond, so a duration reads as a number and not as noise. */
function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

function negate(value: number | undefined): number | undefined {
  return value === undefined ? undefined : -value;
}
