// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Every path of the mock TypeSafe server: authentication, body validation and its messages, the
// documented default answers, the three named answer policies, scripted answers, the `failNext`
// queue with its `retry-after`, the recorded requests, `GET /v1/models`, `GET /healthz` and
// `close`.
//
// Ports are always 0, so the suite runs beside any other worktree without a port collision.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { peakedness, type Answer, type Question, type SystemOneRequest } from "./answers.ts";
import { REDACTED } from "./http.ts";
import {
  ACCEPTED_MODELS,
  MOCK_MODEL,
  startMockTypeSafe,
  systemOneResponseIssue,
  type MockTypeSafe,
} from "./typesafe-mock.ts";

const KEY = "test-key";

let mock: MockTypeSafe;

beforeEach(async () => {
  mock = await startMockTypeSafe({ port: 0 });
});

afterEach(async () => {
  await mock.close();
});

interface ErrorBody {
  error: { type: string; message: string };
}

interface SystemOneBody {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}

async function post(
  body: unknown,
  init: { key?: string | null; raw?: string } = {},
): Promise<{ status: number; retryAfter: string | null; json: unknown }> {
  const key = init.key === undefined ? KEY : init.key;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers.authorization = `Bearer ${key}`;
  const response = await fetch(`${mock.url}/v1/systemone`, {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(body),
  });
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    json: (await response.json()) as unknown,
  };
}

const CHOICE: Question = {
  type: "choice",
  instructions: "Which candidate matches the observations?",
  criteria: { air_leak_dryer_purge: "Purge valve not seating", high_air_demand: "Heavy demand" },
};

const SCORE: Question = {
  type: "score",
  instructions: "How serious is it?",
  criteria: ["Readings drift", "Works harder", "Line pressure falls", "Unit is stopping"],
};

const NOUL: Question = { type: "noul", instructions: "Does the purge pressure rise?" };

function request(questions: Record<string, Question>, state: unknown = "a compressor"): unknown {
  return { model: MOCK_MODEL, state, questions };
}

function expectedTokens(state: unknown, questions: unknown): number {
  return Math.ceil(
    (Buffer.byteLength(JSON.stringify(state), "utf8") +
      Buffer.byteLength(JSON.stringify(questions), "utf8")) /
      4,
  );
}

describe("authentication", () => {
  it("refuses a request with no bearer", async () => {
    const { status, json } = await post(request({ q: NOUL }), { key: null });
    expect(status).toBe(401);
    expect(json).toEqual({
      error: { type: "authentication_error", message: "Missing or invalid API key." },
    });
  });

  it("refuses an empty bearer", async () => {
    const { status } = await post(request({ q: NOUL }), { key: "" });
    expect(status).toBe(401);
  });

  it("accepts any non-empty bearer when no key is configured", async () => {
    const { status } = await post(request({ q: NOUL }), { key: "anything-at-all" });
    expect(status).toBe(200);
  });

  it("accepts only the configured key when one is set", async () => {
    const guarded = await startMockTypeSafe({ port: 0, apiKey: "only-this" });
    try {
      const wrong = await fetch(`${guarded.url}/v1/systemone`, {
        method: "POST",
        headers: { authorization: "Bearer other" },
        body: JSON.stringify(request({ q: NOUL })),
      });
      expect(wrong.status).toBe(401);
      const right = await fetch(`${guarded.url}/v1/systemone`, {
        method: "POST",
        headers: { authorization: "Bearer only-this" },
        body: JSON.stringify(request({ q: NOUL })),
      });
      expect(right.status).toBe(200);
    } finally {
      await guarded.close();
    }
  });
});

