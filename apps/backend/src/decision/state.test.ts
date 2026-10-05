// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The state every backend reads.
 *
 * Three properties carry the weight here and all three are asserted over every
 * fixture event rather than over one hand-picked case:
 *
 *  * it fits the budget — a state that grew by a candidate or by a longer
 *    manual sentence is a silent cost regression through `app.cost_ledger`;
 *  * no bucket word contains a digit — the moment a level reads "level two"
 *    the model is being asked to compare numbers, which is what the whole
 *    bucket vocabulary exists to avoid;
 *  * every path a question names resolves — an `inspect` entry that points at
 *    nothing is a question asked about missing data.
 */

import { describe, expect, it } from "vitest";

import { assertValid, SIGNALS } from "@fdp/contracts";
import type { LevelBucket, SignalMove, SuspectEvent, TrendBucket } from "@fdp/contracts";

import { VALUE_WINDOW_S } from "../detection/features.ts";
import { RUNNING_CURRENT_A } from "../detection/state.ts";
import { moveTarget, parseObservedBuckets } from "../retrieval/match.ts";
import { candidatesFor, catalogEntry, FIXTURE_LABELS } from "../../test/fixtures/catalog/index.ts";
import { asCandidates, causesUnder, manEntry } from "../../test/fixtures/catalog/man/index.ts";
import {
  dryerTowersHeld,
  S304_CURRENT_A,
  S304_HOLD_S,
  separatorDrainOpen,
  startFailure,
  type StartFailure,
} from "../../test/fixtures/synthetic/calibration.ts";
import {
  BASELINE_EVENT,
  DEPOT_LPS_EVENT,
  FIXTURE_CASES,
  FIXTURE_UNIT_ID,
  OIL_COOLER_CANDIDATE_IDS,
  OIL_COOLER_EVENT,
  SIGNATURE_A_CANDIDATE_IDS,
  SIGNATURE_A_EVENT,
} from "../../test/fixtures/catalog/events.ts";
import {
  buildState,
  byHoursWords,
  canonicalStateJson,
  estimateTokens,
  inspectPathsFor,
  LOADED_MOTOR_NOT_RUNNING,
  MACHINE_KIND,
  MAX_OBSERVATIONS,
  NO_ALARMS,
  QUIET_HOURS_WORDS,
  resolveStatePath,
  stateDigest,
  STATE_TOKEN_BUDGET,
} from "./state.ts";
import type { DecisionState, SignalLabels } from "./state.ts";
import type { DecisionInput } from "./types.ts";
import {
  buildQuestions,
  estimateQuestionTokens,
  LONGEST_QUESTION_TOKEN_BUDGET,
  longestQuestionTokens,
  REQUEST_TOKEN_BUDGET,
} from "./von/questions.ts";

function inputFor(event: DecisionInput["event"], candidateIds: readonly string[]): DecisionInput {
  return {
    event,
    candidates: candidatesFor(candidateIds),
    unit_id: FIXTURE_UNIT_ID,
  };
}

const CASES = FIXTURE_CASES.map((testCase) => ({
  name: testCase.name,
  input: inputFor(testCase.event, testCase.candidateIds),
}));

describe.each(CASES)("buildState: $name", ({ input }) => {
  const state = buildState(input, FIXTURE_LABELS);

  it("fits the state's size budget", () => {
    expect(estimateTokens(state)).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
  });

  it("puts no digit in any level, trend or duration word", () => {
    const words = [
      state.machine.mode,
      state.machine.mode_for,
      state.machine.ambient,
      state.symptom.for,
      ...state.observations.flatMap((observation) => [
        observation.level,
        observation.trend,
        observation.since,
      ]),
    ];
    for (const word of words) expect(word).not.toMatch(/\d/);
  });

  it("resolves every path the question set inspects", () => {
    const paths = inspectPathsFor(state);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(resolveStatePath(state, path), `path ${path}`).toBeDefined();
    }
  });

  it("keeps the observation list inside its cap", () => {
    expect(state.observations.length).toBeGreaterThan(0);
    expect(state.observations.length).toBeLessThanOrEqual(MAX_OBSERVATIONS);
  });

  it("names every observation and every candidate", () => {
    for (const observation of state.observations) {
      expect(observation.label.length).toBeGreaterThan(0);
      expect(observation.label).not.toMatch(/_/);
    }
    for (const candidate of state.candidates) {
      expect(candidate.cause.length).toBeGreaterThan(0);
      expect(candidate.condition.length).toBeGreaterThan(0);
      expect(candidate.expected_signal_moves.length).toBeGreaterThan(0);
    }
  });

  it("is a twin of the candidates it was built from", () => {
    expect(state.candidates.map((candidate) => candidate.id)).toEqual(
      input.candidates.map((candidate) => candidate.fault_id),
    );
  });
});

