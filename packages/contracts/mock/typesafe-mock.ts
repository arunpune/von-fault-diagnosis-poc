// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The mock TypeSafe System One server. Every unit test, every integration test and the Compose CI
// stack talk to this instead of api.typesafe.ai: the documented `POST /v1/systemone` shape, the
// documented status codes, and answers that are a pure function of the request.
//
// It reproduces shapes, never judgment. The confidence heuristic here is arithmetic on a
// probability vector the mock itself made up; the thresholds that matter are tuned on the real
// model. What the mock is allowed to prove is that a caller builds a legal request, reads the
// answers back correctly, and survives a 429.
//
// Bodies and bearer values never reach a log line, in a container or anywhere else.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:http";

import type { AnySchemaObject, ErrorObject, ValidateFunction } from "ajv";
import _Ajv2020 from "ajv/dist/2020.js";

import { AJV_OPTIONS } from "../src/generated/validators.ts";
import {
  answerWithPolicy,
  estimateInputTokens,
  isAnswerPolicyName,
  type Answer,
  type AnswerPolicy,
  type AnswerPolicyName,
  type SystemOneRequest,
  type SystemOneResponse,
} from "./answers.ts";
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
import requestSchema from "./schemas/systemone-request.schema.json" with { type: "json" };
import responseSchema from "./schemas/systemone-response.schema.json" with { type: "json" };

// ajv ships CommonJS with a default export, which Node's ESM interop hands back as the module
// object itself; the cast restores the declared class, exactly as `src/generated/validators.ts`
// does for the shipped validators.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;

/** The versioned model id the mock always answers with, and the aliases it accepts. */
export const MOCK_MODEL = "jev-1.13.0";

/** The model ids `POST /v1/systemone` accepts; anything else is a 422. */
export const ACCEPTED_MODELS: readonly string[] = [MOCK_MODEL, "jev-latest", "jev-preview"];

/** What `GET /v1/models` answers. The real docs do not publish this body. */
export const MOCK_MODEL_LIST = {
  models: [
    { id: "jev-latest", resolves_to: MOCK_MODEL },
    { id: "jev-preview", resolves_to: MOCK_MODEL },
  ],
} as const;

/** The statuses `failNext` can queue. */
export type FailStatus = 401 | 422 | 429 | 500 | 529;

const ERROR_TYPES: Readonly<Record<number, string>> = {
  400: "invalid_request_error",
  401: "authentication_error",
  404: "not_found_error",
  405: "invalid_request_error",
  413: "invalid_request_error",
  422: "invalid_request_error",
  429: "rate_limit_error",
  500: "api_error",
  529: "overloaded_error",
};

const ERROR_MESSAGES: Readonly<Record<number, string>> = {
  401: "Missing or invalid API key.",
  429: "Rate limit exceeded.",
  500: "Internal server error.",
  529: "Overloaded.",
};

export interface MockTypeSafeOptions {
  /** `0`, the default, binds a free port so parallel test workers never collide. */
  readonly port?: number;
  /** Default `127.0.0.1`; a container listens on `0.0.0.0`. */
  readonly host?: string;
  /** The single accepted bearer token. Left out, any non-empty bearer is accepted. */
  readonly apiKey?: string;
  /** The model id every response reports. Default `jev-1.13.0`. */
  readonly model?: string;
  /** Delay before each API answer, for reproducing a slow upstream. */
  readonly latencyMs?: number;
  /** A scripted policy, the same one `script()` installs later. */
  readonly answer?: AnswerPolicy;
  /** The named policy behind the unscripted answers. Default `default`. */
  readonly answerPolicy?: AnswerPolicyName;
  /** One line per request, `<method> <path> -> <status>`; never a body, never a bearer. */
  readonly log?: LogLine;
}

export interface MockTypeSafe extends MockServer {
  /** Installs a scripted policy, or clears it with `null`. The name the backend's tests call. */
  script(policy: AnswerPolicy | null): void;
  /** Alias of `script`. */
  setAnswerPolicy(policy: AnswerPolicy | null): void;
  /** Switches the named policy behind the unscripted answers. */
  setNamedPolicy(policy: AnswerPolicyName): void;
  /** The named policy in force. */
  readonly answerPolicy: AnswerPolicyName;
  /** Queues `times` answers with `status`, served before auth and validation. */
  failNext(status: FailStatus, times?: number, retryAfterS?: number): void;
}

function errorBody(status: number, message?: string): { error: { type: string; message: string } } {
  return {
    error: {
      type: ERROR_TYPES[status] ?? "api_error",
      message: message ?? ERROR_MESSAGES[status] ?? "Request failed.",
    },
  };
}

/** `<instancePath> <message>`, the form `src/validate.ts` uses for a schema failure. */
function issueText(errors: readonly ErrorObject[] | null | undefined): string {
  const first = errors?.[0];
  if (first === undefined) return "the request body is invalid";
  const path = first.instancePath === "" ? "the request body" : first.instancePath;
  return `${path} ${first.message ?? "is invalid"}`;
}

function compile(schema: AnySchemaObject): ValidateFunction {
  return new Ajv2020({ ...AJV_OPTIONS }).compile(schema);
}

let responseValidator: ValidateFunction | undefined;

