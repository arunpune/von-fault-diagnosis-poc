// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * One positive and one negative per detection rule.
 *
 * The positives are synthetic frames: a real frame of the first-month cycle
 * with the one number of the table moved past its threshold, so the test reads
 * like the row it checks. That is deliberate — three of these
 * signatures appear in the recording only inside labelled failure windows, and
 * no backend test may encode one.
 *
 * The negatives are the whole of a healthy stream: every rule, enabled or
 * not, stays silent on every unguarded frame of the synthetic baseline and of
 * the first-month fixture. Onset timing against F1–F4 is the eval harness's
 * and never appears here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Sample } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { baseline, scenarioBatches } from "../../../test/fixtures/synthetic/index.ts";
import { hasFixture, loadFixture, REPO_ROOT } from "../../../test/helpers/fixtures.ts";
import { guardsPassed } from "../state.ts";
import type { FeatureFrame } from "../types.ts";
import { dischargeDifferentialLow, DIFFERENTIAL_LOW_BAR } from "./discharge-differential-low.ts";
import { dryerTowerNotSwitching, MISSING_CYCLES } from "./dryer-tower-not-switching.ts";
import { fastDecay, CONSECUTIVE_CYCLES } from "./fast-decay.ts";
import { flowPulsesMissing, STUCK_S } from "./flow-pulses-missing.ts";
import {
  contextOf,
  framesOf,
  lastFrameIn,
  laterBy,
  ROLES,
  withCycleRateLevel,
  withSignal,
} from "./frames.test-helper.ts";
import { frequentCycling } from "./frequent-cycling.ts";
import { createRuleEngine, DEFAULT_RULES_DISABLED, enabledRules, REGISTRY } from "./index.ts";
import { longLoadedRuns, LONG_RUNS_IN_LAST_FIVE } from "./long-loaded-runs.ts";
import { lowOilLevel, LOW_FOR_S } from "./low-oil-level.ts";
import { lowPressureSwitch } from "./low-pressure-switch.ts";
import { motorCurrentHigh, MOTOR_CURRENT_HIGH_A } from "./motor-current-high.ts";
import { motorCurrentLow, MOTOR_CURRENT_LOW_A, SETTLE_S } from "./motor-current-low.ts";
import { oilTemperatureHigh, OIL_MIN_HIGH_C } from "./oil-temperature-high.ts";
import { oilTemperatureRising, OIL_TREND_C_PER_H } from "./oil-temperature-rising.ts";
import { purgePressureHigh, CONSECUTIVE_SAMPLES } from "./purge-pressure-high.ts";
import { reservoirPressureMismatch, MISMATCH_BAR } from "./reservoir-pressure-mismatch.ts";
import { separatorNotVenting, H1_RETURN_S } from "./separator-not-venting.ts";
import { stuckLoaded, LOADED_RUN_S, TP3_SLOPE_BAR_PER_MIN } from "./stuck-loaded.ts";
import type { Rule, RuleHit } from "./types.ts";

const healthy = framesOf(scenarioBatches(baseline(8)).flatMap((batch) => batch.samples));
const loaded = lastFrameIn(healthy, "loaded");
const unloaded = lastFrameIn(healthy, "unloaded");

/** Run one rule against one frame, with the context that frame implies. */
function fire(rule: Rule, frame: FeatureFrame): RuleHit | null {
  return rule.evaluate(frame, contextOf(frame));
}

/** A hit the test expects, with its numbers. */
function expectHit(rule: Rule, frame: FeatureFrame): RuleHit {
  const hit = fire(rule, frame);
  expect(hit, `${rule.id} did not fire`).not.toBeNull();
  const found = hit as RuleHit;
  expect(found.rule_id).toBe(rule.id);
  expect(found.symptom_key).toBe(rule.symptom_key);
  expect(found.severity_hint).toBe(rule.severity_hint);
  expect(found.since_sim_ts).toBe(frame.sim_ts);
  expect(found.detail.length).toBeGreaterThan(0);
  return found;
}

