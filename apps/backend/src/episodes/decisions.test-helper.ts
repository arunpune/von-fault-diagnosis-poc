// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Suspect events and decision messages the episode and ticket tests build by
 * hand.
 *
 * The state machine and the ticket lifecycle read three things of a decision —
 * whether it answered, what it chose and what the gate made of it — so the
 * messages here are built through the real `toDecisionMessage` and `gate`
 * from a small hand-written answer rather than through a backend. That keeps
 * every message on contract (the helpers validate) without making a lifecycle
 * test depend on how a backend computes its confidence.
 *
 * Candidates come from the caller: this file lives beside production code and
 * may not import the test fixtures (`no-test-in-prod`), so a test hands over
 * `candidatesFor(...)` from `test/fixtures/catalog`.
 *
 * The file is named `*.test-helper.ts` rather than `*.test.ts` so Vitest does
 * not collect it as a suite of its own.
 */

import { assertValid } from "@fdp/contracts";
import type { Decision, SuspectEvent } from "@fdp/contracts";

import { DecisionError, NONE_OF_THESE } from "../decision/types.ts";
import type { DecisionOutput } from "../decision/types.ts";
import { toDecisionMessage, type DecisionCost } from "../decision/message.ts";
import { gate as applyGate, type GateConfig, type GateResult } from "../gate/index.ts";
import { digestOf } from "../ids.ts";
import type { Candidate } from "../retrieval/types.ts";

/** The gate's default thresholds. */
export const TEST_GATE: GateConfig = { ticketMin: 0.85, reviewMin: 0.6 };

/** The wall instant every hand-built message is stamped with. */
export const TEST_WALL_TS = "2026-09-22T08:00:00.000Z";

/** Identifiers that read as what they are in a failing assertion. */
export function sequentialIds(prefix: number): () => string {
  let next = 0;
  return () => {
    next += 1;
    const tail = next.toString(16).padStart(12, "0");
    return `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${tail}`;
  };
}

/**
 * `base` moved to another instant and, optionally, another key.
 *
 * The window ends at the new instant and the event gets a fresh id, which is
 * what detection's re-emission of the same symptom looks like.
 */
export function eventAt(
  base: SuspectEvent,
  eventId: string,
  simTs: string,
  overrides: Partial<
    Pick<SuspectEvent, "unit_id" | "symptom_key" | "co_symptoms" | "rule_ids">
  > = {},
): SuspectEvent {
  return assertValid("suspect-event", {
    ...base,
    ...overrides,
    event_id: eventId,
    sim_ts: simTs,
    window: { ...base.window, to_sim_ts: simTs },
  });
}

/** What one hand-built decision says. */
export interface DecisionDraft {
  readonly event: SuspectEvent;
  readonly candidates: readonly Candidate[];
  readonly episodeId: string;
  readonly decisionId: string;
  /** A candidate's `fault_id`, or {@link NONE_OF_THESE}. */
  readonly choice: string;
  readonly confidence: number;
  /** Defaults to the event's own instant. */
  readonly simTs?: string;
}

/** A decision message and the gate result it carries. */
export interface GatedDecision {
  readonly decision: Decision;
  readonly gate: GateResult;
}

/** Nothing costs anything in these tests; the ledger is `cost/`'s. */
function freeOfCharge(): DecisionCost {
  return { usd: 0, price_input_per_mtok: 0, price_output_per_mtok: 0, prices_as_of: "2026-09-19" };
}

function context(draft: DecisionDraft) {
  return {
    unit_id: draft.event.unit_id,
    decision_id: draft.decisionId,
    episode_id: draft.episodeId,
    event_id: draft.event.event_id,
    sim_ts: draft.simTs ?? draft.event.sim_ts,
    wall_ts: TEST_WALL_TS,
    backend: "rules" as const,
    model: "rules-v1",
    symptom_key: draft.event.symptom_key,
    candidates: draft.candidates,
    gate: TEST_GATE,
    prices: freeOfCharge,
  };
}

/**
 * The mass of one answer: `confidence` on the choice, the rest spread evenly.
 *
 * Only the choice, the confidence and the gate matter to the lifecycle; the
 * distribution just has to be one the contract accepts.
 */
function probabilitiesFor(draft: DecisionDraft): Record<string, number> {
  const keys = [...draft.candidates.map((candidate) => candidate.fault_id), NONE_OF_THESE];
  const rest = (1 - draft.confidence) / (keys.length - 1);
  return Object.fromEntries(
    keys.map((key) => [key, key === draft.choice ? draft.confidence : rest]),
  );
}

/** An answered decision, gated with {@link TEST_GATE}. */
export function answered(draft: DecisionDraft): GatedDecision {
  const state = { event_id: draft.event.event_id, choice: draft.choice };
  const output: DecisionOutput = {
    backend: "rules",
    model: "rules-v1",
    choice: draft.choice,
    probabilities: probabilitiesFor(draft),
    confidence: draft.confidence,
    support: Object.fromEntries(draft.candidates.map((candidate) => [candidate.fault_id, 0.5])),
    severity: { level: "high", score: 2, probabilities: { "2": 1 }, confidence: 1 },
    usage: { input_tokens: 0, output_tokens: 0 },
    latency_ms: 3,
    state,
    state_digest: digestOf(state),
    raw: {},
  };
  const decision = assertValid("decision", toDecisionMessage(output, context(draft)));
  return { decision, gate: applyGate(output, TEST_GATE) };
}

/** A call that failed: the error form of the message, never gated. */
export function failed(draft: Omit<DecisionDraft, "choice" | "confidence">): Decision {
  const error = new DecisionError("overloaded", "the decision service is overloaded", {
    status: 529,
  });
  return assertValid(
    "decision",
    toDecisionMessage(error, context({ ...draft, choice: NONE_OF_THESE, confidence: 0 })),
  );
}
