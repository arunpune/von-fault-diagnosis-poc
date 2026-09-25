// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The load cycle and its metrics.
 *
 * The numbers the fixture section asserts are the published anatomy of a
 * first-month cycle: 109 s loaded, a 407 s run-on, cut-in at
 * 8.05 bar, cut-out at 10.03 bar and a non-loaded decay of 0.069 bar/min. They
 * describe a healthy machine, so nothing here encodes a failure window.
 */

import { SIGNALS, type Sample } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { hasFixture, loadFixture } from "../../test/helpers/fixtures.ts";
import {
  BASELINE_CYCLE,
  cycles as cyclePhases,
  runBatches,
  type CycleShape,
} from "../../test/fixtures/synthetic/index.ts";
import {
  createCycleTracker,
  CUT_OUT_BAR,
  MAX_CYCLES,
  median,
  slopePerMinute,
  TOWER_PULSE_MIN_S,
} from "./cycles.ts";
import { resolveRoles } from "./signals.ts";
import { machineMode } from "./state.ts";
import type { Cycle } from "./types.ts";

const roles = resolveRoles(SIGNALS);

/** Replay a stream of samples through a fresh tracker. */
function track(samples: readonly Sample[], maxCycles = MAX_CYCLES): readonly Cycle[] {
  const tracker = createCycleTracker(roles, maxCycles);
  for (const sample of samples) {
    tracker.push(sample, machineMode(sample, roles), Date.parse(sample.sim_ts));
  }
  return tracker.cycles();
}

function syntheticCycles(shape: CycleShape, count: number): readonly Cycle[] {
  return track(runBatches(cyclePhases(shape, count)).flatMap((batch) => batch.samples));
}

function middle(values: readonly (number | undefined)[]): number {
  const defined = values.filter((value): value is number => value !== undefined);
  const value = median(defined);
  expect(value).toBeDefined();
  return value as number;
}

describe("slopePerMinute", () => {
  it("reads a series in the unit of its x axis, per minute", () => {
    const points = [
      { t: 0, v: 8 },
      { t: 30, v: 8.5 },
      { t: 60, v: 9 },
    ];
    expect(slopePerMinute(points, 3)).toBeCloseTo(1, 10);
  });

  it("is negative for a falling series", () => {
    const points = Array.from({ length: 10 }, (_, index) => ({
      t: index * 10,
      v: 10 - index * 0.01,
    }));
    expect(slopePerMinute(points, 6)).toBeCloseTo(-0.06, 10);
  });

  it("refuses too few points and a series with no spread in time", () => {
    expect(slopePerMinute([{ t: 0, v: 1 }], 2)).toBeUndefined();
    expect(
      slopePerMinute(
        [
          { t: 5, v: 1 },
          { t: 5, v: 2 },
          { t: 5, v: 3 },
        ],
        3,
      ),
    ).toBeUndefined();
  });
});

describe("median", () => {
  it("takes the middle of an odd list and the mean of the two middles of an even one", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });
});

describe("the cycle tracker on a synthetic first-month cycle", () => {
  const closed = syntheticCycles(BASELINE_CYCLE, 4);

  it("closes one cycle per cut-in after the first", () => {
    expect(closed).toHaveLength(3);
  });

  it("splits the period into the three states without losing a second", () => {
    for (const cycle of closed) {
      expect(cycle.loaded_s + cycle.unloaded_s + cycle.off_s).toBeCloseTo(cycle.period_s, 6);
      expect(cycle.nonloaded_s).toBeCloseTo(cycle.unloaded_s + cycle.off_s, 6);
    }
  });

  it("measures the run, the run-on and the pressures it was built from", () => {
    const cycle = closed[0] as Cycle;
    expect(cycle.loaded_s).toBeCloseTo(110, 0);
    expect(cycle.unloaded_s).toBeCloseTo(410, 0);
    expect(cycle.cutin_tp3).toBeCloseTo(8.05, 2);
    // The last loaded sample sits one period short of the cut-out instant, so
    // the pressure the tracker reads is the ramp's value there, not its end.
    expect(cycle.cutout_tp3).toBeGreaterThanOrEqual(CUT_OUT_BAR);
    expect(cycle.cutout_tp3).toBeLessThanOrEqual(10.03);
    expect(cycle.cut_out_reached).toBe(true);
  });

  it("reads the decay positive downwards and the rise positive upwards", () => {
    const cycle = closed[0] as Cycle;
    expect(cycle.decay_bar_per_min).toBeCloseTo(0.069, 3);
    expect(cycle.rise_bar_per_min).toBeGreaterThan(1);
  });

  it("sees the changeover pulse, the separator coming back and the loaded medians", () => {
    const cycle = closed[0] as Cycle;
    expect(cycle.towers_pulse).toBe(true);
    expect(cycle.h1_return_s).toBe(0);
    expect(cycle.tp2_minus_tp3_loaded).toBeCloseTo(0.32, 2);
    expect(cycle.motor_current_loaded).toBeCloseTo(6, 3);
    expect(cycle.start_current_peak).toBeCloseTo(6, 3);
    expect(cycle.dv_pressure_loaded).toBeCloseTo(-0.018, 3);
    expect(cycle.dv_pressure_loaded_max).toBeCloseTo(-0.018, 3);
    expect(cycle.oil_max).toBeCloseTo(56.6, 3);
  });
});

