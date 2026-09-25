// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The decision message, for an answered call and for a failed one.
 *
 * Both are validated against `decision.schema.json` rather than compared field
 * by field: the schema is the contract every other language in this repository
 * reads, and a message that only satisfies a TypeScript type would still break
 * the frontend and the evaluation harness.
 */

import { describe, expect, it } from "vitest";

import { assertValid, validate } from "@fdp/contracts";

import {
  candidatesFor,
  FIXTURE_LABELS,
  FIXTURE_SEVERITY_HINTS,
} from "../../test/fixtures/catalog/index.ts";
import {
  FIXTURE_UNIT_ID,
  OIL_COOLER_CANDIDATE_IDS,
  OIL_COOLER_EVENT,
  SIGNATURE_A_CANDIDATE_IDS,
  SIGNATURE_A_EVENT,
} from "../../test/fixtures/catalog/events.ts";
import { toDecisionMessage } from "./message.ts";
import type { DecisionMessageContext } from "./message.ts";
import { createRulesBackend } from "./rules/index.ts";
import { DecisionError } from "./types.ts";
import type { DecisionInput, DecisionOutput, DecisionUsage } from "./types.ts";

const PRICES_AS_OF = "2026-09-19";

/** What the cost ledger would have computed; the message only repeats it. */
function prices(usage: DecisionUsage) {
  const priceInput = 0.042;
  const priceOutput = 0;
  return {
    usd: (usage.input_tokens * priceInput + usage.output_tokens * priceOutput) / 1e6,
    price_input_per_mtok: priceInput,
    price_output_per_mtok: priceOutput,
    prices_as_of: PRICES_AS_OF,
  };
}

function contextFor(
  event: DecisionInput["event"],
  candidateIds: readonly string[],
): DecisionMessageContext {
  return {
    unit_id: FIXTURE_UNIT_ID,
    decision_id: "aaaaaaaa-0000-4000-8000-000000000001",
    episode_id: "bbbbbbbb-0000-4000-8000-000000000002",
    event_id: event.event_id,
    sim_ts: event.sim_ts,
    wall_ts: "2026-09-20T08:00:00.000Z",
    backend: "rules",
    model: "rules-v1",
    symptom_key: event.symptom_key,
    candidates: candidatesFor(candidateIds),
    gate: { ticketMin: 0.85, reviewMin: 0.6 },
    prices,
  };
}

async function answer(
  event: DecisionInput["event"],
  candidateIds: readonly string[],
): Promise<DecisionOutput> {
  const backend = createRulesBackend({
    severityHints: FIXTURE_SEVERITY_HINTS,
    labels: FIXTURE_LABELS,
    now: () => 0,
  });
  return backend.decide({
    event,
    candidates: candidatesFor(candidateIds),
    unit_id: FIXTURE_UNIT_ID,
  });
}

