// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The cassette server (tools/eval/CASSETTES.md): a recorded request is answered
// with the recorded answers whatever the key order of the body it arrives in,
// any other request falls through to the mock's own answers and is counted
// with its digest, and only the harness's own bearer is accepted. The
// requests go over HTTP exactly as the SDK sends them.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CassetteError, CassetteStore, cassetteOf, withRecording, withRepeat } from "./cassette.ts";
import { CASSETTE_API_KEY, answerIndex, startCassetteServer } from "./cassette-server.ts";
import { requestDigest } from "./digest.ts";

const MODEL = "von-1.13.0";

const temporary: string[] = [];

afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratchStore(): CassetteStore {
  const root = mkdtempSync(join(tmpdir(), "fdp-cassette-server-"));
  temporary.push(root);
  return CassetteStore.forModel(MODEL, root);
}

/** A request the mock's schema accepts; `word` makes each one distinct. */
function request(word: string) {
  return {
    state: { machine: "CAU-7", symptom: `dryer purge pressure ${word}` },
    model: MODEL,
    questions: {
      fault: {
        type: "choice",
        instructions: "Which candidate's expected movements match the observations?",
        criteria: { a: "Candidate a", b: "Candidate b" },
      },
      severity: {
        type: "score",
        instructions: "How serious is the situation?",
        criteria: ["The unit still holds pressure.", "The unit no longer holds pressure."],
      },
    },
  };
}

/** Answers no mock policy would give, so a hit is recognisable. */
const RECORDED_ANSWERS = {
  fault: {
    type: "choice",
    choice: "b",
    confidence: 0.8125,
    probabilities: { a: 0.0625, b: 0.9375 },
  },
  severity: {
    type: "score",
    score: 1,
    confidence: 0.4375,
    legend: { "0": "The unit still holds pressure.", "1": "The unit no longer holds pressure." },
    probabilities: { "0": 0.1875, "1": 0.8125 },
  },
};

function record(store: CassetteStore, word: string): string {
  const cassette = cassetteOf(
    {
      request: request(word),
      response: {
        model: MODEL,
        answers: RECORDED_ANSWERS,
        usage: { input_tokens: 1480, output_tokens: 0 },
      },
    },
    { model: MODEL, recordedAt: new Date("2026-09-23T10:00:00.000Z"), backendVersion: "1.0.0" },
  );
  store.put(cassette);
  return cassette.request_digest;
}

// A synthetic exchange shaped exactly like a real System One answer to the backend's question
// set; every value is fictional. The Choice's criteria and the Score's levels are objects, one
// Noul per candidate, and the live API echoes each Score level verbatim as its legend entry, with
// a probability-weighted mean as the score and billed output tokens. The mock's own answers never
// look like this: before its response schema took object levels, every hit on a real recording
// answered 500, and a whole cassette run turned into failed decisions.

const LEVELS = [
  { summary: "Nothing to act on yet.", signals: ["pressure holds", "cycles as usual"] },
  { summary: "Worth a look this week.", signals: ["pressure sags a little", "loaded longer"] },
  { summary: "Act before the next shift.", signals: ["pressure falls", "loaded throughout"] },
  { summary: "Stop the unit.", signals: ["pressure lost", "a shutdown alarm"] },
];

const CANDIDATES = ["purge_valve_stuck", "hose_split", "demand_surge"] as const;

function realShapedRequest() {
  const criterion = (what: string) => ({
    what,
    signals: [`${what}: the first sign`, `${what}: the second sign`],
    not_for: "a reading that holds steady",
  });
  return {
    state: {
      machine: { unit: "CAU-7", kind: "screw compressor with a desiccant dryer" },
      symptom: "the line pressure sags while the unit is loaded",
      observations: [{ label: "line pressure", level: "below normal", trend: "falling" }],
      controller_alarms: [],
      candidates: CANDIDATES.map((id) => ({ id, expected_signal_moves: [`${id} moves`] })),
    },
    model: MODEL,
    questions: {
      fault: {
        type: "choice",
        instructions: { question: "Which cause fits?", inspect: ["observations"], focus: "moves" },
        criteria: {
          ...Object.fromEntries(CANDIDATES.map((id) => [id, criterion(id)])),
          none_of_these: { what: "none of the above", not_for: "a listed cause" },
        },
      },
      ...Object.fromEntries(
        CANDIDATES.map((id) => [
          `match_${id}`,
          {
            type: "noul",
            instructions: { question: `Do the moves fit ${id}?`, inspect: ["observations"] },
            criteria: {
              true: { what: "they do", examples: ["every move is seen"] },
              false: { what: "they do not", examples: ["a move is missing"] },
            },
          },
        ]),
      ),
      severity: {
        type: "score",
        instructions: { question: "How urgent is it?", inspect: ["observations"] },
        criteria: LEVELS,
      },
    },
  };
}

