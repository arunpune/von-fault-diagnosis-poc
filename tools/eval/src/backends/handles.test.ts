// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The live and cassette handles, offline.
//
// "Live" here is the contracts' mock TypeSafe server and the contracts' mock
// Anthropic server standing in for the two APIs, reached with stand-in keys
// that exist only inside this test process. The decisions are real: a
// contracts suspect-event fixture, the mini catalog's candidates from the
// pipeline's own retriever, the pipeline's own Jev and LLM backends.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SuspectEvent } from "@fdp/contracts";
import { MOCK_MODEL, startMockAnthropic, startMockTypeSafe } from "@fdp/contracts/mock";
import type { Answer, AnswerPolicy } from "@fdp/contracts/mock";
import { fixturesFor } from "@fdp/contracts/testing";
import { createCatalogRetriever } from "@fdp/backend/pipeline";
import type { DecisionInput, DecisionOutput } from "@fdp/backend/pipeline";
import { afterAll, describe, expect, it } from "vitest";

import { loadReferenceCatalog, MINI_CATALOG_PATH } from "../catalog/reference.ts";
import { ConfigError, loadConfig } from "../config.ts";
import type { Env } from "../config.ts";
import { createFakeWallClock } from "../runner/host.ts";
import { CassetteStore } from "./cassette.ts";
import type { Cassette } from "./cassette.ts";
import { requestDigest } from "./digest.ts";
import { createCassetteJevHandle, createLiveJevHandle } from "./jev.ts";
import { createLlmHandle } from "./llm.ts";

/** Stand-in keys; every assertion on output greps for them. */
const TYPESAFE_KEY = "tsk-handles-test-7f3a";
const LLM_KEY = "sk-handles-test-91c2";

const RECORDED_AT = new Date("2026-09-23T10:00:00.000Z");

const temporary: string[] = [];

afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-handles-"));
  temporary.push(directory);
  return directory;
}

function config(env: Env, argv: readonly string[] = []) {
  return loadConfig(argv, env, { cwd: "/tmp" });
}

/** A decision about one contracts suspect-event fixture, over the mini catalog's candidates. */
async function decisionInput(file: string): Promise<DecisionInput> {
  const fixture = fixturesFor("suspect-event").valid.find((entry) => entry.file === file);
  if (fixture === undefined) throw new Error(`no suspect-event fixture ${file}`);
  const event = fixture.data as SuspectEvent;
  const catalog = loadReferenceCatalog(MINI_CATALOG_PATH);
  const retriever = createCatalogRetriever(catalog.entries, { conditions: catalog.conditionTable });
  return { event, candidates: await retriever.retrieve(event), unit_id: event.unit_id };
}

/** What a decision decided, without the fields a replay may legitimately differ in. */
function decided(output: DecisionOutput) {
  const { backend, model, choice, probabilities, confidence, support, severity, usage } = output;
  return {
    backend,
    model,
    choice,
    probabilities,
    confidence,
    support,
    severity,
    usage,
    state_digest: output.state_digest,
  };
}

const CONTINUOUS_LOAD = await decisionInput("valid-continuous-load.json");
const FREQUENT_CYCLING = await decisionInput("valid-frequent-cycling.json");