describe("buildState: what reaches the model", () => {
  const input = inputFor(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS);
  const state = buildState(input, FIXTURE_LABELS);

  it("describes the machine, its state and the weather in words", () => {
    expect(state.machine).toEqual({
      kind: MACHINE_KIND,
      mode: "loaded",
      mode_for: "about an hour",
      ambient: "warm",
    });
  });

  it("names the symptom and what else is firing with the manual's titles", () => {
    expect(state.symptom).toEqual({
      condition: "Compressor stays loaded and does not reach cut-out",
      also_present: ["Dryer purge pressure high, air escaping at the purge silencer"],
      for: "about an hour",
    });
  });

  it("orders the observations by how far out of band they sit", () => {
    expect(state.observations.slice(0, 3).map((observation) => observation.signal)).toEqual([
      "loaded_run_duration",
      "dryer_purge_pressure",
      "cut_out_reached",
    ]);
  });

  it("splits the bucket words the way detection joined them", () => {
    const purge = state.observations.find(
      (observation) => observation.signal === "dryer_purge_pressure",
    );
    // The fixture's first evidence item, the rule's, measured this row, so its
    // sentence travels beside the words.
    expect(purge).toEqual({
      signal: "dryer_purge_pressure",
      label: "Dryer purge pressure",
      level: "far above normal",
      trend: "flat",
      since: "about an hour",
      seen: "Dryer purge pressure has been far above its normal band for about an hour.",
    });
  });

  it("carries the controller messages with their titles", () => {
    expect(state.controller_alarms).toEqual([
      "W102 Continuous load time exceeded",
      "W103 Dryer purge pressure high",
    ]);
  });

  it("quotes the manual's own sentences as the expected movements", () => {
    const leak = state.candidates.find((candidate) => candidate.id === "dryer_purge_leak");
    expect(leak?.expected_signal_moves).toEqual(catalogEntry("dryer_purge_leak").signal_moves_text);
    expect(leak?.benign).toBe(false);
  });

  it("marks a benign cause as benign", () => {
    const demand = state.candidates.find((candidate) => candidate.id === "high_air_demand");
    expect(demand?.benign).toBe(true);
  });

  it("says `none` rather than nothing when the controller is quiet", () => {
    const quiet = buildState(inputFor(BASELINE_EVENT, ["high_air_demand"]), FIXTURE_LABELS);
    expect(quiet.controller_alarms).toEqual([NO_ALARMS]);
  });

  it("keeps a signal a candidate expects to stay normal", () => {
    const oil = buildState(inputFor(OIL_COOLER_EVENT, OIL_COOLER_CANDIDATE_IDS), FIXTURE_LABELS);
    const ambient = oil.observations.find(
      (observation) => observation.signal === "ambient_temperature",
    );
    expect(ambient).toMatchObject({ level: "normal", trend: "flat" });
  });

  it("drops a signal that is behaving and that no candidate asked about", () => {
    const narrow = buildState(inputFor(OIL_COOLER_EVENT, ["oil_level_low"]), FIXTURE_LABELS);
    expect(narrow.observations.map((observation) => observation.signal)).toEqual([
      "oil_temperature",
      "load_cycle_rate",
      "oil_level_ok",
    ]);
  });

  it("falls back to the signal id when nothing named it", () => {
    const unnamed = buildState(input);
    const purge = unnamed.observations.find(
      (observation) => observation.signal === "dryer_purge_pressure",
    );
    expect(purge?.label).toBe("dryer purge pressure");
  });
});

/** One row of the crowded event and the order weight the builder gives it. */
type CrowdedRow = readonly [signal: string, level: LevelBucket, trend: TrendBucket, weight: number];

/**
 * A crowded event: every signal and behaviour of the unit, most of them moving.
 *
 * It is written by hand for the observation cap. The last column
 * is the order weight the builder gives the row — far off its band 3, off it
 * 2; erratic or stuck 2, rising or falling 1 — not anything detection
 * measured. Sixteen rows move, four more than the cap holds. The rows a
 * candidate names while they sit normal and flat are spread through the list,
 * because ordered by magnitude alone they are exactly the rows the cap cuts.
 */
const CROWDED_ROWS: readonly CrowdedRow[] = [
  ["line_pressure", "far_below", "falling", 4],
  ["purge_switch", "normal", "flat", 0],
  ["discharge_pressure", "below", "flat", 2],
  ["motor_current", "above", "erratic", 4],
  ["cut_out_reached", "normal", "flat", 0],
  ["flow_pulse", "far_below", "stuck", 5],
  ["separator_discharge_pressure", "below", "rising", 3],
  ["load_cycle_rate", "normal", "flat", 0],
  ["reservoir_pressure", "below", "flat", 2],
  ["dryer_purge_pressure", "far_above", "flat", 3],
  ["intake_closed", "normal", "stuck", 2],
  ["oil_level_ok", "normal", "flat", 0],
  ["load_valve", "normal", "erratic", 2],
  ["unloaded_pressure_decay", "far_above", "erratic", 5],
  ["oil_temperature", "above", "rising", 3],
  ["dryer_tower", "normal", "rising", 1],
  ["loaded_run_duration", "far_above", "rising", 4],
  ["regulator_contact", "normal", "falling", 1],
  ["ambient_temperature", "above", "flat", 2],
  ["start_current_peak", "above", "rising", 3],
  ["low_pressure_switch", "normal", "flat", 0],
  ["pressure_rise_while_loaded", "below", "falling", 3],
];

const CROWDED_EVENT: SuspectEvent = assertValid("suspect-event", {
  ...SIGNATURE_A_EVENT,
  event_id: "88888888-8888-4888-8888-888888888888",
  observations: CROWDED_ROWS.map(([signal, level, trend]) => ({
    signal,
    level,
    trend,
    since: "about an hour",
  })),
});

const CROWDED_WEIGHTS: ReadonlyMap<string, number> = new Map(
  CROWDED_ROWS.map(([signal, , , weight]) => [signal, weight]),
);

/**
 * Two causes whose expectations include a signal staying put and a switch
 * holding its state: the silencer expects the cut-out and the cycle rate
 * unchanged and the purge switch to stay on; the low oil level expects the
 * level switch off and the cycle rate unchanged.
 */
const CROWDED_CANDIDATE_IDS: readonly string[] = ["purge_silencer_damaged", "oil_level_low"];

