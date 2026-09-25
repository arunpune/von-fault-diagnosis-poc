// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Every path of the mock Anthropic Messages server: the key on `x-api-key` or on a bearer, the
// committed request schema, the scripted content blocks, the three stop reasons, the `failNext`
// queue for 401, 429 and 529, the redacted request log, and the opt-in check of a scripted answer
// against the request's output schema.
//
// The SDKs meet the same server in `mock/anthropic-sdk-compat.test.ts`; this suite drives it
// with plain `fetch`, so a failure here is the mock's and not a client's.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startMockAnthropic, type AnthropicMessage, type MockAnthropic } from "./anthropic-mock.ts";
import { REDACTED } from "./http.ts";

const MODEL = "claude-opus-5";

let mock: MockAnthropic;

beforeEach(async () => {
  mock = await startMockAnthropic({ port: 0 });
});

afterEach(async () => {
  await mock.close();
});

interface ErrorBody {
  type: string;
  error: { type: string; message: string };
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: { fault_id: { type: "string" } },
  required: ["fault_id"],
  additionalProperties: false,
};

function body(overrides: Record<string, unknown> = {}): unknown {
  return {
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: "Which candidate fits the observations?" }],
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    ...overrides,
  };
}

async function post(
  payload: unknown,
  init: { headers?: Record<string, string>; raw?: string } = {},
): Promise<{ status: number; retryAfter: string | null; json: unknown }> {
  const response = await fetch(`${mock.url}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? { "x-api-key": "test" }),
    },
    body: init.raw ?? JSON.stringify(payload),
  });
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    json: (await response.json()) as unknown,
  };
}

describe("authentication", () => {
  it("accepts the key on x-api-key", async () => {
    expect((await post(body())).status).toBe(200);
  });

  it("accepts the key on Authorization: Bearer", async () => {
    const { status } = await post(body(), { headers: { authorization: "Bearer test" } });
    expect(status).toBe(200);
  });

  it("refuses a request with no key at all", async () => {
    const { status, json } = await post(body(), { headers: {} });
    expect(status).toBe(401);
    expect((json as ErrorBody).error.type).toBe("authentication_error");
  });

  it("accepts only the configured key when one is set", async () => {
    const guarded = await startMockAnthropic({ port: 0, apiKey: "only-this" });
    try {
      const wrong = await fetch(`${guarded.url}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": "other" },
        body: JSON.stringify(body()),
      });
      expect(wrong.status).toBe(401);
    } finally {
      await guarded.close();
    }
  });
});

describe("request validation", () => {
  it("refuses a body that is not JSON", async () => {
    const { status, json } = await post(undefined, { raw: "{" });
    expect(status).toBe(422);
    expect((json as ErrorBody).error.type).toBe("invalid_request_error");
  });

  it("refuses a body without max_tokens or messages", async () => {
    const noTokens = await post({ model: MODEL, messages: [{ role: "user", content: "hi" }] });
    expect(noTokens.status).toBe(422);
    expect((noTokens.json as ErrorBody).error.message).toContain("max_tokens");

    const noMessages = await post({ model: MODEL, max_tokens: 8 });
    expect(noMessages.status).toBe(422);
    expect((noMessages.json as ErrorBody).error.message).toContain("messages");
  });

  it("refuses an output format that is not the one this repository sends", async () => {
    const wrongType = await post(
      body({ output_config: { format: { type: "json_object", schema: OUTPUT_SCHEMA } } }),
    );
    expect(wrongType.status).toBe(422);
    expect((wrongType.json as ErrorBody).error.message).toContain("/output_config/format/type");

    const noSchema = await post(body({ output_config: { format: { type: "json_schema" } } }));
    expect(noSchema.status).toBe(422);
    expect((noSchema.json as ErrorBody).error.message).toContain("schema");
  });

  it("accepts a request with no output_config at all", async () => {
    const { status } = await post(body({ output_config: undefined }));
    expect(status).toBe(200);
  });
});

