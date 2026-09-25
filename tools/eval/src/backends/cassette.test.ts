// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The cassette store (tools/eval/CASSETTES.md): what it writes, what it reads
// back, and every way it refuses a document rather than let a replay miss in
// silence. Every cassette here is written to a temporary directory.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  CASSETTE_SCHEMA_ID,
  CASSETTES_DIR,
  CassetteError,
  CassetteStore,
  cassetteOf,
  recordingsOf,
  responsesAt,
  responsesOf,
  validateCassette,
  withRecording,
  withRepeat,
} from "./cassette.ts";
import type { Cassette } from "./cassette.ts";
import { requestDigest } from "./digest.ts";

const MODEL = "jev-1.13.0";

const temporary: string[] = [];

afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-cassette-store-"));
  temporary.push(directory);
  return directory;
}

/** The request half of one exchange; `word` makes each one distinct. */
function request(word: string) {
  return {
    state: { machine: "CAU-7", symptom: `dryer purge pressure ${word}` },
    model: MODEL,
    questions: {
      fault: { type: "choice", instructions: "Which candidate fits?" },
      severity: { type: "score", instructions: "How serious?" },
    },
  };
}

/** What the model answered to it. */
const RESPONSE = {
  model: MODEL,
  answers: {
    fault: { type: "choice", choice: "dryer_purge_leak", probabilities: { dryer_purge_leak: 0.9 } },
    severity: { type: "score", score: 2, probabilities: { "2": 0.8 }, confidence: 0.7 },
  },
  usage: { input_tokens: 1480, output_tokens: 0 },
};

const CONTEXT = {
  model: MODEL,
  recordedAt: new Date("2026-09-23T10:00:00.000Z"),
  backendVersion: "1.0.0",
};

function cassette(word: string): Cassette {
  return cassetteOf({ request: request(word), response: RESPONSE }, CONTEXT);
}

describe("cassetteOf", () => {
  it("files the exchange under the digest of its request", () => {
    const built = cassette("high");
    expect(built).toEqual({
      schema: CASSETTE_SCHEMA_ID,
      model: MODEL,
      request_digest: requestDigest(request("high")),
      recorded_wall_ts: "2026-09-23T10:00:00.000Z",
      backend_version: "1.0.0",
      request: request("high"),
      response: RESPONSE,
    });
  });

  it("carries the scenario id when the recorder knows it", () => {
    const built = cassetteOf(
      { request: request("high"), response: RESPONSE },
      { ...CONTEXT, scenarioId: "f3_air_leak_jun05" },
    );
    expect(built.scenario_id).toBe("f3_air_leak_jun05");
  });

  it("refuses an exchange without both bodies", () => {
    expect(() => cassetteOf({ request: request("high") }, CONTEXT)).toThrow(CassetteError);
    expect(() => cassetteOf({ response: RESPONSE }, CONTEXT)).toThrow(/no request or no response/);
  });

  it("refuses a response that is not the cassette shape", () => {
    const response = { model: MODEL, answers: {}, usage: { input_tokens: -1, output_tokens: 0 } };
    expect(() => cassetteOf({ request: request("high"), response }, CONTEXT)).toThrow(
      /\/response\/answers must NOT have fewer than 1 properties/,
    );
  });

  it("refuses a request for another model than the one the cassette is filed under", () => {
    expect(() =>
      cassetteOf(
        { request: request("high"), response: RESPONSE },
        { ...CONTEXT, model: "jev-1.14.0" },
      ),
    ).toThrow(/asked for jev-1.13.0, but the cassette is filed under jev-1.14.0/);
  });
});

describe("withRepeat and responsesOf", () => {
  const again = (confidence: number): Cassette =>
    cassetteOf(
      {
        request: request("high"),
        response: {
          ...RESPONSE,
          answers: { ...RESPONSE.answers, fault: { ...RESPONSE.answers.fault, confidence } },
        },
      },
      { ...CONTEXT, recordedAt: new Date("2026-09-23T10:30:00.000Z") },
    );

  it("keeps every answer of a repeated request, in the order they came", () => {
    const first = cassette("high");
    const twice = withRepeat(first, again(0.5));
    const thrice = withRepeat(twice, again(0.25));
    expect(responsesOf(first)).toEqual([RESPONSE]);
    expect(
      responsesOf(thrice).map((response) => response.answers["fault"]?.["confidence"]),
    ).toEqual([undefined, 0.5, 0.25]);
    expect(thrice.response).toEqual(RESPONSE);
    expect(thrice.recorded_wall_ts).toBe(first.recorded_wall_ts);
    expect(validateCassette(JSON.parse(JSON.stringify(thrice)), "thrice.json")).toEqual(thrice);
  });

  it("refuses to append the answer of another request", () => {
    expect(() => withRepeat(cassette("high"), cassette("low"))).toThrow(/is not a repeat of/);
  });

  it("refuses an empty list of repeats", () => {
    expect(() =>
      validateCassette({ ...cassette("high"), repeat_responses: [] }, "empty.json"),
    ).toThrow(/\/repeat_responses must NOT have fewer than 1 items/);
  });
});