/** The directions that expect a steady signal or a digital state. */
const RESTING_DIRECTIONS: ReadonlySet<SignalMove["direction"]> = new Set([
  "unchanged",
  "stays_on",
  "stays_off",
  "on",
  "off",
]);

function signalsOf(state: DecisionState): string[] {
  return state.observations.map((observation) => observation.signal);
}

/** Every signal or behaviour the candidates' expected movements name. */
function namedSignals(input: DecisionInput): ReadonlySet<string | undefined> {
  return new Set(input.candidates.flatMap((candidate) => candidate.signal_moves.map(moveTarget)));
}

describe("buildState: the cap keeps what the candidates name", () => {
  const input = inputFor(CROWDED_EVENT, CROWDED_CANDIDATE_IDS);
  const state = buildState(input, FIXTURE_LABELS);
  const named = namedSignals(input);

  it("is built on an event with more moving signals than the cap holds", () => {
    const moving = CROWDED_ROWS.filter(
      ([, level, trend]) => level !== "normal" || trend !== "flat",
    );
    expect(moving.length).toBeGreaterThan(MAX_OBSERVATIONS);
    expect(state.observations).toHaveLength(MAX_OBSERVATIONS);
  });

  it("puts the named signals first and fills the rest with unnamed moving ones by magnitude", () => {
    expect(signalsOf(state)).toEqual([
      // Named, by magnitude, ties in the event's order.
      "dryer_purge_pressure",
      "oil_temperature",
      "purge_switch",
      "cut_out_reached",
      "load_cycle_rate",
      "oil_level_ok",
      // Unnamed and moving, by magnitude, ties in the event's order.
      "flow_pulse",
      "unloaded_pressure_decay",
      "line_pressure",
      "motor_current",
      "loaded_run_duration",
      "separator_discharge_pressure",
    ]);
  });

  it("keeps every steady and digital expectation of every candidate, in words", () => {
    const resting = input.candidates.flatMap((candidate) =>
      candidate.signal_moves
        .filter((move) => RESTING_DIRECTIONS.has(move.direction))
        .map((move) => ({ candidate: candidate.fault_id, signal: moveTarget(move) })),
    );
    expect(resting.map(({ signal }) => signal)).toEqual([
      "purge_switch",
      "cut_out_reached",
      "load_cycle_rate",
      "oil_level_ok",
      "load_cycle_rate",
    ]);
    for (const { candidate, signal } of resting) {
      const kept = state.observations.find((observation) => observation.signal === signal);
      expect(kept, `${candidate} expects ${String(signal)}`).toMatchObject({
        level: "normal",
        trend: "flat",
        since: "about an hour",
      });
    }
  });

  it("leaves out only unnamed signals, none of them further off than one it kept", () => {
    const kept = signalsOf(state);
    const dropped = CROWDED_ROWS.map(([signal]) => signal).filter(
      (signal) => !kept.includes(signal),
    );
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.filter((signal) => named.has(signal))).toEqual([]);

    const weightOf = (signal: string): number => CROWDED_WEIGHTS.get(signal) ?? Number.NaN;
    const smallestKept = Math.min(
      ...kept.filter((signal) => !named.has(signal)).map((signal) => weightOf(signal)),
    );
    for (const signal of dropped) {
      expect(weightOf(signal), signal).toBeLessThanOrEqual(smallestKept);
    }
  });

  it("is deterministic, whatever order retrieval listed the candidates in", () => {
    const again = buildState(input, FIXTURE_LABELS);
    expect(again).toEqual(state);
    expect(stateDigest(again)).toBe(stateDigest(state));

    const reversed = buildState(
      inputFor(CROWDED_EVENT, [...CROWDED_CANDIDATE_IDS].reverse()),
      FIXTURE_LABELS,
    );
    expect(reversed.observations).toEqual(state.observations);
  });

  it("stays inside the budget and puts no digit in a word", () => {
    expect(estimateTokens(state)).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
    for (const observation of state.observations) {
      for (const word of [observation.level, observation.trend, observation.since]) {
        expect(word).not.toMatch(/\d/);
      }
    }
  });

  it("fills the cap with named signals alone when six candidates name more than it holds", () => {
    const wide = inputFor(CROWDED_EVENT, [
      "dryer_purge_leak",
      "purge_silencer_damaged",
      "downstream_air_leak",
      "intake_filter_clogged",
      "oil_cooler_fouled",
      "oil_level_low",
    ]);
    const wideNamed = namedSignals(wide);
    const observedNamed = CROWDED_ROWS.filter(([signal]) => wideNamed.has(signal));
    expect(observedNamed.length).toBeGreaterThan(MAX_OBSERVATIONS);

    // The named group is ordered by magnitude like the rest, so when it alone
    // overflows the cap its resting rows at the end are the ones cut
    // (`oil_level_ok`, `low_pressure_switch`) and no unnamed row enters, not
    // even the stuck flow pulse: the recorded limit of the ordering, which keeps
    // the cap at twelve.
    expect(signalsOf(buildState(wide, FIXTURE_LABELS))).toEqual([
      "unloaded_pressure_decay",
      "line_pressure",
      "motor_current",
      "loaded_run_duration",
      "dryer_purge_pressure",
      "oil_temperature",
      "pressure_rise_while_loaded",
      "discharge_pressure",
      "ambient_temperature",
      "purge_switch",
      "cut_out_reached",
      "load_cycle_rate",
    ]);
  });
});

