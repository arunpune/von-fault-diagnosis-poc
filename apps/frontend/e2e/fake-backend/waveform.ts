// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// A synthetic compressor waveform, so the mock-mode suite needs no dataset. Every reading is a pure
// function of the data time, the conditions in force and a seed: the live stream and the REST
// history of the same instant are therefore identical, and the "noise" is a hash of the instant
// rather than a random draw.
//
// The normal cycle is the dataset's first-month anatomy (docs/dataset.md): cut-in at 8.05 bar, a
// 109 s loaded run up to the 10.03 bar cut-out, a 407 s unloaded run-on, then 1,329 s off while
// the line decays back to cut-in. While loaded the discharge sits 0.32 bar above the line and the
// separator reads about zero; otherwise the discharge is vented and the separator follows the
// line. The dryer's tower signal drops for the first 60 s after each cut-in.
//
// Two departures from it:
//   * signature A, the stuck-loaded leak of F1–F3: the unit stays loaded and never reaches
//     cut-out, the line plateaus at about 8.1 bar, the purge line holds about 2.1 bar, the motor
//     current sags and the oil climbs to about 76 °C;
//   * the oil-cooler-fouling injection: the oil rises by up to 14 °C over three simulated hours
//     (scaled by the instance's magnitude) while the cycling stays normal. The other injections of
//     the menu are accepted and drawn as bands but leave the waveform unchanged.

import { tagOf } from "./data.ts";
import { unitNoise } from "./random.ts";

import type { Sample } from "@/api/types";

/** The replay rate of MetroPT-3: one row every ten seconds of data time. */
export const SAMPLE_INTERVAL_MS = 10_000;

/** The seed of the noise when a caller names none. */
export const DEFAULT_SEED = 7;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Where the cycle starts: the first row of the dataset, at cut-in. */
const CYCLE_ANCHOR_MS = Date.parse("2020-02-01T00:00:00.000Z");

/** The first-month normal cycle. */
export const CYCLE = {
  cutInBar: 8.05,
  cutOutBar: 10.03,
  loadedS: 109,
  runOnS: 407,
  offS: 1329,
  runOnDecayBarPerS: 0.086 / 60,
  dischargeAboveLineBar: 0.32,
  ventedDischargeBar: -0.012,
  separatorLoadedBar: -0.014,
  purgeRestBar: -0.018,
  reservoirBelowLineBar: 0.002,
  loadedCurrentA: 6.0,
  unloadedCurrentA: 3.77,
  offCurrentA: 0.038,
  towerPulseS: 60,
  oilMeanC: 56,
  oilDriftC: 2,
  oilDriftPeriodMs: 6 * HOUR_MS,
} as const;

/** Signature A, the stuck-loaded leak. */
export const LEAK = {
  lineBar: 8.1,
  lineWobbleBar: 0.02,
  purgeBar: 2.1,
  currentA: 5.53,
  oilC: 76,
  oilRampMs: 90 * MINUTE_MS,
  towerHalfPeriodS: 60,
} as const;

/** The synthetic ambient temperature: a daily swing peaking in the afternoon. */
const AMBIENT = { meanC: 19, swingC: 4, peakHourUtc: 15 } as const;

/** How an injection moves the oil temperature: a trapezoid of `riseC` degrees. */
interface OilOffset {
  readonly riseC: number;
  readonly rampInMs: number;
  readonly rampOutMs: number;
}

/** The injections that change the waveform, keyed by injection id. */
const OIL_OFFSETS: Readonly<Record<string, OilOffset>> = {
  oil_cooler_fouling: { riseC: 14, rampInMs: 3 * HOUR_MS, rampOutMs: HOUR_MS },
};

export type MachineMode = "loaded" | "unloaded" | "off";

/** One row of the synthetic dataset, keyed by MetroPT-3 column (plus the synthetic ambient). */
export interface Readings {
  readonly mode: MachineMode;
  readonly TP2: number;
  readonly TP3: number;
  readonly H1: number;
  readonly DV_pressure: number;
  readonly Reservoirs: number;
  readonly Oil_temperature: number;
  readonly Motor_current: number;
  readonly COMP: boolean;
  readonly DV_eletric: boolean;
  readonly Towers: boolean;
  readonly MPG: boolean;
  readonly LPS: boolean;
  readonly Pressure_switch: boolean;
  readonly Oil_level: boolean;
  readonly Caudal_impulses: boolean;
  readonly ambient_temperature: number;
}

type Column = Exclude<keyof Readings, "mode">;