// The Jev thresholds pre-registration's amendment of 2026-09-24: the tuning list is recorded once
// at GATE_PERSIST_SIM_MIN 0 and once at 1, into one store keyed by digest. The two recordings send
// many of the same requests, so a cassette keeps one recording per value, and each run replaces
// only its own.
describe("one recording per GATE_PERSIST_SIM_MIN", () => {
  const at = (persistSimMin: number, confidence: number, minute = 0): Cassette =>
    cassetteOf(
      {
        request: request("high"),
        response: {
          ...RESPONSE,
          answers: { ...RESPONSE.answers, fault: { ...RESPONSE.answers.fault, confidence } },
        },
      },
      {
        ...CONTEXT,
        recordedAt: new Date(Date.parse("2026-09-25T10:00:00.000Z") + minute * 60_000),
        persistSimMin,
      },
    );
  const confidences = (answers: readonly { answers: Cassette["response"]["answers"] }[]) =>
    answers.map((answer) => answer.answers["fault"]?.["confidence"]);

  it("says at which GATE_PERSIST_SIM_MIN a cassette was recorded", () => {
    expect(at(0, 0.5).persist_sim_min).toBe(0);
    expect(cassette("high")).not.toHaveProperty("persist_sim_min");
  });

  it("keeps the recording of each value side by side, the newest one first", () => {
    const zero = withRepeat(at(0, 0.5), at(0, 0.55, 1));
    const both = withRecording(zero, at(1, 0.9, 5));
    expect(both.persist_sim_min).toBe(1);
    expect(both.recorded_wall_ts).toBe("2026-09-25T10:05:00.000Z");
    expect(both.other_recordings).toEqual([
      {
        persist_sim_min: 0,
        recorded_wall_ts: "2026-09-25T10:00:00.000Z",
        backend_version: "1.0.0",
        response: zero.response,
        repeat_responses: zero.repeat_responses,
      },
    ]);
    expect(confidences(responsesAt(both, 0) ?? [])).toEqual([0.5, 0.55]);
    expect(confidences(responsesAt(both, 1) ?? [])).toEqual([0.9]);
    expect(responsesAt(both, 2)).toBeUndefined();
    expect(recordingsOf(both).map((entry) => entry.persist_sim_min)).toEqual([1, 0]);
    expect(validateCassette(JSON.parse(JSON.stringify(both)), "both.json")).toEqual(both);
  });

  it("appends a repeat to the recording of its own value, wherever it is kept", () => {
    const both = withRecording(at(0, 0.5), at(1, 0.9, 5));
    const again = withRepeat(withRepeat(both, at(0, 0.45, 6)), at(1, 0.95, 7));
    expect(confidences(responsesAt(again, 0) ?? [])).toEqual([0.5, 0.45]);
    expect(confidences(responsesAt(again, 1) ?? [])).toEqual([0.9, 0.95]);
    expect(() => withRepeat(at(0, 0.5), at(1, 0.9))).toThrow(
      /holds no recording at GATE_PERSIST_SIM_MIN 1/,
    );
  });

  it("replaces an earlier run's recording at the same value, never mixing with it", () => {
    const both = withRecording(at(0, 0.5), at(1, 0.9, 5));
    const rerecorded = withRecording(both, at(0, 0.3, 9));
    expect(confidences(responsesAt(rerecorded, 0) ?? [])).toEqual([0.3]);
    expect(confidences(responsesAt(rerecorded, 1) ?? [])).toEqual([0.9]);
    expect(recordingsOf(rerecorded)).toHaveLength(2);
  });

  it("replaces a cassette recorded before recordings were told apart, which serves any value", () => {
    const untold = cassette("high");
    expect(responsesAt(untold, 0)).toEqual([RESPONSE]);
    expect(responsesAt(untold, 1)).toEqual([RESPONSE]);
    const replaced = withRecording(untold, at(1, 0.9));
    expect(replaced.other_recordings).toBeUndefined();
    expect(responsesAt(replaced, 0)).toBeUndefined();
    expect(withRecording(undefined, at(1, 0.9))).toEqual(at(1, 0.9));
  });

  it("serves a cassette that does not say its value to no replay that asks for N's own recording", () => {
    // The pre-registered sweep scores each N on the recording made at N "and on no other": a
    // cassette recorded before recordings were told apart, or by code that did not tell them
    // apart, cannot show it is N's, so under `ownRecordingOnly` it is a miss at every value.
    const untold = cassette("high");
    expect(responsesAt(untold, 0, { ownRecordingOnly: true })).toBeUndefined();
    expect(responsesAt(untold, 1, { ownRecordingOnly: true })).toBeUndefined();
    const both = withRecording(at(0, 0.5), at(1, 0.9, 5));
    expect(confidences(responsesAt(both, 0, { ownRecordingOnly: true }) ?? [])).toEqual([0.5]);
    expect(confidences(responsesAt(both, 1, { ownRecordingOnly: true }) ?? [])).toEqual([0.9]);
    expect(responsesAt(both, 2, { ownRecordingOnly: true })).toBeUndefined();
  });

  it("refuses two recordings at one value, and other recordings beside an untold one", () => {
    const both = withRecording(at(0, 0.5), at(1, 0.9, 5));
    const [other] = both.other_recordings ?? [];
    expect(() =>
      validateCassette(
        { ...both, other_recordings: [{ ...other, persist_sim_min: 1 }] },
        "twice.json",
      ),
    ).toThrow(/twice\.json: holds two recordings at GATE_PERSIST_SIM_MIN 1/);
    const untold: Record<string, unknown> = { ...both };
    delete untold["persist_sim_min"];
    expect(() => validateCassette(untold, "untold.json")).toThrow(
      /must have property persist_sim_min when property other_recordings is present/,
    );
    expect(() => withRecording(cassette("low"), at(1, 0.9))).toThrow(/is not a recording of/);
  });
});

