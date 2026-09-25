// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The mock Anthropic Messages server, in the shape of the TypeSafe mock beside it. Before it
// existed the only code touching the Anthropic SDKs — the optional `llm` decision backend and the
// catalog structurer — would have met a socket for the first time during the single live call at
// the end of the project, and the Node and Python sides were not even spelled the same way.
//
// One wire shape for structured output, pinned by `mock/schemas/anthropic-messages-request.schema.json`:
//
//     output_config.format = { type: "json_schema", schema: <JSON Schema> }
//
// Node reaches it through `messages.parse({ …, output_config: { format: zodOutputFormat(S) } })`
// and reads `parsed_output`; Python reaches it through `messages.create(…, output_config={...})`
// with a raw JSON Schema and parses the first text block. The mock therefore never has to know
// which SDK called it — it answers the JSON text of the first content block either way.
//
// The real API decodes under `output_config.format.schema`, so a reply that ends normally always
// satisfies the schema the request carried. The mock only replays what a policy scripted, and a
// policy can script an answer the API could never send: that is how a schema the API constrains
// to `{}` (a `z.record` map the SDK closed with `additionalProperties: false`) once passed every
// offline test while every live answer failed (review finding be-decide-02). With
// `enforceOutputSchema`, a scripted `json` answer of an `end_turn` reply is held to that schema,
// and a mismatch is answered with a 500 that names it. `text` stays unchecked — it is how a test
// scripts content the API should never produce — and so do refusals and `max_tokens` stops,
// which the API does not bind to the schema either.
//
// Bodies and key values never reach a log line.

import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { AnySchemaObject, ErrorObject, ValidateFunction } from "ajv";
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";

import { AJV_OPTIONS } from "../src/generated/validators.ts";
import {
  bearerToken,
  closeServer,
  FailureQueue,
  listen,
  parseBody,
  pathOf,
  readBody,
  redactHeaders,
  sendJson,
  sendText,
  sleep,
  type LogLine,
  type MockServer,
  type RecordedRequest,
} from "./http.ts";
import messagesRequestSchema from "./schemas/anthropic-messages-request.schema.json" with { type: "json" };

const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

/** The `output_config.format` this repository sends, and the only one the mock understands. */
export interface JsonSchemaOutputFormat {
  readonly type: "json_schema";
  readonly schema: Record<string, unknown>;
}

/** The body of `POST /v1/messages`, after it validated against the committed schema. */
export interface AnthropicMessagesRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly { readonly role: "user" | "assistant"; readonly content: unknown }[];
  readonly system?: unknown;
  readonly output_config?: {
    readonly effort?: string | null;
    readonly format?: JsonSchemaOutputFormat | null;
  };
}

/** The stop reasons the mock can be scripted with. */
export type MockStopReason = "end_turn" | "refusal" | "max_tokens";

/** The `stop_details` of a refusal, mirroring `RefusalStopDetails` of the SDK. */
export interface RefusalStopDetails {
  readonly type: "refusal";
  readonly category: "cyber" | "bio" | "frontier_llm" | "reasoning_extraction" | "general_harms";
  readonly explanation: string | null;
}

/** A `text` content block, the only kind the mock produces. */
export interface TextBlock {
  readonly type: "text";
  readonly text: string;
  readonly citations: null;
}

