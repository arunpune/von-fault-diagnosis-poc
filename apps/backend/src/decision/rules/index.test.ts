// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The rules twin's calibration.
 *
 * This file is a gate: before anything builds on the rules backend, it has to
 * be shown that its confidence reaches the review threshold on a clear
 * signature, stays under it on ordinary behaviour, and — the property the old
 * `p1 − p2` margin did not have — does not move when retrieval hands over more
 * weakly matching candidates.
 *
 * The four calibration cases are the ones the evaluation harness scores
 * as labelled events: signature A, the fouled oil cooler, an ordinary
 * first-month hour and a unit parked at the depot with its low-pressure switch
 * closed.
 */

import { describe, expect, it } from "vitest";

import { RULES_MODEL } from "../../config/env.ts";
import {
  candidatesFor,
  FIXTURE_LABELS,
  FIXTURE_SEVERITY_HINTS,
} from "../../../test/fixtures/catalog/index.ts";
import {
  BASELINE_CANDIDATE_IDS,
  BASELINE_EVENT,
  DEPOT_LPS_CANDIDATE_IDS,
  DEPOT_LPS_EVENT,
  FAST_DECAY_CANDIDATE_IDS,
  FAST_DECAY_EVENT,
  FIXTURE_CASES,
  FIXTURE_UNIT_ID,
  OIL_COOLER_CANDIDATE_IDS,
  OIL_COOLER_EVENT,
  SIGNATURE_A_CANDIDATE_IDS,
  SIGNATURE_A_EVENT,
} from "../../../test/fixtures/catalog/events.ts";
import { gate } from "../../gate/index.ts";
import type { GateConfig } from "../../gate/index.ts";
import type { Candidate } from "../../retrieval/types.ts";
import { NONE_OF_THESE } from "../types.ts";
import type { DecisionInput, DecisionOutput } from "../types.ts";
import { ABSTAIN_BELOW_SUPPORT, createRulesBackend, gatingConfidence } from "./index.ts";

/** The default gate thresholds, which the calibration is stated against. */
const GATE: GateConfig = { ticketMin: 0.85, reviewMin: 0.6 };

/** A clock that never moves, so a latency assertion is not a race. */
function frozenClock(): () => number {
  return () => 1_700_000_000_000;
}

function backend(now = frozenClock()) {
  return createRulesBackend({
    severityHints: FIXTURE_SEVERITY_HINTS,
    labels: FIXTURE_LABELS,
    now,
  });
}

function inputFor(event: DecisionInput["event"], candidateIds: readonly string[]): DecisionInput {
  return { event, candidates: candidatesFor(candidateIds), unit_id: FIXTURE_UNIT_ID };
}

async function decide(
  event: DecisionInput["event"],
  candidateIds: readonly string[],
): Promise<DecisionOutput> {
  return backend().decide(inputFor(event, candidateIds));
}

describe("createRulesBackend: the calibrated rules confidence", () => {
  it("reaches at least review on the signature-A-like event", async () => {
    const output = await decide(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS);
    expect(output.choice).toBe("dryer_purge_leak");
    expect(output.confidence).toBeGreaterThanOrEqual(GATE.reviewMin);
    expect(gate(output, GATE).outcome).not.toBe("log");
  });

  it("reaches at least review on the oil-cooler-like event", async () => {
    const output = await decide(OIL_COOLER_EVENT, OIL_COOLER_CANDIDATE_IDS);
    expect(output.choice).toBe("oil_cooler_fouled");
    expect(output.confidence).toBeGreaterThanOrEqual(GATE.reviewMin);
    expect(gate(output, GATE).outcome).toBe("review");
  });

  it("only logs the baseline-like event", async () => {
    const output = await decide(BASELINE_EVENT, BASELINE_CANDIDATE_IDS);
    expect(output.confidence).toBeLessThan(GATE.reviewMin);
    expect(gate(output, GATE).outcome).toBe("log");
  });

  it("abstains on the depot-LPS-like event and only logs it", async () => {
    const output = await decide(DEPOT_LPS_EVENT, DEPOT_LPS_CANDIDATE_IDS);
    expect(output.choice).toBe(NONE_OF_THESE);
    expect(output.confidence).toBeGreaterThanOrEqual(GATE.reviewMin);
    expect(gate(output, GATE)).toMatchObject({ outcome: "log", abstained: true });
  });

  it("stays under the threshold where a leak and a busy plant look alike", async () => {
    // The catalog files causes under shared conditions on purpose; the fast-decay
    // precursor is the case where a benign explanation fits as well as the
    // leak, and saying so is the right answer, not a failure.
    const output = await decide(FAST_DECAY_EVENT, FAST_DECAY_CANDIDATE_IDS);
    expect(output.support["downstream_air_leak"]).toBeGreaterThan(0.6);
    expect(output.support["high_air_demand"]).toBeGreaterThan(0.6);
    expect(gate(output, GATE).outcome).toBe("log");
  });
});

