// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The feature frame and the observations.
 *
 * The engine is the one place where the whole of `detection/` runs at once, so
 * this file checks three things: the frame carries every field it declares, the
 * words that leave it carry no digits and validate as a `suspect-event`, and
 * the numbers the rules will compare against cross their thresholds on
 * the synthetic signatures and stay well below them on a normal machine.
 *
 * The synthetic scenarios exist because fast decay, frequent cycling and the
 * low-pressure switch appear in the recording only inside labelled failure
 * windows, which no backend test may encode. The fixtures used here are
 * the first-month baseline, a normal summer day, an unlabelled continuous-load
 * episode and the synthetic gap.
 */

import { DEFAULT_UNIT_ID, SIGNALS, validate, type Sample } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { hasFixture, loadFixture, type BackendFixtureName } from "../../test/helpers/fixtures.ts";
import {
  baseline,
  fastDecay,
  frequentCycling,
  longLoadedRuns,
  lowPressureSwitch,
  scenarioBatches,
  type Scenario,
} from "../../test/fixtures/synthetic/index.ts";
import { ABSOLUTE_THRESHOLD, BASELINE_REF } from "./baseline.ts";
import { bucketString } from "./buckets.ts";
import {
  bucketStringOf,
  createFeatureEngine,
  DV_PRESSURE_HIGH_BAR,
  observations,
  toContractObservation,
  type FeatureEngine,
} from "./features.ts";
import { resolveRoles, SIGNAL_ROLES } from "./signals.ts";
import { BEHAVIOUR_IDS, type FeatureFrame, type Observation } from "./types.ts";

const roles = resolveRoles(SIGNALS);

/** Every field of the feature frame, in sorted order. */
const FRAME_FIELDS = [
  "active_alarms",
  "ambient_bucket",
  "ambient_c",
  "behaviours",
  "caudal_stuck_s",
  "cycles_per_hour",
  "decay_median",
  "dryer_tower",
  "dv_pressure_loaded_consecutive_gt",
  "fast_decays_in_row",
  "guards",
  "h1_return_s",
  "loaded_run_median_s",
  "loaded_run_s",
  "long_runs_in_last5",
  "lps_active_s",
  "mode",
  "mode_for_s",
  "mode_since_sim_ts",
  "motor_current_loaded_a",
  "off_median_s",
  "oil_30min_min_c",
  "oil_c",
  "oil_level_low_s",
  "oil_trend_c_per_h",
  "reservoirs_minus_tp3",
  "rolling",
  "signals",
  "sim_ts",
  "sim_ts_ms",
  "towers_pulse_missing_cycles",
  "tp2_minus_tp3_loaded",
  "tp3_slope_bar_per_min",
  "window",
].sort();

interface Replay {
  readonly engine: FeatureEngine;
  readonly frames: readonly FeatureFrame[];
  readonly resets: readonly string[];
  readonly last: FeatureFrame;
}

function replay(samples: readonly Sample[]): Replay {
  const engine = createFeatureEngine({ roles });
  const frames: FeatureFrame[] = [];
  const resets: string[] = [];
  for (const sample of samples) {
    const update = engine.push(sample);
    if (update.frame !== undefined) frames.push(update.frame);
    if (update.reset !== undefined) resets.push(update.reset);
  }
  const last = frames[frames.length - 1];
  expect(last).toBeDefined();
  return { engine, frames, resets, last: last as FeatureFrame };
}

function scenarioSamples(scenario: Scenario): Sample[] {
  return scenarioBatches(scenario).flatMap((batch) => batch.samples);
}

function fixtureSamples(name: BackendFixtureName): Sample[] {
  return loadFixture(name).batches.flatMap((batch) => batch.samples);
}

/** The highest value a frame ever reported for one field. */
function peak(
  frames: readonly FeatureFrame[],
  read: (frame: FeatureFrame) => number | undefined,
): number {
  let highest = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    const value = read(frame);
    if (value !== undefined && value > highest) highest = value;
  }
  return highest;
}

/** A minimal `suspect-event` carrying the observations of one frame. */
function suspectEvent(frame: FeatureFrame, list: readonly Observation[]): unknown {
  return {
    schema: "urn:fdp:schema:suspect-event:v1",
    unit_id: DEFAULT_UNIT_ID,
    wall_ts: "2026-09-21T00:00:00.000Z",
    event_id: "3f1d6a58-0a2f-4d0b-9a3e-2c6b5d4e7f01",
    sim_ts: frame.sim_ts,
    symptom_key: "continuous_load",
    rule_ids: ["stuck_loaded"],
    machine_state: {
      mode: frame.mode,
      since_sim_ts: frame.mode_since_sim_ts,
      dryer_tower: frame.dryer_tower,
    },
    window: frame.window,
    evidence: [{ metric: "line_pressure", observation: "The line pressure is below its band." }],
    observations: list.map((observation) => toContractObservation(observation)),
    active_alarms: [...frame.active_alarms],
    co_symptoms: [],
    ambient: frame.ambient_bucket,
    baseline_ref: BASELINE_REF,
  };
}