describe("buildState: the idle decay by kind of hour", () => {
  const LEVELS: readonly LevelBucket[] = [
    "far_below",
    "below",
    "normal",
    "above",
    "far_above",
    "unknown",
  ];
  const LEAK_AND_DEMAND = asCandidates([
    manEntry("downstream_air_leak"),
    manEntry("high_air_demand"),
  ]);

  /** A first-month event of a fast idle decay, with `byHours` on the decay row or without. */
  function decayEvent(byHours?: { quiet: LevelBucket; busy: LevelBucket }): SuspectEvent {
    return assertValid("suspect-event", {
      ...BASELINE_EVENT,
      symptom_key: "low_line_pressure",
      rule_ids: ["fast_decay"],
      observations: [
        {
          signal: "unloaded_pressure_decay",
          level: "far_above",
          trend: "flat",
          since: "several hours",
          ...(byHours === undefined ? {} : { by_hours: byHours }),
        },
        { signal: "load_cycle_rate", level: "far_above", trend: "flat", since: "several hours" },
        { signal: "line_pressure", level: "normal", trend: "falling", since: "minutes" },
        { signal: "low_pressure_switch", level: "normal", trend: "flat", since: "days" },
      ],
    });
  }

  function stateOf(event: SuspectEvent): DecisionState {
    return buildState(
      { event, candidates: LEAK_AND_DEMAND, unit_id: FIXTURE_UNIT_ID },
      FIXTURE_LABELS,
    );
  }

  it("says a leak's decay stays fast when the plant draws least air", () => {
    expect(byHoursWords({ quiet: "far_above", busy: "above" })).toBe(
      `faster than usual in the busy hours and also in ${QUIET_HOURS_WORDS}`,
    );
  });

  it("says a demand's decay is fast only in the busy hours", () => {
    expect(byHoursWords({ quiet: "normal", busy: "far_above" })).toBe(
      `faster than usual only in the busy hours; as usual in ${QUIET_HOURS_WORDS}`,
    );
  });

  it("says a healthy decay is as usual in both", () => {
    expect(byHoursWords({ quiet: "normal", busy: "normal" })).toBe(
      `as usual in the busy hours and in ${QUIET_HOURS_WORDS}`,
    );
  });

  it("says which kind of hour it has not seen since the decay turned faster", () => {
    expect(byHoursWords({ quiet: "unknown", busy: "far_above" })).toBe(
      `faster than usual in the busy hours; ${QUIET_HOURS_WORDS}, not seen since it turned faster`,
    );
    expect(byHoursWords({ quiet: "unknown", busy: "normal" })).toBe(
      `as usual in the busy hours; ${QUIET_HOURS_WORDS}, not seen yet`,
    );
    expect(byHoursWords({ quiet: "above", busy: "unknown" })).toBe(
      `faster than usual in ${QUIET_HOURS_WORDS}; the busy hours not seen since it turned faster`,
    );
  });

  it("has a sentence for every pair but the one it knows nothing about, none with a digit or an underscore", () => {
    for (const quiet of LEVELS) {
      for (const busy of LEVELS) {
        const sentence = byHoursWords({ quiet, busy });
        if (quiet === "unknown" && busy === "unknown") {
          expect(sentence).toBeUndefined();
          continue;
        }
        expect(sentence).toMatch(/^[a-z ,;]+$/);
        expect(sentence).toContain("busy hours");
        expect(sentence).toContain(QUIET_HOURS_WORDS);
      }
    }
  });

  it("puts the sentence on the decay row and on no other", () => {
    const state = stateOf(decayEvent({ quiet: "far_above", busy: "far_above" }));
    const rows = state.observations.filter((observation) => observation.by_hours !== undefined);
    expect(rows.map((observation) => observation.signal)).toEqual(["unloaded_pressure_decay"]);
    expect(rows[0]?.by_hours).toBe(
      `faster than usual in the busy hours and also in ${QUIET_HOURS_WORDS}`,
    );
  });

  it("leaves a state without the evidence exactly as it was", () => {
    const json = canonicalStateJson(stateOf(decayEvent()));
    expect(json).not.toContain("by_hours");
    expect(json).not.toContain("quiet hours");
  });

  it("gives the twin the same buckets with or without it, so its scores cannot move", () => {
    const withHours = stateOf(decayEvent({ quiet: "normal", busy: "far_above" }));
    const without = stateOf(decayEvent());
    expect(parseObservedBuckets(withHours.observations)).toEqual(
      parseObservedBuckets(without.observations),
    );
  });

  it("shows a decay known only by kind of hour when a candidate names it, and as unknown now", () => {
    const dayOnly = assertValid("suspect-event", {
      ...decayEvent(),
      observations: [
        { signal: "low_pressure_switch", level: "far_above", trend: "flat", since: "minutes" },
        { signal: "line_pressure", level: "far_below", trend: "falling", since: "minutes" },
        {
          signal: "unloaded_pressure_decay",
          level: "unknown",
          trend: "unknown",
          by_hours: { quiet: "far_above", busy: "far_above" },
        },
      ],
    });
    const state = stateOf(dayOnly);
    const decay = state.observations.find(
      (observation) => observation.signal === "unloaded_pressure_decay",
    );
    expect(decay).toMatchObject({
      level: "unknown",
      trend: "unknown",
      since: "unknown",
      by_hours: `faster than usual in the busy hours and also in ${QUIET_HOURS_WORDS}`,
    });
    // The twin skips a row it cannot place, so it scores what it scored before.
    expect(parseObservedBuckets(state.observations).map((row) => row.signal)).not.toContain(
      "unloaded_pressure_decay",
    );

    // No candidate asks about the decay: a row that says nothing about now stays out.
    const unnamed = buildState(
      {
        event: dayOnly,
        candidates: asCandidates([manEntry("oil_cooler_fouled")]),
        unit_id: FIXTURE_UNIT_ID,
      },
      FIXTURE_LABELS,
    );
    expect(unnamed.observations.map((observation) => observation.signal)).not.toContain(
      "unloaded_pressure_decay",
    );
  });

  it("is part of what the backend saw, so the digest follows it", () => {
    const leak = stateOf(decayEvent({ quiet: "far_above", busy: "far_above" }));
    const demand = stateOf(decayEvent({ quiet: "normal", busy: "far_above" }));
    expect(stateDigest(leak)).not.toBe(stateDigest(demand));
    expect(estimateTokens(leak)).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
  });
});