describe("the live Jev handle", () => {
  it("needs the key", () => {
    expect(() => createLiveJevHandle(config({}), { wall: createFakeWallClock() })).toThrow(
      /^TYPESAFE_API_KEY: live mode calls the TypeSafe API/,
    );
  });

  it("decides through the rate-limited queue and records nothing without --record", async () => {
    const api = await startMockTypeSafe({
      port: 0,
      apiKey: TYPESAFE_KEY,
      answerPolicy: "confident-first",
    });
    const root = scratch();
    try {
      const cfg = config({ TYPESAFE_API_KEY: TYPESAFE_KEY, TYPESAFE_BASE_URL: api.url });
      const handle = createLiveJevHandle(cfg, { wall: createFakeWallClock(), cassettesDir: root });
      expect([handle.name, handle.model, handle.mode]).toEqual(["jev", MOCK_MODEL, "live"]);

      const output = await handle.backend.decide(CONTINUOUS_LOAD);
      expect(output.backend).toBe("jev");
      expect(output.usage.input_tokens).toBeGreaterThan(0);
      expect({ ...handle.stats }).toEqual({
        calls: 1,
        failures: 0,
        cassetteMisses: 0,
        rateLimit: { calls: 1, retries: 0, waitedMs: 0 },
      });
      expect(CassetteStore.forModel(MOCK_MODEL, root).count).toBe(0);
      expect(JSON.stringify(api.requests)).not.toContain(TYPESAFE_KEY);
    } finally {
      await api.close();
    }
  });

  it("records every answered call as a cassette under --record", async () => {
    const api = await startMockTypeSafe({
      port: 0,
      apiKey: TYPESAFE_KEY,
      answerPolicy: "confident-first",
    });
    const root = scratch();
    try {
      const cfg = config({ TYPESAFE_API_KEY: TYPESAFE_KEY, TYPESAFE_BASE_URL: api.url }, [
        "--record",
      ]);
      const handle = createLiveJevHandle(cfg, {
        wall: createFakeWallClock(),
        cassettesDir: root,
        now: () => RECORDED_AT,
      });
      const first = await handle.backend.decide(CONTINUOUS_LOAD);
      await handle.backend.decide(FREQUENT_CYCLING);
      await handle.backend.decide(CONTINUOUS_LOAD);

      const store = CassetteStore.forModel(MOCK_MODEL, root);
      expect(store.count).toBe(2);
      const request = first.raw.request as { model: string; state: unknown; questions: unknown };
      const cassette = store.get(requestDigest(request));
      expect(cassette?.recorded_wall_ts).toBe(RECORDED_AT.toISOString());
      expect(cassette?.request).toEqual(JSON.parse(JSON.stringify(request)));
      expect(cassette?.response).toEqual(first.raw.response);
      expect(cassette?.backend_version).toBe("1.0.0");
      for (const path of store.list().map((entry) => store.pathOf(entry.request_digest))) {
        expect(readFileSync(path, "utf8")).not.toContain(TYPESAFE_KEY);
      }
    } finally {
      await api.close();
    }
  });
});

