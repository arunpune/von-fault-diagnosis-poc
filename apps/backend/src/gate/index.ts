// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The confidence gate.
 *
 * Opening a work order is the costly action and a log line costs nothing, so
 * the thresholds are asymmetric: a ticket needs `GATE_TICKET_MIN_CONFIDENCE`,
 * a review ticket needs `GATE_REVIEW_MIN_CONFIDENCE`, and everything else is
 * recorded and re-decided half a sim hour later.
 *
 * Two things this module deliberately does not do. It never looks at severity —
 * how serious a situation is and how sure the backend is are two judgments, and
 * mixing them would make an evaluation unable to say which one was wrong. And
 * it never sees a failed call: a backend that did not answer produces a
 * decision message with {@link failedGate}, not a gate decision.
 *
 * The thresholds are values, not constants: the evaluation harness sweeps them
 * per backend and per model version, and the questions are never reworded to
 * move policy.
 */

import { NONE_OF_THESE } from "../decision/types.ts";
import type { FaultChoice } from "../decision/types.ts";

/** What the gate decided about one decision. */
export type GateOutcome = "ticket" | "review" | "log";

/** The two thresholds, from `GATE_TICKET_MIN_CONFIDENCE` and its review twin. */
export interface GateConfig {
  /** Default 0.85. */
  readonly ticketMin: number;
  /** Default 0.60. */
  readonly reviewMin: number;
}

/** The gate's answer, with the sentence the decision message repeats. */
export interface GateResult {
  readonly outcome: GateOutcome;
  /** True when the backend said "no catalog cause fits" and meant it. */
  readonly abstained: boolean;
  /** One sentence naming the rule that produced the outcome. */
  readonly reason: string;
}

/** The part of a decision the gate reads; severity is not in it, by design. */
export interface GateInput {
  readonly choice: FaultChoice;
  readonly confidence: number;
}

/** A confidence, rounded for the reason sentence so it reads as a number. */
function shown(confidence: number): string {
  return confidence.toFixed(2);
}

/**
 * Apply the gate to one answered decision.
 *
 * The abstention is the interesting row: a backend that says `none_of_these`
 * *confidently* has told us something — no catalog cause explains this — and
 * the evaluation harness counts it as abstention accuracy. It still only logs,
 * because there is nothing to put on a ticket.
 */
export function gate(decision: GateInput, config: GateConfig): GateResult {
  const { choice, confidence } = decision;
  if (choice === NONE_OF_THESE) {
    if (confidence >= config.reviewMin) {
      return {
        outcome: "log",
        abstained: true,
        reason:
          `no candidate's expected movements fit and the backend is sure of it ` +
          `(confidence ${shown(confidence)} at or above the review threshold ` +
          `${shown(config.reviewMin)}); recorded, no ticket`,
      };
    }
    return {
      outcome: "log",
      abstained: false,
      reason:
        `no candidate was chosen and confidence ${shown(confidence)} is below the review ` +
        `threshold ${shown(config.reviewMin)}; recorded and re-decided later`,
    };
  }

  if (confidence >= config.ticketMin) {
    return {
      outcome: "ticket",
      abstained: false,
      reason:
        `${choice} was chosen with confidence ${shown(confidence)}, at or above the ticket ` +
        `threshold ${shown(config.ticketMin)}`,
    };
  }
  if (confidence >= config.reviewMin) {
    return {
      outcome: "review",
      abstained: false,
      reason:
        `${choice} was chosen with confidence ${shown(confidence)}, between the review ` +
        `threshold ${shown(config.reviewMin)} and the ticket threshold ` +
        `${shown(config.ticketMin)}; a technician confirms it`,
    };
  }
  return {
    outcome: "log",
    abstained: false,
    reason:
      `${choice} was chosen with confidence ${shown(confidence)}, below the review threshold ` +
      `${shown(config.reviewMin)}; recorded and re-decided later`,
  };
}

/**
 * The gate block a failed call carries.
 *
 * A backend that did not answer is still a decision message,
 * and that message's `gate` block has to say something. It says `log` and names
 * the outage, so a run that lost its provider is visible in the decision list
 * instead of looking like a quiet machine.
 */
export function failedGate(): GateResult {
  return {
    outcome: "log",
    abstained: false,
    reason: "the backend returned no answer, so the gate was not applied; recorded as failed",
  };
}