describe("request validation", () => {
  it("refuses a body that is not JSON", async () => {
    const { status, json } = await post(undefined, { raw: "not json" });
    expect(status).toBe(422);
    expect((json as ErrorBody).error.type).toBe("invalid_request_error");
    expect((json as ErrorBody).error.message).toContain("not JSON");
  });

  it("refuses a body without questions", async () => {
    const { status, json } = await post({ model: MOCK_MODEL, state: "x" });
    expect(status).toBe(422);
    expect((json as ErrorBody).error.message).toContain("questions");
  });

  it("refuses an empty question map", async () => {
    const { status, json } = await post(request({}));
    expect(status).toBe(422);
    expect((json as ErrorBody).error.message).toContain("/questions");
  });

  it("names the offending question when a choice has fewer than two labels", async () => {
    const { status, json } = await post(
      request({ fault: { type: "choice", instructions: "?", criteria: { only: "one" } } }),
    );
    expect(status).toBe(422);
    expect((json as ErrorBody).error.message).toContain("/questions/fault/criteria");
    expect((json as ErrorBody).error.message).toContain("fewer than 2");
  });

  it("refuses score criteria that are not a list of at least two levels", async () => {
    const asMap = await post(
      request({ severity: { type: "score", instructions: "?", criteria: { a: 1 } } as never }),
    );
    expect(asMap.status).toBe(422);
    expect((asMap.json as ErrorBody).error.message).toContain("/questions/severity/criteria");

    const tooShort = await post(
      request({ severity: { type: "score", instructions: "?", criteria: ["only"] } }),
    );
    expect(tooShort.status).toBe(422);
    expect((tooShort.json as ErrorBody).error.message).toContain("fewer than 2");
  });

  it("accepts a noul without criteria and refuses an unknown question field", async () => {
    expect((await post(request({ q: NOUL }))).status).toBe(200);
    const extra = await post(
      request({ q: { type: "noul", instructions: "?", weight: 2 } as never }),
    );
    expect(extra.status).toBe(422);
    expect((extra.json as ErrorBody).error.message).toContain("additional properties");
  });

  it("refuses an unknown question type", async () => {
    const { status, json } = await post(
      request({ q: { type: "ranking", instructions: "?" } as never }),
    );
    expect(status).toBe(422);
    expect((json as ErrorBody).error.message).toContain("/questions/q/type");
  });

  it("accepts every documented model id and refuses any other", async () => {
    for (const model of ACCEPTED_MODELS) {
      const { status, json } = await post({ model, state: "x", questions: { q: NOUL } });
      expect(status).toBe(200);
      expect((json as SystemOneBody).model).toBe(MOCK_MODEL);
    }
    const { status, json } = await post({ model: "von-2", state: "x", questions: { q: NOUL } });
    expect(status).toBe(422);
    expect((json as ErrorBody).error.message).toContain("von-2");
  });
});

describe("default answers", () => {
  it("answers a choice with a uniform vector, the first label and confidence 0", async () => {
    const { status, json } = await post(request({ fault: CHOICE }));
    expect(status).toBe(200);
    const answer = (json as SystemOneBody).answers.fault;
    expect(answer).toEqual({
      type: "choice",
      choice: "air_leak_dryer_purge",
      confidence: 0,
      probabilities: { air_leak_dryer_purge: 0.5, high_air_demand: 0.5 },
    });
  });

  it("puts a score's mass on the middle level and reports the rubric as the legend", async () => {
    const { json } = await post(request({ severity: SCORE }));
    expect((json as SystemOneBody).answers.severity).toEqual({
      type: "score",
      score: 1,
      confidence: 1,
      legend: {
        "0": "Readings drift",
        "1": "Works harder",
        "2": "Line pressure falls",
        "3": "Unit is stopping",
      },
      probabilities: { "0": 0, "1": 1, "2": 0, "3": 0 },
    });
  });

  it("renders an object level through `summary`, and otherwise as JSON", async () => {
    const levels: Question = {
      type: "score",
      instructions: "?",
      criteria: [{ summary: "One change", signals: ["a"] }, { detail: "no summary" }, "plain"],
    };
    const { json } = await post(request({ severity: levels }));
    const answer = (json as SystemOneBody).answers.severity;
    expect(answer).toMatchObject({
      score: 1,
      legend: { "0": "One change", "1": '{"detail":"no summary"}', "2": "plain" },
    });
  });

  it("answers a noul with 0.5", async () => {
    const { json } = await post(request({ q: NOUL }));
    expect((json as SystemOneBody).answers.q).toEqual({ type: "noul", noul: 0.5 });
  });

  it("puts `type` on every answer and always reports the pinned model", async () => {
    const { json } = await post(request({ fault: CHOICE, severity: SCORE, match: NOUL }));
    const body = json as SystemOneBody;
    expect(body.model).toBe(MOCK_MODEL);
    expect(Object.values(body.answers).map((answer) => answer.type)).toEqual([
      "choice",
      "score",
      "noul",
    ]);
  });

  it("reports the documented token estimate", async () => {
    const state = { observations: ["line pressure below normal"] };
    const questions = { fault: CHOICE, match: NOUL };
    const { json } = await post(request(questions, state));
    expect((json as SystemOneBody).usage).toEqual({
      input_tokens: expectedTokens(state, questions),
      output_tokens: 0,
    });
  });

  it("makes `peakedness` 0 on [0.5, 0.5] and 1 on a one-hot vector", () => {
    expect(peakedness([0.5, 0.5])).toBe(0);
    expect(peakedness([1, 0, 0])).toBe(1);
    expect(peakedness([0.9, 0.1])).toBeGreaterThan(0.5);
  });
});

