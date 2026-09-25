// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Anthropic provider over a real socket.
 *
 * Every case here drives the real `@anthropic-ai/sdk` against
 * `startMockAnthropic` from `@fdp/contracts/mock`, bound to a random port. The
 * mock validates every `POST /v1/messages` body against the request schema
 * committed beside it and answers 422 when one does not fit, so a call that
 * comes back answered is itself the proof that the SDK's request has the
 * structured-output shape `anthropic.ts` pins. The recorded body is then read back to
 * say which shape that was.
 *
 * The mock also runs with `enforceOutputSchema`: a scripted `json` answer must
 * satisfy the JSON Schema the SDK actually put on the wire, as the real API's
 * constrained decoding guarantees. Without it a schema the API can only answer
 * with `{}` passed here with any answer at all.
 * The cases that need content the API would never send script it as `text`.
 *
 * Every provider is built with `maxRetries: 0` except the one case that
 * is about the SDK's own retries, so each scripted failure is one request and
 * the request count is part of the assertion.
 */

import { startMockAnthropic } from "@fdp/contracts/mock";
import type { MockAnthropic, ScriptedMessage } from "@fdp/contracts/mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";

import { candidatesFor, FIXTURE_LABELS } from "../../../test/fixtures/catalog/index.ts";
import {
  FIXTURE_UNIT_ID,
  SIGNATURE_A_CANDIDATE_IDS,
  SIGNATURE_A_EVENT,
} from "../../../test/fixtures/catalog/events.ts";
import { fixedClock } from "../../clock.ts";
import { Secret } from "../../config/secret.ts";
import { buildState } from "../state.ts";
import { isDecisionError, NONE_OF_THESE } from "../types.ts";
import type { DecisionError, DecisionInput } from "../types.ts";
import { createAnthropicProvider, MAX_TOKENS } from "./anthropic.ts";
import type { AnthropicProviderOptions } from "./anthropic.ts";
import { createLlmBackend, SYSTEM_PROMPT } from "./index.ts";
import type { LlmProvider, LlmRequest } from "./provider.ts";
import { DecisionSchema } from "./schema.ts";
import type { DecisionAnswer } from "./schema.ts";

/** The only key the mock accepts; a test value, never a real one. */
const TEST_KEY = "sk-test-fdp-mock-anthropic-0001";

const MODEL = "claude-opus-5";

const INPUT: DecisionInput = {
  event: SIGNATURE_A_EVENT,
  candidates: candidatesFor(SIGNATURE_A_CANDIDATE_IDS),
  unit_id: FIXTURE_UNIT_ID,
};

const STATE_JSON = JSON.stringify(buildState(INPUT, FIXTURE_LABELS));

const REQUEST: LlmRequest = { system: SYSTEM_PROMPT, user: STATE_JSON, schema: DecisionSchema };

/**
 * The answer the mock is scripted with in the happy path, shaped like a real
 * one: every option in `probabilities`, three of the six candidates judged.
 */
const ANSWER: DecisionAnswer = {
  choice: "dryer_purge_leak",
  probabilities: [
    { id: "dryer_purge_leak", probability: 0.82 },
    { id: "purge_silencer_damaged", probability: 0.08 },
    { id: "downstream_air_leak", probability: 0.04 },
    { id: "high_air_demand", probability: 0.03 },
    { id: "intake_filter_clogged", probability: 0.01 },
    { id: "airend_element_wear", probability: 0.01 },
    { id: NONE_OF_THESE, probability: 0.01 },
  ],
  support: [
    { id: "dryer_purge_leak", support: 0.95 },
    { id: "purge_silencer_damaged", support: 0.6 },
    { id: "high_air_demand", support: 0.05 },
  ],
  severity_level: "high",
  severity_confidence: 0.7,
  rationale: "Purge pressure sits far above normal while the unit never reaches its cut-out.",
};

let mock: MockAnthropic;

beforeEach(async () => {
  mock = await startMockAnthropic({ port: 0, apiKey: TEST_KEY, enforceOutputSchema: true });
});

afterEach(async () => {
  await mock.close();
});

/** A provider pointed at the mock; `overrides` bends one option. */
function provider(overrides: Partial<AnthropicProviderOptions> = {}): LlmProvider {
  return createAnthropicProvider({
    apiKey: new Secret(TEST_KEY),
    model: MODEL,
    baseURL: mock.url,
    maxRetries: 0,
    timeoutMs: 5_000,
    ...overrides,
  });
}

