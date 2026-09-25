// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `decision` contract message (docs/decision-backends.md#the-decision-message).
 *
 * One function, two inputs: an answer or a failure. Both produce a message,
 * because a backend outage is a fact about the run and hiding it behind a
 * silent fall-back to the rules twin would make the evaluation report a lie.
 * A failed call carries `status: "failed"`, the abstention, zero tokens, no
 * candidates and a non-null `error`, and it never reaches the gate.
 *
 * The state itself is not here. Only its sha256 travels on the broker; the
 * state goes to `app.decisions` where an operator can read it.
 */

import type { Candidate as MessageCandidate, Decision, SeverityLevel } from "@fdp/contracts";

import { failedGate, gate } from "../gate/index.ts";
import type { GateConfig, GateResult } from "../gate/index.ts";
import type { Candidate } from "../retrieval/types.ts";
import { isDecisionError, NONE_OF_THESE } from "./types.ts";
import type { DecisionBackendName, DecisionError, DecisionOutput, DecisionUsage } from "./types.ts";

/** The schema id every decision message repeats. */
const DECISION_SCHEMA = "urn:fdp:schema:decision:v1";

/** How many candidates the contract lets a message carry (`maxItems: 6`). */
const MAX_MESSAGE_CANDIDATES = 6;

/** The cost block, as the price function returns it. */
export interface DecisionCost {
  readonly usd: number;
  readonly price_input_per_mtok: number;
  readonly price_output_per_mtok: number;
  /** The day the prices were read, `YYYY-MM-DD`. */
  readonly prices_as_of: string;
}

/**
 * Everything the message needs that the backend does not know.
 *
 * `prices` is a function rather than a table so the cost ledger stays the one
 * owner of arithmetic in dollars: the message repeats what the
 * ledger computed instead of computing it a second time and drifting.
 */
export interface DecisionMessageContext {
  readonly unit_id: string;
  readonly decision_id: string;
  readonly episode_id: string;
  readonly event_id: string;
  readonly sim_ts: string;
  readonly wall_ts: string;
  readonly backend: DecisionBackendName;
  /** The model the run configured; a failed call has no response to read it from. */
  readonly model: string;
  /** The symptom the episode was opened on; it picks each candidate's condition. */
  readonly symptom_key: string;
  /** What retrieval offered, in its own order. */
  readonly candidates: readonly Candidate[];
  readonly gate: GateConfig;
  /**
   * `GATE_PERSIST_SIM_MIN`, repeated in the gate block beside the thresholds:
   * the persistence an episode's evidence needed before it could be
   * decided towards a new ticket. The pipeline always passes it; a caller that
   * does not leaves the field out of the message.
   */
  readonly persistSimMin?: number;
  readonly prices: (usage: DecisionUsage) => DecisionCost;
}

/** The severity a failed call reports: the lowest, with no confidence at all. */
function failedSeverity(): Decision["severity"] {
  return { level: "low", score: 0, probabilities: { "0": 1 }, confidence: 0 };
}

/** The condition a candidate is offered under, or the first one it explains. */
function conditionOf(candidate: Candidate, symptomKey: string): string {
  const listed = candidate.conditions.find((condition) => condition.condition_id === symptomKey);
  return (listed ?? candidate.conditions[0]).condition_id;
}

/** The candidate rows of the message, at most the six the contract allows. */
function messageCandidates(
  context: DecisionMessageContext,
  probabilities: Readonly<Record<string, number>>,
): MessageCandidate[] {
  return context.candidates.slice(0, MAX_MESSAGE_CANDIDATES).map((candidate) => ({
    fault_id: candidate.fault_id,
    condition_id: conditionOf(candidate, context.symptom_key),
    name: candidate.name,
    probability: probabilities[candidate.fault_id] ?? 0,
    benign: candidate.benign,
    manual_ref: candidate.manual_ref,
  }));
}

/** The `support` map of the contract: numbers only, so a `null` is dropped. */
function messageSupport(support: Readonly<Record<string, number | null>>): Record<string, number> {
  const numbers: Record<string, number> = {};
  for (const [faultId, value] of Object.entries(support)) {
    if (value !== null) numbers[faultId] = value;
  }
  return numbers;
}

/** The severity block, narrowed to what the contract carries (no legend). */
function messageSeverity(output: DecisionOutput): Decision["severity"] {
  const level: SeverityLevel = output.severity.level;
  return {
    level,
    score: output.severity.score,
    probabilities: { ...output.severity.probabilities },
    confidence: output.severity.confidence,
  };
}

/** The `gate` block: what the gate decided, and the thresholds and persistence it ran with. */
function gateBlock(
  result: GateResult,
  config: GateConfig,
  persistSimMin: number | undefined,
): Decision["gate"] {
  return {
    outcome: result.outcome,
    abstained: result.abstained,
    reason: result.reason,
    ticket_min_confidence: config.ticketMin,
    review_min_confidence: config.reviewMin,
    ...(persistSimMin === undefined ? {} : { persist_sim_min: persistSimMin }),
  };
}

const NO_USAGE: DecisionUsage = { input_tokens: 0, output_tokens: 0 };

/** The fields every decision message carries, answered or not. */
function envelope(
  context: DecisionMessageContext,
): Pick<
  Decision,
  | "schema"
  | "unit_id"
  | "wall_ts"
  | "decision_id"
  | "episode_id"
  | "event_id"
  | "sim_ts"
  | "backend"
> {
  return {
    schema: DECISION_SCHEMA,
    unit_id: context.unit_id,
    wall_ts: context.wall_ts,
    decision_id: context.decision_id,
    episode_id: context.episode_id,
    event_id: context.event_id,
    sim_ts: context.sim_ts,
    backend: context.backend,
  };
}

/**
 * Build the `decision` message of one answered or failed call.
 *
 * The gate is applied here, once, so the pipeline, the database row and the
 * broker payload can never disagree about the outcome: everything downstream
 * reads `message.gate.outcome`.
 */
export function toDecisionMessage(
  result: DecisionOutput | DecisionError,
  context: DecisionMessageContext,
): Decision {
  if (isDecisionError(result)) {
    const failure = failedGate();
    return {
      ...envelope(context),
      model: context.model,
      status: "failed",
      choice: NONE_OF_THESE,
      probabilities: { [NONE_OF_THESE]: 1 },
      confidence: 0,
      support: {},
      candidates: [],
      severity: failedSeverity(),
      gate: gateBlock(failure, context.gate, context.persistSimMin),
      usage: { ...NO_USAGE },
      cost: context.prices(NO_USAGE),
      latency_ms: 0,
      state_digest: "0".repeat(64),
      error: {
        kind: result.kind,
        ...(result.status === undefined ? {} : { status: result.status }),
        message: result.message,
      },
      ...(result.request_id === undefined ? {} : { request_id: result.request_id }),
    };
  }

  const decided = gate(result, context.gate);
  return {
    ...envelope(context),
    model: result.model,
    status: "ok",
    choice: result.choice,
    probabilities: { ...result.probabilities },
    confidence: result.confidence,
    support: messageSupport(result.support),
    candidates: messageCandidates(context, result.probabilities) as Decision["candidates"],
    severity: messageSeverity(result),
    gate: gateBlock(decided, context.gate, context.persistSimMin),
    usage: { ...result.usage },
    cost: context.prices(result.usage),
    latency_ms: Math.round(result.latency_ms),
    state_digest: result.state_digest,
    error: null,
    ...(result.request_id === undefined ? {} : { request_id: result.request_id }),
  };
}