describe("the cassette Jev handle", () => {
  /** Records the two fixtures against a confident mock and returns the live outputs. */
  async function recordTwo(root: string): Promise<DecisionOutput[]> {
    const api = await startMockTypeSafe({
      port: 0,
      apiKey: TYPESAFE_KEY,
      answerPolicy: "confident-first",
    });
    try {
      const cfg = config({ TYPESAFE_API_KEY: TYPESAFE_KEY, TYPESAFE_BASE_URL: api.url }, [
        "--record",
      ]);
      const handle = createLiveJevHandle(cfg, { wall: createFakeWallClock(), cassettesDir: root });
      return [
        await handle.backend.decide(CONTINUOUS_LOAD),
        await handle.backend.decide(FREQUENT_CYCLING),
      ];
    } finally {
      await api.close();
    }
  }

  it("reproduces the recorded decisions with no key and counts the hits", async () => {
    const root = scratch();
    const live = await recordTwo(root);
    const handle = await createCassetteJevHandle(config({}), {
      wall: createFakeWallClock(),
      cassettesDir: root,
    });
    try {
      expect([handle.mode, handle.model]).toEqual(["cassette", MOCK_MODEL]);
      const replayed = [
        await handle.backend.decide(CONTINUOUS_LOAD),
        await handle.backend.decide(FREQUENT_CYCLING),
      ];
      expect(replayed.map(decided)).toEqual(live.map(decided));
      expect({ ...handle.stats }).toEqual({
        calls: 2,
        failures: 0,
        cassetteMisses: 0,
        cassetteHits: 2,
        cassetteMissDigests: [],
        cassetteReused: 0,
        cassetteResample: 0,
        cassetteAnswersMax: 1,
      });
    } finally {
      await handle.close();
    }
  });

  it("replays answers shaped as the live API gives them, with no failed decision", async () => {
    // The live API echoes every Score level verbatim as the legend — the backend asks with object
    // levels — and reports a probability-weighted mean as the score. A recording of that shape
    // once answered 500 on every hit, and every replayed decision failed.
    const liveShaped: AnswerPolicy = (request) => {
      const answers: Record<string, Answer> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type === "score") {
          const levels = question.criteria;
          const mass = levels.map((_, index) => (index === 1 ? 0.7 : 0.3 / (levels.length - 1)));
          answers[id] = {
            type: "score",
            score: mass.reduce((sum, p, index) => sum + p * index, 0),
            confidence: 0.64,
            legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
            probabilities: Object.fromEntries(mass.map((p, index) => [String(index), p])),
          };
        }
        if (question.type === "choice") {
          const labels = Object.keys(question.criteria);
          const [pick] = labels;
          if (pick === undefined) continue;
          answers[id] = {
            type: "choice",
            choice: pick,
            confidence: 0.71,
            probabilities: Object.fromEntries(
              labels.map((label) => [label, label === pick ? 0.75 : 0.25 / (labels.length - 1)]),
            ),
          };
        }
      }
      return answers;
    };
    const root = scratch();
    const api = await startMockTypeSafe({ port: 0, apiKey: TYPESAFE_KEY, answer: liveShaped });
    let live: DecisionOutput;
    try {
      const cfg = config({ TYPESAFE_API_KEY: TYPESAFE_KEY, TYPESAFE_BASE_URL: api.url }, [
        "--record",
      ]);
      const recorder = createLiveJevHandle(cfg, {
        wall: createFakeWallClock(),
        cassettesDir: root,
      });
      live = await recorder.backend.decide(CONTINUOUS_LOAD);
    } finally {
      await api.close();
    }
    const [recorded] = CassetteStore.forModel(MOCK_MODEL, root).list();
    const severity = recorded?.response.answers["severity"] as { legend: Record<string, unknown> };
    expect(typeof severity.legend["0"]).toBe("object");

    const handle = await createCassetteJevHandle(config({}), {
      wall: createFakeWallClock(),
      cassettesDir: root,
    });
    try {
      const replayed = await handle.backend.decide(CONTINUOUS_LOAD);
      expect(decided(replayed)).toEqual(decided(live));
      expect({ ...handle.stats }).toMatchObject({ calls: 1, failures: 0, cassetteHits: 1 });
    } finally {
      await handle.close();
    }
  });

  it("records every answer of a repeated request and replays them in order", async () => {
    // The live model answers the same request differently each time; the stand-in does too,
    // by the index of the call, so only a replay that serves each arrival its own answer
    // reproduces the live decisions.
    const drifting: AnswerPolicy = (request, index) => {
      const answers: Record<string, Answer> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type !== "choice") continue;
        const labels = Object.keys(question.criteria);
        const [pick] = labels;
        if (pick === undefined) continue;
        const confidence = [0.62, 0.88, 0.71][index % 3] ?? 0.5;
        answers[id] = {
          type: "choice",
          choice: pick,
          confidence,
          probabilities: Object.fromEntries(
            labels.map((label) => [
              label,
              label === pick ? confidence : (1 - confidence) / (labels.length - 1),
            ]),
          ),
        };
      }
      return answers;
    };
    const root = scratch();
    const api = await startMockTypeSafe({ port: 0, apiKey: TYPESAFE_KEY, answer: drifting });
    const live: DecisionOutput[] = [];
    try {
      const cfg = config({ TYPESAFE_API_KEY: TYPESAFE_KEY, TYPESAFE_BASE_URL: api.url }, [
        "--record",
      ]);
      const recorder = createLiveJevHandle(cfg, {
        wall: createFakeWallClock(),
        cassettesDir: root,
      });
      for (let call = 0; call < 3; call += 1)
        live.push(await recorder.backend.decide(CONTINUOUS_LOAD));
    } finally {
      await api.close();
    }
    expect(new Set(live.map((output) => output.confidence)).size).toBe(3);
    const store = CassetteStore.forModel(MOCK_MODEL, root);
    expect(store.count).toBe(1);
    const [cassette] = store.list();
    expect(cassette?.response).toEqual(live[0]?.raw.response);
    expect(cassette?.repeat_responses).toEqual([live[1]?.raw.response, live[2]?.raw.response]);

    const handle = await createCassetteJevHandle(config({}), {
      wall: createFakeWallClock(),
      cassettesDir: root,
    });
    try {
      const replayed: DecisionOutput[] = [];
      for (let call = 0; call < 4; call += 1)
        replayed.push(await handle.backend.decide(CONTINUOUS_LOAD));
      expect(replayed.slice(0, 3).map(decided)).toEqual(live.map(decided));
      expect(decided(replayed[3] as DecisionOutput)).toEqual(decided(live[2] as DecisionOutput));
      expect({ ...handle.stats }).toMatchObject({
        calls: 4,
        failures: 0,
        cassetteHits: 4,
        cassetteMisses: 0,
        cassetteReused: 1,
      });
    } finally {
      await handle.close();
    }
  });

  it("replaces an older recording run's cassette instead of appending to it", async () => {
    const root = scratch();
    const [first] = await recordTwo(root);
    await recordTwo(root);
    const request = first!.raw.request as { model: string; state: unknown; questions: unknown };
    const cassette = CassetteStore.forModel(MOCK_MODEL, root).get(requestDigest(request));
    expect(cassette?.repeat_responses).toBeUndefined();
  });

  it("keeps the recordings made at GATE_PERSIST_SIM_MIN 0 and 1 in one store, each replayed at its own value", async () => {
    // The Jev thresholds pre-registration's amendment of 2026-09-24: the tuning list is recorded
    // at N = 0 and at N = 1 into one store keyed by digest, and the two recordings send many of
    // the same requests. Here both send the same one; the stand-in answers each run differently,
    // as the live model would, so only a replay of each run's own answers gives its decisions.
    const answering =
      (confidences: readonly number[]): AnswerPolicy =>
      (request, index) => {
        const answers: Record<string, Answer> = {};
        for (const [id, question] of Object.entries(request.questions)) {
          if (question.type !== "choice") continue;
          const labels = Object.keys(question.criteria);
          const [pick] = labels;
          if (pick === undefined) continue;
          const confidence = confidences[index % confidences.length] ?? 0.5;
          answers[id] = {
            type: "choice",
            choice: pick,
            confidence,
            probabilities: Object.fromEntries(
              labels.map((label) => [
                label,
                label === pick ? confidence : (1 - confidence) / (labels.length - 1),
              ]),
            ),
          };
        }
        return answers;
      };
    const root = scratch();
    const recordAt = async (persist: string, confidences: readonly number[], calls: number) => {
      const api = await startMockTypeSafe({
        port: 0,
        apiKey: TYPESAFE_KEY,
        answer: answering(confidences),
      });
      try {
        const cfg = config(
          {
            TYPESAFE_API_KEY: TYPESAFE_KEY,
            TYPESAFE_BASE_URL: api.url,
            GATE_PERSIST_SIM_MIN: persist,
          },
          ["--record"],
        );
        const recorder = createLiveJevHandle(cfg, {
          wall: createFakeWallClock(),
          cassettesDir: root,
        });
        const live: DecisionOutput[] = [];
        for (let call = 0; call < calls; call += 1)
          live.push(await recorder.backend.decide(CONTINUOUS_LOAD));
        return live;
      } finally {
        await api.close();
      }
    };
    const replayAt = async (persist: string, calls: number) => {
      const handle = await createCassetteJevHandle(config({ GATE_PERSIST_SIM_MIN: persist }), {
        wall: createFakeWallClock(),
        cassettesDir: root,
      });
      try {
        const replayed: DecisionOutput[] = [];
        for (let call = 0; call < calls; call += 1)
          replayed.push(await handle.backend.decide(CONTINUOUS_LOAD));
        return { replayed, stats: { ...handle.stats } };
      } finally {
        await handle.close();
      }
    };

    const atZero = await recordAt("0", [0.62, 0.66], 2);
    const atOne = await recordAt("1", [0.91, 0.87, 0.83], 3);
    const store = CassetteStore.forModel(MOCK_MODEL, root);
    expect(store.count).toBe(1);
    const [cassette] = store.list();
    expect(cassette?.persist_sim_min).toBe(1);
    expect(cassette?.other_recordings?.map((entry) => entry.persist_sim_min)).toEqual([0]);

    const zero = await replayAt("0", 2);
    expect(zero.replayed.map(decided)).toEqual(atZero.map(decided));
    expect(zero.stats).toMatchObject({ cassetteHits: 2, cassetteMisses: 0, cassetteAnswersMax: 2 });
    const one = await replayAt("1", 3);
    expect(one.replayed.map(decided)).toEqual(atOne.map(decided));
    expect(one.stats).toMatchObject({ cassetteHits: 3, cassetteMisses: 0, cassetteAnswersMax: 3 });

    // Recording N = 0 again replaces N = 0's answers and leaves N = 1's as they were.
    const again = await recordAt("0", [0.58], 1);
    expect((await replayAt("0", 1)).replayed.map(decided)).toEqual(again.map(decided));
    expect((await replayAt("1", 3)).replayed.map(decided)).toEqual(atOne.map(decided));
    // A value nobody recorded at is a miss for every request, which is how a sweep tells it.
    const two = await replayAt("2", 1);
    expect(two.stats).toMatchObject({ cassetteHits: 0, cassetteMisses: 1 });
  });

  it("bills a hit at the recorded usage, not at the mock's estimate", async () => {
    const root = scratch();
    const [live] = await recordTwo(root);
    const store = CassetteStore.forModel(MOCK_MODEL, root);
    const request = live!.raw.request as { model: string; state: unknown; questions: unknown };
    const recorded = store.get(requestDigest(request)) as Cassette;
    store.put({
      ...recorded,
      response: { ...recorded.response, usage: { input_tokens: 4242, output_tokens: 0 } },
    });

    const handle = await createCassetteJevHandle(config({}), {
      wall: createFakeWallClock(),
      cassettesDir: root,
    });
    try {
      const replayed = await handle.backend.decide(CONTINUOUS_LOAD);
      expect(replayed.usage).toEqual({ input_tokens: 4242, output_tokens: 0 });
      expect(live!.usage.input_tokens).not.toBe(4242);
    } finally {
      await handle.close();
    }
  });

  it("counts a request it has no cassette for, with its digest, and answers it from the mock", async () => {
    const root = scratch();
    const [live] = await recordTwo(root);
    const store = CassetteStore.forModel(MOCK_MODEL, root);
    const request = live!.raw.request as { model: string; state: unknown; questions: unknown };
    rmSync(store.pathOf(requestDigest(request)));

    const handle = await createCassetteJevHandle(config({}), {
      wall: createFakeWallClock(),
      cassettesDir: root,
    });
    try {
      const replayed = await handle.backend.decide(CONTINUOUS_LOAD);
      expect(replayed.backend).toBe("jev");
      expect(handle.stats.cassetteMisses).toBe(1);
      expect(handle.stats.cassetteHits).toBe(0);
      expect(handle.stats.cassetteMissDigests).toEqual([requestDigest(request)]);
    } finally {
      await handle.close();
    }
  });

  it("serves a cassette that does not say its value to no replay that asks for N's own recording", async () => {
    // The pre-registered sweep's replays set `cassetteOwnRecordingOnly`: each N is read from the
    // recording made at N and no other, and a cassette written before recordings were told apart
    // (or by a recorder that did not tell them apart) cannot show it is N's.
    const root = scratch();
    const [live] = await recordTwo(root);
    const store = CassetteStore.forModel(MOCK_MODEL, root);
    for (const recorded of store.list()) {
      const untold: Record<string, unknown> = { ...recorded };
      delete untold["persist_sim_min"];
      store.put(untold as unknown as Cassette);
    }
    const request = live!.raw.request as { model: string; state: unknown; questions: unknown };
    const replay = async (ownRecordingOnly: boolean) => {
      const handle = await createCassetteJevHandle(
        {
          ...config({ GATE_PERSIST_SIM_MIN: "1" }),
          ...(ownRecordingOnly ? { cassetteOwnRecordingOnly: true } : {}),
        },
        { wall: createFakeWallClock(), cassettesDir: root },
      );
      try {
        await handle.backend.decide(CONTINUOUS_LOAD);
        return { ...handle.stats };
      } finally {
        await handle.close();
      }
    };
    expect(await replay(false)).toMatchObject({ cassetteHits: 1, cassetteMisses: 0 });
    const strict = await replay(true);
    expect(strict).toMatchObject({ cassetteHits: 0, cassetteMisses: 1 });
    expect(strict.cassetteMissDigests).toEqual([requestDigest(request)]);
  });

  it("refuses a model without cassettes and a model the mock does not answer", async () => {
    const empty = await createCassetteJevHandle(config({}), {
      wall: createFakeWallClock(),
      cassettesDir: scratch(),
    }).catch((caught: unknown) => caught);
    expect(empty).toBeInstanceOf(ConfigError);
    expect((empty as ConfigError).flag).toBe("EVAL_JEV_MODE");

    const other = await createCassetteJevHandle(config({ JEV_MODEL: "jev-1.14.0" }), {
      wall: createFakeWallClock(),
      cassettesDir: scratch(),
    }).catch((caught: unknown) => caught);
    expect(other).toBeInstanceOf(ConfigError);
    expect((other as ConfigError).flag).toBe("JEV_MODEL");
  });
});

