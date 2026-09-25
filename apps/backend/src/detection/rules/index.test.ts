// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The registry and its timers.
 *
 * Two jobs. The first is a snapshot: the rule table is a contract between
 * the manual, retrieval and the episode manager, so its ids, symptoms, holds
 * and severity hints are pinned here and a change to any of them has to be a
 * change to this file as well.
 *
 * The second is the behaviour the rules themselves do not have: the hold and
 * clear timers on the sim clock, the guards that suppress evaluation, the
 * staleness test that closes the frozen guard's latency, and the disabled
 * list.
 */

import { describe, expect, it } from "vitest";

import { baseline, scenarioBatches } from "../../../test/fixtures/synthetic/index.ts";
import type { FeatureFrame, Guards, RuleHit } from "../types.ts";
import { contextOf, framesOf, lastFrameIn, laterBy, withSignal } from "./frames.test-helper.ts";
import {
  createRuleEngine,
  DEFAULT_RULES_DISABLED,
  enabledRules,
  FROZEN_TUPLE_ROLES,
  isStale,
  REGISTRY,
  ruleById,
  ruleMetric,
  ruleOrder,
  type RuleLog,
} from "./index.ts";

/** The rule table (docs/detection.md), in its own order. */
const TABLE: readonly (readonly [string, string, number, string])[] = [
  ["stuck_loaded", "continuous_load", 0, "high"],
  ["purge_pressure_high", "purge_pressure_high", 0, "high"],
  ["fast_decay", "low_line_pressure", 0, "medium"],
  ["frequent_cycling", "frequent_cycling", 0, "medium"],
  ["long_loaded_runs", "frequent_cycling", 0, "medium"],
  ["low_pressure_switch", "low_line_pressure", 60, "critical"],
  ["oil_temperature_high", "oil_temperature_high", 1800, "medium"],
  ["oil_temperature_rising", "oil_temperature_high", 7200, "low"],
  ["motor_current_high", "motor_current_high", 60, "medium"],
  ["motor_current_low", "motor_current_low", 60, "medium"],
  ["discharge_differential_low", "motor_current_low", 60, "medium"],
  ["dryer_tower_not_switching", "dryer_changeover_fault", 0, "low"],
  ["separator_not_venting", "separator_pressure_abnormal", 0, "medium"],
  ["reservoir_pressure_mismatch", "reservoir_deviation", 300, "low"],
  ["low_oil_level", "oil_level_low", 300, "medium"],
  ["flow_pulses_missing", "no_flow_signal", 600, "low"],
];

/** The contracts' identifier grammar (common.schema.json). */
const IDENTIFIER = /^[a-z][a-z0-9_]{1,39}$/;

const healthy = framesOf(scenarioBatches(baseline(8)).flatMap((batch) => batch.samples));
const loaded = lastFrameIn(healthy, "loaded");

/** Loaded current above and inside the band of `motor_current_high` (hold 60 s). */
const HOT_A = 7.2;
const CALM_A = 6.0;

/**
 * A loaded frame `seconds` past the healthy one, with the line where it would
 * be a moment later.
 *
 * Every frame moves the line pressure, because a frame whose analog values
 * repeat is a stalled logger and the registry evaluates nothing on it (see
 * {@link isStale}); the staleness suite below builds its repeats on purpose.
 */
let tick = 0;
function frameAt(seconds: number, currentA: number): FeatureFrame {
  tick += 1;
  return withSignal(
    { ...laterBy(loaded, seconds), mode: "loaded", motor_current_loaded_a: currentA },
    "tp3",
    8 + tick / 1000,
  );
}

const PASSING: Guards = {
  discontinuity: false,
  frozen: false,
  parked: false,
  warmup: false,
};

/** Evaluate one frame with guards that pass, whatever the frame carried. */
function step(
  engine: ReturnType<typeof createRuleEngine>,
  frame: FeatureFrame,
  guards: Guards = PASSING,
): RuleHit[] {
  return engine.evaluate({ ...frame, guards }, { ...contextOf(frame), guards });
}