/** One running or finished injection instance, in data time. */
export interface InjectionRun {
  readonly injectionId: string;
  readonly startMs: number;
  /** The planned end, moved earlier when the instance is cleared or cut short. */
  endMs: number;
  readonly magnitude: number;
}

/** What is wrong with the unit over a stretch of data time. */
export interface Conditions {
  /** Signature A has held since this instant, or null for a healthy unit. */
  readonly leakSinceMs: number | null;
  readonly injections: readonly InjectionRun[];
}

export const HEALTHY: Conditions = { leakSinceMs: null, injections: [] };

/** A small deterministic perturbation of `amplitude` for one channel at one instant. */
function jitter(seed: number, instantMs: number, channel: number, amplitude: number): number {
  return amplitude * unitNoise(seed, instantMs, channel);
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

interface CyclePoint {
  readonly mode: MachineMode;
  readonly lineBar: number;
  /** Seconds since the last cut-in. */
  readonly phaseS: number;
}

/** Where the normal cycle stands at an instant. */
function cycleAt(instantMs: number): CyclePoint {
  const periodS = CYCLE.loadedS + CYCLE.runOnS + CYCLE.offS;
  const phaseS = positiveModulo((instantMs - CYCLE_ANCHOR_MS) / 1000, periodS);
  if (phaseS < CYCLE.loadedS) {
    const lineBar = CYCLE.cutInBar + ((CYCLE.cutOutBar - CYCLE.cutInBar) * phaseS) / CYCLE.loadedS;
    return { mode: "loaded", lineBar, phaseS };
  }
  const runOnEndBar = CYCLE.cutOutBar - CYCLE.runOnDecayBarPerS * CYCLE.runOnS;
  if (phaseS < CYCLE.loadedS + CYCLE.runOnS) {
    const lineBar = CYCLE.cutOutBar - CYCLE.runOnDecayBarPerS * (phaseS - CYCLE.loadedS);
    return { mode: "unloaded", lineBar, phaseS };
  }
  const offS = phaseS - CYCLE.loadedS - CYCLE.runOnS;
  const lineBar = runOnEndBar - ((runOnEndBar - CYCLE.cutInBar) * offS) / CYCLE.offS;
  return { mode: "off", lineBar, phaseS };
}

function healthyOilC(instantMs: number): number {
  const angle = (2 * Math.PI * (instantMs - CYCLE_ANCHOR_MS)) / CYCLE.oilDriftPeriodMs;
  return CYCLE.oilMeanC + CYCLE.oilDriftC * Math.sin(angle);
}

function ambientC(instantMs: number): number {
  const hour = positiveModulo(instantMs, DAY_MS) / HOUR_MS;
  return (
    AMBIENT.meanC + AMBIENT.swingC * Math.cos((2 * Math.PI * (hour - AMBIENT.peakHourUtc)) / 24)
  );
}

/** The share of an injection's full effect at an instant: ramp in, hold, ramp out. */
function envelope(run: InjectionRun, instantMs: number, shape: OilOffset): number {
  if (instantMs < run.startMs) {
    return 0;
  }
  const risen = (until: number): number => Math.min(1, (until - run.startMs) / shape.rampInMs);
  if (instantMs < run.endMs) {
    return risen(instantMs);
  }
  return risen(run.endMs) * Math.max(0, 1 - (instantMs - run.endMs) / shape.rampOutMs);
}

function injectedOilOffsetC(instantMs: number, injections: readonly InjectionRun[]): number {
  let offset = 0;
  for (const run of injections) {
    const shape = OIL_OFFSETS[run.injectionId];
    if (shape !== undefined) {
      offset += shape.riseC * run.magnitude * envelope(run, instantMs, shape);
    }
  }
  return offset;
}

function healthyReadings(instantMs: number, seed: number): Readings {
  const cycle = cycleAt(instantMs);
  const loaded = cycle.mode === "loaded";
  const line = cycle.lineBar + jitter(seed, instantMs, 1, 0.004);
  const current =
    cycle.mode === "loaded"
      ? CYCLE.loadedCurrentA
      : cycle.mode === "unloaded"
        ? CYCLE.unloadedCurrentA
        : CYCLE.offCurrentA;
  return {
    mode: cycle.mode,
    TP2: loaded ? line + CYCLE.dischargeAboveLineBar : CYCLE.ventedDischargeBar,
    TP3: line,
    H1: loaded ? CYCLE.separatorLoadedBar : line,
    DV_pressure: CYCLE.purgeRestBar + jitter(seed, instantMs, 2, 0.002),
    Reservoirs: line - CYCLE.reservoirBelowLineBar,
    Oil_temperature: healthyOilC(instantMs) + jitter(seed, instantMs, 3, 0.1),
    Motor_current: current + (cycle.mode === "off" ? 0 : jitter(seed, instantMs, 4, 0.03)),
    COMP: !loaded,
    DV_eletric: loaded,
    Towers: !(loaded && cycle.phaseS < CYCLE.towerPulseS),
    MPG: !loaded,
    LPS: false,
    Pressure_switch: true,
    Oil_level: true,
    Caudal_impulses: true,
    ambient_temperature: ambientC(instantMs) + jitter(seed, instantMs, 5, 0.05),
  };
}

function leakReadings(instantMs: number, sinceMs: number, seed: number): Readings {
  const elapsedMs = Math.max(0, instantMs - sinceMs);
  const wobble = LEAK.lineWobbleBar * Math.sin((2 * Math.PI * elapsedMs) / (17 * MINUTE_MS));
  const line = LEAK.lineBar + wobble + jitter(seed, instantMs, 1, 0.004);
  const healthyOil = healthyOilC(instantMs);
  const oilShare = Math.min(1, elapsedMs / LEAK.oilRampMs);
  const towerHalfPeriods = Math.floor(elapsedMs / 1000 / LEAK.towerHalfPeriodS);
  return {
    mode: "loaded",
    TP2: line + CYCLE.dischargeAboveLineBar,
    TP3: line,
    H1: CYCLE.separatorLoadedBar,
    DV_pressure: LEAK.purgeBar + jitter(seed, instantMs, 2, 0.03),
    Reservoirs: line - CYCLE.reservoirBelowLineBar,
    Oil_temperature:
      healthyOil + (LEAK.oilC - healthyOil) * oilShare + jitter(seed, instantMs, 3, 0.1),
    Motor_current: LEAK.currentA + jitter(seed, instantMs, 4, 0.03),
    COMP: false,
    DV_eletric: true,
    Towers: towerHalfPeriods % 2 === 1,
    MPG: false,
    LPS: false,
    Pressure_switch: true,
    Oil_level: true,
    Caudal_impulses: true,
    ambient_temperature: ambientC(instantMs) + jitter(seed, instantMs, 5, 0.05),
  };
}

/** The synthetic row at an instant under the given conditions. */
export function readingsAt(
  instantMs: number,
  conditions: Conditions,
  seed: number = DEFAULT_SEED,
): Readings {
  const base =
    conditions.leakSinceMs === null || instantMs < conditions.leakSinceMs
      ? healthyReadings(instantMs, seed)
      : leakReadings(instantMs, conditions.leakSinceMs, seed);
  const oilOffset = injectedOilOffsetC(instantMs, conditions.injections);
  return oilOffset === 0 ? base : { ...base, Oil_temperature: base.Oil_temperature + oilOffset };
}

/** When the unit entered the mode it is in at `instantMs`. */
export function modeSinceMs(instantMs: number, conditions: Conditions): number {
  if (conditions.leakSinceMs !== null && instantMs >= conditions.leakSinceMs) {
    return conditions.leakSinceMs;
  }
  const cycle = cycleAt(instantMs);
  const intoModeS =
    cycle.mode === "loaded"
      ? cycle.phaseS
      : cycle.mode === "unloaded"
        ? cycle.phaseS - CYCLE.loadedS
        : cycle.phaseS - CYCLE.loadedS - CYCLE.runOnS;
  return instantMs - Math.round(intoModeS * 1000);
}

const COLUMNS: readonly Column[] = [
  "TP2",
  "TP3",
  "H1",
  "DV_pressure",
  "Reservoirs",
  "Oil_temperature",
  "Motor_current",
  "COMP",
  "DV_eletric",
  "Towers",
  "MPG",
  "LPS",
  "Pressure_switch",
  "Oil_level",
  "Caudal_impulses",
  "ambient_temperature",
];

/** Column → tag id through the register map, resolved once. */
const COLUMN_TAGS: readonly (readonly [Column, string])[] = COLUMNS.map(
  (column) => [column, tagOf(column)] as const,
);

/** Rounds an analog value the way the register map's scale would (three decimals). */
function registerValue(value: number | boolean): number | boolean {
  return typeof value === "boolean" ? value : Math.round(value * 1000) / 1000;
}

/** The readings as a sample's `values`: keyed by tag id, analogs rounded to the register scale. */
export function sampleValues(readings: Readings): Sample["values"] {
  const values: Sample["values"] = {};
  for (const [column, tag] of COLUMN_TAGS) {
    values[tag] = registerValue(readings[column]);
  }
  return values;
}