describe("stuck_loaded", () => {
  it("fires on a loaded run past ten minutes that is not building pressure", () => {
    const frame: FeatureFrame = {
      ...loaded,
      loaded_run_s: LOADED_RUN_S + 300,
      tp3_slope_bar_per_min: 0.02,
    };
    const hit = expectHit(stuckLoaded, frame);
    expect(hit.value).toBe(LOADED_RUN_S + 300);
    expect(hit.threshold).toBe(LOADED_RUN_S);
    expect(hit.detail).toContain("minutes");
  });

  it("says how long the run has lasted in duration words", () => {
    const hit = expectHit(stuckLoaded, {
      ...loaded,
      loaded_run_s: 3600,
      tp3_slope_bar_per_min: 0,
    });
    expect(hit.detail).toContain("about an hour");
  });

  it("stays silent while the line is still rising", () => {
    expect(
      fire(stuckLoaded, {
        ...loaded,
        loaded_run_s: LOADED_RUN_S + 300,
        tp3_slope_bar_per_min: TP3_SLOPE_BAR_PER_MIN,
      }),
    ).toBeNull();
  });

  it("stays silent when the machine is not loaded", () => {
    expect(
      fire(stuckLoaded, { ...unloaded, loaded_run_s: 900, tp3_slope_bar_per_min: 0 }),
    ).toBeNull();
  });
});

describe("purge_pressure_high", () => {
  it("fires after six consecutive loaded samples above the band", () => {
    const frame = withSignal(
      { ...loaded, dv_pressure_loaded_consecutive_gt: CONSECUTIVE_SAMPLES },
      "dv_pressure",
      0.9,
    );
    const hit = expectHit(purgePressureHigh, frame);
    expect(hit.value).toBe(0.9);
    expect(hit.unit).toBe(ROLES.dv_pressure.unit);
  });

  it("stays silent one sample short of the run", () => {
    expect(
      fire(purgePressureHigh, {
        ...loaded,
        dv_pressure_loaded_consecutive_gt: CONSECUTIVE_SAMPLES - 1,
      }),
    ).toBeNull();
  });
});

describe("fast_decay", () => {
  it("fires on three consecutive cycles above the decay threshold", () => {
    const frame: FeatureFrame = {
      ...unloaded,
      fast_decays_in_row: CONSECUTIVE_CYCLES,
      decay_median: 0.45,
    };
    const hit = expectHit(fastDecay, frame);
    expect(hit.value).toBe(0.45);
    // No rolling median on this stream, so the absolute floor stands.
    expect(hit.threshold).toBe(0.25);
    expect(hit.unit).toBe("bar/min");
  });

  it("stays silent on two", () => {
    expect(
      fire(fastDecay, {
        ...unloaded,
        fast_decays_in_row: CONSECUTIVE_CYCLES - 1,
        decay_median: 0.45,
      }),
    ).toBeNull();
  });
});

describe("frequent_cycling", () => {
  it("fires above five cycles an hour", () => {
    const hit = expectHit(frequentCycling, { ...unloaded, cycles_per_hour: 6 });
    expect(hit.value).toBe(6);
    expect(hit.threshold).toBe(5);
  });

  it("fires when the motor hardly stops between cycles", () => {
    const hit = expectHit(frequentCycling, {
      ...unloaded,
      cycles_per_hour: 2,
      off_median_s: 120,
    });
    expect(hit.value).toBe(120);
    expect(hit.threshold).toBe(250);
    expect(hit.unit).toBe("s");
  });

  it("stays silent at the first-month rate with a full off phase", () => {
    expect(
      fire(frequentCycling, { ...unloaded, cycles_per_hour: 2, off_median_s: 1300 }),
    ).toBeNull();
  });
});

describe("long_loaded_runs", () => {
  it("fires when three of the last five runs are long", () => {
    const hit = expectHit(longLoadedRuns, {
      ...unloaded,
      long_runs_in_last5: LONG_RUNS_IN_LAST_FIVE,
      loaded_run_median_s: 320,
    });
    expect(hit.value).toBe(320);
    expect(hit.threshold).toBe(200);
    expect(hit.symptom_key).toBe("frequent_cycling");
  });

  it("stays silent on two", () => {
    expect(
      fire(longLoadedRuns, {
        ...unloaded,
        long_runs_in_last5: LONG_RUNS_IN_LAST_FIVE - 1,
        loaded_run_median_s: 320,
      }),
    ).toBeNull();
  });
});

describe("low_pressure_switch", () => {
  it("fires while the switch is closed and the motor runs", () => {
    const hit = expectHit(lowPressureSwitch, { ...loaded, lps_active_s: 120 });
    expect(hit.severity_hint).toBe("critical");
    expect(hit.unit).toBe(ROLES.tp3.unit);
    expect(hit.detail).toContain("minutes");
  });

  it("stays silent with the motor off, which is a depot stop", () => {
    expect(fire(lowPressureSwitch, { ...loaded, mode: "off", lps_active_s: 600 })).toBeNull();
  });
});