describe("the feature frame", () => {
  const { frames, last } = replay(scenarioSamples(baseline(4)));

  it("carries every field of the frame", () => {
    expect(Object.keys(last).sort()).toEqual(FRAME_FIELDS);
  });

  it("carries one bucketed feature per signal role and per derived behaviour", () => {
    expect(Object.keys(last.signals).sort()).toEqual([...SIGNAL_ROLES].sort());
    expect(Object.keys(last.behaviours).sort()).toEqual([...BEHAVIOUR_IDS].sort());
    for (const role of SIGNAL_ROLES) {
      expect(last.signals[role].signal_id, role).toBe(roles[role].signal_id);
      expect(last.signals[role].unit, role).toBe(roles[role].unit);
    }
  });

  it("dates itself and its window from the sim clock", () => {
    expect(last.sim_ts).toBe(new Date(last.sim_ts_ms).toISOString());
    expect(Date.parse(last.window.from_sim_ts)).toBeLessThanOrEqual(last.sim_ts_ms);
    expect(last.window.to_sim_ts).toBe(last.sim_ts);
    expect(last.window.samples).toBeGreaterThan(0);
  });

  it("is recomputed on a state change and on every sim minute, never more often", () => {
    const minutes = new Set(frames.map((frame) => Math.floor(frame.sim_ts_ms / 60_000)));
    const transitions = frames.filter(
      (frame, index) => index > 0 && frame.mode !== (frames[index - 1] as FeatureFrame).mode,
    ).length;
    expect(frames.length).toBeLessThanOrEqual(minutes.size + transitions);
    expect(frames.length).toBeGreaterThanOrEqual(minutes.size);
  });

  it("leaves a field undefined rather than zero while its window is too short", () => {
    const first = frames[0] as FeatureFrame;
    expect(first.cycles_per_hour).toBeUndefined();
    expect(first.decay_median).toBeUndefined();
    expect(first.oil_trend_c_per_h).toBeUndefined();
    expect(first.rolling).toEqual({
      decay_bar_per_min: undefined,
      cycles_per_hour: undefined,
      loaded_run_s: undefined,
      off_s: undefined,
    });
  });

  it("reports the loaded run only while the machine is loaded", () => {
    for (const frame of frames) {
      if (frame.mode === "loaded") expect(frame.loaded_run_s).toBeDefined();
      else expect(frame.loaded_run_s).toBeUndefined();
    }
  });

  it("names the dryer tower in service and the ambient bucket", () => {
    expect([1, 2]).toContain(last.dryer_tower);
    expect(["cold", "mild", "warm", "hot", "unknown"]).toContain(last.ambient_bucket);
    expect(last.ambient_c).toBeDefined();
  });
});

describe("the feature frame on a healthy machine", () => {
  const { frames, last } = replay(scenarioSamples(baseline(8)));

  it("stays below every rule threshold", () => {
    expect(peak(frames, (frame) => frame.decay_median)).toBeLessThan(
      ABSOLUTE_THRESHOLD.decay_bar_per_min,
    );
    expect(peak(frames, (frame) => frame.cycles_per_hour)).toBeLessThan(
      ABSOLUTE_THRESHOLD.cycles_per_hour,
    );
    expect(peak(frames, (frame) => frame.loaded_run_s)).toBeLessThan(
      ABSOLUTE_THRESHOLD.loaded_run_s,
    );
    expect(peak(frames, (frame) => frame.long_runs_in_last5)).toBe(0);
    expect(peak(frames, (frame) => frame.fast_decays_in_row)).toBe(0);
    expect(peak(frames, (frame) => frame.dv_pressure_loaded_consecutive_gt)).toBe(0);
    expect(peak(frames, (frame) => frame.lps_active_s)).toBe(0);
    expect(peak(frames, (frame) => frame.oil_level_low_s)).toBe(0);
    expect(peak(frames, (frame) => frame.towers_pulse_missing_cycles)).toBe(0);
  });

  it("keeps the line, the separator and the reservoirs in step", () => {
    expect(last.reservoirs_minus_tp3).toBeCloseTo(-0.002, 3);
    expect(last.h1_return_s).toBeLessThanOrEqual(10);
  });
});

