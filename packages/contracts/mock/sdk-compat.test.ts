// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The compatibility test of the mock: the real `von-sdk` client against it, over
// HTTP, on a random port. Nothing is stubbed — the SDK builds the body, signs it with a bearer,
// parses the answers and runs its own retry policy.
//
// It also compares the two ways of building a question. The backend hand-builds
// `{ type, instructions, criteria }` objects while this suite uses the SDK's `choice` / `score` /
// `noul` helpers: a field the helpers add or rename would pass every offline test and fail on the
// single live call. The last case here builds each primitive both ways, sends both, and asserts
// that the two bodies the mock recorded are identical.

import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from "von-sdk";
import { choice, noul, score, VonClient } from "von-sdk";
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
];

const MATCH_QUESTION = "Does `observations` show the purge pressure rising?";
const FAULT_QUESTION = "Which candidate matches `observations`?";
const SEVERITY_QUESTION = "How serious is the situation?";

let mock: MockTypeSafe;
let client: VonClient;

beforeEach(async () => {
  mock = await startMockTypeSafe({ port: 0 });
  client = new VonClient({
    apiKey: "test",
    baseURL: mock.url,
  });
});

afterEach(async () => {
  await mock.close();
});

describe("von-sdk against the mock", () => {
  it("sends a Choice, a Score and a Noul in one request and reads all three answers", async () => {
    const { model, answers, usage } = await client.systemOne({
      state: STATE,
      model: MOCK_MODEL,
      questions: {
        fault: choice(FAULT_QUESTION, FAULT_CRITERIA),
        severity: score(SEVERITY_QUESTION, SEVERITY_LEVELS),
        match_air_leak_dryer_purge: noul(MATCH_QUESTION),
      },
    });

    const faultAnswer = answers.fault as ChoiceAnswer;
    const severityAnswer = answers.severity as ScoreAnswer;
    const matchAnswer = answers.match_air_leak_dryer_purge as NoulAnswer;
    expect(model).toBe(MOCK_MODEL);
    expect(faultAnswer.choice).toBe("air_leak_dryer_purge");
    expect(faultAnswer.confidence).toBe(0);
    expect(faultAnswer.probabilities).toEqual({
      air_leak_dryer_purge: 0.5,
      high_air_demand: 0.5,
    });
    expect(severityAnswer.score).toBe(1);
    expect(severityAnswer.legend[1]).toBe(SEVERITY_LEVELS[1]);
    expect(matchAnswer.noul).toBe(0.5);

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
      model: MOCK_MODEL,
      questions: {
        fault: choice(FAULT_QUESTION, FAULT_CRITERIA),
        match_air_leak_dryer_purge: noul(MATCH_QUESTION),
      },
    });
    const faultA = answers.fault as ChoiceAnswer;
    const matchA = answers.match_air_leak_dryer_purge as NoulAnswer;
    expect(faultA.choice).toBe("high_air_demand");
    expect(faultA.confidence).toBe(0.88);
    expect(matchA.noul).toBe(0.17);
  });

  it("surfaces a server error as a VonError", async () => {
    mock.failNext(529, 1);
    await expect(
      client.systemOne({
        state: STATE,
        model: MOCK_MODEL,
        questions: { q: noul(MATCH_QUESTION) },
      }),
    ).rejects.toMatchObject({ status: 529 });
  });

  it("builds the same wire body from the helpers and from plain objects", async () => {
    const viaHelpers = {
      fault: choice(FAULT_QUESTION, FAULT_CRITERIA),
      severity: score(SEVERITY_QUESTION, SEVERITY_LEVELS),
      match_air_leak_dryer_purge: noul(MATCH_QUESTION),
    };
    // Exactly what `apps/backend/src/decision/von/questions.ts` hand-builds.
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