describe("createRulesBackend: confidence does not depend on how long the list is", () => {
  const WEAK_CANDIDATES = ["oil_level_low", "high_air_demand"] as const;
  const WEAK_SIGNATURE_A_CANDIDATES = ["oil_cooler_fouled", "oil_level_low"] as const;

  it("is unchanged when two weakly matching candidates are added", async () => {
    const short = await decide(OIL_COOLER_EVENT, ["oil_cooler_fouled", "high_ambient_temperature"]);
    const long = await decide(OIL_COOLER_EVENT, [
      "oil_cooler_fouled",
      "high_ambient_temperature",
      ...WEAK_CANDIDATES,
    ]);

    expect(long.confidence).toBe(short.confidence);
    expect(long.choice).toBe(short.choice);
    expect(gate(long, GATE).outcome).toBe(gate(short, GATE).outcome);
  });

  it("is the quantity the display probabilities are not", async () => {
    const short = await decide(OIL_COOLER_EVENT, ["oil_cooler_fouled", "high_ambient_temperature"]);
    const long = await decide(OIL_COOLER_EVENT, [
      "oil_cooler_fouled",
      "high_ambient_temperature",
      ...WEAK_CANDIDATES,
    ]);
    // The whole point of the calibrated confidence: the normalised mass of the
    // winner falls as the list grows, which is why it must not be what the gate
    // reads.
    expect(long.probabilities["oil_cooler_fouled"]).toBeLessThan(
      short.probabilities["oil_cooler_fouled"] ?? 0,
    );
  });

  it("is unchanged when weakly matching candidates join the signature-A list", async () => {
    const shortIds = SIGNATURE_A_CANDIDATE_IDS.slice(0, 4);
    const short = await decide(SIGNATURE_A_EVENT, shortIds);
    const long = await decide(SIGNATURE_A_EVENT, [...shortIds, ...WEAK_SIGNATURE_A_CANDIDATES]);

    // Weak means below the runner-up the short list already had.
    const runnerUp = Object.values(short.support)
      .map((value) => value ?? 0)
      .sort((left, right) => right - left)[1];
    for (const faultId of WEAK_SIGNATURE_A_CANDIDATES) {
      expect(long.support[faultId]).toBeLessThan(runnerUp ?? 0);
    }
    expect(long.choice).toBe(short.choice);
    expect(long.confidence).toBe(short.confidence);
    expect(gate(long, GATE).outcome).toBe(gate(short, GATE).outcome);
  });

  it.each([
    { name: "one candidate", supports: [0.8], expected: 0.8 },
    { name: "a decisive gap", supports: [0.8, 0.4], expected: 0.8 },
    { name: "a gap at the edge", supports: [0.8, 0.5], expected: 0.8 },
    { name: "half a gap", supports: [0.8, 0.65], expected: 0.4 },
    { name: "a tie", supports: [0.8, 0.8], expected: 0 },
    { name: "extra weak candidates", supports: [0.8, 0.4, 0.2, 0.1], expected: 0.8 },
    { name: "no candidate at all", supports: [], expected: 0 },
  ])("$name", ({ supports, expected }) => {
    expect(gatingConfidence(supports)).toBeCloseTo(expected, 10);
  });
});