const REAL_SHAPED_ANSWERS = {
  fault: {
    type: "choice",
    choice: "hose_split",
    confidence: 0.57,
    probabilities: {
      purge_valve_stuck: 0.08,
      hose_split: 0.61,
      demand_surge: 0.07,
      none_of_these: 0.24,
    },
  },
  match_purge_valve_stuck: { type: "noul", noul: 0.12 },
  match_hose_split: { type: "noul", noul: 0.83 },
  match_demand_surge: { type: "noul", noul: 0.2 },
  severity: {
    type: "score",
    score: 1.93,
    confidence: 0.55,
    legend: Object.fromEntries(LEVELS.map((level, index) => [String(index), level])),
    probabilities: { "0": 0.02, "1": 0.19, "2": 0.63, "3": 0.16 },
  },
};

function recordRealShaped(store: CassetteStore, answers: unknown = REAL_SHAPED_ANSWERS): string {
  const cassette = cassetteOf(
    {
      request: realShapedRequest(),
      response: { model: MODEL, answers, usage: { input_tokens: 4321, output_tokens: 212 } },
    },
    { model: MODEL, recordedAt: new Date("2026-09-23T10:00:00.000Z"), backendVersion: "1.0.0" },
  );
  store.put(cassette);
  return cassette.request_digest;
}

/** Posts a body as the SDK would: JSON, with a bearer. */
async function post(url: string, body: unknown, bearer = CASSETTE_API_KEY) {
  const response = await fetch(`${url}/v1/systemone`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The same object with its top-level keys in the opposite order. */
function reordered(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).reverse());
}