describe("the live LLM handle", () => {
  it("needs the key", () => {
    expect(() => createLlmHandle(config({}))).toThrow(/^LLM_API_KEY: /);
  });

  it("decides through the Messages API and the rate-limited queue", async () => {
    const [first] = CONTINUOUS_LOAD.candidates;
    if (first === undefined) throw new Error("the mini catalog offered no candidate");
    const ids = CONTINUOUS_LOAD.candidates.map((candidate) => candidate.fault_id);
    const api = await startMockAnthropic({
      port: 0,
      apiKey: LLM_KEY,
      enforceOutputSchema: true,
      reply: () => ({
        json: {
          choice: first.fault_id,
          probabilities: [...ids, "none_of_these"].map((id) => ({
            id,
            probability: id === first.fault_id ? 0.8 : 0,
          })),
          support: ids.map((id) => ({ id, support: id === first.fault_id ? 1 : 0 })),
          severity_level: "medium",
          severity_confidence: 0.7,
          rationale: "Line pressure stays below the setpoint while the unit runs loaded.",
        },
        usage: { input_tokens: 900, output_tokens: 120 },
      }),
    });
    try {
      const cfg = config({ LLM_API_KEY: LLM_KEY });
      const handle = createLlmHandle(cfg, { baseURL: api.url });
      expect([handle.name, handle.model, handle.mode]).toEqual(["llm", "claude-opus-5", "live"]);

      const output = await handle.backend.decide(CONTINUOUS_LOAD);
      expect(output.backend).toBe("llm");
      expect(output.choice).toBe(first.fault_id);
      expect(output.usage).toEqual({ input_tokens: 900, output_tokens: 120 });
      expect(handle.stats.rateLimit).toEqual({ calls: 1, retries: 0, waitedMs: 0 });
      expect(JSON.stringify(api.requests)).not.toContain(LLM_KEY);
    } finally {
      await api.close();
    }
  });
});