/** Script every reply of the mock with the same message. */
function replyWith(message: ScriptedMessage): void {
  mock.script(() => message);
}

/** The `DecisionError` a promise rejected with; anything else fails the test. */
async function failureOf(pending: Promise<unknown>): Promise<DecisionError> {
  const caught: unknown = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!isDecisionError(caught)) throw new Error(`expected a DecisionError, got ${String(caught)}`);
  return caught;
}

/** The body of the one request the mock recorded. */
function recordedBody(): Record<string, unknown> {
  expect(mock.requests).toHaveLength(1);
  return mock.requests[0]?.body as Record<string, unknown>;
}

/** The parts of a JSON Schema node the wire-shape assertions read. */
interface JsonSchemaNode {
  readonly $ref?: string;
  readonly type?: string;
  readonly properties?: Record<string, JsonSchemaNode>;
  readonly items?: JsonSchemaNode;
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly allOf?: readonly JsonSchemaNode[];
  readonly $defs?: Record<string, JsonSchemaNode>;
  readonly additionalProperties?: unknown;
}

/** Every `type: "object"` node of `schema`, with the path that reaches it. */
function objectNodes(schema: JsonSchemaNode, path = "#"): { path: string; node: JsonSchemaNode }[] {
  const children: [string, JsonSchemaNode][] = [
    ...Object.entries(schema.properties ?? {}).map(([name, node]): [string, JsonSchemaNode] => [
      `${path}/properties/${name}`,
      node,
    ]),
    ...Object.entries(schema.$defs ?? {}).map(([name, node]): [string, JsonSchemaNode] => [
      `${path}/$defs/${name}`,
      node,
    ]),
    ...(schema.items === undefined
      ? []
      : [[`${path}/items`, schema.items] as [string, JsonSchemaNode]]),
    ...(schema.anyOf ?? []).map((node, index): [string, JsonSchemaNode] => [
      `${path}/anyOf/${String(index)}`,
      node,
    ]),
    ...(schema.allOf ?? []).map((node, index): [string, JsonSchemaNode] => [
      `${path}/allOf/${String(index)}`,
      node,
    ]),
  ];
  return [
    ...(schema.type === "object" ? [{ path, node: schema }] : []),
    ...children.flatMap(([childPath, node]) => objectNodes(node, childPath)),
  ];
}

describe("the request the SDK sends", () => {
  it("is the pinned structured-output shape, and the mock's schema accepts it", async () => {
    replyWith({ json: ANSWER });
    const completion = await provider().complete(REQUEST);

    expect(completion.parsed).not.toBeNull();
    const body = recordedBody();
    expect(body["model"]).toBe(MODEL);
    expect(body["max_tokens"]).toBe(MAX_TOKENS);
    expect(body["system"]).toBe(SYSTEM_PROMPT);
    expect(body["messages"]).toEqual([{ role: "user", content: STATE_JSON }]);

    const format = (body["output_config"] as { format: Record<string, unknown> }).format;
    expect(Object.keys(format).sort()).toEqual(["schema", "type"]);
    expect(format["type"]).toBe("json_schema");
    const schema = format["schema"] as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "choice",
      "probabilities",
      "rationale",
      "severity_confidence",
      "severity_level",
      "support",
    ]);
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
  });

  it("carries the two per-id judgments as lists of closed entries, never as maps", async () => {
    replyWith({ json: ANSWER });
    await provider().complete(REQUEST);
    const format = (recordedBody()["output_config"] as { format: { schema: JsonSchemaNode } })
      .format;

    // The SDK may lift an entry into `$defs` (a `$ref`, which structured outputs accept).
    const list = (name: string): JsonSchemaNode => {
      const node = format.schema.properties?.[name] ?? {};
      const ref = node.items?.$ref;
      const items =
        ref === undefined ? node.items : format.schema.$defs?.[ref.replace("#/$defs/", "")];
      return { ...node, ...(items === undefined ? {} : { items }) };
    };
    const entry = (value: string) => ({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, [value]: { type: "number" } },
        required: ["id", value],
        additionalProperties: false,
      },
    });
    expect(list("probabilities")).toMatchObject(entry("probability"));
    expect(list("support")).toMatchObject(entry("support"));

    // Structured outputs close every object (`additionalProperties: false`), so
    // an object with no properties can only ever be answered with `{}`.
    const empty = objectNodes(format.schema).filter(
      ({ node }) => Object.keys(node.properties ?? {}).length === 0,
    );
    expect(empty.map(({ path }) => path)).toEqual([]);
  });

  it("is recorded for app.decisions exactly as it was sent, without a header", async () => {
    replyWith({ json: ANSWER });
    const completion = await provider().complete(REQUEST);

    expect(completion.raw.request).toEqual(recordedBody());
    expect(JSON.stringify(completion.raw)).not.toContain(TEST_KEY);
  });

  it("carries the key on x-api-key, which the mock records only redacted", async () => {
    replyWith({ json: ANSWER });
    await provider().complete(REQUEST);

    const headers = mock.requests[0]?.headers ?? {};
    expect(headers["x-api-key"]).toBe("[redacted]");
    expect(JSON.stringify(mock.requests)).not.toContain(TEST_KEY);
  });
});