describe("scripted answers", () => {
  it("merges the scripted answers over the defaults, question by question", async () => {
    mock.script(() => ({
      fault: {
        type: "choice",
        choice: "high_air_demand",
        confidence: 0.82,
        probabilities: { air_leak_dryer_purge: 0.18, high_air_demand: 0.82 },
      },
    }));
    const { json } = await post(request({ fault: CHOICE, match: NOUL }));
    const body = json as SystemOneBody;
    expect(body.answers.fault).toMatchObject({ choice: "high_air_demand", confidence: 0.82 });
    expect(body.answers.match).toEqual({ type: "noul", noul: 0.5 });
  });

  it("passes the request and a zero-based index to the policy", async () => {
    const seen: number[] = [];
    mock.setAnswerPolicy((req: SystemOneRequest, index: number) => {
      seen.push(index);
      expect(req.questions.q).toBeDefined();
      return {};
    });
    await post(request({ q: NOUL }));
    await post(request({ q: NOUL }));
    expect(seen).toEqual([0, 1]);
  });

  it("ignores an id that names no question and is cleared by `script(null)`", async () => {
    mock.script(() => ({ nothing_like_that: { type: "noul", noul: 0.1 } }));
    const scripted = await post(request({ q: NOUL }));
    expect(Object.keys((scripted.json as SystemOneBody).answers)).toEqual(["q"]);
    mock.script(null);
    const plain = await post(request({ q: NOUL }));
    expect((plain.json as SystemOneBody).answers.q).toEqual({ type: "noul", noul: 0.5 });
  });

  it("refuses to serve an answer that does not match the response schema", async () => {
    mock.script(() => ({ q: { type: "noul", noul: 7 } as Answer }));
    const { status, json } = await post(request({ q: NOUL }));
    expect(status).toBe(500);
    expect((json as ErrorBody).error.message).toContain("scripted answer is malformed");
  });

  it("serves a Score legend that echoes object levels, as the live API does", async () => {
    // The live API returns each rubric level exactly as it was asked (the SDK's `ScoreLegend`):
    // an object level comes back as that object, and the score is a probability-weighted mean.
    const levels: Question = {
      type: "score",
      instructions: "How serious is it?",
      criteria: [
        { summary: "Readings drift", signals: { line_pressure: "flat" } },
        { summary: "Line pressure falls", signals: { line_pressure: "down" } },
      ],
    };
    const echoed: Answer = {
      type: "score",
      score: 0.62,
      confidence: 0.58,
      legend: {
        "0": { summary: "Readings drift", signals: { line_pressure: "flat" } },
        "1": { summary: "Line pressure falls", signals: { line_pressure: "down" } },
      },
      probabilities: { "0": 0.38, "1": 0.62 },
    };
    mock.script(() => ({ severity: echoed }));
    const { status, json } = await post(request({ severity: levels }));
    expect(status).toBe(200);
    expect((json as SystemOneBody).answers.severity).toEqual(echoed);
  });

  it("still refuses a legend level that is no entry at all", async () => {
    mock.script(() => ({
      severity: {
        type: "score",
        score: 1,
        confidence: 1,
        legend: { "0": 3, "1": "Line pressure falls" },
        probabilities: { "0": 0, "1": 1 },
      } as unknown as Answer,
    }));
    const { status, json } = await post(request({ severity: SCORE }));
    expect(status).toBe(500);
    expect((json as ErrorBody).error.message).toContain("/answers/severity/legend/0");
  });
});

describe("systemOneResponseIssue", () => {
  const usage = { input_tokens: 10, output_tokens: 2 };

  it("accepts what the mock serves and an object legend level", () => {
    const answers = {
      severity: {
        type: "score",
        score: 1.5,
        confidence: 0.5,
        legend: { "0": { summary: "a" }, "1": "b", "2": ["c"], "3": null },
        probabilities: { "0": 0, "1": 0.5, "2": 0.5, "3": 0 },
      },
    };
    expect(systemOneResponseIssue({ model: MOCK_MODEL, answers, usage })).toBeUndefined();
  });

  it("names the first problem of a response the mock would refuse to serve", () => {
    const answers = { q: { type: "noul", noul: 7 } };
    expect(systemOneResponseIssue({ model: MOCK_MODEL, answers, usage })).toBe(
      "/answers/q/noul must be <= 1",
    );
  });
});

