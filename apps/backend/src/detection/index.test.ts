// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The detector, end to end over a stream of samples.
 *
 * The positives are the synthetic signatures of `test/fixtures/synthetic` plus
 * the unlabelled continuous-load episode of the recording; the negatives are
 * the four fixtures whose whole purpose is to stay silent — a first-month
 * morning, a normal summer day, a stalled logger and a depot stop.
 *
 * No test here encodes a labelled failure window: the unlabelled May
 * episode lies outside every scored window, and the onset timing of F1–F4
 * belongs to the eval scenarios.
 */

import { SIGNALS, assertValid, type Sample } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { fixedClock } from "../clock.ts";
import {
  baseline,
  fastDecay,
  frequentCycling,
  lowPressureSwitch,
  scenarioBatches,
  type Scenario,
} from "../../test/fixtures/synthetic/index.ts";
import { hasFixture, loadFixture, type BackendFixtureName } from "../../test/helpers/fixtures.ts";
import { bucketString } from "./buckets.ts";
import {
  createDetector,
  type DetectionLog,
  type Detector,
  MAX_OBSERVATIONS,
  type SuspectEventMessage,
} from "./index.ts";
import { resolveRoles, SIGNAL_ROLES } from "./signals.ts";
import type { RuleHit } from "./types.ts";

const roles = resolveRoles(SIGNALS);

/** A detector whose wall clock and ids stand still, so a run is reproducible. */
function detector(options: { rulesDisabled?: readonly string[] } = {}): Detector {
  let next = 0;
  return createDetector({
    roles,
    rulesDisabled: options.rulesDisabled,
    wall: fixedClock("2026-09-21T00:00:00.000Z"),
    newEventId: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
  });
}

interface Run {
  readonly events: SuspectEventMessage[];
  readonly firing: RuleHit[];
  readonly detector: Detector;
  /** The sample index of the first sample that raised the discontinuity guard. */
  readonly jumpAt: number;
  /** The sim instant of each event, for the windows a test wants to look at. */
  readonly at: readonly number[];
}

function replay(
  samples: readonly Sample[],
  options: { rulesDisabled?: readonly string[] } = {},
): Run {
  const instance = detector(options);
  const events: SuspectEventMessage[] = [];
  const at: number[] = [];
  let jumpAt = -1;
  let firing: RuleHit[] = [];
  samples.forEach((sample, index) => {
    const output = instance.push(sample);
    if (output.guards.discontinuity && jumpAt < 0) jumpAt = index;
    for (const event of output.events) {
      events.push(event);
      at.push(index);
    }
    firing = output.firing;
  });
  return { events, firing, detector: instance, jumpAt, at };
}

function scenarioSamples(scenario: Scenario): Sample[] {
  return scenarioBatches(scenario).flatMap((batch) => batch.samples);
}

function fixtureSamples(name: BackendFixtureName): Sample[] {
  return loadFixture(name).batches.flatMap((batch) => batch.samples);
}

/** Every symptom the run raised an event for. */
function symptoms(run: Run): string[] {
  return [...new Set(run.events.map((event) => event.symptom_key))];
}

/** Every rule that appeared in an event, under its symptom or as a co-symptom. */
function firedRules(run: Run): string[] {
  return [...new Set(run.events.flatMap((event) => event.rule_ids))];
}

describe("a healthy machine", () => {
  const run = replay(scenarioSamples(baseline(8)));

  it("raises no event at all", () => {
    expect(run.events).toEqual([]);
    expect(run.firing).toEqual([]);
  });

  it("still builds a frame on every sim minute", () => {
    expect(run.detector.frame()).toBeDefined();
    expect(run.detector.buildEvent()).toBeUndefined();
  });
});

