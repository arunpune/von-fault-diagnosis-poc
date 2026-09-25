// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Abstention accuracy: does the system know when it does not know? It is
// what the "benign causes with alarming symptoms" are there to measure.
//
// An abstain case is a scenario or window whose ground truth is `abstain`: a
// benign injection, a depot depressurisation with a genuine LPS trip, a hot
// summer day. The right behaviour is not silence — a review item naming the
// benign cause is a good answer — it is the absence of a confident wrong one.
//
// A case is correct when both hold:
//
//   1. no ticket names a non-benign fault, and
//   2. every decision in it either says `none_of_these` with confidence at or
//      above the review floor, or names a benign candidate, or was gated to
//      `log` (the gate already refused it).
//
// The second clause is what separates "abstained" from "got lucky": a decision
// that named a leak with 0.84 confidence was gated to `log` by the 0.85
// threshold and is forgiven, while the same claim at 0.86 opens a ticket and
// is not. `explicitRate` is reported beside the accuracy because the two
// answer different questions — how often the system was right to stay quiet,
// and how often it said so in as many words.

import type { AbstainVerdict, AbstentionResult, DecisionRecord, TicketRecord } from "./types.ts";
import { NONE_OF_THESE } from "./types.ts";

export type { AbstainVerdict, AbstentionResult } from "./types.ts";

/** One case abstention is measured over. */
export interface AbstainCase {
  readonly id: string;
  readonly tickets: readonly TicketRecord[];
  readonly decisions: readonly DecisionRecord[];
  readonly benignFaultIds: ReadonlySet<string>;
  /** `GATE_REVIEW_MIN_CONFIDENCE`, the floor an explicit `none_of_these` must clear. */
  readonly reviewMin: number;
}

/** True when the decision is one of the three forms an abstain case forgives. */
function acceptable(decision: DecisionRecord, reviewMin: number): boolean {
  if (decision.gate === "log") return true;
  if (decision.benignChoice) return true;
  return decision.choice === NONE_OF_THESE && decision.confidence >= reviewMin;
}

function judge(item: AbstainCase): AbstainVerdict {
  const reasons: string[] = [];

  for (const ticket of item.tickets) {
    if (!item.benignFaultIds.has(ticket.faultAtOpen)) {
      reasons.push(`ticket ${ticket.ticketId} names the non-benign fault ${ticket.faultAtOpen}`);
    }
  }
  for (const decision of item.decisions) {
    if (!acceptable(decision, item.reviewMin)) {
      reasons.push(
        `decision ${decision.decisionId} chose ${decision.choice} at ${decision.confidence} ` +
          `and was gated to ${decision.gate}`,
      );
    }
  }
  return { id: item.id, correct: reasons.length === 0, reasons };
}

/**
 * Abstention accuracy and the explicit abstention rate.
 *
 * @param cases the abstain cases of a scenario, a backend or a whole run.
 * @returns the counts, `accuracy` = correct / total and `explicitRate` = decisions carrying
 * `abstained: true` over all decisions in the cases; both `null` when their denominator is
 * empty, because "no abstain cases" is not an accuracy of zero.
 */
export function abstention(cases: readonly AbstainCase[]): AbstentionResult {
  const verdicts = cases.map(judge);
  const correct = verdicts.filter((verdict) => verdict.correct).length;
  const decisions = cases.reduce((total, item) => total + item.decisions.length, 0);
  const explicit = cases.reduce(
    (total, item) => total + item.decisions.filter((decision) => decision.abstained).length,
    0,
  );

  return {
    correct,
    total: cases.length,
    accuracy: cases.length === 0 ? null : correct / cases.length,
    decisions,
    explicit,
    explicitRate: decisions === 0 ? null : explicit / decisions,
    cases: verdicts,
  };
}

/**
 * Two abstention results pooled into one.
 *
 * The run summary adds per-scenario results rather than re-judging every case, so a scenario
 * keeps the benign set and review floor it was scored with.
 */
export function mergeAbstention(results: readonly AbstentionResult[]): AbstentionResult {
  const correct = results.reduce((total, result) => total + result.correct, 0);
  const total = results.reduce((sum, result) => sum + result.total, 0);
  const decisions = results.reduce((sum, result) => sum + result.decisions, 0);
  const explicit = results.reduce((sum, result) => sum + result.explicit, 0);

  return {
    correct,
    total,
    accuracy: total === 0 ? null : correct / total,
    decisions,
    explicit,
    explicitRate: decisions === 0 ? null : explicit / decisions,
    cases: results.flatMap((result) => result.cases),
  };
}
