// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `suspect-event` builder.
 *
 * Everything downstream of detection reads this message and nothing else, so
 * the tests here are about what it says rather than about how it was computed:
 * which symptom it names, which rules it lists under that symptom, which
 * observations it carries, which sentences the ticket will repeat, and whether
 * the contracts accept it.
 *
 * The frames come from the synthetic first-month cycle; the hits are written
 * out by hand, because the point of each case is the choice the builder makes
 * between them.
 */

import { assertValid, validate, type SeverityLevel } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { baseline, scenarioBatches } from "../../test/fixtures/synthetic/index.ts";
import { BASELINE_REF } from "./baseline.ts";
import { observations } from "./features.ts";
import { framesOf, lastFrameIn, ROLES } from "./rules/frames.test-helper.ts";
import { REGISTRY } from "./rules/index.ts";
import { SIGNAL_ROLES } from "./signals.ts";
import { buildSuspectEvent, MAX_OBSERVATIONS, SUSPECT_EVENT_SCHEMA } from "./suspect.ts";
import { BEHAVIOUR_IDS, type FeatureFrame, type Observation, type RuleHit } from "./types.ts";

const healthy = framesOf(scenarioBatches(baseline(8)).flatMap((batch) => batch.samples));
const frame: FeatureFrame = lastFrameIn(healthy, "loaded");
const list: Observation[] = observations(frame, ROLES);

function isBehaviour(signalId: string): boolean {
  return (BEHAVIOUR_IDS as readonly string[]).includes(signalId);
}

/** Out of its band, or not flat inside it. */
function hasMoved(observation: Observation): boolean {
  return observation.level !== "normal" || observation.trend !== "flat";
}

/** The same observations, every one of them sitting still inside its band. */
function stilled(given: readonly Observation[]): Observation[] {
  return given.map((observation) => ({
    ...observation,
    level: "normal" as const,
    trend: "flat" as const,
  }));
}

/** `count` made-up signals far above their band, to push against the cap. */
function spareMoving(count: number): Observation[] {
  return Array.from({ length: count }, (_, index) => ({
    ...(list[0] as Observation),
    signal_id: `spare_signal_${String(index)}`,
    level: "far_above_normal" as const,
  }));
}

/**
 * The metrics of the observation sentences as the builder wrote them before
 * it carried every observation: the behaviours and the moving signals,
 * capped, and of those only the ones that moved. The fuller `observations` must not change `evidence`, so the old
 * selection stays here as the reference.
 */
function evidenceMetricsBeforeTheFullSet(given: readonly Observation[]): string[] {
  return given
    .filter((observation) => isBehaviour(observation.signal_id) || hasMoved(observation))
    .slice(0, MAX_OBSERVATIONS)
    .filter(hasMoved)
    .map((observation) => observation.signal_id);
}

const CONTEXT = {
  unitId: "cau-7",
  wallTs: "2026-09-21T00:00:00.000Z",
  eventId: "3f1d6a58-0a2f-4d0b-9a3e-2c6b5d4e7f01",
};

function hit(
  ruleId: string,
  symptom: string,
  severity: SeverityLevel,
  extra: Partial<RuleHit> = {},
): RuleHit {
  return {
    rule_id: ruleId,
    symptom_key: symptom,
    severity_hint: severity,
    since_sim_ts: frame.sim_ts,
    detail: `Something about ${ruleId} a technician can read.`,
    ...extra,
  };
}

const STUCK = hit("stuck_loaded", "continuous_load", "high", {
  since_sim_ts: new Date(frame.sim_ts_ms - 3_600_000).toISOString(),
  value: 3600,
  threshold: 600,
  unit: "s",
});
const PURGE = hit("purge_pressure_high", "purge_pressure_high", "high", {
  value: 0.9,
  threshold: 0.5,
  unit: "bar",
});
const SWITCH = hit("low_pressure_switch", "low_line_pressure", "critical");
const CYCLING = hit("frequent_cycling", "frequent_cycling", "medium");
const LONG_RUNS = hit("long_loaded_runs", "frequent_cycling", "medium");