describe("validateCassette", () => {
  it("names the source and every schema problem", () => {
    const document: Record<string, unknown> = { ...cassette("high"), extra: 1 };
    delete document["schema"];
    let message = "";
    try {
      validateCassette(document, "some.json");
    } catch (error) {
      expect(error).toBeInstanceOf(CassetteError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/^some\.json: is not a urn:fdp:eval:cassette:v1 document: /);
    expect(message).toContain("must have required property 'schema'");
    expect(message).toContain("must NOT have additional properties");
  });

  it("refuses a request that was edited after the recording", () => {
    const edited = structuredClone(cassette("high")) as { request: { state: { symptom: string } } };
    edited.request.state.symptom = "dryer purge pressure low";
    expect(() => validateCassette(edited, "edited.json")).toThrow(
      /is not the digest of its request/,
    );
  });
});

describe("CassetteStore", () => {
  it("resolves a model's directory under the default root", () => {
    expect(CassetteStore.forModel(MODEL).dir).toBe(join(CASSETTES_DIR, MODEL));
  });

  it("is empty when its directory does not exist", () => {
    const store = CassetteStore.forModel(MODEL, scratch());
    expect(store.count).toBe(0);
    expect(store.list()).toEqual([]);
    expect(store.get(requestDigest(request("high")))).toBeUndefined();
  });

  it("puts, gets and lists cassettes, one file per digest", () => {
    const store = CassetteStore.forModel(MODEL, scratch());
    const high = cassette("high");
    const low = cassette("low");

    const path = store.put(high);
    store.put(low);
    store.put(high);

    expect(path).toBe(join(store.dir, `${high.request_digest}.json`));
    expect(store.count).toBe(2);
    expect(readdirSync(store.dir).sort()).toEqual(
      [`${high.request_digest}.json`, `${low.request_digest}.json`].sort(),
    );
    expect(store.get(high.request_digest)).toEqual(high);
    expect(store.list().map((entry) => entry.request_digest)).toEqual(
      [high.request_digest, low.request_digest].sort(),
    );
    expect(store.get("not-a-digest")).toBeUndefined();
  });

  it("writes readable JSON and leaves no temporary file behind", () => {
    const store = CassetteStore.forModel(MODEL, scratch());
    const path = store.put(cassette("high"));
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(cassette("high"));
    expect(readdirSync(store.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses to put a cassette whose digest does not match its request", () => {
    const store = CassetteStore.forModel(MODEL, scratch());
    const wrong = { ...cassette("high"), request_digest: requestDigest(request("low")) };
    expect(() => store.put(wrong)).toThrow(CassetteError);
    expect(store.count).toBe(0);
  });

  it("refuses to read a tampered file, a renamed file and a file that is not JSON", () => {
    const tampered = CassetteStore.forModel(MODEL, scratch());
    const path = tampered.put(cassette("high"));
    const document = JSON.parse(readFileSync(path, "utf8")) as Cassette;
    writeFileSync(
      path,
      JSON.stringify({
        ...document,
        request: { ...document.request, state: { machine: "edited" } },
      }),
    );
    expect(() => tampered.list()).toThrow(/is not the digest of its request/);

    const renamed = CassetteStore.forModel(MODEL, scratch());
    const high = cassette("high");
    renamed.put(high);
    const other = join(renamed.dir, `${"0".repeat(64)}.json`);
    writeFileSync(other, JSON.stringify(high));
    expect(() => renamed.list()).toThrow(/is not named after its request_digest/);

    const broken = CassetteStore.forModel(MODEL, scratch());
    broken.put(cassette("high"));
    writeFileSync(join(broken.dir, "notes.json"), "not json");
    expect(() => broken.list()).toThrow(/notes\.json: is not a readable JSON document/);
  });
});