/** When a variant of signature A was raised, and how long the unit had been in its mode. */
const LOAD_EVENT_SIM_TS = SIGNATURE_A_EVENT.sim_ts;

function sinceBefore(seconds: number): string {
  return new Date(Date.parse(LOAD_EVENT_SIM_TS) - seconds * 1000).toISOString();
}

/**
 * Signature A's event with the motor current carrying a measured median, as
 * detection's events do (the fixture events are words only), in a given mode
 * held for a given time.
 */
function withMotorCurrent(
  amperes: number | undefined,
  mode: SuspectEvent["machine_state"]["mode"] = "loaded",
  modeHeldS = 3600,
): SuspectEvent {
  return assertValid("suspect-event", {
    ...SIGNATURE_A_EVENT,
    event_id: "99999999-9999-4999-8999-999999999999",
    machine_state: {
      ...SIGNATURE_A_EVENT.machine_state,
      mode,
      since_sim_ts: sinceBefore(modeHeldS),
    },
    observations: SIGNATURE_A_EVENT.observations.map((observation) =>
      observation.signal === "motor_current"
        ? {
            ...observation,
            level: "far_below",
            ...(amperes === undefined ? {} : { value: amperes, unit: "A" }),
          }
        : observation,
    ),
  });
}

function modeOf(event: SuspectEvent): string {
  return buildState(inputFor(event, SIGNATURE_A_CANDIDATE_IDS), FIXTURE_LABELS).machine.mode;
}

describe("buildState: a load request the motor does not answer", () => {
  it("says the motor is not running when the controller holds the unit loaded without it", () => {
    const state = buildState(
      inputFor(withMotorCurrent(0.02), SIGNATURE_A_CANDIDATE_IDS),
      FIXTURE_LABELS,
    );
    expect(state.machine).toEqual({
      kind: MACHINE_KIND,
      mode: LOADED_MOTOR_NOT_RUNNING,
      mode_for: "about an hour",
      ambient: "warm",
    });
    expect(state.machine.mode).not.toMatch(/\d/);
    expect(estimateTokens(state)).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
  });

  it("changes nothing but the mode word", () => {
    const stopped = buildState(
      inputFor(withMotorCurrent(0.02), SIGNATURE_A_CANDIDATE_IDS),
      FIXTURE_LABELS,
    );
    const running = buildState(
      inputFor(withMotorCurrent(4.5), SIGNATURE_A_CANDIDATE_IDS),
      FIXTURE_LABELS,
    );
    expect(running.machine.mode).toBe("loaded");
    expect({ ...stopped, machine: running.machine }).toEqual(running);
  });

  it("reads detection's running threshold: at it the motor runs", () => {
    expect(modeOf(withMotorCurrent(RUNNING_CURRENT_A))).toBe("loaded");
    expect(modeOf(withMotorCurrent(RUNNING_CURRENT_A - 0.01))).toBe(LOADED_MOTOR_NOT_RUNNING);
  });

  it("waits until the value window lies inside the load request", () => {
    // On the cut-in sample the median still holds the off phase before it.
    expect(modeOf(withMotorCurrent(0.04, "loaded", 10))).toBe("loaded");
    expect(modeOf(withMotorCurrent(0.04, "loaded", VALUE_WINDOW_S - 1))).toBe("loaded");
    expect(modeOf(withMotorCurrent(0.04, "loaded", VALUE_WINDOW_S))).toBe(LOADED_MOTOR_NOT_RUNNING);
  });

  it("keeps detection's word for every other mode and for an event without the value", () => {
    expect(modeOf(withMotorCurrent(0.02, "off"))).toBe("off");
    expect(modeOf(withMotorCurrent(0.02, "unloaded"))).toBe("unloaded");
    expect(modeOf(withMotorCurrent(0.02, "unknown"))).toBe("unknown");
    expect(modeOf(withMotorCurrent(undefined))).toBe("loaded");
    expect(modeOf(SIGNATURE_A_EVENT)).toBe("loaded");
  });
});

/** The register map's human names for the tags, as the pipeline labels a state. */
const SIGNAL_LABELS: SignalLabels = Object.fromEntries(
  SIGNALS.map((signal) => [signal.tag, signal.name]),
);

/**
 * The decision input on this event, with the causes the manual files under its
 * condition.
 */
function manInputOf(event: SuspectEvent): DecisionInput {
  return {
    event,
    candidates: asCandidates(causesUnder(event.symptom_key)),
    unit_id: event.unit_id,
  };
}

/**
 * The state of a decision on this event, with the causes the manual files under
 * its condition.
 */
function manStateOf(event: SuspectEvent): DecisionState {
  return buildState(manInputOf(event), SIGNAL_LABELS);
}

/** How long detection's mode had held when the event was built, in seconds. */
function modeHeldS(event: SuspectEvent): number {
  return (Date.parse(event.sim_ts) - Date.parse(event.machine_state.since_sim_ts)) / 1000;
}