describe("the message", () => {
  const event = buildSuspectEvent([STUCK, PURGE, CYCLING], frame, list, CONTEXT);

  it("is a suspect event the contracts accept", () => {
    expect(() => assertValid("suspect-event", event)).not.toThrow();
  });

  it("carries the envelope and the ids it was given", () => {
    expect(event.schema).toBe(SUSPECT_EVENT_SCHEMA);
    expect(event.unit_id).toBe(CONTEXT.unitId);
    expect(event.wall_ts).toBe(CONTEXT.wallTs);
    expect(event.event_id).toBe(CONTEXT.eventId);
    expect(event.sim_ts).toBe(frame.sim_ts);
  });

  it("reads the machine state, the ambient bucket and the baseline off the frame", () => {
    expect(event.machine_state).toEqual({
      mode: frame.mode,
      since_sim_ts: frame.mode_since_sim_ts,
      dryer_tower: frame.dryer_tower,
    });
    expect(event.ambient).toBe(frame.ambient_bucket);
    expect(event.baseline_ref).toBe(BASELINE_REF);
    expect(event.active_alarms).toEqual([...frame.active_alarms]);
  });

  it("opens its window at the earliest onset and closes it now", () => {
    expect(event.window.from_sim_ts).toBe(STUCK.since_sim_ts);
    expect(event.window.to_sim_ts).toBe(frame.sim_ts);
    expect(event.window.samples).toBe(frame.window.samples);
  });
});

describe("the symptom the event is about", () => {
  it("is the highest-severity hit, and the others are co-symptoms", () => {
    const event = buildSuspectEvent([CYCLING, SWITCH, STUCK], frame, list, CONTEXT);
    expect(event.symptom_key).toBe("low_line_pressure");
    expect(event.rule_ids).toEqual(["low_pressure_switch"]);
    expect(event.co_symptoms).toEqual(["continuous_load", "frequent_cycling"]);
  });

  it("breaks a tie by registry order", () => {
    const event = buildSuspectEvent([PURGE, STUCK], frame, list, CONTEXT);
    expect(event.symptom_key).toBe("continuous_load");
    expect(event.co_symptoms).toEqual(["purge_pressure_high"]);
  });

  it("lists every rule of that symptom, in registry order", () => {
    const event = buildSuspectEvent([LONG_RUNS, CYCLING], frame, list, CONTEXT);
    expect(event.symptom_key).toBe("frequent_cycling");
    expect(event.rule_ids).toEqual(["frequent_cycling", "long_loaded_runs"]);
    expect(event.co_symptoms).toEqual([]);
  });

  it("names each co-symptom once", () => {
    const event = buildSuspectEvent([STUCK, CYCLING, LONG_RUNS], frame, list, CONTEXT);
    expect(event.co_symptoms).toEqual(["frequent_cycling"]);
  });

  it("refuses to build an event no rule stands behind", () => {
    expect(() => buildSuspectEvent([], frame, list, CONTEXT)).toThrow(/at least one rule hit/);
  });

  it("refuses to build an event with nothing observed", () => {
    expect(() => buildSuspectEvent([STUCK], frame, [], CONTEXT)).toThrow(
      /at least one observation/,
    );
  });
});

describe("rules_fired", () => {
  const event = buildSuspectEvent([STUCK, PURGE], frame, list, CONTEXT);

  it("repeats the numbers of every rule under the symptom", () => {
    expect(event.rules_fired).toEqual([
      {
        rule_id: "stuck_loaded",
        since_sim_ts: STUCK.since_sim_ts,
        detail: STUCK.detail,
        value: 3600,
        threshold: 600,
        unit: "s",
      },
    ]);
  });

  it("agrees with rule_ids", () => {
    expect(event.rules_fired.map((rule) => rule.rule_id)).toEqual([...event.rule_ids]);
  });
});