describe("oil_temperature_high", () => {
  it("fires when the half-hour minimum stays above the limit", () => {
    const hit = expectHit(oilTemperatureHigh, { ...loaded, oil_30min_min_c: OIL_MIN_HIGH_C + 5 });
    expect(hit.threshold).toBe(OIL_MIN_HIGH_C);
    expect(hit.unit).toBe(ROLES.oil_temperature.unit);
  });

  it("stays silent when the oil came back down inside the half hour", () => {
    expect(fire(oilTemperatureHigh, { ...loaded, oil_30min_min_c: OIL_MIN_HIGH_C })).toBeNull();
  });
});

describe("oil_temperature_rising", () => {
  it("fires on a steady climb while the load pattern stays normal", () => {
    const frame = withCycleRateLevel(
      { ...loaded, oil_trend_c_per_h: OIL_TREND_C_PER_H + 2 },
      "normal",
    );
    const hit = expectHit(oilTemperatureRising, frame);
    expect(hit.severity_hint).toBe("low");
    expect(hit.unit).toBe("C/h");
  });

  it("stays silent when the machine is simply working harder", () => {
    const frame = withCycleRateLevel(
      { ...loaded, oil_trend_c_per_h: OIL_TREND_C_PER_H + 2 },
      "far_above_normal",
    );
    expect(fire(oilTemperatureRising, frame)).toBeNull();
  });
});

describe("motor_current_high", () => {
  it("fires above the loaded band", () => {
    const hit = expectHit(motorCurrentHigh, {
      ...loaded,
      motor_current_loaded_a: MOTOR_CURRENT_HIGH_A + 0.4,
    });
    expect(hit.threshold).toBe(MOTOR_CURRENT_HIGH_A);
    expect(hit.unit).toBe(ROLES.motor_current.unit);
  });

  it("stays silent at the first-month median", () => {
    expect(fire(motorCurrentHigh, { ...loaded, motor_current_loaded_a: 6.0 })).toBeNull();
  });
});

describe("motor_current_low", () => {
  it("fires below the loaded band once the start peak has settled", () => {
    const hit = expectHit(motorCurrentLow, {
      ...loaded,
      loaded_run_s: SETTLE_S + 30,
      motor_current_loaded_a: MOTOR_CURRENT_LOW_A - 0.4,
    });
    expect(hit.threshold).toBe(MOTOR_CURRENT_LOW_A);
  });

  it("stays silent in the first thirty seconds of a run", () => {
    expect(
      fire(motorCurrentLow, {
        ...loaded,
        loaded_run_s: SETTLE_S,
        motor_current_loaded_a: MOTOR_CURRENT_LOW_A - 0.4,
      }),
    ).toBeNull();
  });
});

describe("discharge_differential_low", () => {
  it("fires when the discharge side barely rises above the line", () => {
    const hit = expectHit(dischargeDifferentialLow, {
      ...loaded,
      tp2_minus_tp3_loaded: DIFFERENTIAL_LOW_BAR - 0.05,
    });
    expect(hit.symptom_key).toBe("motor_current_low");
    expect(hit.unit).toBe(ROLES.tp2.unit);
  });

  it("stays silent at the first-month difference", () => {
    expect(fire(dischargeDifferentialLow, { ...loaded, tp2_minus_tp3_loaded: 0.322 })).toBeNull();
  });
});

describe("dryer_tower_not_switching", () => {
  it("fires after three cycles with no changeover pulse", () => {
    const hit = expectHit(dryerTowerNotSwitching, {
      ...unloaded,
      towers_pulse_missing_cycles: MISSING_CYCLES,
    });
    expect(hit.value).toBe(MISSING_CYCLES);
    expect(hit.unit).toBe("cycles");
  });

  it("stays silent on two", () => {
    expect(
      fire(dryerTowerNotSwitching, {
        ...unloaded,
        towers_pulse_missing_cycles: MISSING_CYCLES - 1,
      }),
    ).toBeNull();
  });
});

describe("separator_not_venting", () => {
  it("fires when the separator takes more than two minutes to come back", () => {
    const hit = expectHit(separatorNotVenting, { ...unloaded, h1_return_s: H1_RETURN_S + 80 });
    expect(hit.threshold).toBe(H1_RETURN_S);
  });

  it("stays silent on a separator that vents in seconds", () => {
    expect(fire(separatorNotVenting, { ...unloaded, h1_return_s: 10 })).toBeNull();
  });
});