/** The response body of `POST /v1/messages`. */
export interface AnthropicMessage {
  readonly id: string;
  readonly type: "message";
  readonly role: "assistant";
  readonly model: string;
  readonly content: readonly TextBlock[];
  readonly stop_reason: MockStopReason;
  readonly stop_details: RefusalStopDetails | null;
  readonly stop_sequence: null;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

/**
 * What a policy pins for one reply. Everything it leaves out keeps the default: one text block
 * holding `{}`, `stop_reason: "end_turn"`, no `stop_details`, and token counts derived from the
 * request and the reply.
 */
export interface ScriptedMessage {
  readonly id?: string;
  readonly model?: string;
  /** The text of the single content block. Wins over `json`. */
  readonly text?: string;
  /** Serialised into the single content block; this is the structured-output path. */
  readonly json?: unknown;
  /** A full content override, for the empty content of a refusal. */
  readonly content?: readonly TextBlock[];
  readonly stopReason?: MockStopReason;
  readonly stopDetails?: RefusalStopDetails | null;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

/** A scripted reply policy; `index` counts the requests the mock has already answered. */
export type MessagePolicy = (request: AnthropicMessagesRequest, index: number) => ScriptedMessage;

/** The statuses `failNext` can queue; 401, 429 and 529 are the ones clients must handle. */
export type AnthropicFailStatus = 400 | 401 | 422 | 429 | 500 | 529;

const ERROR_TYPES: Readonly<Record<number, string>> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  405: "invalid_request_error",
  413: "request_too_large",
  422: "invalid_request_error",
  429: "rate_limit_error",
  500: "api_error",
  529: "overloaded_error",
};

const ERROR_MESSAGES: Readonly<Record<number, string>> = {
  401: "invalid x-api-key",
  429: "Number of requests has exceeded your rate limit.",
  500: "Internal server error.",
  529: "Overloaded.",
};

/** The default refusal, used when a policy asks for `refusal` without saying which category. */
const DEFAULT_REFUSAL: RefusalStopDetails = {
  type: "refusal",
  category: "general_harms",
  explanation: "The mock was scripted to refuse.",
};

export interface MockAnthropicOptions {
  /** `0`, the default, binds a free port. */
  readonly port?: number;
  /** Default `127.0.0.1`. */
  readonly host?: string;
  /** The single accepted key. Left out, any non-empty key is accepted. */
  readonly apiKey?: string;
  /** Delay before each answer, for reproducing a slow upstream. */
  readonly latencyMs?: number;
  /** A scripted policy, the same one `script()` installs later. */
  readonly reply?: MessagePolicy;
  /** One line per request, `<method> <path> -> <status>`; never a body, never a key. */
  readonly log?: LogLine;
  /**
   * Hold every scripted `json` answer of an `end_turn` reply to the request's
   * `output_config.format.schema`, as the real API's constrained decoding does, and answer a 500
   * naming the first mismatch instead of a reply the API could never send. Off by default;
   * `text`, `content`, the unscripted `{}` and refusal or `max_tokens` replies are never checked.
   */
  readonly enforceOutputSchema?: boolean;
}

export interface MockAnthropic extends MockServer {
  /** Installs a reply policy, or clears it with `null`. */
  script(policy: MessagePolicy | null): void;
  /** Queues `times` answers with `status`, served before auth and validation. */
  failNext(status: AnthropicFailStatus, times?: number, retryAfterS?: number): void;
}

function errorBody(
  status: number,
  message?: string,
): { type: "error"; error: { type: string; message: string } } {
  return {
    type: "error",
    error: {
      type: ERROR_TYPES[status] ?? "api_error",
      message: message ?? ERROR_MESSAGES[status] ?? "Request failed.",
    },
  };
}

function issueText(
  errors: readonly ErrorObject[] | null | undefined,
  root = "the request body",
): string {
  const first = errors?.[0];
  if (first === undefined) return `${root} is invalid`;
  const path = first.instancePath === "" ? root : first.instancePath;
  const property =
    typeof first.params["additionalProperty"] === "string"
      ? ` ("${first.params["additionalProperty"]}")`
      : "";
  return `${path} ${first.message ?? "is invalid"}${property}`;
}

/**
 * The validator of each output schema the requests carry, compiled once per distinct schema.
 *
 * Not strict: the schema is the caller's, and the mock checks answers against it rather than
 * linting it. The formats are the contracts' own (`ajv-formats`), a superset of the string
 * formats structured outputs accept.
 */
function outputSchemaValidators(): (schema: Record<string, unknown>) => ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: false, allowUnionTypes: true });
  addFormats(ajv);
  const compiled = new Map<string, ValidateFunction>();
  return (schema) => {
    const key = JSON.stringify(schema);
    const known = compiled.get(key);
    if (known !== undefined) return known;
    const validate = ajv.compile(schema);
    compiled.set(key, validate);
    return validate;
  };
}

/** The key on `x-api-key` or on `Authorization: Bearer`, in that order. */
function apiKeyOf(message: IncomingMessage): string | undefined {
  const header = message.headers["x-api-key"];
  if (typeof header === "string" && header !== "") return header;
  return bearerToken(message);
}

function tokensOf(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value ?? null), "utf8") / 4);
}

/** The content blocks of a reply: the explicit override, the text, the JSON, or `{}`. */
function contentOf(scripted: ScriptedMessage): TextBlock[] {
  if (scripted.content !== undefined) return [...scripted.content];
  if (scripted.text !== undefined) {
    return [{ type: "text", text: scripted.text, citations: null }];
  }
  if (scripted.json !== undefined) {
    return [{ type: "text", text: JSON.stringify(scripted.json), citations: null }];
  }
  if (scripted.stopReason === "refusal") return [];
  return [{ type: "text", text: "{}", citations: null }];
}

/**
 * Starts the mock and resolves once it is listening.
 *
 * ```ts
 * const mock = await startMockAnthropic({ port: 0 });
 * mock.script(() => ({ json: { fault_id: "downstream_air_leak" } }));
 * mock.failNext(529, 1);
 * await mock.close();
 * ```
 */