describe("evidence", () => {
  const event = buildSuspectEvent([STUCK], frame, list, CONTEXT);

  it("starts with one item per firing rule", () => {
    const first = event.evidence[0];
    expect(first.metric).toBe("loaded_run_duration");
    expect(first.observation).toBe(STUCK.detail);
    expect(first.value).toBe(3600);
    expect(first.unit).toBe("s");
    expect(first.baseline).toBe(600);
    expect(first.duration).toBe("about an hour");
  });

  it("names a signal metric by its register-map tag", () => {
    const purge = buildSuspectEvent([PURGE], frame, list, CONTEXT);
    expect(purge.evidence[0].metric).toBe(ROLES.dv_pressure.signal_id);
  });

  it("continues with one sentence per observation that is not normal and flat", () => {
    const moved = list.map((observation, index) =>
      index === 0 ? { ...observation, level: "far_above_normal" as const } : observation,
    );
    const event2 = buildSuspectEvent([STUCK], frame, moved, CONTEXT);
    const sentence = event2.evidence.find((item) => item.metric === moved[0]?.signal_id);
    expect(sentence?.observation).toBe(
      `${moved[0]?.label ?? ""} far above normal, ` +
        `${(moved[0]?.trend ?? "").replaceAll("_", " ")} for ` +
        `${(moved[0]?.since ?? "").replaceAll("_", " ")}.`,
    );
    expect(sentence?.unit).toBe(moved[0]?.unit);
  });

  it("leaves a number out rather than carrying an empty one", () => {
    const bare = buildSuspectEvent([SWITCH], frame, list, CONTEXT);
    expect(Object.keys(bare.evidence[0]).sort()).toEqual(["duration", "metric", "observation"]);
    expect(validate("suspect-event", bare).ok).toBe(true);
  });

  it("is the same set of sentences as before the event carried every observation", () => {
    const disturbed = list.map((observation) =>
      observation.signal_id === ROLES.lps.signal_id ||
      observation.signal_id === ROLES.oil_temperature.signal_id
        ? { ...observation, level: "far_above_normal" as const }
        : observation,
    );
    const crowded = [...spareMoving(30), ...list];
    for (const [name, given] of [
      ["the synthetic frame", list],
      ["two signals pushed out of their band", disturbed],
      ["more moving observations than the cap", crowded],
    ] as const) {
      const built = buildSuspectEvent([STUCK], frame, given, CONTEXT);
      const sentences = built.evidence.slice(1).map((item) => item.metric);
      expect(sentences, name).toEqual(evidenceMetricsBeforeTheFullSet(given));
    }
  });

  it("gives a signal sitting still no sentence, though it travels as an observation", () => {
    const quiet = buildSuspectEvent([STUCK], frame, stilled(list), CONTEXT);
    expect(quiet.evidence.map((item) => item.metric)).toEqual(["loaded_run_duration"]);
    expect(quiet.observations).toHaveLength(list.length);
  });
});