/** The motor-current median the event carries. */
function motorMedianA(event: SuspectEvent): number | undefined {
  return event.observations.find((observation) => observation.signal === "motor_current")?.value;
}

/** The same event with a running motor's median in place of its own; every word unchanged. */
function withRunningMedian(event: SuspectEvent): SuspectEvent {
  return assertValid("suspect-event", {
    ...event,
    observations: event.observations.map((observation) =>
      observation.signal === "motor_current"
        ? { ...observation, value: RUNNING_CURRENT_A }
        : observation,
    ),
  });
}

/** The three token budgets of the whole request this state would send. */
function expectInsideRequestBudgets(state: DecisionState, input: DecisionInput): void {
  const questions = buildQuestions(state, input);
  const stateTokens = estimateTokens(state);
  expect(stateTokens).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
  expect(stateTokens + estimateQuestionTokens(questions)).toBeLessThanOrEqual(REQUEST_TOKEN_BUDGET);
  expect(stateTokens + longestQuestionTokens(questions)).toBeLessThanOrEqual(
    LONGEST_QUESTION_TOKEN_BUDGET,
  );
}

/** The event detection raises when the unanswered request starts a symptom of its own. */
function raisedOnRequest(run: StartFailure): SuspectEvent {
  const raised = run.raised.find(({ event }) => event.symptom_key === "motor_current_low");
  if (raised === undefined) throw new Error("the start failure raised no motor_current_low event");
  return raised.event;
}

describe("buildState: the manual's S304 start failure, over synthetic frames", () => {
  // Telemetry written from alarms.yaml S304 and the reference operation
  // (test/fixtures/synthetic/calibration.ts), replayed through the real
  // detector; the events are the ones the pipeline would decide on. No
  // scenario, slice or recorded run is read.
  const atRest = startFailure();
  const onThreshold = startFailure({ currentA: S304_CURRENT_A });
  const underThreshold = startFailure({ currentA: S304_CURRENT_A - 0.01 });
  const inEpisode = startFailure({ hotOil: true });

  it("tests S304's own threshold: detection's running current is the manual's 1.0 A", () => {
    expect(RUNNING_CURRENT_A).toBe(S304_CURRENT_A);
  });

  it("names a load request the motor does not answer once it outlasts S304's hold and the window", () => {
    const raised = raisedOnRequest(atRest);
    const end = atRest.at("end of request").event;
    for (const event of [raised, end]) {
      expect(event.machine_state.mode).toBe("loaded");
      expect(modeHeldS(event)).toBeGreaterThanOrEqual(Math.max(S304_HOLD_S, VALUE_WINDOW_S));
      expect(motorMedianA(event)).toBeLessThan(S304_CURRENT_A);
      const state = manStateOf(event);
      expect(state.machine.mode).toBe(LOADED_MOTOR_NOT_RUNNING);
      expect(state.machine.mode).not.toMatch(/\d/);
      expectInsideRequestBudgets(state, manInputOf(event));
    }
    expect(modeHeldS(end)).toBeGreaterThan(modeHeldS(raised));
  });

  it("changes nothing on that event but the mode word", () => {
    const raised = raisedOnRequest(atRest);
    const stopped = manStateOf(raised);
    const running = manStateOf(withRunningMedian(raised));
    expect(running.machine.mode).toBe("loaded");
    expect({ ...stopped, machine: running.machine }).toEqual(running);
  });

  it("keeps loaded when the motor draws S304's threshold, and names the stop just under it", () => {
    const onIt = raisedOnRequest(onThreshold);
    const underIt = raisedOnRequest(underThreshold);
    expect(motorMedianA(onIt)).toBe(S304_CURRENT_A);
    expect(motorMedianA(underIt)).toBeLessThan(S304_CURRENT_A);
    expect(modeHeldS(onIt)).toBeGreaterThanOrEqual(VALUE_WINDOW_S);
    expect(modeHeldS(underIt)).toBe(modeHeldS(onIt));
    expect(manStateOf(onIt).machine.mode).toBe("loaded");
    expect(manStateOf(underIt).machine.mode).toBe(LOADED_MOTOR_NOT_RUNNING);
  });

  it("keeps loaded while the request is younger than the value window", () => {
    // Re-decisions of an open episode. On the cut-in the median still holds
    // the stand before it; half a minute in, S304's hold has passed but the
    // window has not, so the median cannot yet say the motor never started.
    const cutIn = inEpisode.at("cut-in").event;
    const firstMinute = inEpisode.at("first minute").event;
    expect(modeHeldS(cutIn)).toBe(0);
    expect(modeHeldS(firstMinute)).toBeGreaterThan(S304_HOLD_S);
    expect(modeHeldS(firstMinute)).toBeLessThan(VALUE_WINDOW_S);
    for (const event of [cutIn, firstMinute]) {
      expect(event.machine_state.mode).toBe("loaded");
      expect(motorMedianA(event)).toBeLessThan(S304_CURRENT_A);
      expect(manStateOf(event).machine.mode).toBe("loaded");
    }

    const pastWindow = inEpisode.at("past the window").event;
    expect(modeHeldS(pastWindow)).toBeGreaterThanOrEqual(VALUE_WINDOW_S);
    expect(manStateOf(pastWindow).machine.mode).toBe(LOADED_MOTOR_NOT_RUNNING);
  });

  it("keeps detection's word once the unit is stopped or idling, however low the median", () => {
    for (const run of [atRest, inEpisode]) {
      const stopped = run.at("stopped").event;
      expect(stopped.machine_state.mode).toBe("off");
      expect(motorMedianA(stopped)).toBeLessThan(S304_CURRENT_A);
      expect(manStateOf(stopped).machine.mode).toBe("off");
    }
    // Stood past the window (hot oil keeps a symptom firing through the stand),
    // the median is read wholly at rest: only the mode keeps the word from
    // naming a load request the unit is not under.
    const stood = inEpisode.at("end of stand").event;
    expect(stood.machine_state.mode).toBe("off");
    expect(modeHeldS(stood)).toBeGreaterThanOrEqual(VALUE_WINDOW_S);
    expect(motorMedianA(stood)).toBeLessThan(S304_CURRENT_A);
    expect(manStateOf(stood).machine.mode).toBe("off");

    const restart = inEpisode.at("restart").event;
    expect(restart.machine_state.mode).toBe("unloaded");
    expect(motorMedianA(restart)).toBeLessThan(S304_CURRENT_A);
    expect(manStateOf(restart).machine.mode).toBe("unloaded");
  });
});