describe("createRulesBackend: the shape of its answer", () => {
  it("names itself and the pinned model, and spends nothing", async () => {
    const output = await decide(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS);
    expect(output.backend).toBe("rules");
    expect(output.model).toBe(RULES_MODEL);
    expect(output.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(output.raw).toEqual({});
    expect(output.request_id).toBeUndefined();
  });

  it("carries the state it read and its digest", async () => {
    const input = inputFor(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS);
    const output = await backend().decide(input);
    expect(output.state_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(output.state).toMatchObject({ machine: { mode: "loaded" } });
  });

  it("gives every candidate a support, never a null", async () => {
    const output = await decide(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS);
    expect(Object.keys(output.support)).toEqual([...SIGNATURE_A_CANDIDATE_IDS]);
    for (const value of Object.values(output.support)) {
      expect(typeof value).toBe("number");
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("spreads a probability over the candidates plus the abstention", async () => {
    const output = await decide(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS);
    const keys = Object.keys(output.probabilities);
    expect(keys).toContain(NONE_OF_THESE);
    expect(keys).toHaveLength(SIGNATURE_A_CANDIDATE_IDS.length + 1);
    const total = Object.values(output.probabilities).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("reports the worst severity hint of the rules that fired, one-hot", async () => {
    const output = await decide(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS);
    expect(output.severity).toEqual({
      level: "high",
      score: 2,
      probabilities: { "0": 0, "1": 0, "2": 1, "3": 0 },
      confidence: 1,
    });
  });

  it("falls back to the lowest severity when no rule carries a hint", async () => {
    const unknownHints = createRulesBackend({ severityHints: {}, labels: FIXTURE_LABELS });
    const output = await unknownHints.decide(
      inputFor(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS),
    );
    expect(output.severity.level).toBe("low");
    expect(output.severity.score).toBe(0);
  });

  it("measures its own latency from the injected clock", async () => {
    let tick = 1_000;
    const moving = createRulesBackend({
      severityHints: FIXTURE_SEVERITY_HINTS,
      labels: FIXTURE_LABELS,
      now: () => {
        tick += 7;
        return tick;
      },
    });
    const output = await moving.decide(inputFor(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS));
    expect(output.latency_ms).toBe(7);
  });

  it("answers the same input identically every time", async () => {
    const first = await decide(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS);
    const second = await decide(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS);
    expect(second).toEqual(first);
  });

  it("abstains when nothing explains even a third of the machine", async () => {
    const output = await decide(DEPOT_LPS_EVENT, DEPOT_LPS_CANDIDATE_IDS);
    const best = Math.max(...Object.values(output.support).map((value) => value ?? 0));
    expect(best).toBeLessThan(ABSTAIN_BELOW_SUPPORT);
    expect(output.confidence).toBeCloseTo(1 - best, 10);
  });

  it("abstains with full confidence when retrieval found nothing at all", async () => {
    const output = await decide(BASELINE_EVENT, []);
    expect(output.choice).toBe(NONE_OF_THESE);
    expect(output.confidence).toBe(1);
    expect(output.probabilities).toEqual({ [NONE_OF_THESE]: 1 });
  });
});

describe("createRulesBackend: determinism", () => {
  /** A candidate built for this file: one analog move and one resting-state digital move. */
  const PROBE_ID = "resting_contact_probe";

  function probeCandidate(): Candidate {
    const [base] = candidatesFor(["oil_cooler_fouled"]);
    if (base === undefined) throw new Error("catalog fixture: oil_cooler_fouled is missing");
    return {
      ...base,
      fault_id: PROBE_ID,
      signal_moves: [
        { signal: "oil_temperature", direction: "rises" },
        { signal: "regulator_contact", direction: "stays_off" },
      ],
    };
  }

  /** The oil-cooler event read in `mode`, with the regulator contact resting in view. */
  function oilCoolerWhile(mode: DecisionInput["event"]["machine_state"]["mode"]): DecisionInput {
    const event: DecisionInput["event"] = {
      ...OIL_COOLER_EVENT,
      machine_state: { ...OIL_COOLER_EVENT.machine_state, mode },
      observations: [
        ...OIL_COOLER_EVENT.observations,
        { signal: "regulator_contact", level: "normal", trend: "flat", since: "several hours" },
      ],
    };
    return { event, candidates: [probeCandidate()], unit_id: FIXTURE_UNIT_ID };
  }

  it("answers every calibration case the same whatever it decided before", async () => {
    const fresh = await Promise.all(
      FIXTURE_CASES.map((fixture) =>
        backend().decide(inputFor(fixture.event, fixture.candidateIds)),
      ),
    );

    const shared = backend();
    const replayed: DecisionOutput[] = [];
    for (const fixture of [...FIXTURE_CASES].reverse()) {
      replayed.unshift(await shared.decide(inputFor(fixture.event, fixture.candidateIds)));
    }

    expect(replayed).toEqual(fresh);
  });

  it("does not depend on the order retrieval listed the candidates in", async () => {
    const forward = await decide(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS);
    const backward = await decide(SIGNATURE_A_EVENT, [...SIGNATURE_A_CANDIDATE_IDS].reverse());
    expect(backward.support).toEqual(forward.support);
    expect(backward.choice).toBe(forward.choice);
    expect(backward.confidence).toBe(forward.confidence);
  });

  it("judges a digital in the mode of the event it decides, not of the one before", async () => {
    const twin = backend();
    const loaded = await twin.decide(oilCoolerWhile("loaded"));
    const unloaded = await twin.decide(oilCoolerWhile("unloaded"));
    const loadedAgain = await twin.decide(oilCoolerWhile("loaded"));

    // While loaded the contact rests at its usual off value: silent, so the
    // probe keeps the oil's half. While idling the same reading is the usual
    // on, which contradicts stays_off and costs half a match.
    expect(loaded.support[PROBE_ID]).toBe(0.5);
    expect(unloaded.support[PROBE_ID]).toBe(0.25);
    expect(loadedAgain).toEqual(loaded);
  });
});