describe("observations", () => {
  it("keeps every derived behaviour and every signal that moved", () => {
    const event = buildSuspectEvent([STUCK], frame, list, CONTEXT);
    const kept = event.observations.map((observation) => observation.signal);
    for (const id of BEHAVIOUR_IDS) {
      if (list.some((observation) => observation.signal_id === id)) expect(kept).toContain(id);
    }
    for (const observation of list) {
      const normal = observation.level === "normal" && observation.trend === "flat";
      const behaviour = (BEHAVIOUR_IDS as readonly string[]).includes(observation.signal_id);
      if (!normal || behaviour)
        expect(kept, observation.signal_id).toContain(observation.signal_id);
    }
  });

  it("keeps a signal sitting still inside its band", () => {
    const quiet = stilled(list);
    const event = buildSuspectEvent([STUCK], frame, quiet, CONTEXT);
    const kept = event.observations.map((observation) => observation.signal);
    const ids = quiet.map((observation) => observation.signal_id);
    expect(kept).toEqual([...ids.filter(isBehaviour), ...ids.filter((id) => !isBehaviour(id))]);
  });

  it("carries every signal role and every behaviour the frame could compute", () => {
    const event = buildSuspectEvent([STUCK], frame, list, CONTEXT);
    const kept = event.observations.map((observation) => observation.signal);
    expect([...kept].sort()).toEqual(list.map((observation) => observation.signal_id).sort());
    for (const role of SIGNAL_ROLES) expect(kept, role).toContain(ROLES[role].signal_id);
    expect(kept.length).toBeLessThanOrEqual(MAX_OBSERVATIONS);
  });

  it("keeps the steady expectations' signals when they sit normal and flat", () => {
    const event = buildSuspectEvent([STUCK], frame, stilled(list), CONTEXT);
    for (const id of [
      "low_pressure_switch",
      "purge_switch",
      "motor_current",
      "ambient_temperature",
    ]) {
      const carried = event.observations.find((observation) => observation.signal === id);
      expect(carried, id).toMatchObject({ level: "normal", trend: "flat" });
    }
  });

  it("puts the behaviours and the signals that moved ahead of the still ones", () => {
    const event = buildSuspectEvent([STUCK], frame, list, CONTEXT);
    const kept = event.observations.map((observation) => observation.signal);
    const leading = list.filter(
      (observation) => isBehaviour(observation.signal_id) || hasMoved(observation),
    );
    const still = list.filter(
      (observation) => !isBehaviour(observation.signal_id) && !hasMoved(observation),
    );
    expect(leading.length).toBeGreaterThan(0);
    expect(still.length).toBeGreaterThan(0);
    expect(kept).toEqual([...leading, ...still].map((observation) => observation.signal_id));
  });

  it("carries the whole picture when nothing has moved", () => {
    const quiet = stilled(list.filter((observation) => !isBehaviour(observation.signal_id)));
    const event = buildSuspectEvent([STUCK], frame, quiet, CONTEXT);
    expect(event.observations).toHaveLength(quiet.length);
    expect(validate("suspect-event", event).ok).toBe(true);
  });

  it("never sends more than the cap", () => {
    const event = buildSuspectEvent([STUCK], frame, spareMoving(40), CONTEXT);
    expect(event.observations).toHaveLength(MAX_OBSERVATIONS);
  });

  it("lets the cap drop only signals sitting still", () => {
    const signals = list.filter((observation) => !isBehaviour(observation.signal_id));
    const quiet = stilled(signals);
    const moving = spareMoving(MAX_OBSERVATIONS - 4);
    const event = buildSuspectEvent([STUCK], frame, [...quiet, ...moving], CONTEXT);
    const kept = event.observations.map((observation) => observation.signal);
    expect(kept).toEqual(
      [...moving, ...quiet.slice(0, 4)].map((observation) => observation.signal_id),
    );

    const crowded = buildSuspectEvent([STUCK], frame, [...quiet, ...spareMoving(30)], CONTEXT);
    expect(crowded.observations.every((observation) => observation.level === "far_above")).toBe(
      true,
    );
  });

  it("narrows the internal words to the contract enums and keeps digits out", () => {
    const event = buildSuspectEvent([STUCK], frame, list, CONTEXT);
    for (const observation of event.observations) {
      expect(["far_below", "below", "normal", "above", "far_above", "unknown"]).toContain(
        observation.level,
      );
      expect(["falling", "flat", "rising", "erratic", "stuck", "unknown"]).toContain(
        observation.trend,
      );
      expect(observation.since ?? "", observation.signal).not.toMatch(/[_0-9]/);
    }
  });
});

describe("every rule of the registry", () => {
  it("produces a message that validates", () => {
    for (const rule of REGISTRY) {
      const event = buildSuspectEvent(
        [hit(rule.id, rule.symptom_key, rule.severity_hint)],
        frame,
        list,
        CONTEXT,
      );
      const result = validate("suspect-event", event);
      expect(result.ok ? [] : result.errors, rule.id).toEqual([]);
      expect(event.symptom_key, rule.id).toBe(rule.symptom_key);
      expect(event.rule_ids, rule.id).toEqual([rule.id]);
    }
  });
});