describe("an answered call", () => {
  it("hands back the scripted parsed_output with usage, model and stop reason", async () => {
    replyWith({ json: ANSWER, usage: { input_tokens: 1_234, output_tokens: 210 } });
    const completion = await provider().complete(REQUEST);

    expect(completion.parsed).toEqual(ANSWER);
    expect(completion.usage).toEqual({ input_tokens: 1_234, output_tokens: 210 });
    expect(completion.model).toBe(MODEL);
    expect(completion.stop_reason).toBe("end_turn");
    expect(completion.detail).toBeUndefined();
  });

  it("becomes the backend's DecisionOutput end to end", async () => {
    replyWith({ json: ANSWER, usage: { input_tokens: 1_234, output_tokens: 210 } });
    const backend = createLlmBackend(provider(), fixedClock("2026-09-22T08:00:00.000Z"), {
      labels: FIXTURE_LABELS,
    });
    const output = await backend.decide(INPUT);

    expect(output.backend).toBe("llm");
    expect(output.model).toBe(MODEL);
    expect(output.choice).toBe("dryer_purge_leak");
    expect(output.confidence).toBeCloseTo(0.74, 12);
    expect(output.usage).toEqual({ input_tokens: 1_234, output_tokens: 210 });
    expect(output.support["downstream_air_leak"]).toBeNull();
    expect(output.severity.level).toBe("high");
  });

  it("round-trips a realistic answer through the real SDK into DecisionOutput's maps", async () => {
    replyWith({ json: ANSWER });
    const backend = createLlmBackend(provider(), fixedClock("2026-09-22T08:00:00.000Z"), {
      labels: FIXTURE_LABELS,
    });
    const output = await backend.decide(INPUT);

    const expected = Object.fromEntries(
      ANSWER.probabilities.map(({ id, probability }) => [id, probability]),
    );
    expect(Object.keys(output.probabilities).sort()).toEqual(Object.keys(expected).sort());
    for (const [id, probability] of Object.entries(expected)) {
      expect(output.probabilities[id]).toBeCloseTo(probability, 12);
    }
    expect(output.support).toEqual({
      dryer_purge_leak: 0.95,
      purge_silencer_damaged: 0.6,
      downstream_air_leak: null,
      high_air_demand: 0.05,
      intake_filter_clogged: null,
      airend_element_wear: null,
    });
    expect(output.confidence).toBeCloseTo(0.74, 12);
    expect(output.severity).toMatchObject({ level: "high", score: 2, confidence: 0.7 });
  });

  it("would have been refused with the open maps of before (be-decide-02)", async () => {
    // The schema this backend sent until be-decide-02: `zodOutputFormat` closes
    // the record into `{ properties: {}, additionalProperties: false }`, so the
    // API could only ever have answered `probabilities: {}`.
    const maps = z.object({ probabilities: z.record(z.string(), z.number()) });
    replyWith({ json: { probabilities: { dryer_purge_leak: 0.82, [NONE_OF_THESE]: 0.18 } } });

    const error = await failureOf(provider().complete({ ...REQUEST, schema: maps }));
    expect(error.status).toBe(500);
    expect(error.message).toContain("could never send it");
    expect(error.message).toContain("/probabilities must NOT have additional properties");
    expect(error.message).toContain("dryer_purge_leak");
  });

  it("reports the model the API answered with, not the one it was asked for", async () => {
    replyWith({ json: ANSWER, model: "claude-opus-5-mock-successor" });
    const completion = await provider().complete(REQUEST);
    expect(completion.model).toBe("claude-opus-5-mock-successor");
  });
});

