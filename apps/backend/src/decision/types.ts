// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The decision layer's vocabulary (docs/decision-backends.md).
 *
 * Three backends answer the same three questions — which cause, how well each
 * candidate fits, how serious it is — and everything downstream (the gate, the
 * episodes, the tickets, the cost ledger, the UI and `tools/eval`) reads one
 * shape. A backend is a function of its input and nothing else: it is handed
 * the event, the candidates and the unit, and it returns what it saw
 * (`state`), what it answered and what it cost.
 *
 * `confidence` is the one field whose meaning differs per backend, and that is
 * deliberate: Jev reports the peakedness of its own distribution, the LLM
 * reports a self-report and the rules twin reports a calibrated margin. The
 * gate applies the same thresholds to all three, and every report that
 * compares them names the quantity it shows.
 */

import type { DecisionBackend as DecisionBackendName, SeverityLevel } from "@fdp/contracts";
import type { SuspectEvent } from "@fdp/contracts";

import type { Candidate } from "../retrieval/types.ts";

export type { DecisionBackendName };

/** The Choice option that means "no candidate's expected movements fit". */
export const NONE_OF_THESE = "none_of_these";

/** A catalog `fault_id`, or the abstention (`common.schema.json#/$defs/choice`). */
export type FaultChoice = string | typeof NONE_OF_THESE;

/** What one decision is taken about. */
export interface DecisionInput {
  readonly event: SuspectEvent;
  /** What retrieval offered, at most six, best first. */
  readonly candidates: readonly Candidate[];
  readonly unit_id: string;
}

/** Tokens a backend reported; the rules twin reports zeros. */
export interface DecisionUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/** How serious the situation is, as the severity question answered it. */
export interface DecisionSeverity {
  readonly level: SeverityLevel;
  /** The level's index, `0` low to `3` critical. */
  readonly score: number;
  /** Mass per level index, keyed by the index as a string. */
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  /** The Score primitive's own rendering of its levels, when it returns one. */
  readonly legend?: readonly string[];
}

/** One answer of one backend to one suspect event. */
export interface DecisionOutput {
  readonly backend: DecisionBackendName;
  readonly model: string;
  readonly choice: FaultChoice;
  /** Mass over the candidate fault ids plus {@link NONE_OF_THESE}; sums to 1. */
  readonly probabilities: Readonly<Record<string, number>>;
  /** The gating quantity; what it measures depends on the backend. */
  readonly confidence: number;
  /** Per candidate; `null` for a backend with no per-candidate question. */
  readonly support: Readonly<Record<string, number | null>>;
  readonly severity: DecisionSeverity;
  readonly usage: DecisionUsage;
  readonly latency_ms: number;
  readonly request_id?: string;
  /** What the backend saw. It reaches the database, never the broker. */
  readonly state: unknown;
  /** The sha256 of that state's canonical JSON. */
  readonly state_digest: string;
  /** Provider bodies with no headers and no key material. */
  readonly raw: { readonly request?: unknown; readonly response?: unknown };
}

/** Why a backend call failed (the decision message repeats it). */
export type DecisionErrorKind =
  "auth" | "validation" | "rate_limit" | "overloaded" | "network" | "timeout" | "unknown";

/**
 * A backend call that produced no answer.
 *
 * It is an `Error` because a backend throws it; the pipeline catches it and
 * still writes a decision message, so an outage is visible rather than silently
 * retried with another backend.
 */
export class DecisionError extends Error {
  readonly kind: DecisionErrorKind;
  readonly status?: number;
  readonly request_id?: string;

  constructor(
    kind: DecisionErrorKind,
    message: string,
    details: { status?: number; request_id?: string } = {},
  ) {
    super(message);
    this.name = "DecisionError";
    this.kind = kind;
    if (details.status !== undefined) this.status = details.status;
    if (details.request_id !== undefined) this.request_id = details.request_id;
  }
}

/** Whether an unknown value is a {@link DecisionError}. */
export function isDecisionError(value: unknown): value is DecisionError {
  return value instanceof DecisionError;
}

/** What a `decide` call may be given beyond its input. */
export interface DecideOptions {
  /** Aborts the provider call; the backend maps the abort to a `timeout`. */
  readonly signal?: AbortSignal;
}

/** One answer engine. */
export interface DecisionBackend {
  readonly name: DecisionBackendName;
  /** The model identifier the answer will carry; `rules-v1` for the twin. */
  readonly model: string;
  decide(input: DecisionInput, options?: DecideOptions): Promise<DecisionOutput>;
}
