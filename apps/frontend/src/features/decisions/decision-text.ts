// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// How a decision reads, in the words the alerts feed and the decision sheet share: what it chose,
// what the confidence gate did with it, why it failed, which backend answered and at what prices.
// The contract's own spellings are used: a candidate carries `name`, a failure carries
// `error.kind`, and the gate reports an abstention itself. Every enum keeps an `other` branch, so a
// value a newer contract adds reads as its own words instead of breaking the page
// (packages/contracts/VERSIONING.md).

import type { Candidate, Decision } from "@/api/types";
import { fmtUsd, humanize } from "@/lib/format";

/** The choice a backend makes when no candidate applies. */
export const NONE_OF_THESE = "none_of_these";

const GATE_WORDS: Readonly<Record<string, string>> = {
  ticket: "Ticket",
  review: "Review",
  log: "Logged",
};

const BACKEND_NAMES: Readonly<Record<string, string>> = {
  jev: "Jev",
  llm: "Claude",
  rules: "Rules",
};

/** True when the backend did not answer: the decision is a record of the failure. */
export function isFailedDecision(decision: Decision): boolean {
  return decision.status === "failed" || decision.error !== null;
}

/**
 * True when the backend said "none of these" with a confidence at or above the review threshold:
 * it looked and ruled every candidate out, which is an answer, not a shrug. The gate reports it
 * as `abstained`; the rule is repeated here so a record whose flag is missing still reads right.
 */
export function isAbstention(decision: Decision): boolean {
  return (
    decision.gate.abstained ||
    (decision.choice === NONE_OF_THESE &&
      !isFailedDecision(decision) &&
      decision.confidence >= decision.gate.review_min_confidence)
  );
}

/** What the confidence gate did: "Ticket", "Review", "Logged", or "Abstained". */
export function gateWord(decision: Decision): string {
  if (isAbstention(decision)) {
    return "Abstained";
  }
  const outcome: string = decision.gate.outcome;
  return GATE_WORDS[outcome] ?? humanize(outcome);
}

/** The candidate the decision chose; none for "none of these" or a choice outside the list. */
export function chosenCandidate(decision: Decision): Candidate | undefined {
  return decision.candidates.find((candidate) => candidate.fault_id === decision.choice);
}

/** What the decision chose, as a title: the cause name, or "No matching fault". */
export function chosenTitle(decision: Decision): string {
  if (decision.choice === NONE_OF_THESE) {
    return "No matching fault";
  }
  return chosenCandidate(decision)?.name ?? humanize(decision.choice);
}

/** Why a failed call failed, in words: "timeout", "rate limit"; null for an answered call. */
export function failureWords(decision: Decision): string | null {
  if (decision.error !== null) {
    return humanize(decision.error.kind).toLowerCase();
  }
  return decision.status === "failed" ? "unknown" : null;
}

/** The backend and its model as the status bar's chip names them: "Jev · jev-1.13.0", "Rules". */
export function backendLabel(backend: string, model: string): string {
  const name = BACKEND_NAMES[backend] ?? humanize(backend);
  return backend === "rules" || model === "" ? name : `${name} · ${model}`;
}

/** The prices a decision was billed at: "$0.042 per MTok input, output free, prices as of …". */
export function priceLine(cost: Decision["cost"]): string {
  const input = `${fmtUsd(cost.price_input_per_mtok)} per MTok input`;
  const output =
    cost.price_output_per_mtok === 0
      ? "output free"
      : `${fmtUsd(cost.price_output_per_mtok)} per MTok output`;
  return `${input}, ${output}, prices as of ${cost.prices_as_of}`;
}
