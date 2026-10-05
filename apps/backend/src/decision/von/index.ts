// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Von decision backend (docs/decision-backends.md#von).
 *
 * One `POST /v1/systemone` per suspect event: the state of `decision/state.ts`,
 * the question set of `decision/von/questions.ts`, the answers read by
 * `decision/von/parse.ts`. Nothing else happens here, because everything else
 * is arithmetic, windows or policy and those belong to code.
 *
 * Three decisions are worth naming.
 *
 * **The model is passed on every call.** The version is passed explicitly per
 * call so every run can say which version answered it.
 *
 * **Retries are handled here.** The von-sdk's VonClient does not have built-in
 * retry logic, so we implement a simple exponential backoff for 429/5xx here.
 *
 * **No body and no key ever reaches a log.** Errors raised here carry a status
 * and a sentence, never the provider's body. The bodies are kept in
 * {@link DecisionOutput.raw}, which reaches the database and never the broker.
 */

import { VonClient, VonError } from "von-sdk";
import type { Question } from "von-sdk";

import type { Secret } from "../../config/secret.ts";
import { buildState, stateDigest } from "../state.ts";
import type { DecisionState, SignalLabels } from "../state.ts";
import { DecisionError } from "../types.ts";
import type { DecideOptions, DecisionBackend, DecisionInput, DecisionOutput } from "../types.ts";
import { parseAnswers, readResponse } from "./parse.ts";
import type { VonResponse } from "./parse.ts";
import { buildQuestions } from "./questions.ts";
import type { VonRequestBody } from "./questions.ts";

/** Per-attempt timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Retries after the first attempt. */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Where the backend reports what is worth an operator's attention.
 *
 * The signature is pino's `logger.warn(fields, message)`, so the composition
 * root passes a child logger's method and a test passes a spy. The fields are
 * identifiers and ids, never a body.
 */
export type VonWarn = (fields: Readonly<Record<string, string | number>>, message: string) => void;

/** What `createVonBackend` needs from its caller. */
export interface VonBackendOptions {
  /** The Von API key, unwrapped once here: this is the provider boundary. */
  readonly apiKey: Secret;
  /** `VON_BASE_URL`; a test points it at the mock server. */
  readonly baseURL: string;
  /** `VON_MODEL`, a pinned version. It travels on every request. */
  readonly model: string;
  /** Per-attempt timeout; there is no total retry budget. */
  readonly timeoutMs?: number;
  /** Retries after the first attempt. A test that counts requests sets it to zero. */
  readonly maxRetries?: number;
  /**
   * First backoff delay in milliseconds for retries.
   * A test that asserts a retry count sets this to a millisecond or two.
   */
  readonly backoffInitialMs?: number;
  /** Maximum backoff delay in milliseconds. */
  readonly backoffMaxMs?: number;
  /** The human names of the signals, for the state this backend builds. */
  readonly labels?: SignalLabels;
  /** Wall clock, injected so a latency assertion is not a race. */
  readonly wall?: () => number;
  /** Where a model mismatch or a contradicted Choice is reported. */
  readonly warn?: VonWarn;
}

/**
 * The state as JSON-compatible value.
 */
function asEntry(state: DecisionState): unknown {
  return state as unknown;
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
 */
export function toDecisionError(error: unknown): DecisionError {
  if (error instanceof DecisionError) return error;
  if (error instanceof VonError) {
    if (error.status !== undefined) {
      return new DecisionError(
        kindOfStatus(error.status),
        `the Von API answered ${String(error.status)}`,
        { status: error.status },
      );
    }
    const msg = error.message ?? "";
    if (msg.includes("timed out") || msg.includes("AbortError")) {
      return new DecisionError("timeout", "the Von API did not answer in time");
    }
    if (msg.includes("network") || msg.includes("fetch")) {
      return new DecisionError("network", "the Von API could not be reached");
    }
    return new DecisionError("validation", "the Von SDK refused the request");
  }
  // Handle raw abort errors from an AbortSignal
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return new DecisionError("timeout", "the decision was aborted before the API answered");
    }
    // ECONNREFUSED, ECONNRESET etc. → network
    if (
      error.message.includes("ECONNREFUSED") ||
      error.message.includes("ECONNRESET") ||
      error.message.includes("fetch failed")
    ) {
      return new DecisionError("network", "the Von API could not be reached");
    }
  }
  return new DecisionError("unknown", "the Von call failed");
}

/** One response, its envelope checked. */
interface Answered {
  readonly response: VonResponse;
  /** The body exactly as it arrived, for `app.decisions.response`. */
  readonly body: unknown;
  readonly requestId: string | undefined;
}

/** Whether this status is worth retrying. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the Von backend.
 */
export function createVonBackend(options: VonBackendOptions): DecisionBackend {
  const {
    apiKey,
    baseURL,
    model,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    backoffInitialMs = 500,
    backoffMaxMs = 8_000,
    labels = {},
    wall = () => Date.now(),
    warn,
  } = options;

  const client = new VonClient({
    apiKey: apiKey.reveal(),
    baseURL,
    timeout: timeoutMs,
  });

  /** One attempt; throws DecisionError on any failure. */
  async function attempt(request: VonRequestBody, signal?: AbortSignal): Promise<Answered> {
    // Abort immediately if signal is already aborted
    if (signal?.aborted) {
      throw new DecisionError("timeout", "the decision was aborted before the API answered");
    }
    try {
      const data = await client.systemOne({
        state: asEntry(request.state),
        model: request.model,
        // The von-sdk types restrict criteria to string | string[], but the
        // wire protocol supports structured JSON values; cast to bypass.
        questions: request.questions as unknown as Record<string, Question>,
      });
      return {
        response: readResponse(data),
        body: data,
        requestId: undefined,
      };
    } catch (error) {
      throw toDecisionError(error);
    }
  }

  /** Retry with exponential backoff for retryable errors. */
  async function call(request: VonRequestBody, signal?: AbortSignal): Promise<Answered> {
    let lastError: DecisionError | undefined;
    for (let attempt_num = 0; attempt_num <= maxRetries; attempt_num++) {
      if (attempt_num > 0) {
        const delay = Math.min(backoffInitialMs * Math.pow(2, attempt_num - 1), backoffMaxMs);
        await sleep(delay);
      }
      try {
        return await attempt(request, signal);
      } catch (error) {
        if (!(error instanceof DecisionError)) throw error;
        lastError = error;
        if (error.status === undefined || !isRetryable(error.status) || attempt_num >= maxRetries) {
          throw error;
        }
      }
    }
    throw lastError ?? new DecisionError("unknown", "the Von call failed");
  }

  return {
    name: "von",
    model,
    async decide(input: DecisionInput, decideOptions?: DecideOptions): Promise<DecisionOutput> {
      const started = wall();
      const state = buildState(input, labels);
      const request: VonRequestBody = { model, state, questions: buildQuestions(state, input) };
      const { response, body, requestId } = await call(request, decideOptions?.signal);

      if (response.model !== model) {
        warn?.(
          { model: response.model, pinned: model },
          "von answered with a model other than the pinned one",
        );
      }

      const parsed = parseAnswers(
        state.candidates.map((candidate) => candidate.id),
        response.answers,
      );
      if (parsed.inconsistent) {
        warn?.(
          { choice: parsed.choice, support: parsed.support[parsed.choice] ?? 0 },
          "von chose a cause whose own movement check stays low",
        );
      }

      return {
        backend: "von",
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
