// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synthetic compressor waveforms, built from the first-month statistics.
 *
 * Three of the rule signatures — fast pressure decay, frequent cycling and the
 * low-pressure switch — only appear inside the recording's labelled failure
 * windows, and no backend test may encode one of those windows. They are
 * generated here instead, from the published anatomy of a normal cycle and
 * the deviation each rule looks for, so the positive case is a number a reader
 * can check against the rule table rather than a slice of data nobody may
 * quote.
 *
 * Everything is a pure function of its arguments: same call, same samples, no
 * clock and no generator.
 *
 * The model is deliberately plain. A cycle is three phases —
 *
 *   loaded    the compressor delivers, line pressure rises from cut-in to
 *             cut-out at about 1.1 bar/min, the motor draws 6.0 A and the
 *             dryer pulses for a minute
 *   unloaded  the motor keeps running for a fixed run-on of 407 s, discharge
 *             pressure vents, line pressure falls at the decay rate
 *   off       the motor stops; line pressure keeps falling at the same rate
 *             until the next cut-in
 *
 * — and a fault moves one number: the decay rate, the loaded run, or the
 * pressure the run starts from.
 */

import type { TelemetrySamples } from "@fdp/contracts";

import { ambientC } from "../telemetry/ambient.ts";
import { toBatches, type DecodedRow } from "../telemetry/rows.ts";

/** The recording's sampling period. */
export const SAMPLE_PERIOD_S = 10;

/** Cut-in and cut-out line pressure, first month. */
export const CUT_IN_BAR = 8.05;
export const CUT_OUT_BAR = 10.03;

/** The fixed run-on after cut-out: a ~7 minute timer. */
export const RUN_ON_S = 407;

/** Median loaded run and non-loaded decay of the first month. */
export const LOADED_RUN_S = 109;
export const NORMAL_DECAY_BAR_PER_MIN = 0.069;

/** Motor current per state, first-month medians. */
const MOTOR_LOADED_A = 6.0;
const MOTOR_UNLOADED_A = 3.77;
export const MOTOR_OFF_A = 0.038;

/** Discharge pressure: line pressure plus 0.32 bar loaded, vented otherwise. */
const DISCHARGE_OVER_LINE_BAR = 0.32;
export const DISCHARGE_VENTED_BAR = -0.012;

/** Separator pressure equals line pressure unless the compressor is loaded. */
export const SEPARATOR_LOADED_BAR = -0.014;

/** Dryer purge pressure sits just below zero in every normal state. */
const PURGE_PRESSURE_BAR = -0.018;

/** The reservoir sensor tracks line pressure to within a couple of millibar. */
const RESERVOIR_OFFSET_BAR = -0.002;

/** Oil temperature, first-month median. */
const OIL_TEMPERATURE_C = 56.6;

/** The dryer pulses `towers` low for a minute, starting 10 s after cut-in. */
const TOWER_PULSE_START_S = 10;
const TOWER_PULSE_S = 60;

/** The low-pressure switch closes at 6.95 bar falling and opens at 7.74 rising. */
export const LPS_CLOSE_BAR = 6.95;
export const LPS_OPEN_BAR = 7.74;

export type MachineMode = "loaded" | "unloaded" | "off";

/** One stretch of a run, at one machine state. */
export interface Phase {
  readonly mode: MachineMode;
  readonly seconds: number;
  readonly fromBar: number;
  /** Loaded phases rise to this pressure; the others fall at `decayBarPerMin`. */
  readonly toBar?: number;
  readonly decayBarPerMin?: number;
  /**
   * Dryer purge pressure for the whole phase; the vented level when absent.
   * A purge side that holds pressure while loaded is the drain-side signature
   * `purge_pressure_high` watches.
   */
  readonly purgeBar?: number;
}

/** What one cycle looks like; the numbers a fault moves are all here. */
export interface CycleShape {
  readonly loadedS: number;
  readonly runOnS: number;
  readonly cutInBar: number;
  readonly cutOutBar: number;
  readonly decayBarPerMin: number;
}

/** The first-month cycle. */
export const BASELINE_CYCLE: CycleShape = {
  loadedS: LOADED_RUN_S,
  runOnS: RUN_ON_S,
  cutInBar: CUT_IN_BAR,
  cutOutBar: CUT_OUT_BAR,
  decayBarPerMin: NORMAL_DECAY_BAR_PER_MIN,
};

/**
 * The phases of one cycle.
 *
 * The non-loaded interval lasts exactly as long as the decay needs to bring
 * the pressure from cut-out back to cut-in. When that is shorter than the
 * run-on, the next cut-in arrives while the motor is still turning and the
 * cycle has no off phase at all — which is what the recording shows as the
 * decay grows (signature B).
 */
export function cyclePhases(shape: CycleShape): Phase[] {
  const nonLoadedS = onTheGrid(((shape.cutOutBar - shape.cutInBar) / shape.decayBarPerMin) * 60);
  const runOnS = Math.min(onTheGrid(shape.runOnS), nonLoadedS);
  const offS = Math.max(0, nonLoadedS - runOnS);
  const pressureAfterRunOn = shape.cutOutBar - (shape.decayBarPerMin * runOnS) / 60;

  const phases: Phase[] = [
    {
      mode: "loaded",
      seconds: onTheGrid(shape.loadedS),
      fromBar: shape.cutInBar,
      toBar: shape.cutOutBar,
    },
    {
      mode: "unloaded",
      seconds: runOnS,
      fromBar: shape.cutOutBar,
      decayBarPerMin: shape.decayBarPerMin,
    },
  ];
  if (offS > 0) {
    phases.push({
      mode: "off",
      seconds: offS,
      fromBar: pressureAfterRunOn,
      decayBarPerMin: shape.decayBarPerMin,
    });
  }
  return phases;
}