describe("startCassetteServer", () => {
  it("answers a recorded request with its recorded answers and counts the hit", async () => {
    const store = scratchStore();
    const digest = record(store, "high");
    const server = await startCassetteServer({ store, model: MODEL });
    try {
      const answered = await post(server.url, reordered(request("high")));
      expect(answered.status).toBe(200);
      expect(answered.body["model"]).toBe(MODEL);
      expect(answered.body["answers"]).toEqual(RECORDED_ANSWERS);
      expect(server.stats).toEqual({
        hits: 1,
        misses: 0,
        missDigests: [],
        reused: 0,
        resample: 0,
        answersMax: 1,
      });
      expect(server.recorded(digest)?.response.answers).toEqual(RECORDED_ANSWERS);
    } finally {
      await server.close();
    }
  });

  it("falls through to the mock's answers on a miss and keeps the digest", async () => {
    const store = scratchStore();
    record(store, "high");
    const server = await startCassetteServer({ store, model: MODEL });
    try {
      const missed = await post(server.url, request("low"));
      expect(missed.status).toBe(200);
      expect(missed.body["answers"]).not.toEqual(RECORDED_ANSWERS);
      await post(server.url, request("high"));
      await post(server.url, request("low"));

      const lowDigest = requestDigest(request("low"));
      expect(server.stats).toEqual({
        hits: 1,
        misses: 2,
        missDigests: [lowDigest, lowDigest],
        reused: 0,
        resample: 0,
        answersMax: 1,
      });
      expect(server.recorded(lowDigest)).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("accepts only the harness bearer and answers nothing without it", async () => {
    const store = scratchStore();
    record(store, "high");
    const server = await startCassetteServer({ store, model: MODEL });
    try {
      const refused = await post(server.url, request("high"), "a-real-looking-key");
      expect(refused.status).toBe(401);
      expect(server.stats.hits).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("stops on close, and a second close is harmless", async () => {
    const server = await startCassetteServer({ store: scratchStore(), model: MODEL });
    await server.close();
    await server.close();
    await expect(fetch(`${server.url}/healthz`)).rejects.toThrow();
  });

  it("refuses to start over a cassette that is not valid", async () => {
    const store = scratchStore();
    record(store, "high");
    writeFileSync(join(store.dir, `${"f".repeat(64)}.json`), "{}");
    await expect(startCassetteServer({ store, model: MODEL })).rejects.toBeInstanceOf(
      CassetteError,
    );
  });

  it("serves a recording shaped like a real TypeSafe answer, object legend levels included", async () => {
    const store = scratchStore();
    const digest = recordRealShaped(store);
    const server = await startCassetteServer({ store, model: MODEL });
    try {
      const answered = await post(server.url, realShapedRequest());
      expect(answered.status).toBe(200);
      expect(answered.body["answers"]).toEqual(REAL_SHAPED_ANSWERS);
      expect(server.stats).toEqual({
        hits: 1,
        misses: 0,
        missDigests: [],
        reused: 0,
        resample: 0,
        answersMax: 1,
      });
      expect(server.recorded(digest)?.response.usage).toEqual({
        input_tokens: 4321,
        output_tokens: 212,
      });
    } finally {
      await server.close();
    }
  });

  it("serves the n-th recorded answer to the n-th arrival of a repeated request", async () => {
    const store = scratchStore();
    const answerWith = (confidence: number) => ({
      ...REAL_SHAPED_ANSWERS,
      fault: { ...REAL_SHAPED_ANSWERS.fault, confidence },
    });
    const exchange = (confidence: number, inputTokens: number) =>
      cassetteOf(
        {
          request: realShapedRequest(),
          response: {
            model: MODEL,
            answers: answerWith(confidence),
            usage: { input_tokens: inputTokens, output_tokens: 200 },
          },
        },
        { model: MODEL, recordedAt: new Date("2026-09-23T10:00:00.000Z"), backendVersion: "1.0.0" },
      );
    const recorded = withRepeat(
      withRepeat(exchange(0.57, 4001), exchange(0.61, 4002)),
      exchange(0.55, 4003),
    );
    store.put(recorded);
    const digest = recorded.request_digest;

    const server = await startCassetteServer({ store, model: MODEL });
    try {
      expect(server.answered(digest)).toBeUndefined();
      const confidences: unknown[] = [];
      const billed: unknown[] = [];
      for (let arrival = 0; arrival < 4; arrival += 1) {
        const answered = await post(server.url, realShapedRequest());
        expect(answered.status).toBe(200);
        const answers = answered.body["answers"] as { fault: { confidence: number } };
        confidences.push(answers.fault.confidence);
        billed.push(server.answered(digest)?.usage.input_tokens);
      }
      expect(confidences).toEqual([0.57, 0.61, 0.55, 0.55]);
      expect(billed).toEqual([4001, 4002, 4003, 4003]);
      expect(server.stats).toEqual({
        hits: 4,
        misses: 0,
        missDigests: [],
        reused: 1,
        resample: 0,
        answersMax: 3,
      });
    } finally {
      await server.close();
    }

    // A resample rotates the same answers: every arrival gets another answer the model really
    // gave, and over three resamples every arrival has been served all three.
    const served: number[][] = [];
    for (const resample of [1, 2, 3]) {
      const rotated = await startCassetteServer({ store, model: MODEL, resample });
      try {
        const confidences: number[] = [];
        for (let arrival = 0; arrival < 3; arrival += 1) {
          const answered = await post(rotated.url, realShapedRequest());
          confidences.push(
            (answered.body["answers"] as { fault: { confidence: number } }).fault.confidence,
          );
        }
        served.push(confidences);
        expect(rotated.stats).toMatchObject({ hits: 3, misses: 0, reused: 0, resample });
      } finally {
        await rotated.close();
      }
    }
    expect(served).toEqual([
      [0.61, 0.55, 0.57],
      [0.55, 0.57, 0.61],
      // Resample 3 of a three-answer cassette is resample 0 again.
      [0.57, 0.61, 0.55],
    ]);
  });

  it("serves the recording made at its own GATE_PERSIST_SIM_MIN, and misses one it lacks", async () => {
    // The pre-registration's amendment of 2026-09-24: one store holds the tuning list's two
    // recordings, at N = 0 and N = 1. A replay at N reads N's recording and no other.
    const store = scratchStore();
    const exchange = (persistSimMin: number, confidence: number) =>
      cassetteOf(
        {
          request: realShapedRequest(),
          response: {
            model: MODEL,
            answers: {
              ...REAL_SHAPED_ANSWERS,
              fault: { ...REAL_SHAPED_ANSWERS.fault, confidence },
            },
            usage: { input_tokens: 4000, output_tokens: 200 },
          },
        },
        {
          model: MODEL,
          recordedAt: new Date("2026-09-25T10:00:00.000Z"),
          backendVersion: "1.0.0",
          persistSimMin,
        },
      );
    const zero = withRepeat(withRepeat(exchange(0, 0.41), exchange(0, 0.42)), exchange(0, 0.43));
    store.put(withRecording(zero, exchange(1, 0.91)));

    const served = async (persistSimMin: number | undefined, arrivals: number) => {
      const server = await startCassetteServer({
        store,
        model: MODEL,
        ...(persistSimMin === undefined ? {} : { persistSimMin }),
      });
      try {
        const confidences: number[] = [];
        for (let arrival = 0; arrival < arrivals; arrival += 1) {
          const answered = await post(server.url, realShapedRequest());
          confidences.push(
            (answered.body["answers"] as { fault: { confidence: number } }).fault.confidence,
          );
        }
        return { confidences, stats: { ...server.stats } };
      } finally {
        await server.close();
      }
    };

    const atZero = await served(0, 3);
    expect(atZero.confidences).toEqual([0.41, 0.42, 0.43]);
    expect(atZero.stats).toMatchObject({ hits: 3, misses: 0, reused: 0, answersMax: 3 });
    const atOne = await served(1, 2);
    expect(atOne.confidences).toEqual([0.91, 0.91]);
    expect(atOne.stats).toMatchObject({ hits: 2, misses: 0, reused: 1, answersMax: 1 });
    // No recording at N = 2: a miss, answered by the mock, with the digest kept.
    const atTwo = await served(2, 1);
    expect(atTwo.confidences[0]).not.toBe(0.91);
    expect(atTwo.stats).toMatchObject({ hits: 0, misses: 1, answersMax: 0 });
    expect(atTwo.stats.missDigests).toEqual([requestDigest(realShapedRequest())]);
    // A server told no value serves the cassette's own recording, the newest.
    expect((await served(undefined, 1)).confidences).toEqual([0.91]);
  });

  it("misses a cassette that does not say its value when asked for N's own recording only", async () => {
    // The pre-registered sweep's replays: a cassette recorded before recordings were told apart
    // serves any value to other replays, but it cannot show it is N's recording, so the sweep's
    // replay counts it as a miss (with its digest) rather than serve it.
    const store = scratchStore();
    const digest = record(store, "high");
    const strict = await startCassetteServer({
      store,
      model: MODEL,
      persistSimMin: 1,
      ownRecordingOnly: true,
    });
    try {
      const answered = await post(strict.url, request("high"));
      expect(answered.body["answers"]).not.toEqual(RECORDED_ANSWERS);
      expect(strict.stats).toMatchObject({ hits: 0, misses: 1, answersMax: 0 });
      expect(strict.stats.missDigests).toEqual([digest]);
    } finally {
      await strict.close();
    }
    const lenient = await startCassetteServer({ store, model: MODEL, persistSimMin: 1 });
    try {
      expect((await post(lenient.url, request("high"))).body["answers"]).toEqual(RECORDED_ANSWERS);
      expect(lenient.stats).toMatchObject({ hits: 1, misses: 0 });
    } finally {
      await lenient.close();
    }
  });

  it("rotates answer indexes by the resample, modulo the answers a cassette holds", () => {
    // Resample 0 is the recording: the n-th arrival gets the n-th answer, the last one after.
    expect([0, 1, 2, 3, 4].map((arrival) => answerIndex(arrival, 3, 0))).toEqual([0, 1, 2, 2, 2]);
    expect([0, 1, 2, 3].map((arrival) => answerIndex(arrival, 3, 1))).toEqual([1, 2, 0, 0]);
    // A one-answer cassette serves its answer in every resample.
    expect([0, 1, 5].map((resample) => answerIndex(2, 1, resample))).toEqual([0, 0, 0]);
    expect(() => answerIndex(0, 0, 0)).toThrow(RangeError);
  });

  it("refuses a resample that is not a whole number at or above 0", async () => {
    const store = scratchStore();
    recordRealShaped(store);
    await expect(startCassetteServer({ store, model: MODEL, resample: -1 })).rejects.toThrow(
      RangeError,
    );
    await expect(startCassetteServer({ store, model: MODEL, resample: 0.5 })).rejects.toThrow(
      RangeError,
    );
  });

  it("answers every arrival of a one-answer cassette with that answer, counting the reuse", async () => {
    const store = scratchStore();
    recordRealShaped(store);
    const server = await startCassetteServer({ store, model: MODEL });
    try {
      for (let arrival = 0; arrival < 3; arrival += 1) {
        const answered = await post(server.url, realShapedRequest());
        expect(answered.body["answers"]).toEqual(REAL_SHAPED_ANSWERS);
      }
      expect(server.stats).toMatchObject({ hits: 3, misses: 0, reused: 2 });
    } finally {
      await server.close();
    }
  });

  it("refuses to start over a recording the mock could not serve, naming its file", async () => {
    const store = scratchStore();
    const broken = {
      ...REAL_SHAPED_ANSWERS,
      severity: { ...REAL_SHAPED_ANSWERS.severity, legend: { "0": 3, "1": 2, "2": 1, "3": 0 } },
    };
    const digest = recordRealShaped(store, broken);
    const refused = await startCassetteServer({ store, model: MODEL }).catch(
      (caught: unknown) => caught,
    );
    expect(refused).toBeInstanceOf(CassetteError);
    expect((refused as CassetteError).source).toBe(store.pathOf(digest));
    expect((refused as CassetteError).message).toContain("/answers/severity/legend/0");
  });
});