describe("an answer that must not be believed", () => {
  it("reads a refusal from the stop reason and keeps its category", async () => {
    replyWith({
      stopReason: "refusal",
      stopDetails: { type: "refusal", category: "cyber", explanation: null },
    });
    const completion = await provider().complete(REQUEST);

    expect(completion.parsed).toBeNull();
    expect(completion.stop_reason).toBe("refusal");
    expect(completion.detail).toBe("refusal category: cyber");

    const backend = createLlmBackend(provider(), fixedClock("2026-09-22T08:00:00.000Z"));
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("refused");
    expect(error.message).toContain("cyber");
  });

  it("reads max_tokens before the truncated content, which it never parses", async () => {
    replyWith({ stopReason: "max_tokens", text: '{"choice": "dryer_pu' });
    const completion = await provider().complete(REQUEST);

    expect(completion.parsed).toBeNull();
    expect(completion.stop_reason).toBe("max_tokens");

    const backend = createLlmBackend(provider(), fixedClock("2026-09-22T08:00:00.000Z"));
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("cut off");
  });

  it("turns content that is not the schema's JSON into a null parse with the reason", async () => {
    replyWith({ text: "The purge valve is leaking." });
    const completion = await provider().complete(REQUEST);

    expect(completion.parsed).toBeNull();
    expect(completion.stop_reason).toBe("end_turn");
    expect(completion.detail).toContain("Failed to parse structured output");

    const backend = createLlmBackend(provider(), fixedClock("2026-09-22T08:00:00.000Z"));
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("no answer that fits the schema");
  });

  it("turns JSON that misses a required field into a null parse", async () => {
    // As `text`: the API's constrained decoding would never send it as an answer.
    replyWith({ text: JSON.stringify({ choice: "dryer_purge_leak" }) });
    const completion = await provider().complete(REQUEST);

    expect(completion.parsed).toBeNull();
    expect(completion.detail).toContain("probabilities");
  });
});

describe("transport failures", () => {
  it.each([
    [401, "auth"],
    [422, "validation"],
    [429, "rate_limit"],
    [529, "overloaded"],
    [500, "unknown"],
  ] as const)("maps a %i to a %s DecisionError after one request", async (status, kind) => {
    mock.failNext(status);
    const error = await failureOf(provider().complete(REQUEST));

    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(mock.requests).toHaveLength(1);
  });

  it("maps a key the API does not know to auth", async () => {
    const error = await failureOf(
      provider({ apiKey: new Secret("sk-test-not-the-mock-key") }).complete(REQUEST),
    );
    expect(error.kind).toBe("auth");
    expect(error.status).toBe(401);
    expect(error.message).not.toContain("sk-test-not-the-mock-key");
  });

  it("leaves 429 and 529 to the SDK's own two retries by default", async () => {
    mock.failNext(529, 3, 0.01);
    const error = await failureOf(provider({ maxRetries: undefined }).complete(REQUEST));

    expect(error.kind).toBe("overloaded");
    expect(mock.requests).toHaveLength(3);
  });

  it("maps a slow answer to timeout", async () => {
    await mock.close();
    mock = await startMockAnthropic({ port: 0, apiKey: TEST_KEY, latencyMs: 1_000 });
    replyWith({ json: ANSWER });

    const error = await failureOf(provider({ timeoutMs: 50 }).complete(REQUEST));
    expect(error.kind).toBe("timeout");
  });

  it("maps an aborted call to timeout", async () => {
    replyWith({ json: ANSWER });
    const controller = new AbortController();
    controller.abort();

    const error = await failureOf(provider().complete(REQUEST, { signal: controller.signal }));
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("aborted");
  });

  it("maps a server that is not there to network", async () => {
    const gone = await startMockAnthropic({ port: 0 });
    const url = gone.url;
    await gone.close();

    const error = await failureOf(provider({ baseURL: url }).complete(REQUEST));
    expect(error.kind).toBe("network");
  });
});