describe("the registry", () => {
  it("is the rule table, in its order", () => {
    expect(
      REGISTRY.map((rule) => [rule.id, rule.symptom_key, rule.hold_s, rule.severity_hint]),
    ).toEqual(TABLE.map((row) => [...row]));
  });

  it("uses ids and symptom keys the contracts accept", () => {
    for (const rule of REGISTRY) {
      expect(rule.id, rule.id).toMatch(IDENTIFIER);
      expect(rule.symptom_key, rule.id).toMatch(IDENTIFIER);
    }
    expect(new Set(REGISTRY.map((rule) => rule.id)).size).toBe(REGISTRY.length);
  });

  it("gives every rule a clear timer and a metric to report", () => {
    for (const rule of REGISTRY) {
      expect(rule.clear_s, rule.id).toBe(rule.hold_s);
      const metric = ruleMetric(rule.id, loaded);
      expect(metric.length, rule.id).toBeGreaterThan(0);
      expect(metric, rule.id).toMatch(IDENTIFIER);
    }
  });

  it("resolves a signal metric through the register map", () => {
    expect(ruleMetric("purge_pressure_high", loaded)).toBe(loaded.signals.dv_pressure.signal_id);
    expect(ruleMetric("stuck_loaded", loaded)).toBe("loaded_run_duration");
    expect(ruleMetric("not_a_rule", loaded)).toBe("not_a_rule");
  });

  it("looks a rule up by id and knows where it sits", () => {
    expect(ruleById("stuck_loaded")?.symptom_key).toBe("continuous_load");
    expect(ruleById("not_a_rule")).toBeUndefined();
    expect(ruleOrder("stuck_loaded")).toBe(0);
    expect(ruleOrder("flow_pulses_missing")).toBe(REGISTRY.length - 1);
    expect(ruleOrder("not_a_rule")).toBe(REGISTRY.length);
  });

  it("ships with the flow-pulse rule off", () => {
    expect(DEFAULT_RULES_DISABLED).toEqual(["flow_pulses_missing"]);
    expect(enabledRules().map((rule) => rule.id)).not.toContain("flow_pulses_missing");
    expect(enabledRules()).toHaveLength(REGISTRY.length - 1);
    expect(enabledRules([])).toHaveLength(REGISTRY.length);
  });
});

describe("RULES_DISABLED", () => {
  it("removes a rule from the engine entirely", () => {
    const engine = createRuleEngine({ rulesDisabled: ["motor_current_high"] });
    expect(engine.rules().map((rule) => rule.id)).not.toContain("motor_current_high");

    step(engine, frameAt(0, HOT_A));
    expect(step(engine, frameAt(120, HOT_A))).toEqual([]);
  });

  it("keeps the rule when the list does not name it", () => {
    const engine = createRuleEngine({ rulesDisabled: ["flow_pulses_missing"] });
    step(engine, frameAt(0, HOT_A));
    const hits = step(engine, frameAt(120, HOT_A));
    expect(hits.map((hit) => hit.rule_id)).toEqual(["motor_current_high"]);
  });
});

describe("the hold timer", () => {
  it("waits out the hold in sim time before reporting", () => {
    const engine = createRuleEngine();
    expect(step(engine, frameAt(0, HOT_A))).toEqual([]);
    expect(step(engine, frameAt(30, HOT_A))).toEqual([]);
    const hits = step(engine, frameAt(60, HOT_A));
    expect(hits.map((hit) => hit.rule_id)).toEqual(["motor_current_high"]);
  });

  it("dates the hit from the instant the condition first held", () => {
    const engine = createRuleEngine();
    const onset = frameAt(0, HOT_A);
    step(engine, onset);
    const [hit] = step(engine, frameAt(90, HOT_A));
    expect(hit?.since_sim_ts).toBe(onset.sim_ts);
  });

  it("restarts the hold when the condition lapses before it is reached", () => {
    const engine = createRuleEngine();
    step(engine, frameAt(0, HOT_A));
    step(engine, frameAt(30, CALM_A));
    expect(step(engine, frameAt(70, HOT_A))).toEqual([]);
    expect(step(engine, frameAt(140, HOT_A)).map((hit) => hit.rule_id)).toEqual([
      "motor_current_high",
    ]);
  });

  it("reports a rule with no hold on the first frame that meets it", () => {
    const engine = createRuleEngine();
    const stuck: FeatureFrame = {
      ...frameAt(0, CALM_A),
      loaded_run_s: 900,
      tp3_slope_bar_per_min: 0.01,
    };
    expect(step(engine, stuck).map((hit) => hit.rule_id)).toEqual(["stuck_loaded"]);
  });
});