/**
 * Why `body` is not a `POST /v1/systemone` response the mock would serve, or `undefined` when it
 * is: the shape check every scripted answer passes before it leaves the server, for a caller that
 * wants it before the first request. The evaluation harness's cassette server runs it over every
 * recording when it starts, so a recording the mock cannot serve is refused by name instead of
 * answering 500 to every request that hits it.
 */
export function systemOneResponseIssue(body: unknown): string | undefined {
  responseValidator ??= compile(responseSchema as AnySchemaObject);
  return responseValidator(body) ? undefined : issueText(responseValidator.errors);
}

/**
 * Starts the mock and resolves once it is listening.
 *
 * ```ts
 * const mock = await startMockTypeSafe({ port: 0 });
 * mock.failNext(429, 1, 1);          // the next call is rate limited, then succeeds
 * mock.script(() => ({ fault: { type: "choice", choice: "air_leak_dryer_purge", … } }));
 * await mock.close();
 * ```
 */
export async function startMockTypeSafe(options: MockTypeSafeOptions = {}): Promise<MockTypeSafe> {
  const {
    port = 0,
    host = "127.0.0.1",
    apiKey,
    model = MOCK_MODEL,
    latencyMs = 0,
    answer = null,
    answerPolicy = "default",
    log,
  } = options;

  const validateRequest = compile(requestSchema as AnySchemaObject);
  const validateResponse = compile(responseSchema as AnySchemaObject);

  const requests: RecordedRequest[] = [];
  const failures = new FailureQueue();
  let scripted: AnswerPolicy | null = answer;
  let named: AnswerPolicyName = answerPolicy;
  let accepted = 0;

  function record(message: IncomingMessage, text: string): void {
    requests.push({
      wallTs: new Date().toISOString(),
      method: message.method ?? "GET",
      path: message.url ?? "/",
      headers: redactHeaders(message),
      body: parseBody(text),
    });
  }

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

  /** The queued failure for this request, if `failNext` left one. */
  function queuedFailure(message: IncomingMessage, response: ServerResponse): boolean {
    const failure = failures.take();
    if (failure === undefined) return false;
    const headers =
      failure.retryAfterS === undefined
        ? undefined
        : { "retry-after": String(failure.retryAfterS) };
    finish(message, response, failure.status, errorBody(failure.status), headers);
    return true;
  }

  function authorised(message: IncomingMessage): boolean {
    const token = bearerToken(message);
    if (token === undefined || token === "") return false;
    return apiKey === undefined || token === apiKey;
  }

  /** Merges the scripted answers over the named policy's and checks the whole response. */
  function buildResponse(request: SystemOneRequest): SystemOneResponse | string {
    const answers: Record<string, Answer> = answerWithPolicy(request, named);
    if (scripted !== null) {
      const overrides = scripted(request, accepted);
      for (const [id, override] of Object.entries(overrides)) {
        if (override !== undefined && id in answers) answers[id] = override;
      }
    }
    const body: SystemOneResponse = {
      model,
      answers,
      usage: { input_tokens: estimateInputTokens(request), output_tokens: 0 },
    };
    if (!validateResponse(body)) return issueText(validateResponse.errors);
    return body;
  }

  async function handleSystemOne(
    message: IncomingMessage,
    response: ServerResponse,
    text: string,
  ): Promise<void> {
    if (latencyMs > 0) await sleep(latencyMs);
    if (queuedFailure(message, response)) return;
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
    const request = body as SystemOneRequest;
    if (request.model !== undefined && !ACCEPTED_MODELS.includes(request.model)) {
      finish(
        message,
        response,
        422,
        errorBody(422, `model ${request.model} is unknown; use ${ACCEPTED_MODELS.join(", ")}`),
      );
      return;
    }
    const result = buildResponse(request);
    if (typeof result === "string") {
      finish(message, response, 500, errorBody(500, `the scripted answer is malformed: ${result}`));
      return;
    }
    accepted += 1;
    finish(message, response, 200, result);
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
      record(message, text);
      if (path === "/v1/systemone") {
        if (method !== "POST") {
          finish(message, response, 405, errorBody(405, "use POST /v1/systemone"));
          return;
        }
        await handleSystemOne(message, response, text);
        return;
      }
      if (path === "/v1/models") {
        if (latencyMs > 0) await sleep(latencyMs);
        if (!authorised(message)) {
          finish(message, response, 401, errorBody(401));
          return;
        }
        finish(message, response, 200, MOCK_MODEL_LIST);
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
    get answerPolicy(): AnswerPolicyName {
      return named;
    },
    script(policy: AnswerPolicy | null): void {
      scripted = policy;
    },
    setAnswerPolicy(policy: AnswerPolicy | null): void {
      scripted = policy;
    },
    setNamedPolicy(policy: AnswerPolicyName): void {
      named = policy;
    },
    failNext(status: FailStatus, times = 1, retryAfterS?: number): void {
      failures.push(status, times, retryAfterS);
    },
    reset(): void {
      requests.length = 0;
      failures.clear();
      scripted = null;
      accepted = 0;
    },
    close(): Promise<void> {
      return closeServer(bound.server);
    },
  };
}

/** Reads `MOCK_ANSWER_POLICY`, falling back to `default` when it is unset or unknown. */
export function answerPolicyFromEnv(
  value: string | undefined,
): { policy: AnswerPolicyName } | { error: string } {
  if (value === undefined || value === "") return { policy: "default" };
  if (isAnswerPolicyName(value)) return { policy: value };
  return { error: `unknown answer policy ${value}` };
}