describe("the feature frame under the rules' synthetic signatures", () => {
  it("crosses the decay and cycle-rate floors on a fast-decay stream", () => {
    const { frames } = replay(scenarioSamples(fastDecay(6)));
    expect(peak(frames, (frame) => frame.decay_median)).toBeGreaterThan(
      ABSOLUTE_THRESHOLD.decay_bar_per_min,
    );
    expect(peak(frames, (frame) => frame.cycles_per_hour)).toBeGreaterThan(
      ABSOLUTE_THRESHOLD.cycles_per_hour,
    );
    expect(peak(frames, (frame) => frame.fast_decays_in_row)).toBeGreaterThanOrEqual(3);
  });

  it("crosses the cycle rate and loses the off phase on a frequent-cycling stream", () => {
    const { frames } = replay(scenarioSamples(frequentCycling(14)));
    expect(peak(frames, (frame) => frame.cycles_per_hour)).toBeGreaterThan(
      ABSOLUTE_THRESHOLD.cycles_per_hour,
    );
    const offMedians = frames
      .map((frame) => frame.off_median_s)
      .filter((value): value is number => value !== undefined);
    expect(Math.min(...offMedians)).toBeLessThan(ABSOLUTE_THRESHOLD.off_s);
  });

  it("counts the long runs of a long-loaded-runs stream", () => {
    const { frames } = replay(scenarioSamples(longLoadedRuns(6)));
    expect(peak(frames, (frame) => frame.long_runs_in_last5)).toBeGreaterThanOrEqual(3);
  });

  it("keeps the low-pressure switch on with the motor running, so nothing parks it", () => {
    const scenario = lowPressureSwitch();
    const { frames } = replay(scenarioSamples(scenario));
    expect(peak(frames, (frame) => frame.lps_active_s)).toBeGreaterThan(60);
    for (const frame of frames) expect(frame.guards.parked).toBe(false);
  });
});