export async function startMockAnthropic(
  options: MockAnthropicOptions = {},
): Promise<MockAnthropic> {
  const {
    port = 0,
    host = "127.0.0.1",
    apiKey,
    latencyMs = 0,
    reply = null,
    log,
    enforceOutputSchema = false,
  } = options;

  const validateRequest = new Ajv2020({ ...AJV_OPTIONS }).compile(
    messagesRequestSchema as AnySchemaObject,
  );
  const outputValidator = outputSchemaValidators();

  const requests: RecordedRequest[] = [];
  const failures = new FailureQueue();
  let scripted: MessagePolicy | null = reply;
  let answered = 0;

  function finish(
    message: IncomingMessage,
    response: ServerResponse,
    status: number,
    body: unknown,
    headers?: Record<string, string>,
  ): void {
    sendJson(response, status, body, headers);
    log?.(`${message.method ?? "GET"} ${pathOf(message)} -> ${String(status)}`);
  }

  function authorised(message: IncomingMessage): boolean {
    const key = apiKeyOf(message);
    if (key === undefined || key === "") return false;
    return apiKey === undefined || key === apiKey;
  }

  /**
   * Why the real API could never have sent `plan` in answer to `request`, or `undefined` when it
   * could or when the answer is not one the mock checks (see `enforceOutputSchema`).
   */
  function outputMismatch(
    request: AnthropicMessagesRequest,
    plan: ScriptedMessage,
  ): string | undefined {
    const schema = request.output_config?.format?.schema;
    if (!enforceOutputSchema || schema === undefined) return undefined;
    if (plan.json === undefined || plan.text !== undefined || plan.content !== undefined) {
      return undefined;
    }
    if ((plan.stopReason ?? "end_turn") !== "end_turn") return undefined;
    let validate: ValidateFunction;
    try {
      validate = outputValidator(schema);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `mock: output_config.format.schema does not compile: ${reason}`;
    }
    if (validate(plan.json)) return undefined;
    return (
      "mock: the scripted json answer does not satisfy output_config.format.schema, so the API " +
      `could never send it: ${issueText(validate.errors, "the answer")}`
    );
  }

  function buildMessage(
    request: AnthropicMessagesRequest,
    plan: ScriptedMessage,
  ): AnthropicMessage {
    const content = contentOf(plan);
    const stopReason = plan.stopReason ?? "end_turn";
    const stopDetails = plan.stopDetails ?? (stopReason === "refusal" ? DEFAULT_REFUSAL : null);
    const text = content.map((block) => block.text).join("");
    return {
      id: plan.id ?? `msg_mock_${String(answered).padStart(6, "0")}`,
      type: "message",
      role: "assistant",
      model: plan.model ?? request.model,
      content,
      stop_reason: stopReason,
      stop_details: stopDetails,
      stop_sequence: null,
      usage: {
        input_tokens: plan.usage?.input_tokens ?? tokensOf([request.system, request.messages]),
        output_tokens: plan.usage?.output_tokens ?? tokensOf(text),
      },
    };
  }

  async function handleMessages(
    message: IncomingMessage,
    response: ServerResponse,
    text: string,
  ): Promise<void> {
    if (latencyMs > 0) await sleep(latencyMs);
    const failure = failures.take();
    if (failure !== undefined) {
      const headers =
        failure.retryAfterS === undefined
          ? undefined
          : { "retry-after": String(failure.retryAfterS) };
      finish(message, response, failure.status, errorBody(failure.status), headers);
      return;
    }
    if (!authorised(message)) {
      finish(message, response, 401, errorBody(401));
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      finish(message, response, 422, errorBody(422, "the request body is not JSON"));
      return;
    }
    if (!validateRequest(body)) {
      finish(message, response, 422, errorBody(422, issueText(validateRequest.errors)));
      return;
    }
    const request = body as AnthropicMessagesRequest;
    const plan = scripted === null ? {} : scripted(request, answered);
    const mismatch = outputMismatch(request, plan);
    if (mismatch !== undefined) {
      finish(message, response, 500, errorBody(500, mismatch));
      return;
    }
    const answer = buildMessage(request, plan);
    answered += 1;
    finish(message, response, 200, answer);
  }

  const listener = (message: IncomingMessage, response: ServerResponse): void => {
    void (async (): Promise<void> => {
      const path = pathOf(message);
      const method = message.method ?? "GET";
      if (path === "/healthz") {
        sendText(response, method === "GET" || method === "HEAD" ? 200 : 405, "ok");
        return;
      }
      let text: string;
      try {
        text = await readBody(message);
      } catch {
        finish(message, response, 413, errorBody(413, "the request body is too large"));
        return;
      }
      requests.push({
        wallTs: new Date().toISOString(),
        method,
        path: message.url ?? "/",
        headers: redactHeaders(message),
        body: parseBody(text),
      });
      if (path === "/v1/messages") {
        if (method !== "POST") {
          finish(message, response, 405, errorBody(405, "use POST /v1/messages"));
          return;
        }
        await handleMessages(message, response, text);
        return;
      }
      finish(message, response, 404, errorBody(404, `no route for ${method} ${path}`));
    })().catch((error: unknown) => {
      const reason = error instanceof Error ? error.name : "Error";
      if (!response.headersSent) sendJson(response, 500, errorBody(500, `mock failed: ${reason}`));
      else response.end();
    });
  };

  const bound: { server: Server; url: string; port: number } = await listen(listener, host, port);

  return {
    url: bound.url,
    port: bound.port,
    requests,
    script(policy: MessagePolicy | null): void {
      scripted = policy;
    },
    failNext(status: AnthropicFailStatus, times = 1, retryAfterS?: number): void {
      failures.push(status, times, retryAfterS);
    },
    reset(): void {
      requests.length = 0;
      failures.clear();
      scripted = null;
      answered = 0;
    },
    close(): Promise<void> {
      return closeServer(bound.server);
    },
  };
}
