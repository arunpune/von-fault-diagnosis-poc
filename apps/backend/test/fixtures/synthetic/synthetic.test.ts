// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The synthetic waveforms say what they claim to say.
 *
 * This file proves the frames the rules are measured against are the numbers
 * the rule table and the first-month statistics name, so a
 * rule that fails later is a rule problem and not a fixture problem.
 */

import { SIGNALS, isValid } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import {
  allScenarios,
  baseline,
  CUT_IN_BAR,
  CUT_OUT_BAR,
  fastDecay,
  frequentCycling,
  longLoadedRuns,
  lowPressureSwitch,
  LPS_CLOSE_BAR,
  SAMPLE_PERIOD_S,
  scenarioBatches,
  scenarioRows,
  type Scenario,
} from "./index.ts";

/** Every tag the register map declares, which is what a decoded row must carry. */
const EVERY_TAG = SIGNALS.map((signal) => signal.tag).sort();

/** The machine states, read back from the tag values. */
function modeOf(values: Record<string, number | boolean>): "loaded" | "unloaded" | "off" {
  if (values.intake_closed === false && values.load_valve === true) return "loaded";
  return (values.motor_current as number) >= 1 ? "unloaded" : "off";
}

/** The closed loaded runs of a scenario, in seconds. */
function loadedRunsOf(scenario: Scenario): number[] {
  const rows = scenarioRows(scenario);
  const runs: number[] = [];
  let current = 0;
  for (const row of rows) {
    if (modeOf(row.values) === "loaded") current += SAMPLE_PERIOD_S;
    else if (current > 0) {
      runs.push(current);
      current = 0;
    }
  }
  return runs;
}

describe("every scenario", () => {
  it("produces batches the contracts accept", () => {
    for (const scenario of allScenarios()) {
      const batches = scenarioBatches(scenario);
      expect(batches.length, scenario.name).toBeGreaterThan(0);
      for (const batch of batches) expect(isValid("telemetry-samples", batch)).toBe(true);
    }
  });

  it("carries every tag of the register map on every sample", () => {
    for (const scenario of allScenarios()) {
      for (const row of scenarioRows(scenario)) {
        expect(Object.keys(row.values).sort(), scenario.name).toEqual(EVERY_TAG);
      }
    }
  });

  it("is the same waveform every time it is built", () => {
    for (const scenario of allScenarios()) {
      expect(scenarioRows(scenario)).toEqual(scenarioRows(scenario));
    }
  });

  it("steps by the recording's sampling period, with no gap", () => {
    for (const scenario of allScenarios()) {
      const rows = scenarioRows(scenario);
      for (let index = 1; index < rows.length; index += 1) {
        const step = (rows[index] as { simTsMs: number }).simTsMs;
        const previous = (rows[index - 1] as { simTsMs: number }).simTsMs;
        expect(step - previous, scenario.name).toBe(SAMPLE_PERIOD_S * 1000);
      }
    }
  });
});

describe("baseline", () => {
  const scenario = baseline(6);

  it("cycles at the first month's rate, about twice an hour", () => {
    const rows = scenarioRows(scenario);
    const hours = (rows.length * SAMPLE_PERIOD_S) / 3600;
    expect(loadedRunsOf(scenario).length / hours).toBeGreaterThan(1.8);
    expect(loadedRunsOf(scenario).length / hours).toBeLessThan(2.2);
  });

  it("runs loaded for about 109 s and swings between cut-in and cut-out", () => {
    for (const run of loadedRunsOf(scenario)) expect(run).toBeLessThanOrEqual(110);
    const pressures = scenarioRows(scenario).map((row) => row.values.line_pressure as number);
    expect(Math.max(...pressures)).toBeLessThanOrEqual(CUT_OUT_BAR + 0.01);
    expect(Math.min(...pressures)).toBeGreaterThan(CUT_IN_BAR - 0.1);
  });

  it("keeps the low-pressure switch open and gives every cycle an off phase", () => {
    const rows = scenarioRows(scenario);
    expect(rows.some((row) => row.values.low_pressure_switch === true)).toBe(false);
    expect(rows.some((row) => modeOf(row.values) === "off")).toBe(true);
  });

  it("pulses the dryer for a minute after each cut-in", () => {
    const rows = scenarioRows(scenario);
    const pulses = rows.filter((row) => row.values.dryer_tower === false).length;
    expect(pulses).toBe(loadedRunsOf(scenario).length * (60 / SAMPLE_PERIOD_S));
  });
});

describe("fast-decay", () => {
  const scenario = fastDecay(5);

  it("loses pressure far faster than the rule's floor of 0.25 bar/min", () => {
    const rows = scenarioRows(scenario);
    const decays: number[] = [];
    let start: { simTsMs: number; bar: number } | undefined;
    for (const row of rows) {
      const bar = row.values.line_pressure as number;
      if (modeOf(row.values) === "loaded") {
        start = undefined;
        continue;
      }
      if (start === undefined) start = { simTsMs: row.simTsMs, bar };
      else if (row.simTsMs - start.simTsMs >= 60_000) {
        decays.push(((start.bar - bar) / (row.simTsMs - start.simTsMs)) * 60_000);
        start = undefined;
      }
    }
    expect(decays.length).toBeGreaterThanOrEqual(3);
    for (const decay of decays) expect(decay).toBeGreaterThan(0.25);
  });

  it("has no off phase left, the way signature B loses it", () => {
    expect(scenarioRows(scenario).some((row) => modeOf(row.values) === "off")).toBe(false);
  });
});

describe("frequent-cycling", () => {
  const scenario = frequentCycling(14);

  it("cycles more than five times an hour", () => {
    const rows = scenarioRows(scenario);
    const hours = (rows.length * SAMPLE_PERIOD_S) / 3600;
    expect(loadedRunsOf(scenario).length / hours).toBeGreaterThan(5);
  });
});

describe("long-loaded-runs", () => {
  it("runs loaded past 200 s in every one of the last five cycles", () => {
    const runs = loadedRunsOf(longLoadedRuns(5));
    expect(runs.length).toBeGreaterThanOrEqual(5);
    for (const run of runs.slice(-5)) expect(run).toBeGreaterThan(200);
  });
});

describe("low-pressure-switch", () => {
  const scenario = lowPressureSwitch();

  it("closes the switch while the machine is running, never parked", () => {
    const closed = scenarioRows(scenario).filter((row) => row.values.low_pressure_switch === true);
    expect(closed.length).toBeGreaterThan(6);
    for (const row of closed) {
      expect(modeOf(row.values)).not.toBe("off");
      expect(row.values.line_pressure as number).toBeLessThanOrEqual(LPS_CLOSE_BAR);
    }
  });

  it("opens the switch again only above the rising threshold", () => {
    const rows = scenarioRows(scenario);
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1] as { values: Record<string, number | boolean> };
      const current = rows[index] as { values: Record<string, number | boolean> };
      if (previous.values.low_pressure_switch === true) {
        if (current.values.low_pressure_switch === false) {
          expect(current.values.line_pressure as number).toBeGreaterThanOrEqual(7.74);
        }
      }
    }
  });
});
