// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Jev decision backend (docs/decision-backends.md#jev).
 *
 * One `POST /v1/systemone` per suspect event: the state of `decision/state.ts`,
 * the question set of `decision/jev/questions.ts`, the answers read by
 * `decision/jev/parse.ts`. Nothing else happens here, because everything else
 * is arithmetic, windows or policy and those belong to code.
 *
 * Three decisions are worth naming.
 *
 * **The model is passed on every call.** The SDK's default resolves to
 * `jev-latest`, an alias `config/env.ts` refuses outright: a run that cannot
 * say which version answered it is not an evaluation. The response's own
 * `model` is stored and a mismatch is warned about rather than thrown on, so a
 * provider-side alias move shows up in the report instead of stopping the run.
 *
 * **Retries are the SDK's.** It already backs off on 429 and 5xx and honours
 * `Retry-After`; a second layer on top would multiply the budget and hide which
 * one gave up. {@link JevBackendOptions.maxRetries} exists so a test can set it
 * to zero and count the requests the mock recorded.
 *
 * **No body and no key ever reaches a log.** The SDK's own logger is switched
 * off — at `debug` it prints headers and bodies — and the errors raised here
 * carry a status, a request id and a sentence, never the provider's body. The
 * bodies are kept in {@link DecisionOutput.raw}, which reaches the database and
 * never the broker.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import type { EntryType } from "@typesafe-ai/sdk";

import type { Secret } from "../../config/secret.ts";
import { buildState, stateDigest } from "../state.ts";
import type { DecisionState, SignalLabels } from "../state.ts";
import { DecisionError } from "../types.ts";
import type { DecideOptions, DecisionBackend, DecisionInput, DecisionOutput } from "../types.ts";
import { parseAnswers, readResponse } from "./parse.ts";
import type { JevResponse } from "./parse.ts";
import { buildQuestions } from "./questions.ts";
import type { JevRequestBody } from "./questions.ts";

/** Per-attempt timeout, the SDK's own default. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Retries after the first attempt, the SDK's own default. */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Where the backend reports what is worth an operator's attention.
 *
 * The signature is pino's `logger.warn(fields, message)`, so the composition
 * root passes a child logger's method and a test passes a spy. The fields are
 * identifiers and ids, never a body.
 */
export type JevWarn = (fields: Readonly<Record<string, string | number>>, message: string) => void;

/** What `createJevBackend` needs from its caller. */
export interface JevBackendOptions {
  /** The TypeSafe key, unwrapped once here: this is the provider boundary. */
  readonly apiKey: Secret;
  /** `TYPESAFE_BASE_URL`; a test points it at the mock server. */
  readonly baseURL: string;
  /** `JEV_MODEL`, a pinned version. It travels on every request. */
  readonly model: string;
  /** Per-attempt timeout; there is no total retry budget. */
  readonly timeoutMs?: number;
  /** Retries after the first attempt. A test that counts requests sets it to zero. */
  readonly maxRetries?: number;
  /**
   * First and largest backoff delay, in milliseconds.
   *
   * Production leaves both at the SDK's defaults. A test that asserts a retry
   * count sets them to a millisecond or two rather than waiting the real
   * backoff out, which is the same reason the heartbeat tests shorten
   * their timeouts.
   */
  readonly backoffInitialMs?: number;
  readonly backoffMaxMs?: number;
  /** The human names of the signals, for the state this backend builds. */
  readonly labels?: SignalLabels;
  /** Wall clock, injected so a latency assertion is not a race. */
  readonly wall?: () => number;
  /** Where a model mismatch or a contradicted Choice is reported. */
  readonly warn?: JevWarn;
}

/**
 * The state as the SDK's `EntryType`.
 *
 * {@link DecisionState} is JSON — it is written to the database and hashed as
 * JSON — but it is declared as a deeply readonly interface, and neither a
 * readonly array nor an interface without an index signature is assignable to
 * the SDK's mutable `JsonValue`. The cast asserts what the shape already is.
 */
function asEntry(state: DecisionState): EntryType {
  return state as unknown as EntryType;
}

/** Which {@link DecisionError} kind an HTTP status is. */
function kindOfStatus(status: number): DecisionError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 404 || status === 413 || status === 422) return "validation";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  return "unknown";
}

