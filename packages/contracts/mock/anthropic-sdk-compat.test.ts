// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Both official Anthropic clients against one mock server.
//
// The Node client (`@anthropic-ai/sdk` 0.127.0) reaches the structured-output wire shape
// through `messages.parse` with `zodOutputFormat` and reads `parsed_output`; the Python client
// (`anthropic` 1.7.0, run through `uv run --no-project` on `mock/py/anthropic_client.py`)
// reaches it through `messages.create` with a raw JSON Schema and parses the first text block.
// The point of the suite is that the mock — and therefore the real API — never has to know
// which of the two called it: both requests validate against the committed request schema and
// carry the same `output_config.format` structure.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AnySchemaObject } from "ajv";
import _Ajv2020 from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";

import { AJV_OPTIONS } from "../src/generated/validators.ts";
import { startMockAnthropic, type MockAnthropic } from "./anthropic-mock.ts";
import requestSchema from "./schemas/anthropic-messages-request.schema.json" with { type: "json" };

const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const validateRequest = new Ajv2020({ ...AJV_OPTIONS }).compile(requestSchema as AnySchemaObject);

const run = promisify(execFile);

const MODEL = "claude-opus-5";
const PROMPT = "Which candidate fits the observations?";
const ANSWER = { fault_id: "air_leak_dryer_purge", confidence: 0.82 };

/** The same structured output the Python script asks for, expressed as a Zod schema. */
const Answer = z.object({
  fault_id: z.string().describe("The chosen candidate id"),
  confidence: z.number(),
});

const PYTHON_CLIENT = fileURLToPath(new URL("./py/anthropic_client.py", import.meta.url));

interface RecordedFormat {
  type: string;
  schema: {
    type: string;
    required: string[];
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  };
}

function formatOf(body: unknown): RecordedFormat {
  const format = (body as { output_config?: { format?: RecordedFormat } }).output_config?.format;
  if (format === undefined) throw new Error("the recorded request carries no output format");
  return format;
}

let mock: MockAnthropic;

beforeEach(async () => {
  mock = await startMockAnthropic({ port: 0 });
  mock.script(() => ({ json: ANSWER }));
});

afterEach(async () => {
  await mock.close();
});

describe("@anthropic-ai/sdk 0.127.0 against the mock", () => {
  it("parses the structured output out of the first content block", async () => {
    const client = new Anthropic({ apiKey: "test", baseURL: mock.url, maxRetries: 0 });
    const message = await client.messages.parse({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: PROMPT }],
      output_config: { format: zodOutputFormat(Answer) },
    });

    expect(message.parsed_output).toEqual(ANSWER);
    expect(message.stop_reason).toBe("end_turn");
    expect(message.model).toBe(MODEL);
    expect(message.usage.input_tokens).toBeGreaterThan(0);
    expect(mock.requests).toHaveLength(1);
    expect(validateRequest(mock.requests[0]?.body)).toBe(true);
  });

  it("reports a scripted refusal through stop_reason and stop_details", async () => {
    mock.script(() => ({ stopReason: "refusal" }));
    const client = new Anthropic({ apiKey: "test", baseURL: mock.url, maxRetries: 0 });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: PROMPT }],
    });
    expect(message.stop_reason).toBe("refusal");
    expect(message.stop_details).toMatchObject({ type: "refusal", category: "general_harms" });
    expect(message.content).toEqual([]);
  });

  it("reports a scripted max_tokens stop", async () => {
    mock.script(() => ({ stopReason: "max_tokens", text: '{"fault_id": "air_lea' }));
    const client = new Anthropic({ apiKey: "test", baseURL: mock.url, maxRetries: 0 });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 8,
      messages: [{ role: "user", content: PROMPT }],
    });
    expect(message.stop_reason).toBe("max_tokens");
  });

  it("surfaces the queued 401, 429 and 529 as the SDK's own error classes", async () => {
    const client = new Anthropic({ apiKey: "test", baseURL: mock.url, maxRetries: 0 });
    const ask = (): Promise<unknown> =>
      client.messages.create({
        model: MODEL,
        max_tokens: 16,
        messages: [{ role: "user", content: PROMPT }],
      });

    mock.failNext(401);
    await expect(ask()).rejects.toBeInstanceOf(Anthropic.AuthenticationError);
    mock.failNext(429, 1, 2);
    await expect(ask()).rejects.toMatchObject({ status: 429 });
    mock.failNext(529);
    await expect(ask()).rejects.toMatchObject({ status: 529 });
  });
});

describe("anthropic 1.7.0 (Python) against the same mock", () => {
  it("sends the same output_config.format as the Node client", async () => {
    const client = new Anthropic({ apiKey: "test", baseURL: mock.url, maxRetries: 0 });
    await client.messages.parse({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: PROMPT }],
      output_config: { format: zodOutputFormat(Answer) },
    });

    const { stdout } = await run(
      "uv",
      [
        "run",
        "--no-project",
        "--quiet",
        PYTHON_CLIENT,
        "--base-url",
        mock.url,
        "--model",
        MODEL,
        "--prompt",
        PROMPT,
      ],
      { encoding: "utf8" },
    );
    const python = JSON.parse(stdout) as {
      parsed: unknown;
      stop_reason: string;
      model: string;
      usage: { input_tokens: number };
    };

    expect(python.parsed).toEqual(ANSWER);
    expect(python.stop_reason).toBe("end_turn");
    expect(python.model).toBe(MODEL);
    expect(python.usage.input_tokens).toBeGreaterThan(0);

    expect(mock.requests).toHaveLength(2);
    const [node, py] = mock.requests.map((entry) => entry.body);
    expect(validateRequest(node)).toBe(true);
    expect(validateRequest(py)).toBe(true);

    const nodeFormat = formatOf(node);
    const pythonFormat = formatOf(py);
    expect(pythonFormat.type).toBe("json_schema");
    expect(nodeFormat.type).toBe(pythonFormat.type);
    expect(pythonFormat.schema.type).toBe(nodeFormat.schema.type);
    expect(pythonFormat.schema.required).toEqual(nodeFormat.schema.required);
    expect(Object.keys(pythonFormat.schema.properties)).toEqual(
      Object.keys(nodeFormat.schema.properties),
    );
    expect(pythonFormat.schema.additionalProperties).toBe(nodeFormat.schema.additionalProperties);
    expect(pythonFormat.schema.properties).toMatchObject(nodeFormat.schema.properties);
  }, 120_000);
});
