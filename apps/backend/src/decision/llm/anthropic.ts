// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one {@link LlmProvider}: Anthropic's Messages API
 * (docs/decision-backends.md#the-llm-backend).
 *
 * `@anthropic-ai/sdk` 0.127.0 with `messages.parse` and `zodOutputFormat`
 * sends the structured-output shape this repository pins —
 * `output_config.format = { type: "json_schema", schema: … }` — and hands back
 * `parsed_output`. That is the same wire shape the catalog structurer sends
 * from Python, which is why one mock server can stand in for both
 * (`@fdp/contracts/mock`).
 *
 * ## Stop reason first, content second
 *
 * `refusal` and `max_tokens` both leave an answer that must not be believed:
 * the first has no content at all, the second has content that stops
 * mid-token. The SDK, however, parses the text block inside
 * `messages.parse` itself, before the caller sees the message, and a truncated
 * JSON document makes it throw — which would lose the stop reason that
 * explains the failure. So the format handed to the SDK keeps
 * `zodOutputFormat`'s type and schema (the wire shape is unchanged) and wraps
 * its `parse` so a failure is recorded instead of thrown. The stop reason is
 * then read first: a refusal or a cut-off reply comes back as `parsed: null`
 * with the reason (and a refusal's `stop_details.category`), and only an
 * answer that ended normally is allowed to be parsed at all. `index.ts` turns
 * every `parsed: null` into a `DecisionError { kind: 'validation' }`, one rule
 * for every provider.
 *
 * ## Transport failures
 *
 * Those this module maps, because only it can: the SDK's error classes are
 * tested most specific first, since `APIConnectionTimeoutError` extends
 * `APIConnectionError` and every status class extends `APIError`.
 *
 * ## Request ids
 *
 * A failure carries the `request-id` header on the SDK's error, and the
 * `DecisionError` keeps it. A success does not: `messages.parse` copies the
 * message into a new object and drops the SDK's non-enumerable `_request_id`
 * on the way, so an answered call is traced by the message `id` stored with
 * the raw response in `app.decisions.response`.
 *
 * The key is revealed once, here, at the SDK boundary: secrets come from the
 * environment only and never reach a log or a stored body. Nothing
 * this module returns carries a header, so no `x-api-key` can reach the raw
 * bodies that `app.decisions` stores.
 */

import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AutoParseableOutputFormat } from "@anthropic-ai/sdk/lib/parser";
import type { RefusalStopDetails } from "@anthropic-ai/sdk/resources/messages";
import type { ZodType } from "zod";

import type { Secret } from "../../config/secret.ts";
import { DecisionError } from "../types.ts";
import type { DecisionErrorKind } from "../types.ts";
import type { LlmCallOptions, LlmCompletion, LlmProvider, LlmRequest } from "./provider.ts";

/** The provider's name, as `LlmProvider.name` and `LLM_PROVIDER` spell it. */
export const ANTHROPIC_PROVIDER = "anthropic";

/** The output budget of one decision. */
export const MAX_TOKENS = 4096;

/**
 * How long one call may take.
 *
 * Longer than Jev's ten seconds: this backend asks one model for three
 * judgments and a sentence in a single reply, and a timeout that fires while
 * the answer is still being written would be counted as an outage by the
 * heartbeat rather than as the slow call it is.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Retries the SDK runs on 429 and 529; the backend adds none. */
export const DEFAULT_MAX_RETRIES = 2;

/** What {@link createAnthropicProvider} needs to talk to the API. */
export interface AnthropicProviderOptions {
  /** `LLM_API_KEY`, revealed once when the client is built. */
  readonly apiKey: Secret;
  /** `LLM_MODEL`; every answer carries it back. */
  readonly model: string;
  /** Per-call deadline; {@link DEFAULT_TIMEOUT_MS} when unset. */
  readonly timeoutMs?: number;
  /** Where the API lives (`LLM_BASE_URL`). Tests point it at the mock server. */
  readonly baseURL?: string;
  /** How often the SDK retries a 429 or a 529 itself; `0` in tests. */
  readonly maxRetries?: number;
  /**
   * A ready-made client, for a test that has to drive the transport itself.
   * When it is given, `apiKey`, `timeoutMs`, `baseURL` and `maxRetries` are
   * the client's business and are not read.
   */
  readonly client?: Anthropic;
}

/** The stop reasons that mean "there is no answer to read". */
const NO_ANSWER_STOP_REASONS: ReadonlySet<string> = new Set(["refusal", "max_tokens"]);

/** HTTP statuses whose meaning for a decision is fixed. */
const KIND_BY_STATUS: ReadonlyMap<number, DecisionErrorKind> = new Map<number, DecisionErrorKind>([
  [400, "validation"],
  [401, "auth"],
  [403, "auth"],
  [404, "validation"],
  [408, "timeout"],
  [413, "validation"],
  [422, "validation"],
  [429, "rate_limit"],
  [503, "overloaded"],
  [529, "overloaded"],
]);

/** The details every {@link DecisionError} of this module carries when it has them. */
function details(error: APIError): { status?: number; request_id?: string } {
  const carried: { status?: number; request_id?: string } = {};
  if (typeof error.status === "number") carried.status = error.status;
  if (typeof error.requestID === "string") carried.request_id = error.requestID;
  return carried;
}

/**
 * The SDK's failure as a {@link DecisionError}.
 *
 * Most specific first: `APIConnectionTimeoutError` and `APIUserAbortError` are
 * both `APIConnectionError`s or `APIError`s, and `AuthenticationError` and
 * `RateLimitError` are both `APIError`s, so the order of these branches is the
 * mapping.
 */
export function toDecisionError(error: unknown): DecisionError {
  if (error instanceof DecisionError) return error;
  if (error instanceof AuthenticationError) {
    return new DecisionError(
      "auth",
      `anthropic rejected the key: ${error.message}`,
      details(error),
    );
  }
  if (error instanceof RateLimitError) {
    return new DecisionError(
      "rate_limit",
      `anthropic rate limit: ${error.message}`,
      details(error),
    );
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new DecisionError("timeout", "anthropic did not answer in time");
  }
  if (error instanceof APIUserAbortError) {
    return new DecisionError("timeout", "the anthropic call was aborted");
  }
  if (error instanceof APIConnectionError) {
    return new DecisionError("network", `anthropic is unreachable: ${error.message}`);
  }
  if (error instanceof APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const kind = (status === undefined ? undefined : KIND_BY_STATUS.get(status)) ?? "unknown";
    return new DecisionError(
      kind,
      `anthropic returned ${status === undefined ? "no status" : String(status)}: ${error.message}`,
      details(error),
    );
  }
  return new DecisionError("unknown", `the anthropic call failed: ${messageOf(error)}`);
}

/** An unknown throwable's message, without assuming it is an `Error`. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One `complete` call's output format, and what its parse step found wrong, if anything. */
interface RecordingFormat {
  readonly format: AutoParseableOutputFormat<unknown>;
  /** The first parse failure of this call, or `undefined` when there was none. */
  failure(): string | undefined;
}

/**
 * `zodOutputFormat(schema)` whose `parse` records a failure instead of throwing.
 *
 * The type and the JSON Schema are the helper's own, so the request on the wire
 * is exactly the pinned one; only what happens to a bad reply changes.
 */
function recordingFormat(schema: ZodType): RecordingFormat {
  const format = zodOutputFormat(schema);
  let failure: string | undefined;
  return {
    format: {
      ...format,
      parse: (content: string): unknown => {
        try {
          return format.parse(content);
        } catch (error) {
          failure ??= messageOf(error);
          return null;
        }
      },
    },
    failure: () => failure,
  };
}

/** What `stop_details` says about a refusal, when it names a category. */
function refusalCategory(stopDetails: RefusalStopDetails | null): string | undefined {
  const category = stopDetails?.category;
  return category === null || category === undefined ? undefined : `refusal category: ${category}`;
}

/**
 * Build the Anthropic provider.
 *
 * `client` and `baseURL` exist for the tests: the provider is driven
 * over a real socket against `startMockAnthropic` before it is ever pointed at
 * the live API, so the request the SDK builds is checked against the committed
 * request schema rather than against a hand-written expectation.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions): LlmProvider {
  const { model, timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES } = options;
  const client =
    options.client ??
    new Anthropic({
      apiKey: options.apiKey.reveal(),
      timeout: timeoutMs,
      maxRetries,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    });

  return {
    name: ANTHROPIC_PROVIDER,
    model,

    async complete(request: LlmRequest, callOptions: LlmCallOptions = {}): Promise<LlmCompletion> {
      const output = recordingFormat(request.schema);
      const body = {
        model,
        max_tokens: MAX_TOKENS,
        system: request.system,
        messages: [{ role: "user" as const, content: request.user }],
      };

      const message = await client.messages
        .parse(
          { ...body, output_config: { format: output.format } },
          callOptions.signal === undefined ? undefined : { signal: callOptions.signal },
        )
        .catch((error: unknown) => {
          throw toDecisionError(error);
        });

      const stopReason = message.stop_reason;
      const answered = stopReason === null || !NO_ANSWER_STOP_REASONS.has(stopReason);
      const parsed: unknown = answered ? message.parsed_output : null;
      const detail =
        stopReason === "refusal" ? refusalCategory(message.stop_details) : output.failure();

      return {
        parsed,
        usage: {
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
        },
        model: message.model,
        stop_reason: stopReason,
        ...(parsed === null && detail !== undefined ? { detail } : {}),
        raw: {
          // What `app.decisions.request` stores: the body as sent, no headers.
          request: {
            ...body,
            output_config: { format: { type: output.format.type, schema: output.format.schema } },
          },
          response: message,
        },
      };
    },
  };
}