describe("answers", () => {
  it("returns an assistant message whose single text block holds the scripted JSON", async () => {
    mock.script(() => ({ json: { fault_id: "air_leak_dryer_purge" } }));
    const { status, json } = await post(body());
    expect(status).toBe(200);
    const message = json as AnthropicMessage;
    expect(message).toMatchObject({
      type: "message",
      role: "assistant",
      model: MODEL,
      stop_reason: "end_turn",
      stop_details: null,
    });
    expect(message.content).toHaveLength(1);
    expect(JSON.parse(message.content[0]?.text ?? "")).toEqual({
      fault_id: "air_leak_dryer_purge",
    });
  });

  it("answers `{}` and end_turn when nothing is scripted", async () => {
    const { json } = await post(body());
    const message = json as AnthropicMessage;
    expect(message.content[0]?.text).toBe("{}");
    expect(message.stop_reason).toBe("end_turn");
  });

  it("counts tokens from the request and the reply, and lets a policy pin them", async () => {
    const derived = (await post(body())).json as AnthropicMessage;
    expect(derived.usage.input_tokens).toBeGreaterThan(0);
    expect(derived.usage.output_tokens).toBeGreaterThan(0);

    mock.script(() => ({ usage: { input_tokens: 1234, output_tokens: 56 } }));
    const pinned = (await post(body())).json as AnthropicMessage;
    expect(pinned.usage).toEqual({ input_tokens: 1234, output_tokens: 56 });
  });

  it("gives every reply a deterministic id that follows the request counter", async () => {
    const first = (await post(body())).json as AnthropicMessage;
    const second = (await post(body())).json as AnthropicMessage;
    expect(first.id).toBe("msg_mock_000000");
    expect(second.id).toBe("msg_mock_000001");
  });

  it("scripts a refusal with its stop_details and no content", async () => {
    mock.script(() => ({ stopReason: "refusal" }));
    const message = (await post(body())).json as AnthropicMessage;
    expect(message.stop_reason).toBe("refusal");
    expect(message.stop_details).toMatchObject({ type: "refusal", category: "general_harms" });
    expect(message.content).toEqual([]);

    mock.script(() => ({
      stopReason: "refusal",
      stopDetails: { type: "refusal", category: "cyber", explanation: null },
    }));
    const pinned = (await post(body())).json as AnthropicMessage;
    expect(pinned.stop_details).toEqual({ type: "refusal", category: "cyber", explanation: null });
  });

  it("scripts a max_tokens stop with a truncated text block", async () => {
    mock.script(() => ({ stopReason: "max_tokens", text: '{"fault_id": "air_lea' }));
    const message = (await post(body())).json as AnthropicMessage;
    expect(message.stop_reason).toBe("max_tokens");
    expect(message.stop_details).toBeNull();
    expect(message.content[0]?.text).toBe('{"fault_id": "air_lea');
  });

  it("passes the request and a zero-based index to the policy", async () => {
    const seen: number[] = [];
    mock.script((request, index) => {
      seen.push(index);
      expect(request.model).toBe(MODEL);
      return {};
    });
    await post(body());
    await post(body());
    expect(seen).toEqual([0, 1]);
  });
});