/** Every row of a state without the rules' sentences: what the state read before they travelled. */
function withoutSeen(state: DecisionState): DecisionState {
  return {
    ...state,
    observations: state.observations.map(({ seen: _seen, ...row }) => row),
  };
}

describe("buildState: the dryer towers stop changing over, over synthetic frames", () => {
  // Telemetry written from faults.yaml's tower changeover valve fault and the
  // reference operation (test/fixtures/synthetic/calibration.ts), replayed
  // through the real detector. No scenario, slice or recorded run is read.
  const { event } = dryerTowersHeld();
  const input: DecisionInput = {
    event,
    candidates: asCandidates(causesUnder("dryer_changeover_fault")),
    unit_id: FIXTURE_UNIT_ID,
  };
  const state = buildState(input, FIXTURE_LABELS);
  const tower = state.observations.find((observation) => observation.signal === "dryer_tower");

  it("is raised under the manual's condition by the rule that watches the towers", () => {
    expect(event.symptom_key).toBe("dryer_changeover_fault");
    expect(event.rule_ids).toEqual(["dryer_tower_not_switching"]);
  });

  it("reads the held tower indication as normal and flat, words that cannot say it stopped alternating", () => {
    expect(tower).toMatchObject({ level: "normal", trend: "flat", since: "several hours" });
  });

  it("carries on the tower row what the rule saw there, in the rule's own sentence", () => {
    expect(tower?.seen).toBe(event.rules_fired[0]?.detail);
    expect(tower?.seen).toBe(
      "The dryer has not pulsed its towers over at the start of the last few load cycles.",
    );
  });

  it("puts that sentence on no other row, and no observation's own evidence sentence anywhere", () => {
    const rows = state.observations.filter((observation) => observation.seen !== undefined);
    expect(rows.map((observation) => observation.signal)).toEqual(["dryer_tower"]);
    const json = canonicalStateJson(state);
    for (const item of event.evidence.slice(event.rule_ids.length)) {
      expect(json).not.toContain(item.observation);
    }
  });

  it("puts no digit in the sentence and stays inside the request budgets", () => {
    expect(tower?.seen).not.toMatch(/\d/);
    const questions = buildQuestions(state, input);
    const stateTokens = estimateTokens(state);
    expect(stateTokens).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
    expect(stateTokens + estimateQuestionTokens(questions)).toBeLessThanOrEqual(
      REQUEST_TOKEN_BUDGET,
    );
    expect(stateTokens + longestQuestionTokens(questions)).toBeLessThanOrEqual(
      LONGEST_QUESTION_TOKEN_BUDGET,
    );
  });

  it("changes nothing else in the state, and gives the twin the same buckets", () => {
    // The same event with the rule's item pointing at no row: the state the
    // model read before the sentences travelled.
    const unsaid = buildState(
      {
        ...input,
        event: {
          ...event,
          evidence: [
            { metric: "no_row_measures_this", observation: "A sentence no row carries." },
            ...event.evidence.slice(event.rule_ids.length),
          ],
        },
      },
      FIXTURE_LABELS,
    );
    expect(withoutSeen(state)).toEqual(unsaid);
    expect(parseObservedBuckets(state.observations)).toEqual(
      parseObservedBuckets(unsaid.observations),
    );
  });
});

describe("buildState: the condensate drain stays open, over synthetic frames", () => {
  // Telemetry written from signals.yaml's separator discharge pressure and
  // faults.yaml's stuck-open drain (test/fixtures/synthetic/calibration.ts),
  // replayed through the real detector. No scenario, slice or recorded run is
  // read. Since the rule's sentence rides on the row it measured, it must
  // point the way the row and the manual do.
  const { event } = separatorDrainOpen();
  const input: DecisionInput = {
    event,
    candidates: asCandidates(causesUnder("separator_pressure_abnormal")),
    unit_id: FIXTURE_UNIT_ID,
  };
  const state = buildState(input, FIXTURE_LABELS);
  const separator = state.observations.find(
    (observation) => observation.signal === "separator_discharge_pressure",
  );

  it("is raised while the unit idles, under the manual's condition, by the rule that watches the separator", () => {
    expect(event.symptom_key).toBe("separator_pressure_abnormal");
    expect(event.rule_ids).toEqual(["separator_not_venting"]);
    expect(event.machine_state.mode).not.toBe("loaded");
  });

  it("reads the idle separator far below the line it should stand at", () => {
    expect(separator).toMatchObject({ level: "far below normal" });
  });

  it("carries a sentence that says the reading has not come back up, as the row reads", () => {
    expect(separator?.seen).toBe(event.rules_fired[0]?.detail);
    expect(separator?.seen).toMatch(/has not come back up/);
    // The blocked drain's words (faults.yaml: "stays high under load",
    // "standing condensate keeps it up") describe the other side of the
    // manual's separation, which this reading is not.
    expect(separator?.seen).not.toMatch(/pressuri[sz]ed|stay(?:s|ed)? up|kept up|held up|high/);
  });

  it("puts that sentence on no other row, and no digit in it", () => {
    const rows = state.observations.filter((observation) => observation.seen !== undefined);
    expect(rows.map((observation) => observation.signal)).toEqual(["separator_discharge_pressure"]);
    expect(separator?.seen).not.toMatch(/\d/);
  });
});