describe("the rules' synthetic signatures", () => {
  it("reads a fast-decay stream as a falling line and a machine cycling too often", () => {
    const run = replay(scenarioSamples(fastDecay(6)));
    expect(symptoms(run)).toEqual(
      expect.arrayContaining(["low_line_pressure", "frequent_cycling"]),
    );
    expect(firedRules(run)).toContain("fast_decay");
  });

  it("reads a frequent-cycling stream as frequent cycling", () => {
    const run = replay(scenarioSamples(frequentCycling(14)));
    expect(symptoms(run)).toContain("frequent_cycling");
    expect(firedRules(run)).toContain("frequent_cycling");
  });

  it("reads a closed low-pressure switch with the motor running as a critical event", () => {
    const run = replay(scenarioSamples(lowPressureSwitch()));
    expect(symptoms(run)).toEqual(["low_line_pressure"]);
    expect(firedRules(run)).toEqual(["low_pressure_switch"]);
    expect(run.events[0]?.evidence[0]?.observation).toContain("low-pressure switch");
  });

  it("emits one event when a symptom starts and not again while it keeps firing", () => {
    const run = replay(scenarioSamples(lowPressureSwitch()));
    expect(run.events).toHaveLength(1);
    expect(run.firing.map((hit) => hit.rule_id)).toEqual(["low_pressure_switch"]);
  });

  it("gives the episode manager the same message again for a re-decision", () => {
    const run = replay(scenarioSamples(lowPressureSwitch()));
    const again = run.detector.buildEvent();
    expect(again?.symptom_key).toBe("low_line_pressure");
    expect(again?.event_id).not.toBe(run.events[0]?.event_id);
    expect(again?.sim_ts).toBe(run.detector.frame()?.sim_ts);
  });
});

describe("RULES_DISABLED", () => {
  it("takes a rule out of the run", () => {
    const run = replay(scenarioSamples(lowPressureSwitch()), {
      rulesDisabled: ["low_pressure_switch", "flow_pulses_missing"],
    });
    expect(run.events).toEqual([]);
    expect(run.firing).toEqual([]);
  });
});

describe("every message that leaves detection", () => {
  const runs = [
    replay(scenarioSamples(fastDecay(6))),
    replay(scenarioSamples(frequentCycling(14))),
    replay(scenarioSamples(lowPressureSwitch())),
  ];

  it("validates against the contracts schema", () => {
    for (const run of runs) {
      expect(run.events.length).toBeGreaterThan(0);
      for (const event of run.events) {
        expect(() => assertValid("suspect-event", event)).not.toThrow();
      }
    }
  });

  it("carries every signal role, the ones sitting still included", () => {
    const tags = SIGNAL_ROLES.map((role) => roles[role].signal_id);
    for (const run of runs) {
      for (const event of run.events) {
        const carried = event.observations.map((observation) => observation.signal);
        expect(carried).toEqual(expect.arrayContaining(tags));
        expect(carried.length).toBeLessThanOrEqual(MAX_OBSERVATIONS);
        expect(
          event.observations.some(
            (observation) => observation.level === "normal" && observation.trend === "flat",
          ),
        ).toBe(true);
      }
    }
  });

  it("carries words with no digits in them", () => {
    for (const run of runs) {
      for (const event of run.events) {
        for (const observation of event.observations) {
          expect(observation.level, observation.signal).not.toMatch(/\d/);
          expect(observation.trend, observation.signal).not.toMatch(/\d/);
          expect(observation.since ?? "", observation.signal).not.toMatch(/[_0-9]/);
        }
        expect(event.ambient).not.toMatch(/\d/);
        for (const rule of event.rules_fired) expect(rule.detail, rule.rule_id).not.toMatch(/\d/);
      }
    }
  });

  it("writes the bucket sentence the decision state builder reads back", () => {
    const [first] = runs;
    const observation = first?.events[0]?.observations[0];
    expect(observation).toBeDefined();
    const sentence = [observation?.level, observation?.trend, observation?.since]
      .map((word) => (word ?? "").replaceAll("_", " "))
      .join("; ");
    expect(sentence).not.toMatch(/[_0-9]/);
    expect(bucketString("normal", "flat", "seconds")).toBe("normal; flat; seconds");
  });
});