describe("failNext", () => {
  it("answers 429 with a retry-after header and the documented body", async () => {
    mock.failNext(429, 1, 2);
    const failed = await post(request({ q: NOUL }));
    expect(failed.status).toBe(429);
    expect(failed.retryAfter).toBe("2");
    expect((failed.json as ErrorBody).error.type).toBe("rate_limit_error");
    expect((await post(request({ q: NOUL }))).status).toBe(200);
  });

  it("answers 529 with `overloaded_error` and no retry-after when none was asked for", async () => {
    mock.failNext(529);
    const { status, retryAfter, json } = await post(request({ q: NOUL }));
    expect(status).toBe(529);
    expect(retryAfter).toBeNull();
    expect((json as ErrorBody).error.type).toBe("overloaded_error");
  });

  it("reproduces 401, 422 and 500 on a valid, authenticated request", async () => {
    for (const [status, type] of [
      [401, "authentication_error"],
      [422, "invalid_request_error"],
      [500, "api_error"],
    ] as const) {
      mock.failNext(status);
      const failed = await post(request({ q: NOUL }));
      expect(failed.status).toBe(status);
      expect((failed.json as ErrorBody).error.type).toBe(type);
    }
  });

  it("serves the queue in order, one entry per request", async () => {
    mock.failNext(429, 2, 1);
    mock.failNext(529, 1);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await post(request({ q: NOUL }))).status);
    expect(statuses).toEqual([429, 429, 529, 200]);
  });

  it("refuses a non-positive `times`", () => {
    expect(() => mock.failNext(429, 0)).toThrow(RangeError);
  });
});

describe("recorded requests", () => {
  it("keeps the body and the headers but never the bearer value", async () => {
    await post(request({ q: NOUL }), { key: "super-secret-token" });
    expect(mock.requests).toHaveLength(1);
    const recorded = mock.requests[0];
    expect(recorded?.method).toBe("POST");
    expect(recorded?.path).toBe("/v1/systemone");
    expect(recorded?.headers.authorization).toBe(REDACTED);
    expect(JSON.stringify(recorded?.headers)).not.toContain("super-secret-token");
    expect(recorded?.body).toMatchObject({ model: MOCK_MODEL });
    expect(recorded?.wallTs).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);
  });

  it("records a refused request too, so a retry sequence can be counted", async () => {
    mock.failNext(429, 1, 1);
    await post(request({ q: NOUL }));
    await post(request({ q: NOUL }));
    expect(mock.requests).toHaveLength(2);
  });

  it("is emptied by `reset`, together with the queue and the policy", async () => {
    mock.failNext(500);
    mock.script(() => ({ q: { type: "noul", noul: 0.9 } }));
    mock.reset();
    const { status, json } = await post(request({ q: NOUL }));
    expect(status).toBe(200);
    expect((json as SystemOneBody).answers.q).toEqual({ type: "noul", noul: 0.5 });
    expect(mock.requests).toHaveLength(1);
  });

  it("never writes a bearer or a body to the log sink", async () => {
    const lines: string[] = [];
    const logged = await startMockTypeSafe({ port: 0, log: (line) => lines.push(line) });
    try {
      await fetch(`${logged.url}/v1/systemone`, {
        method: "POST",
        headers: { authorization: "Bearer super-secret-token" },
        body: JSON.stringify(request({ q: NOUL }, "a very distinctive state string")),
      });
      expect(lines).toEqual(["POST /v1/systemone -> 200"]);
      const joined = lines.join("\n");
      expect(joined).not.toContain("super-secret-token");
      expect(joined).not.toContain("distinctive state string");
    } finally {
      await logged.close();
    }
  });
});

describe("the other routes", () => {
  it("answers GET /healthz with plain ok and no authentication", async () => {
    const response = await fetch(`${mock.url}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("ok");
    expect(mock.requests).toHaveLength(0);
  });

  it("answers GET /v1/models with the alias table", async () => {
    const response = await fetch(`${mock.url}/v1/models`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: [
        { id: "von-latest", resolves_to: MOCK_MODEL },
        { id: "von-preview", resolves_to: MOCK_MODEL },
      ],
    });
  });

  it("answers an unknown route with a 404 JSON body", async () => {
    const response = await fetch(`${mock.url}/v2/anything`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(((await response.json()) as ErrorBody).error.type).toBe("not_found_error");
  });

  it("refuses the wrong method on /v1/systemone", async () => {
    const response = await fetch(`${mock.url}/v1/systemone`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(response.status).toBe(405);
  });
});

describe("lifecycle", () => {
  it("binds a free port and stops answering after close", async () => {
    const short = await startMockTypeSafe({ port: 0 });
    expect(short.port).toBeGreaterThan(0);
    expect(short.url).toBe(`http://127.0.0.1:${String(short.port)}`);
    expect((await fetch(`${short.url}/healthz`)).status).toBe(200);
    await short.close();
    await expect(fetch(`${short.url}/healthz`)).rejects.toThrow();
  });

  it("waits at least `latencyMs` before answering", async () => {
    const slow = await startMockTypeSafe({ port: 0, latencyMs: 60 });
    try {
      const started = performance.now();
      const response = await fetch(`${slow.url}/v1/systemone`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}` },
        body: JSON.stringify(request({ q: NOUL })),
      });
      expect(response.status).toBe(200);
      expect(performance.now() - started).toBeGreaterThanOrEqual(55);
    } finally {
      await slow.close();
    }
  });
});