describe("the clear timer", () => {
  it("keeps reporting until the condition has been false for the clear time", () => {
    const engine = createRuleEngine();
    step(engine, frameAt(0, HOT_A));
    expect(step(engine, frameAt(60, HOT_A))).toHaveLength(1);
    // Thirty seconds of calm is not enough for a rule that clears in sixty.
    expect(step(engine, frameAt(90, CALM_A))).toHaveLength(1);
    expect(step(engine, frameAt(150, CALM_A))).toEqual([]);
  });

  it("does not make a rule serve its hold again after a blip", () => {
    const engine = createRuleEngine();
    step(engine, frameAt(0, HOT_A));
    const [first] = step(engine, frameAt(60, HOT_A));
    step(engine, frameAt(80, CALM_A));
    const [again] = step(engine, frameAt(100, HOT_A));
    expect(again?.since_sim_ts).toBe(first?.since_sim_ts);
  });
});

describe("the guards", () => {
  it.each([["discontinuity"], ["frozen"], ["parked"], ["warmup"]] as const)(
    "evaluates nothing while %s holds",
    (guard) => {
      const engine = createRuleEngine();
      step(engine, frameAt(0, HOT_A));
      step(engine, frameAt(60, HOT_A));
      expect(engine.firing()).toHaveLength(1);

      expect(step(engine, frameAt(90, HOT_A), { ...PASSING, [guard]: true })).toEqual([]);
      expect(engine.firing()).toEqual([]);
    },
  );

  it("makes the rule serve its hold again once the guard lifts", () => {
    const engine = createRuleEngine();
    step(engine, frameAt(0, HOT_A));
    step(engine, frameAt(60, HOT_A));
    step(engine, frameAt(90, HOT_A), { ...PASSING, parked: true });
    expect(step(engine, frameAt(120, HOT_A))).toEqual([]);
    expect(step(engine, frameAt(200, HOT_A))).toHaveLength(1);
  });
});

describe("the staleness test", () => {
  it("watches the five analog values the frozen guard watches", () => {
    expect([...FROZEN_TUPLE_ROLES]).toEqual([
      "tp2",
      "tp3",
      "h1",
      "oil_temperature",
      "motor_current",
    ]);
  });

  it("has nothing to compare the first frame against", () => {
    expect(isStale(loaded, undefined)).toBe(false);
  });

  it("sees a repeated frame and a moved one apart", () => {
    expect(isStale(laterBy(loaded, 60), loaded)).toBe(true);
    expect(isStale(withSignal(laterBy(loaded, 60), "tp3", 9.1), loaded)).toBe(false);
  });

  it("evaluates nothing on a frame the logger did not move", () => {
    // The same five analog values sixty seconds later is a stalled logger, not
    // a machine that held a fault for a minute.
    const first = frameAt(0, HOT_A);
    const stalled = createRuleEngine();
    step(stalled, first);
    expect(step(stalled, laterBy(first, 60))).toEqual([]);

    // The same sequence with the line moving is a machine, and it reports.
    const moving = createRuleEngine();
    step(moving, frameAt(0, HOT_A));
    expect(step(moving, frameAt(60, HOT_A))).toHaveLength(1);
  });

  it("looks at the frames again after a reset", () => {
    const engine = createRuleEngine();
    step(engine, frameAt(0, HOT_A));
    engine.reset();
    expect(engine.firing()).toEqual([]);
    expect(step(engine, frameAt(60, HOT_A))).toEqual([]);
  });
});

describe("the debug log", () => {
  it("names the rule when it first fires and when it clears", () => {
    const lines: { message: string; rule: unknown }[] = [];
    const logger: RuleLog = {
      debug(object, message) {
        lines.push({ message, rule: object.rule_id });
      },
    };
    const engine = createRuleEngine({ logger });
    step(engine, frameAt(0, HOT_A));
    step(engine, frameAt(60, HOT_A));
    step(engine, frameAt(90, HOT_A));
    step(engine, frameAt(200, CALM_A));
    step(engine, frameAt(270, CALM_A));

    expect(lines).toEqual([
      { message: "rule fired", rule: "motor_current_high" },
      { message: "rule cleared", rule: "motor_current_high" },
    ]);
  });
});