describe("resetting the detector", () => {
  it("forgets the rules, so a symptom that is still firing raises a new event", () => {
    const samples = scenarioSamples(lowPressureSwitch());
    const instance = detector();
    let events = 0;
    for (const sample of samples) events += instance.push(sample).events.length;
    expect(events).toBe(1);

    instance.reset("startup");
    expect(instance.firing()).toEqual([]);
    expect(instance.frame()).toBeUndefined();

    let after = 0;
    for (const sample of samples) after += instance.push(sample).events.length;
    expect(after).toBe(1);
  });
});

describe("a message that cannot validate", () => {
  it("is logged and dropped rather than thrown", () => {
    const warnings: string[] = [];
    const logger: DetectionLog = {
      debug() {
        // The detector's debug lines are the registry's; this test is about warn.
      },
      warn(_object, message) {
        warnings.push(message);
      },
    };
    const instance = createDetector({
      roles,
      wall: fixedClock("2026-09-21T00:00:00.000Z"),
      // A unit id the envelope's `unit_id` pattern refuses.
      unitId: "Not A Unit Id",
      logger,
    });
    let events = 0;
    for (const sample of scenarioSamples(lowPressureSwitch())) {
      events += instance.push(sample).events.length;
    }
    expect(events).toBe(0);
    expect(warnings).toContain("suspect event does not match its schema; dropped");
  });
});

describe.each([["baseline-feb"], ["summer-jul05"], ["frozen-jun22"], ["depot-apr30"]] as const)(
  "the negative fixture %s",
  (name) => {
    it.skipIf(!hasFixture(name))("raises no event", () => {
      const run = replay(fixtureSamples(name));
      expect(run.events.map((event) => `${event.sim_ts} ${event.symptom_key}`)).toEqual([]);
    });
  },
);

describe.skipIf(!hasFixture("unlabelled-may19"))("the unlabelled continuous-load episode", () => {
  const run = replay(fixtureSamples("unlabelled-may19"));

  /** The unlabelled episode starts here; the fixture leads in from 21:00. */
  const ONSET_MS = Date.parse("2020-05-19T22:22:00.000Z");

  it("names the continuous load and the purge pressure once the run is established", () => {
    const established = run.events.filter((event) => Date.parse(event.sim_ts) >= ONSET_MS);
    expect([...new Set(established.map((event) => event.symptom_key))]).toEqual(
      expect.arrayContaining(["continuous_load", "purge_pressure_high"]),
    );
  });

  it("says nothing about either of them in the lead-in hour", () => {
    const before = run.events.filter((event) => Date.parse(event.sim_ts) < ONSET_MS);
    for (const event of before) {
      expect(["continuous_load", "purge_pressure_high"]).not.toContain(event.symptom_key);
      expect(event.co_symptoms).not.toContain("continuous_load");
      expect(event.co_symptoms).not.toContain("purge_pressure_high");
    }
  });

  it("carries the other symptoms of the episode along with the primary one", () => {
    const stuck = run.events.find((event) => event.symptom_key === "continuous_load");
    expect(stuck?.rule_ids).toEqual(["stuck_loaded"]);
    expect(stuck?.co_symptoms).toContain("purge_pressure_high");
    expect(stuck?.evidence.length).toBeGreaterThan(1);
  });

  it("emits messages the contracts accept, every one of them", () => {
    expect(run.events.length).toBeGreaterThan(0);
    for (const event of run.events) expect(() => assertValid("suspect-event", event)).not.toThrow();
  });
});

describe.skipIf(!hasFixture("gap-jump"))("the synthetic gap", () => {
  const run = replay(fixtureSamples("gap-jump"));

  it("finds the jump", () => {
    expect(run.jumpAt).toBeGreaterThan(0);
  });

  it("says nothing in the thirty samples that follow it", () => {
    const quiet = run.at.filter((index) => index >= run.jumpAt && index < run.jumpAt + 30);
    expect(quiet).toEqual([]);
  });

  it("picks the episode up again once the windows have refilled", () => {
    expect(symptoms(run)).toContain("continuous_load");
  });
});