/** One mode's band of `manual/spec/derived/normal-bands.json`, as far as this file reads it. */
interface ManualBand {
  readonly low?: number;
  readonly high?: number;
}

/**
 * The manual's bands per signal and machine state: the file signals.yaml copies
 * its `normal_bands` from.
 */
const MANUAL_BANDS = (
  JSON.parse(
    readFileSync(join(REPO_ROOT, "manual", "spec", "derived", "normal-bands.json"), "utf8"),
  ) as { signals: Record<string, Record<"loaded" | "unloaded" | "off", ManualBand>> }
).signals;

describe("the rules' sentences against the manual", () => {
  // A rule's sentence rides on the state row it measured and reaches the
  // model, so it must point the way the manual's signal definition does.

  it("separator_not_venting says the reading has not come back up to the line, the way the manual's bands rise after cut-out", () => {
    const separator = MANUAL_BANDS.separator_discharge_pressure;
    const line = MANUAL_BANDS.line_pressure;
    // signals.yaml: vented close to atmospheric while the unit delivers, and at
    // the line pressure once it does not, so after cut-out the reading rises.
    expect(separator?.loaded.high).toBeLessThan(separator?.unloaded.low ?? Number.NaN);
    expect(separator?.unloaded).toMatchObject({
      low: line?.unloaded.low,
      high: line?.unloaded.high,
    });

    const detail = expectHit(separatorNotVenting, {
      ...unloaded,
      h1_return_s: H1_RETURN_S + 80,
    }).detail;
    expect(detail).toMatch(/come back up to the line pressure/);
    expect(detail).toMatch(/has not come back up/);
    expect(detail).not.toMatch(/pressuri[sz]ed|stay(?:s|ed)? up|kept up|held up|high|above/);
  });
});

describe("reservoir_pressure_mismatch", () => {
  it("fires on a difference either way", () => {
    for (const difference of [MISMATCH_BAR + 0.2, -(MISMATCH_BAR + 0.2)]) {
      const hit = expectHit(reservoirPressureMismatch, {
        ...unloaded,
        reservoirs_minus_tp3: difference,
      });
      expect(hit.value).toBe(difference);
      expect(hit.threshold).toBe(MISMATCH_BAR);
    }
  });

  it("stays silent while the two gauges track each other", () => {
    expect(
      fire(reservoirPressureMismatch, { ...unloaded, reservoirs_minus_tp3: -0.002 }),
    ).toBeNull();
  });
});

describe("low_oil_level", () => {
  it("fires while the contact is closed and the machine runs", () => {
    const hit = expectHit(lowOilLevel, { ...loaded, oil_level_low_s: LOW_FOR_S + 100 });
    expect(hit.threshold).toBe(LOW_FOR_S);
    expect(hit.detail).toContain("minutes");
  });

  it("stays silent with the machine stopped", () => {
    expect(fire(lowOilLevel, { ...loaded, mode: "off", oil_level_low_s: 900 })).toBeNull();
  });
});

describe("flow_pulses_missing", () => {
  it("fires when the counter stands still under load", () => {
    const hit = expectHit(flowPulsesMissing, { ...loaded, caudal_stuck_s: STUCK_S + 60 });
    expect(hit.symptom_key).toBe("no_flow_signal");
    expect(hit.threshold).toBe(STUCK_S);
  });

  it("stays silent while the machine is not delivering", () => {
    expect(fire(flowPulsesMissing, { ...unloaded, caudal_stuck_s: STUCK_S + 60 })).toBeNull();
  });
});

describe("every enabled rule on a healthy machine", () => {
  const unguarded = healthy.filter((frame) => guardsPassed(frame.guards));

  it("has frames to look at", () => {
    expect(unguarded.length).toBeGreaterThan(20);
  });

  it.each(enabledRules().map((rule) => [rule.id, rule] as const))(
    "%s stays silent on every frame of the synthetic first-month cycle",
    (_id, rule) => {
      for (const frame of unguarded) expect(fire(rule, frame), frame.sim_ts).toBeNull();
    },
  );
});