describe("observations", () => {
  const { last } = replay(scenarioSamples(baseline(4)));
  const list = observations(last, roles);

  it("emits one per signal role, and one per behaviour that has a value", () => {
    const ids = list.map((observation) => observation.signal_id);
    for (const role of SIGNAL_ROLES) expect(ids).toContain(roles[role].signal_id);
    expect(ids.slice(0, SIGNAL_ROLES.length)).toEqual(
      SIGNAL_ROLES.map((role) => roles[role].signal_id),
    );
    for (const id of ids.slice(SIGNAL_ROLES.length)) expect(BEHAVIOUR_IDS).toContain(id);
  });

  it("carries words with no digits in them", () => {
    for (const observation of list) {
      for (const word of [observation.level, observation.trend, observation.since]) {
        expect(word, observation.signal_id).toMatch(/^[a-z_]+$/);
      }
      expect(bucketStringOf(observation)).not.toMatch(/[_0-9]/);
      expect(bucketStringOf(observation)).toBe(
        bucketString(observation.level, observation.trend, observation.since),
      );
    }
  });

  it("keeps the number, the unit and the window beside the words", () => {
    for (const observation of list) {
      expect(Number.isFinite(observation.value), observation.signal_id).toBe(true);
      expect(observation.unit.length).toBeGreaterThan(0);
      expect(Number.isInteger(observation.window_s)).toBe(true);
      expect(observation.mode).toBe(last.mode);
      expect(observation.label.length).toBeGreaterThan(0);
    }
  });

  it("serialises into a suspect-event the contracts accept", () => {
    const result = validate("suspect-event", suspectEvent(last, list));
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("narrows the internal words to the contract enums", () => {
    const sharp = toContractObservation({
      ...(list[0] as Observation),
      level: "far_below_normal",
      trend: "rising_sharply",
      since: "about_an_hour",
    });
    expect(sharp.level).toBe("far_below");
    expect(sharp.trend).toBe("rising");
    expect(sharp.since).toBe("about an hour");
    expect(Object.keys(sharp).sort()).toEqual([
      "level",
      "signal",
      "since",
      "trend",
      "unit",
      "value",
    ]);
  });
});

describe("resetting the engine", () => {
  it("clears the windows, the cycles and the baseline", () => {
    const samples = scenarioSamples(baseline(6));
    const engine = createFeatureEngine({ roles });
    for (const sample of samples) engine.push(sample);
    expect(engine.cycles().length).toBeGreaterThan(0);

    engine.reset("discontinuity");
    expect(engine.frame()).toBeUndefined();
    expect(engine.cycles()).toEqual([]);
    expect(engine.baseline().size()).toBe(0);

    const first = engine.push(samples[0] as Sample);
    expect(first.frame?.window.samples).toBe(1);
    expect(first.guards.warmup).toBe(true);
  });

  it("keeps a cycle closed inside an open episode out of the rolling baseline", () => {
    const engine = createFeatureEngine({ roles, insideEpisode: () => true });
    for (const sample of scenarioSamples(fastDecay(6))) engine.push(sample);
    expect(engine.cycles().length).toBeGreaterThan(0);
    expect(engine.baseline().size()).toBe(0);
  });
});

describe.skipIf(!hasFixture("baseline-feb"))("the first-month baseline fixture", () => {
  const { frames, last } = replay(fixtureSamples("baseline-feb"));

  it("reads every signal as normal and never raises a guard", () => {
    for (const frame of frames) {
      expect(frame.signals.dv_pressure.level, frame.sim_ts).toBe("normal");
      expect(frame.guards.frozen).toBe(false);
      expect(frame.guards.parked).toBe(false);
      expect(frame.guards.discontinuity).toBe(false);
    }
  });

  it("stays below every rule threshold", () => {
    expect(peak(frames, (frame) => frame.decay_median)).toBeLessThan(
      ABSOLUTE_THRESHOLD.decay_bar_per_min,
    );
    expect(peak(frames, (frame) => frame.cycles_per_hour)).toBeLessThan(
      ABSOLUTE_THRESHOLD.cycles_per_hour,
    );
    expect(peak(frames, (frame) => frame.loaded_run_s)).toBeLessThan(
      ABSOLUTE_THRESHOLD.loaded_run_s,
    );
    expect(peak(frames, (frame) => frame.dv_pressure_loaded_consecutive_gt)).toBe(0);
  });

  it("serialises every frame's observations into a valid suspect-event", () => {
    for (const frame of frames.slice(0, 40)) {
      const message = suspectEvent(frame, observations(frame, roles));
      expect(validate("suspect-event", message).ok, frame.sim_ts).toBe(true);
    }
    expect(last.active_alarms).toEqual([]);
  });
});

describe.skipIf(!hasFixture("summer-jul05"))("a normal summer day", () => {
  it("cycles faster and decays faster than February without crossing the floors", () => {
    const { frames } = replay(fixtureSamples("summer-jul05"));
    expect(peak(frames, (frame) => frame.cycles_per_hour)).toBeGreaterThan(2);
    expect(peak(frames, (frame) => frame.cycles_per_hour)).toBeLessThan(
      ABSOLUTE_THRESHOLD.cycles_per_hour,
    );
    expect(peak(frames, (frame) => frame.decay_median)).toBeLessThan(
      ABSOLUTE_THRESHOLD.decay_bar_per_min,
    );
  });
});

describe.skipIf(!hasFixture("unlabelled-may19"))("the unlabelled continuous-load episode", () => {
  const { frames } = replay(fixtureSamples("unlabelled-may19"));

  it("sees the machine stay loaded for far longer than any first-month run", () => {
    expect(peak(frames, (frame) => frame.loaded_run_s)).toBeGreaterThan(600);
  });

  it("reads the dryer purge pressure as far from normal while it stays loaded", () => {
    const stuck = frames.filter(
      (frame) => frame.mode === "loaded" && (frame.loaded_run_s ?? 0) > 600,
    );
    expect(stuck.length).toBeGreaterThan(0);
    for (const frame of stuck) {
      expect(frame.signals.dv_pressure.level, frame.sim_ts).not.toBe("normal");
      expect(frame.signals.dv_pressure.value, frame.sim_ts).toBeGreaterThan(DV_PRESSURE_HIGH_BAR);
    }
  });

  it("counts the consecutive loaded samples with a high purge pressure", () => {
    expect(peak(frames, (frame) => frame.dv_pressure_loaded_consecutive_gt)).toBeGreaterThanOrEqual(
      6,
    );
  });
});

describe.skipIf(!hasFixture("gap-jump"))("the synthetic gap", () => {
  const { frames, resets } = replay(fixtureSamples("gap-jump"));

  it("resets exactly once, where the jump is flagged", () => {
    expect(resets).toEqual(["discontinuity"]);
  });

  it("starts the window again from that sample", () => {
    const jump = frames.find((frame) => frame.guards.discontinuity);
    expect(jump).toBeDefined();
    expect(jump?.window.samples).toBe(1);
    expect(jump?.guards.warmup).toBe(true);
    expect(jump?.cycles_per_hour).toBeUndefined();
    expect(jump?.decay_median).toBeUndefined();
    expect(jump?.rolling.loaded_run_s).toBeUndefined();
  });

  it("carries nothing from before the jump into the frames after it", () => {
    const jumpIndex = frames.findIndex((frame) => frame.guards.discontinuity);
    expect(jumpIndex).toBeGreaterThan(0);
    const before = frames[jumpIndex - 1] as FeatureFrame;
    const after = frames[jumpIndex] as FeatureFrame;
    expect(before.window.samples).toBeGreaterThan(after.window.samples);
    expect(Date.parse(after.window.from_sim_ts)).toBe(after.sim_ts_ms);
  });
});