describe("buildState: a rule's sentence on the row it measured", () => {
  /**
   * Signature A with its first `rule_ids.length` evidence items replaced: the
   * items detection writes for the rules under the symptom, before the one per
   * observation that moved.
   */
  function withRules(
    rules: readonly { readonly metric: string; readonly observation: string }[],
  ): SuspectEvent {
    return assertValid("suspect-event", {
      ...SIGNATURE_A_EVENT,
      rule_ids: rules.map((_rule, index) => `rule_${String.fromCharCode(97 + index)}`),
      evidence: [
        ...rules,
        { metric: "cut_out_reached", observation: "Cut-out reached far below normal." },
      ],
    });
  }

  function stateOf(event: SuspectEvent): DecisionState {
    return buildState(inputFor(event, SIGNATURE_A_CANDIDATE_IDS), FIXTURE_LABELS);
  }

  function seenOn(state: DecisionState): Record<string, string | undefined> {
    return Object.fromEntries(
      state.observations
        .filter((observation) => observation.seen !== undefined)
        .map((observation) => [observation.signal, observation.seen]),
    );
  }

  it("joins two rules that measured one signal, in the order they fired", () => {
    const state = stateOf(
      withRules([
        { metric: "oil_temperature", observation: "Oil temperature has been climbing." },
        { metric: "oil_temperature", observation: "Oil temperature stays above its limit." },
      ]),
    );
    expect(seenOn(state)).toEqual({
      oil_temperature: "Oil temperature has been climbing. Oil temperature stays above its limit.",
    });
  });

  it("drops a rule's sentence whose measure is not a row of the state", () => {
    const state = stateOf(
      withRules([
        { metric: "tp2_minus_tp3_loaded", observation: "The discharge side is barely above." },
      ]),
    );
    expect(seenOn(state)).toEqual({});
    expect(withoutSeen(state)).toEqual(state);
  });

  it("never carries an observation's own evidence sentence, only the rules'", () => {
    const state = stateOf(
      withRules([{ metric: "loaded_run_duration", observation: "The unit has been loaded." }]),
    );
    expect(seenOn(state)).toEqual({ loaded_run_duration: "The unit has been loaded." });
    expect(canonicalStateJson(state)).not.toContain("Cut-out reached far below normal.");
  });

  it("keeps the rows, their order and the twin's buckets as they were without it", () => {
    for (const { input } of CASES) {
      const state = buildState(input, FIXTURE_LABELS);
      const bare = withoutSeen(state);
      expect(Object.keys(seenOn(state)).length, input.event.event_id).toBeGreaterThan(0);
      expect(parseObservedBuckets(state.observations)).toEqual(
        parseObservedBuckets(bare.observations),
      );
      expect(state.observations.map((observation) => observation.signal)).toEqual(
        bare.observations.map((observation) => observation.signal),
      );
    }
  });
});

describe("estimateTokens and stateDigest", () => {
  const input = inputFor(OIL_COOLER_EVENT, OIL_COOLER_CANDIDATE_IDS);
  const state = buildState(input, FIXTURE_LABELS);

  it("counts a third of the characters, rounded up", () => {
    expect(estimateTokens(state)).toBe(Math.ceil(canonicalStateJson(state).length / 3));
  });

  it("is a sha256 that does not move between builds", () => {
    const again = buildState(input, FIXTURE_LABELS);
    expect(stateDigest(state)).toMatch(/^[0-9a-f]{64}$/);
    expect(stateDigest(again)).toBe(stateDigest(state));
  });

  it("does not depend on the order the keys happen to be written in", () => {
    const backwards = Object.fromEntries(Object.entries(state).reverse());
    const reordered = JSON.parse(JSON.stringify(backwards)) as typeof state;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(state));
    expect(stateDigest(reordered)).toBe(stateDigest(state));
  });

  it("changes when the state does", () => {
    const other = buildState(inputFor(DEPOT_LPS_EVENT, OIL_COOLER_CANDIDATE_IDS), FIXTURE_LABELS);
    expect(stateDigest(other)).not.toBe(stateDigest(state));
  });
});

describe("resolveStatePath", () => {
  const state = buildState(inputFor(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS), FIXTURE_LABELS);

  it("reads a nested field", () => {
    expect(resolveStatePath(state, "machine.mode")).toBe("loaded");
  });

  it("reads an indexed field and an index inside it", () => {
    expect(resolveStatePath(state, "candidates[0].expected_signal_moves[0]")).toBe(
      catalogEntry("dryer_purge_leak").signal_moves_text[0],
    );
  });

  it("returns undefined for a path that points at nothing", () => {
    expect(resolveStatePath(state, "candidates[99].expected_signal_moves")).toBeUndefined();
    expect(resolveStatePath(state, "machine.colour")).toBeUndefined();
    expect(resolveStatePath(state, "observations[0][0]")).toBeUndefined();
    expect(resolveStatePath(state, "not a path")).toBeUndefined();
  });
});
