// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The port the LLM backend calls.
 *
 * The backend itself owns the judgment — the system prompt, the schema, the
 * normalisation, the rejection of an id the catalog never offered — and knows
 * nothing about the provider it is talking to. Everything vendor-shaped lives
 * behind this one method: the SDK, the wire shape of structured output, the
 * names of its error classes and the header the request id arrives on.
 *
 * That split is what makes the backend testable without a socket. A fake
 * provider is four lines, so the fixture tests of `index.test.ts` drive the
 * answer handling directly; `anthropic.ts` is then exercised on its own over
 * HTTP against the contracts' mock server, which is the only place the
 * real SDK's behaviour is asserted.
 *
 * A provider reports what it saw and never decides what it means. A refusal, a
 * truncated answer and an answer that would not parse all come back as
 * `parsed: null` with the `stop_reason` that explains them; turning that into a
 * {@link ../types.ts DecisionError} is the backend's job, so the rule is
 * written once for every provider. Transport failures are the exception: only
 * the provider can tell a 401 from a 529, so it raises those itself.
 */

import type { ZodType } from "zod";

/** One structured-output call: the fixed prompt, the state, the answer schema. */
export interface LlmRequest {
  /** The fixed system prompt stating the three questions. */
  readonly system: string;
  /** The state as JSON; the only part that changes between decisions. */
  readonly user: string;
  /** The schema the answer must satisfy (`schema.ts`). */
  readonly schema: ZodType;
}

/** Tokens the provider was billed for. */
export interface LlmUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/** What one provider call produced. */
export interface LlmCompletion {
  /**
   * The parsed structured answer, or `null` when there is none.
   *
   * `null` covers every way an answer can fail to arrive with the call itself
   * succeeding: a refusal, a reply cut off at `max_tokens`, or content that did
   * not satisfy the schema. {@link stop_reason} says which.
   */
  readonly parsed: unknown;
  readonly usage: LlmUsage;
  /** The model the provider answered with; it may differ from the one asked for. */
  readonly model: string;
  /** Why the provider stopped, in its own vocabulary, or `null` when it said nothing. */
  readonly stop_reason: string | null;
  /**
   * Why {@link parsed} is `null`, in the provider's own words, when it said:
   * the category of a refusal, or what failed about content that would not
   * parse. The backend records it in the error message.
   */
  readonly detail?: string;
  /** The provider's own identifier for the call, for a support request. */
  readonly request_id?: string;
  /** Provider bodies with no headers and no key material. */
  readonly raw: { readonly request?: unknown; readonly response?: unknown };
}

/** What a `complete` call may be given beyond its request. */
export interface LlmCallOptions {
  /** Aborts the call; the provider maps the abort to a `timeout` DecisionError. */
  readonly signal?: AbortSignal;
}

/** One language-model provider. Anthropic is the only implementation. */
export interface LlmProvider {
  /** The provider's name, as the logs and the decision sheet report it. */
  readonly name: string;
  /** The model identifier every answer of this provider will carry. */
  readonly model: string;
  complete(request: LlmRequest, options?: LlmCallOptions): Promise<LlmCompletion>;
}