describe("the cycle tracker under deviation", () => {
  it("calls a run that stops short of the cut-out pressure unreached", () => {
    const shape: CycleShape = { ...BASELINE_CYCLE, cutOutBar: CUT_OUT_BAR - 0.5 };
    for (const cycle of syntheticCycles(shape, 3)) expect(cycle.cut_out_reached).toBe(false);
  });

  it("follows a faster decay and loses the off phase with it", () => {
    const closed = syntheticCycles({ ...BASELINE_CYCLE, decayBarPerMin: 0.45 }, 4);
    for (const cycle of closed) {
      expect(cycle.decay_bar_per_min).toBeCloseTo(0.45, 2);
      expect(cycle.off_s).toBe(0);
      expect(cycle.unloaded_s).toBeGreaterThan(0);
    }
  });

  it("misses the changeover pulse when the dryer never switches", () => {
    const samples = runBatches(cyclePhases(BASELINE_CYCLE, 3))
      .flatMap((batch) => batch.samples)
      .map((sample) => ({ ...sample, values: { ...sample.values, dryer_tower: true } }));
    for (const cycle of track(samples)) expect(cycle.towers_pulse).toBe(false);
  });

  it("needs the pulse to last long enough to be a changeover", () => {
    expect(TOWER_PULSE_MIN_S).toBe(20);
  });

  it("keeps only the last cycles of the segment", () => {
    const closed = syntheticCycles({ ...BASELINE_CYCLE, decayBarPerMin: 0.45 }, 9);
    expect(track(runBatches(cyclePhases(BASELINE_CYCLE, 1)).flatMap((b) => b.samples))).toEqual([]);
    expect(closed).toHaveLength(8);

    const capped = track(
      runBatches(cyclePhases({ ...BASELINE_CYCLE, decayBarPerMin: 0.45 }, 9)).flatMap(
        (batch) => batch.samples,
      ),
      3,
    );
    expect(capped).toHaveLength(3);
    expect(capped[2]?.cutin_sim_ts_ms).toBe(closed[7]?.cutin_sim_ts_ms);
  });

  it("drops everything on reset, because a new segment starts", () => {
    const tracker = createCycleTracker(roles);
    for (const sample of runBatches(cyclePhases(BASELINE_CYCLE, 3)).flatMap((b) => b.samples)) {
      tracker.push(sample, machineMode(sample, roles), Date.parse(sample.sim_ts));
    }
    expect(tracker.cycles().length).toBeGreaterThan(0);
    tracker.reset();
    expect(tracker.cycles()).toEqual([]);
    expect(tracker.current()).toBeUndefined();
  });

  it("reports the run in progress", () => {
    const tracker = createCycleTracker(roles);
    const samples = runBatches(cyclePhases(BASELINE_CYCLE, 2)).flatMap((b) => b.samples);
    for (const sample of samples.slice(0, 9)) {
      tracker.push(sample, machineMode(sample, roles), Date.parse(sample.sim_ts));
    }
    const run = tracker.current();
    expect(run?.mode).toBe("loaded");
    expect(run?.cutin_sim_ts).toBe(samples[0]?.sim_ts);
    expect(run?.cutout_sim_ts).toBeUndefined();
    expect(run?.loaded_s).toBe(80);
    expect(run?.samples).toBe(9);
  });
});

describe.skipIf(!hasFixture("baseline-feb"))(
  "the cycle tracker on the first-month baseline fixture",
  () => {
    const closed = track(loadFixture("baseline-feb").batches.flatMap((batch) => batch.samples));

    it("finds the cycles of a first-month morning", () => {
      expect(closed.length).toBeGreaterThanOrEqual(10);
    });

    it("measures a loaded run of 109 s ± 15 s", () => {
      expect(middle(closed.map((cycle) => cycle.loaded_s))).toBeGreaterThanOrEqual(109 - 15);
      expect(middle(closed.map((cycle) => cycle.loaded_s))).toBeLessThanOrEqual(109 + 15);
    });

    it("measures the fixed run-on of 407 s ± 12 s", () => {
      const runOn = middle(closed.map((cycle) => cycle.unloaded_s));
      expect(runOn).toBeGreaterThanOrEqual(407 - 12);
      expect(runOn).toBeLessThanOrEqual(407 + 12);
    });

    it("cuts in at 8.05 bar ± 0.1 and out at 10.03 bar ± 0.1", () => {
      const cutIn = middle(closed.map((cycle) => cycle.cutin_tp3));
      const cutOut = middle(closed.map((cycle) => cycle.cutout_tp3));
      expect(cutIn).toBeGreaterThanOrEqual(8.05 - 0.1);
      expect(cutIn).toBeLessThanOrEqual(8.05 + 0.1);
      expect(cutOut).toBeGreaterThanOrEqual(10.03 - 0.1);
      expect(cutOut).toBeLessThanOrEqual(10.03 + 0.1);
    });

    it("loses 0.05 to 0.10 bar a minute while it is not delivering", () => {
      const decay = middle(closed.map((cycle) => cycle.decay_bar_per_min));
      expect(decay).toBeGreaterThanOrEqual(0.05);
      expect(decay).toBeLessThanOrEqual(0.1);
    });

    it("reaches cut-out, pulses the dryer and vents the separator in every cycle", () => {
      for (const cycle of closed) {
        expect(cycle.cut_out_reached, cycle.cutin_sim_ts).toBe(true);
        expect(cycle.towers_pulse, cycle.cutin_sim_ts).toBe(true);
        expect(cycle.h1_return_s, cycle.cutin_sim_ts).toBeLessThanOrEqual(30);
      }
    });

    it("draws about 6 A loaded across a discharge differential of about 0.3 bar", () => {
      expect(middle(closed.map((cycle) => cycle.motor_current_loaded))).toBeCloseTo(6, 0);
      expect(middle(closed.map((cycle) => cycle.tp2_minus_tp3_loaded))).toBeGreaterThan(0.2);
      expect(middle(closed.map((cycle) => cycle.start_current_peak))).toBeLessThan(8.3);
    });
  },
);
