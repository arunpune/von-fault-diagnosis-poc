// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The synthetic scenarios the rule tests replay.
 *
 * One per signature that the recording shows only inside a labelled failure
 * window, plus the baseline they are all compared against. Each one names the
 * rule it is built for and the threshold it is meant to cross, so a reader can
 * check the number against the rule table (docs/detection.md) without running
 * anything.
 *
 * The onset timing of the real failures is not asserted here and never will
 * be: that belongs to the `tools/eval` scenarios.
 */

import type { TelemetrySamples } from "@fdp/contracts";

import type { DecodedRow } from "../telemetry/rows.ts";
import {
  BASELINE_CYCLE,
  cycles,
  runBatches,
  runRows,
  type CycleShape,
  type Phase,
  type RunOptions,
} from "./waveform.ts";

export * from "./waveform.ts";

/** A named scenario, with the rule it exists for. */
export interface Scenario {
  readonly name: string;
  /** The detection rule this scenario is built to make fire, if any. */
  readonly rule: string | null;
  readonly why: string;
  readonly phases: readonly Phase[];
}

/**
 * Normal cycling: 1.97 cycles an hour, 109 s loaded, 0.069 bar/min decay.
 * Every rule must stay silent on it.
 */
export function baseline(count = 6): Scenario {
  return {
    name: "baseline",
    rule: null,
    why: "the first-month cycle; the negative every rule is measured against",
    phases: cycles(BASELINE_CYCLE, count),
  };
}

/**
 * Decay at 0.45 bar/min, well past the rule's `max(0.25, 2 × rolling)`
 * (`fast_decay`; first-month p50 0.069, p99 0.288).
 *
 * At that rate the pressure is back at cut-in before the run-on timer expires,
 * so the cycles also lose their off phase, exactly as signature B does.
 */
export function fastDecay(count = 5): Scenario {
  const shape: CycleShape = { ...BASELINE_CYCLE, decayBarPerMin: 0.45 };
  return {
    name: "fast-decay",
    rule: "fast_decay",
    why: "0.45 bar/min over consecutive cycles, against a 0.25 bar/min floor",
    phases: cycles(shape, count),
  };
}

/**
 * Cycles every ten minutes with no off phase, against the rule's
 * `max(5, 1.8 × rolling)` per hour and its 250 s off-phase median
 * (`frequent_cycling`; the first month runs at 1.97 an hour).
 */
export function frequentCycling(count = 14): Scenario {
  const shape: CycleShape = { ...BASELINE_CYCLE, loadedS: 220, decayBarPerMin: 0.3 };
  return {
    name: "frequent-cycling",
    rule: "frequent_cycling",
    why: "about six cycles an hour and no off phase at all",
    phases: cycles(shape, count),
  };
}

/**
 * Loaded runs longer than 200 s in every cycle (`long_loaded_runs`; the first
 * month's p99 is 149 s).
 */
export function longLoadedRuns(count = 5): Scenario {
  const shape: CycleShape = { ...BASELINE_CYCLE, loadedS: 320, decayBarPerMin: 0.2 };
  return {
    name: "long-loaded-runs",
    rule: "long_loaded_runs",
    why: "320 s loaded in every one of the last five cycles, against a 200 s floor",
    phases: cycles(shape, count),
  };
}

/**
 * The compressor cannot keep up: loaded, and line pressure falls through the
 * switch instead of rising (`low_pressure_switch`; the switch closes at
 * 6.95 bar).
 *
 * The motor is running throughout, which is what separates this from a depot
 * depressurisation — the `parked` guard removes those.
 */
export function lowPressureSwitch(): Scenario {
  return {
    name: "low-pressure-switch",
    rule: "low_pressure_switch",
    why: "line pressure falls through 6.95 bar while the machine is loaded",
    phases: [
      ...cycles(BASELINE_CYCLE, 1),
      // Demand beats supply: the loaded run starts at cut-in and loses
      // 1.2 bar over four minutes instead of gaining two.
      { mode: "loaded", seconds: 240, fromBar: 8.05, toBar: 6.85 },
      { mode: "loaded", seconds: 300, fromBar: 6.85, toBar: 6.4 },
    ],
  };
}

/** Every scenario, for a test that wants to sweep them. */
export function allScenarios(): Scenario[] {
  return [baseline(), fastDecay(), frequentCycling(), longLoadedRuns(), lowPressureSwitch()];
}

/** The rows of a scenario, as a gateway would have decoded them. */
export function scenarioRows(scenario: Scenario, options: RunOptions = {}): DecodedRow[] {
  return runRows(scenario.phases, options);
}

/** The batches of a scenario, as a gateway would have published them. */
export function scenarioBatches(
  scenario: Scenario,
  options: RunOptions & { unitId?: string } = {},
): TelemetrySamples[] {
  return runBatches(scenario.phases, options);
}