/** `count` identical cycles, one after the other. */
export function cycles(shape: CycleShape, count: number): Phase[] {
  return Array.from({ length: count }, () => cyclePhases(shape)).flat();
}

/**
 * A duration rounded to whole samples.
 *
 * The recording has one row every ten seconds, so a phase that ended between
 * two of them would put a sample at a fractional instant and make the stream
 * something the gateway could never have published.
 */
function onTheGrid(seconds: number): number {
  return Math.max(SAMPLE_PERIOD_S, Math.round(seconds / SAMPLE_PERIOD_S) * SAMPLE_PERIOD_S);
}

/** How the run is anchored in the data clock and in the tag values. */
export interface RunOptions {
  /** Where the run starts in the data clock; default 2020-02-03T00:00:00Z. */
  readonly startSimTs?: string;
  readonly oilTemperatureC?: number;
  /** Oil level reads normal on this unit unless a test says otherwise. */
  readonly oilLevelOk?: boolean;
  readonly flowPulse?: boolean;
}

/** A run, as the rows a gateway would have decoded. */
export function runRows(phases: readonly Phase[], options: RunOptions = {}): DecodedRow[] {
  const startMs = Date.parse(options.startSimTs ?? "2020-02-03T00:00:00.000Z");
  const rows: DecodedRow[] = [];

  let elapsedS = 0;
  let sinceCutInS = 0;
  let lowPressureSwitch = false;

  for (const phase of phases) {
    if (phase.mode === "loaded") sinceCutInS = 0;
    for (let offsetS = 0; offsetS < phase.seconds; offsetS += SAMPLE_PERIOD_S) {
      const linePressure = pressureAt(phase, offsetS);
      lowPressureSwitch = switchState(lowPressureSwitch, linePressure, phase.mode);
      rows.push({
        simTsMs: startMs + (elapsedS + offsetS) * 1000,
        missing: false,
        values: tagValues({
          mode: phase.mode,
          purgeBar: phase.purgeBar,
          linePressure,
          sinceCutInS: sinceCutInS + offsetS,
          lowPressureSwitch,
          simTsMs: startMs + (elapsedS + offsetS) * 1000,
          options,
        }),
      });
    }
    if (phase.mode !== "loaded") sinceCutInS += phase.seconds;
    elapsedS += phase.seconds;
  }
  return rows;
}

/** A run, as the batches the gateway would have published. */
export function runBatches(
  phases: readonly Phase[],
  options: RunOptions & { unitId?: string } = {},
): TelemetrySamples[] {
  return toBatches(runRows(phases, options), {
    unitId: options.unitId ?? "cau-7",
    wallStartMs: Date.parse("2026-09-21T00:00:00.000Z"),
  });
}

function pressureAt(phase: Phase, offsetS: number): number {
  if (phase.mode === "loaded") {
    const to = phase.toBar ?? phase.fromBar;
    const share = phase.seconds === 0 ? 1 : offsetS / phase.seconds;
    return phase.fromBar + (to - phase.fromBar) * share;
  }
  return phase.fromBar - ((phase.decayBarPerMin ?? 0) * offsetS) / 60;
}

/** The switch closes falling through 6.95 bar and opens rising through 7.74. */
function switchState(previous: boolean, linePressure: number, mode: MachineMode): boolean {
  if (mode === "off" && linePressure < 2) return previous;
  if (!previous) return linePressure <= LPS_CLOSE_BAR;
  return linePressure < LPS_OPEN_BAR;
}

function tagValues(input: {
  mode: MachineMode;
  purgeBar: number | undefined;
  linePressure: number;
  sinceCutInS: number;
  lowPressureSwitch: boolean;
  simTsMs: number;
  options: RunOptions;
}): Record<string, number | boolean> {
  const loaded = input.mode === "loaded";
  const intakeClosed = !loaded;
  const towerPulse =
    loaded &&
    input.sinceCutInS >= TOWER_PULSE_START_S &&
    input.sinceCutInS < TOWER_PULSE_START_S + TOWER_PULSE_S;

  return {
    discharge_pressure: loaded
      ? round(input.linePressure + DISCHARGE_OVER_LINE_BAR)
      : DISCHARGE_VENTED_BAR,
    line_pressure: round(input.linePressure),
    separator_discharge_pressure: loaded ? SEPARATOR_LOADED_BAR : round(input.linePressure),
    dryer_purge_pressure: input.purgeBar ?? PURGE_PRESSURE_BAR,
    reservoir_pressure: round(input.linePressure + RESERVOIR_OFFSET_BAR),
    oil_temperature: input.options.oilTemperatureC ?? OIL_TEMPERATURE_C,
    motor_current: loaded
      ? MOTOR_LOADED_A
      : input.mode === "unloaded"
        ? MOTOR_UNLOADED_A
        : MOTOR_OFF_A,
    intake_closed: intakeClosed,
    load_valve: loaded,
    dryer_tower: !towerPulse,
    regulator_contact: intakeClosed,
    low_pressure_switch: input.lowPressureSwitch,
    purge_switch: true,
    oil_level_ok: input.options.oilLevelOk ?? true,
    flow_pulse: input.options.flowPulse ?? true,
    ambient_temperature: ambientC(input.simTsMs),
  };
}

/** Three decimals: the recording's own resolution for a pressure. */
function round(bar: number): number {
  return Math.round(bar * 1000) / 1000;
}