/**
 * Map an SDK failure onto the vocabulary the decision message carries.
 *
 * The provider's body is deliberately dropped: it is the one place a key echo
 * or a customer string could travel out of this module, and the status plus the
 * request id say everything the operator needs. The order matters, because the
 * SDK's classes nest: a timeout is a connection error and every one of them is
 * a `TypeSafeError`.
 */
export function toDecisionError(error: unknown): DecisionError {
  if (error instanceof DecisionError) return error;
  if (error instanceof APIError) {
    return new DecisionError(
      kindOfStatus(error.status),
      `the TypeSafe API answered ${String(error.status)}`,
      {
        status: error.status,
        ...(error.requestId === undefined ? {} : { request_id: error.requestId }),
      },
    );
  }
  if (error instanceof APITimeoutError) {
    return new DecisionError("timeout", "the TypeSafe API did not answer in time");
  }
  if (error instanceof APIUserAbortError) {
    return new DecisionError("timeout", "the decision was aborted before the API answered");
  }
  if (error instanceof APIConnectionError) {
    return new DecisionError("network", "the TypeSafe API could not be reached");
  }
  if (error instanceof TypeSafeError) {
    // The SDK checks the question set before it sends anything.
    return new DecisionError("validation", "the TypeSafe SDK refused the request");
  }
  return new DecisionError("unknown", "the TypeSafe call failed");
}

/** One response, its envelope checked, with the id the provider gave it. */
interface Answered {
  readonly response: JevResponse;
  /** The body exactly as it arrived, for `app.decisions.response`. */
  readonly body: unknown;
  readonly requestId: string | undefined;
}

/**
 * Build the Jev backend.
 *
 * The client is built once: it holds the retry policy, the timeout and the
 * bearer, and rebuilding it per decision would re-read the environment on every
 * suspect event.
 */
export function createJevBackend(options: JevBackendOptions): DecisionBackend {
  const {
    apiKey,
    baseURL,
    model,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    backoffInitialMs,
    backoffMaxMs,
    labels = {},
    wall = () => Date.now(),
    warn,
  } = options;

  const client = new TypeSafeClient({
    apiKey: apiKey.reveal(),
    baseURL,
    defaultModel: model,
    timeout: timeoutMs,
    retry: {
      maxRetries,
      ...(backoffInitialMs === undefined ? {} : { backoffInitialMs }),
      ...(backoffMaxMs === undefined ? {} : { backoffMaxMs }),
    },
    // The SDK logs bodies at `debug` and summaries at `info`, both on its own
    // console logger rather than on pino. Everything this backend wants said is
    // said through `warn` below.
    logLevel: "off",
  });

  /** The one round trip of a decision; every failure leaves as a `DecisionError`. */
  async function call(request: JevRequestBody, signal: AbortSignal | undefined): Promise<Answered> {
    try {
      const answered = await client
        .systemOne(
          { state: asEntry(request.state), model: request.model, questions: request.questions },
          signal === undefined ? {} : { signal },
        )
        .withResponse();
      return {
        response: readResponse(answered.data),
        body: answered.data,
        requestId: answered.requestId,
      };
    } catch (error) {
      throw toDecisionError(error);
    }
  }

  return {
    name: "jev",
    model,
    async decide(input: DecisionInput, decideOptions?: DecideOptions): Promise<DecisionOutput> {
      const started = wall();
      const state = buildState(input, labels);
      // Key order is wire order: `state`, `model`, `questions`, which is what
      // the SDK serialises and what the golden request fixture holds.
      const request: JevRequestBody = { state, model, questions: buildQuestions(state, input) };
      const { response, body, requestId } = await call(request, decideOptions?.signal);

      if (response.model !== model) {
        warn?.(
          { model: response.model, pinned: model },
          "jev answered with a model other than the pinned one",
        );
      }

      const parsed = parseAnswers(
        state.candidates.map((candidate) => candidate.id),
        response.answers,
      );
      if (parsed.inconsistent) {
        warn?.(
          { choice: parsed.choice, support: parsed.support[parsed.choice] ?? 0 },
          "jev chose a cause whose own movement check stays low",
        );
      }

      return {
        backend: "jev",
        model: response.model,
        choice: parsed.choice,
        probabilities: parsed.probabilities,
        confidence: parsed.confidence,
        support: parsed.support,
        severity: parsed.severity,
        usage: response.usage,
        latency_ms: Math.max(0, wall() - started),
        ...(requestId === undefined ? {} : { request_id: requestId }),
        state,
        state_digest: stateDigest(state),
        raw: { request, response: body },
      };
    },
  };
}