describe("enforceOutputSchema", () => {
  let strict: MockAnthropic;

  beforeEach(async () => {
    strict = await startMockAnthropic({ port: 0, enforceOutputSchema: true });
  });

  afterEach(async () => {
    await strict.close();
  });

  async function postStrict(payload: unknown): Promise<{ status: number; json: unknown }> {
    const response = await fetch(`${strict.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test" },
      body: JSON.stringify(payload),
    });
    return { status: response.status, json: (await response.json()) as unknown };
  }

  it("answers a scripted json answer that satisfies the request's schema", async () => {
    strict.script(() => ({ json: { fault_id: "air_leak_dryer_purge" } }));
    const { status, json } = await postStrict(body());
    expect(status).toBe(200);
    expect(JSON.parse((json as AnthropicMessage).content[0]?.text ?? "")).toEqual({
      fault_id: "air_leak_dryer_purge",
    });
  });

  it("answers a 500 naming the mismatch for one the API could never send", async () => {
    strict.script(() => ({ json: { fault: "air_leak_dryer_purge" } }));
    const { status, json } = await postStrict(body());
    expect(status).toBe(500);
    expect((json as ErrorBody).error.type).toBe("api_error");
    expect((json as ErrorBody).error.message).toContain("could never send it");
    expect((json as ErrorBody).error.message).toContain("fault_id");
    expect(strict.requests).toHaveLength(1);
  });

  it("refuses a map for an object the schema closed with no properties (be-decide-02)", async () => {
    // What `zodOutputFormat` sends for `z.object({ probabilities: z.record(z.string(), z.number()) })`.
    const closedMap = {
      type: "object",
      properties: {
        probabilities: { type: "object", properties: {}, additionalProperties: false },
      },
      required: ["probabilities"],
      additionalProperties: false,
    };
    strict.script(() => ({ json: { probabilities: { air_leak_dryer_purge: 0.9 } } }));
    const request = body({ output_config: { format: { type: "json_schema", schema: closedMap } } });

    const refused = await postStrict(request);
    expect(refused.status).toBe(500);
    expect((refused.json as ErrorBody).error.message).toContain(
      '/probabilities must NOT have additional properties ("air_leak_dryer_purge")',
    );

    strict.script(() => ({ json: { probabilities: {} } }));
    expect((await postStrict(request)).status).toBe(200);
  });

  it("leaves text, refusals, max_tokens stops and requests with no schema unchecked", async () => {
    strict.script(() => ({ text: '{"fault": "x"}' }));
    expect((await postStrict(body())).status).toBe(200);

    strict.script(() => ({ stopReason: "max_tokens", json: { fault: "x" } }));
    expect((await postStrict(body())).status).toBe(200);

    strict.script(() => ({ stopReason: "refusal" }));
    expect((await postStrict(body())).status).toBe(200);

    strict.script(() => ({ json: { fault: "x" } }));
    expect((await postStrict(body({ output_config: undefined }))).status).toBe(200);
  });

  it("is off by default", async () => {
    mock.script(() => ({ json: { fault: "x" } }));
    expect((await post(body())).status).toBe(200);
  });
});

describe("failNext", () => {
  it("reproduces 401, 429 with retry-after, and 529", async () => {
    mock.failNext(401);
    expect((await post(body())).status).toBe(401);

    mock.failNext(429, 1, 3);
    const limited = await post(body());
    expect(limited.status).toBe(429);
    expect(limited.retryAfter).toBe("3");
    expect((limited.json as ErrorBody).error.type).toBe("rate_limit_error");

    mock.failNext(529, 2);
    expect((await post(body())).status).toBe(529);
    expect((await post(body())).status).toBe(529);
    expect((await post(body())).status).toBe(200);
  });

  it("uses the API's own error envelope", async () => {
    mock.failNext(529);
    const { json } = await post(body());
    expect(json).toMatchObject({ type: "error", error: { type: "overloaded_error" } });
  });
});

describe("recorded requests and routes", () => {
  it("keeps the body but never the key, on either header", async () => {
    await post(body(), { headers: { "x-api-key": "super-secret-key" } });
    await post(body(), { headers: { authorization: "Bearer super-secret-key" } });
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0]?.headers["x-api-key"]).toBe(REDACTED);
    expect(mock.requests[1]?.headers.authorization).toBe(REDACTED);
    expect(JSON.stringify(mock.requests.map((entry) => entry.headers))).not.toContain(
      "super-secret-key",
    );
    expect(mock.requests[0]?.body).toMatchObject({ model: MODEL });
  });

  it("serves /healthz and refuses an unknown route", async () => {
    const health = await fetch(`${mock.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");

    const unknown = await fetch(`${mock.url}/v1/complete`, { method: "POST" });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as ErrorBody).error.type).toBe("not_found_error");
  });

  it("never writes a key or a body to the log sink", async () => {
    const lines: string[] = [];
    const logged = await startMockAnthropic({ port: 0, log: (line) => lines.push(line) });
    try {
      await fetch(`${logged.url}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": "super-secret-key" },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 8,
          messages: [{ role: "user", content: "a very distinctive prompt" }],
        }),
      });
      expect(lines).toEqual(["POST /v1/messages -> 200"]);
      const joined = lines.join("\n");
      expect(joined).not.toContain("super-secret-key");
      expect(joined).not.toContain("distinctive prompt");
    } finally {
      await logged.close();
    }
  });

  it("is emptied by reset and stops answering after close", async () => {
    await post(body());
    mock.reset();
    expect(mock.requests).toHaveLength(0);

    const short = await startMockAnthropic({ port: 0 });
    await short.close();
    await expect(fetch(`${short.url}/healthz`)).rejects.toThrow();
  });
});
