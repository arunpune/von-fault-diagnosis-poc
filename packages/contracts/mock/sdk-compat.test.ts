// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The compatibility test of the mock: the real `@typesafe-ai/sdk` 0.6.0 client against it, over
// HTTP, on a random port. Nothing is stubbed — the SDK builds the body, signs it with a bearer,
// parses the answers and runs its own retry policy.
//
// It also compares the two ways of building a question. The backend hand-builds
// `{ type, instructions, criteria }` objects while this suite uses the SDK's `choice` / `score` /
// `noul` helpers: a field the helpers add or rename would pass every offline test and fail on the
// single live call. The last case here builds each primitive both ways, sends both, and asserts
// that the two bodies the mock recorded are identical.

import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MOCK_MODEL, startMockTypeSafe, type MockTypeSafe } from "./typesafe-mock.ts";

const STATE = {
  machine: { kind: "oil-injected screw compressor", mode: "loaded" },
  observations: [
    { signal: "p_dryer_purge", label: "dryer purge pressure", level: "far above normal" },
    { signal: "p_line", label: "line pressure", level: "below normal" },
  ],
};

const FAULT_CRITERIA = {
  air_leak_dryer_purge: "Dryer purge valve not seating",
  high_air_demand: "Heavy air demand from the plant",
} as const;

const SEVERITY_LEVELS = [
  "Readings drift outside their normal band",
  "The unit works harder than normal",
  "The unit is losing line pressure",
] as const;

const MATCH_QUESTION = "Does `observations` show the purge pressure rising?";
const FAULT_QUESTION = "Which candidate matches `observations`?";
const SEVERITY_QUESTION = "How serious is the situation?";

let mock: MockTypeSafe;
let client: TypeSafeClient;

beforeEach(async () => {
  mock = await startMockTypeSafe({ port: 0 });
  client = new TypeSafeClient({
    apiKey: "test",
    baseURL: mock.url,
    defaultModel: MOCK_MODEL,
    logLevel: "off",
  });
});

afterEach(async () => {
  await mock.close();
});

describe("@typesafe-ai/sdk 0.6.0 against the mock", () => {
  it("sends a Choice, a Score and a Noul in one request and reads all three answers", async () => {
    const { model, answers, usage } = await client.systemOne({
      state: STATE,
      questions: {
        fault: choice(FAULT_QUESTION, FAULT_CRITERIA),
        severity: score(SEVERITY_QUESTION, SEVERITY_LEVELS),
        match_air_leak_dryer_purge: noul(MATCH_QUESTION),
      },
    });

    expect(model).toBe(MOCK_MODEL);
    expect(answers.fault.choice).toBe("air_leak_dryer_purge");
    expect(answers.fault.confidence).toBe(0);
    expect(answers.fault.probabilities).toEqual({
      air_leak_dryer_purge: 0.5,
      high_air_demand: 0.5,
    });
    expect(answers.severity.score).toBe(1);
    expect(answers.severity.legend[1]).toBe(SEVERITY_LEVELS[1]);
    expect(answers.match_air_leak_dryer_purge.noul).toBe(0.5);

    const recorded = mock.requests[0]?.body as { state: unknown; questions: unknown };
    expect(usage.output_tokens).toBe(0);
    expect(usage.input_tokens).toBe(
      Math.ceil(
        (Buffer.byteLength(JSON.stringify(recorded.state), "utf8") +
          Buffer.byteLength(JSON.stringify(recorded.questions), "utf8")) /
          4,
      ),
    );
  });

  it("reads a scripted answer back through the SDK's typed accessors", async () => {
    mock.script(() => ({
      fault: {
        type: "choice",
        choice: "high_air_demand",
        confidence: 0.88,
        probabilities: { air_leak_dryer_purge: 0.12, high_air_demand: 0.88 },
      },
      match_air_leak_dryer_purge: { type: "noul", noul: 0.17 },
    }));
    const { answers } = await client.systemOne({
      state: STATE,
      questions: {
        fault: choice(FAULT_QUESTION, FAULT_CRITERIA),
        match_air_leak_dryer_purge: noul(MATCH_QUESTION),
      },
    });
    expect(answers.fault.choice).toBe("high_air_demand");
    expect(answers.fault.confidence).toBe(0.88);
    expect(answers.match_air_leak_dryer_purge.noul).toBe(0.17);
  });

  it("retries a 429 with its own backoff and succeeds on the second attempt", async () => {
    mock.failNext(429, 1, 1);
    const { model } = await client.systemOne({
      state: STATE,
      questions: { match_air_leak_dryer_purge: noul(MATCH_QUESTION) },
    });
    expect(model).toBe(MOCK_MODEL);
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[1]?.headers["x-typesafe-retry-count"]).toBe("1");
  });

  it("surfaces an exhausted retry budget as an APIError", async () => {
    mock.failNext(529, 5);
    await expect(
      client.systemOne(
        { state: STATE, questions: { q: noul(MATCH_QUESTION) } },
        { retry: { maxRetries: 1, backoffInitialMs: 1, backoffMaxMs: 2 } },
      ),
    ).rejects.toMatchObject({ status: 529 });
    expect(mock.requests).toHaveLength(2);
  });

  it("lists the models through the SDK's own resource", async () => {
    const models = await client.models.list();
    expect(models).toHaveLength(2);
  });

  it("builds the same wire body from the helpers and from plain objects", async () => {
    const viaHelpers = {
      fault: choice(FAULT_QUESTION, FAULT_CRITERIA),
      severity: score(SEVERITY_QUESTION, SEVERITY_LEVELS),
      match_air_leak_dryer_purge: noul(MATCH_QUESTION),
    };
    // Exactly what `apps/backend/src/decision/jev/questions.ts` hand-builds.
    const byHand = {
      fault: { type: "choice", instructions: FAULT_QUESTION, criteria: FAULT_CRITERIA },
      severity: { type: "score", instructions: SEVERITY_QUESTION, criteria: SEVERITY_LEVELS },
      match_air_leak_dryer_purge: { type: "noul", instructions: MATCH_QUESTION },
    } as const;

    await client.systemOne({ state: STATE, model: MOCK_MODEL, questions: viaHelpers });
    await client.systemOne({ state: STATE, model: MOCK_MODEL, questions: byHand });

    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[1]?.body).toEqual(mock.requests[0]?.body);
    expect(mock.requests[0]?.body).toMatchObject({ model: MOCK_MODEL });
  });
});