describe.skipIf(!hasFixture("baseline-feb"))("the registry on the first-month fixture", () => {
  const samples: Sample[] = hasFixture("baseline-feb")
    ? loadFixture("baseline-feb").batches.flatMap((batch) => batch.samples)
    : [];
  const frames = framesOf(samples);

  it("has frames to look at", () => {
    expect(frames.filter((frame) => guardsPassed(frame.guards)).length).toBeGreaterThan(100);
  });

  /**
   * The negative of every rule at once, run the way the runtime runs it.
   *
   * A frame-by-frame sweep would be the wrong test here: February carries
   * cut-in transients — a discharge side still venting (first-month p1 of
   * `tp2_minus_tp3_loaded` is −8.04 bar) and a current still settling from the
   * start peak — that satisfy a condition for a sample or two. The hold timers
   * exist for exactly that, so the statement worth making is that the
   * registry as it ships never reports a hit on a first-month morning.
   */
  it("never reports a hit on a first-month morning", () => {
    const engine = createRuleEngine();
    for (const frame of frames) {
      expect(engine.evaluate(frame, contextOf(frame)), frame.sim_ts).toEqual([]);
    }
  });

  it("would read a healthy February as a flow fault, which is why that rule ships off", () => {
    // `Caudal_impulses` is a constant 1 through February, so
    // the counter "stands still" for the whole recording and the condition of
    // `flow_pulses_missing` holds on a machine that has nothing wrong with it.
    const loadedFrames = frames.filter(
      (frame) => guardsPassed(frame.guards) && frame.mode === "loaded",
    );
    const hits = loadedFrames.filter((frame) => fire(flowPulsesMissing, frame) !== null);
    expect(hits.length).toBeGreaterThan(0);
    expect(DEFAULT_RULES_DISABLED).toContain("flow_pulses_missing");
  });
});

describe("the sentences rules write", () => {
  it("carries no digits: the numbers travel in value, threshold and unit", () => {
    const hits: RuleHit[] = [
      expectHit(stuckLoaded, { ...loaded, loaded_run_s: 900, tp3_slope_bar_per_min: 0.02 }),
      expectHit(
        purgePressureHigh,
        withSignal({ ...loaded, dv_pressure_loaded_consecutive_gt: 6 }, "dv_pressure", 0.9),
      ),
      expectHit(fastDecay, { ...unloaded, fast_decays_in_row: 3, decay_median: 0.45 }),
      expectHit(frequentCycling, { ...unloaded, cycles_per_hour: 6 }),
      expectHit(frequentCycling, { ...unloaded, cycles_per_hour: 2, off_median_s: 120 }),
      expectHit(longLoadedRuns, {
        ...unloaded,
        long_runs_in_last5: 3,
        loaded_run_median_s: 320,
      }),
      expectHit(lowPressureSwitch, { ...loaded, lps_active_s: 120 }),
      expectHit(oilTemperatureHigh, { ...loaded, oil_30min_min_c: 80 }),
      expectHit(
        oilTemperatureRising,
        withCycleRateLevel({ ...loaded, oil_trend_c_per_h: 6 }, "normal"),
      ),
      expectHit(motorCurrentHigh, { ...loaded, motor_current_loaded_a: 7 }),
      expectHit(motorCurrentLow, {
        ...loaded,
        loaded_run_s: 90,
        motor_current_loaded_a: 4.8,
      }),
      expectHit(dischargeDifferentialLow, { ...loaded, tp2_minus_tp3_loaded: 0.05 }),
      expectHit(dryerTowerNotSwitching, { ...unloaded, towers_pulse_missing_cycles: 3 }),
      expectHit(separatorNotVenting, { ...unloaded, h1_return_s: 200 }),
      expectHit(reservoirPressureMismatch, { ...unloaded, reservoirs_minus_tp3: 0.5 }),
      expectHit(lowOilLevel, { ...loaded, oil_level_low_s: 400 }),
      expectHit(flowPulsesMissing, { ...loaded, caudal_stuck_s: 660 }),
    ];
    expect(hits.length).toBeGreaterThanOrEqual(REGISTRY.length);
    for (const hit of hits) {
      expect(hit.detail, hit.rule_id).not.toMatch(/\d/);
      expect(hit.detail.endsWith("."), hit.rule_id).toBe(true);
    }
  });

  it("dates a hit from the frame, so the registry can re-date it", () => {
    const later = laterBy(loaded, 600);
    const hit = expectHit(motorCurrentHigh, { ...later, motor_current_loaded_a: 7 });
    expect(hit.since_sim_ts).toBe(later.sim_ts);
  });
});