describe("toDecisionMessage: an answered call", () => {
  it("validates against the decision schema", async () => {
    const output = await answer(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS);
    const message = toDecisionMessage(
      output,
      contextFor(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS),
    );
    expect(validate("decision", message).ok).toBe(true);
    expect(assertValid("decision", message)).toBe(message);
  });

  it("repeats the answer, the gate and its thresholds", async () => {
    const output = await answer(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS);
    const message = toDecisionMessage(
      output,
      contextFor(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS),
    );
    expect(message).toMatchObject({
      status: "ok",
      backend: "rules",
      model: "rules-v1",
      choice: "dryer_purge_leak",
      error: null,
      state_digest: output.state_digest,
    });
    expect(message.gate).toMatchObject({
      outcome: "ticket",
      abstained: false,
      ticket_min_confidence: 0.85,
      review_min_confidence: 0.6,
    });
  });

  it("carries one candidate row per offered cause, with its probability", async () => {
    const output = await answer(OIL_COOLER_EVENT, OIL_COOLER_CANDIDATE_IDS);
    const message = toDecisionMessage(
      output,
      contextFor(OIL_COOLER_EVENT, OIL_COOLER_CANDIDATE_IDS),
    );
    expect(message.candidates.map((candidate) => candidate.fault_id)).toEqual([
      ...OIL_COOLER_CANDIDATE_IDS,
    ]);
    const cooler = message.candidates.find(
      (candidate) => candidate.fault_id === "oil_cooler_fouled",
    );
    expect(cooler).toMatchObject({
      condition_id: "oil_temperature_high",
      name: "Oil cooler fouled",
      benign: false,
    });
    expect(cooler?.probability).toBeCloseTo(output.probabilities["oil_cooler_fouled"] ?? 0, 10);
  });

  it("keeps at most the six candidates the contract allows", async () => {
    const seven = [...SIGNATURE_A_CANDIDATE_IDS, "condensate_drain_stuck_open"];
    const output = await answer(SIGNATURE_A_EVENT, seven);
    const message = toDecisionMessage(output, {
      ...contextFor(SIGNATURE_A_EVENT, seven),
    });
    expect(message.candidates).toHaveLength(6);
    expect(validate("decision", message).ok).toBe(true);
  });

  it("repeats what the price function computed", async () => {
    const output = await answer(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS);
    const message = toDecisionMessage(
      output,
      contextFor(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS),
    );
    expect(message.cost).toEqual({
      usd: 0,
      price_input_per_mtok: 0.042,
      price_output_per_mtok: 0,
      prices_as_of: PRICES_AS_OF,
    });
    expect(message.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("sends the per-candidate support the twin computed", async () => {
    const output = await answer(OIL_COOLER_EVENT, OIL_COOLER_CANDIDATE_IDS);
    const message = toDecisionMessage(
      output,
      contextFor(OIL_COOLER_EVENT, OIL_COOLER_CANDIDATE_IDS),
    );
    expect(message.support).toEqual(output.support);
  });

  it("drops a null support rather than sending it as a zero", async () => {
    const output = await answer(OIL_COOLER_EVENT, OIL_COOLER_CANDIDATE_IDS);
    const withoutSupport: DecisionOutput = {
      ...output,
      support: { oil_cooler_fouled: null, high_ambient_temperature: 0.5 },
    };
    const message = toDecisionMessage(
      withoutSupport,
      contextFor(OIL_COOLER_EVENT, OIL_COOLER_CANDIDATE_IDS),
    );
    expect(message.support).toEqual({ high_ambient_temperature: 0.5 });
    expect(validate("decision", message).ok).toBe(true);
  });

  it("passes a provider request id through when the backend reported one", async () => {
    const output = await answer(OIL_COOLER_EVENT, OIL_COOLER_CANDIDATE_IDS);
    const message = toDecisionMessage(
      { ...output, request_id: "req_abc123" },
      contextFor(OIL_COOLER_EVENT, OIL_COOLER_CANDIDATE_IDS),
    );
    expect(message.request_id).toBe("req_abc123");
    expect(validate("decision", message).ok).toBe(true);
  });
});

describe("toDecisionMessage: a failed call", () => {
  const failure = new DecisionError("timeout", "the provider did not answer in time", {
    status: 408,
    request_id: "req_timeout",
  });

  it("validates against the decision schema", () => {
    const message = toDecisionMessage(
      failure,
      contextFor(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS),
    );
    expect(validate("decision", message).ok).toBe(true);
  });

  it("is still a decision: an abstention with no confidence and no candidates", () => {
    const message = toDecisionMessage(
      failure,
      contextFor(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS),
    );
    expect(message).toMatchObject({
      status: "failed",
      choice: "none_of_these",
      probabilities: { none_of_these: 1 },
      confidence: 0,
      support: {},
      candidates: [],
      latency_ms: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      severity: { level: "low", score: 0, confidence: 0 },
      request_id: "req_timeout",
    });
  });

  it("records why it failed and never passes the gate", () => {
    const message = toDecisionMessage(
      failure,
      contextFor(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS),
    );
    expect(message.error).toEqual({
      kind: "timeout",
      status: 408,
      message: "the provider did not answer in time",
    });
    expect(message.gate).toMatchObject({ outcome: "log", abstained: false });
    expect(message.gate.reason).toContain("no answer");
  });

  it("omits the status when the failure carried none", () => {
    const network = new DecisionError("network", "the connection was refused");
    const message = toDecisionMessage(
      network,
      contextFor(SIGNATURE_A_EVENT, SIGNATURE_A_CANDIDATE_IDS),
    );
    expect(message.error).toEqual({ kind: "network", message: "the connection was refused" });
    expect(message.request_id).toBeUndefined();
    expect(validate("decision", message).ok).toBe(true);
  });
});
