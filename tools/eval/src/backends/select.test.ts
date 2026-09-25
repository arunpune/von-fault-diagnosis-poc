// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Backend selection and the handles it builds.
//
// Every test runs offline: the rules backend is in process, the Jev handle
// talks to the contracts' mock on a free local port, and "live" is that mock
// reached with a stand-in key. The live plan is a stub here — the real one
// replays scenarios and is exercised by the cassette round trip — so these
// tests are about what the selector does with a plan: log it, and refuse
// without `--confirm-live` before anything is built. The stand-in keys are
// grepped for in every log line and every error.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MOCK_MODEL, startMockTypeSafe } from "@fdp/contracts/mock";
import { DecisionError } from "@fdp/backend/pipeline";
import type { DecisionBackend, DecisionInput } from "@fdp/backend/pipeline";
import { afterAll, describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../config.ts";
import type { EvalConfig } from "../config.ts";
import { createLogger } from "../log.ts";
import type { Logger } from "../log.ts";
import { createFakeWallClock } from "../runner/host.ts";
import { CassetteStore, cassetteOf } from "./cassette.ts";
import { createJevHandle } from "./jev.ts";
import { createMockJevHandle, DEFAULT_MOCK_POLICY, MOCK_API_KEY } from "./mock.ts";
import type { LiveBackendName, LivePlan } from "./plan.ts";
import { createRulesHandle } from "./rules.ts";
import {
  AVAILABLE_JEV_MODES,
  cassetteCount,
  closeBackends,
  resolveJevMode,
  selectBackends,
} from "./select.ts";
import type { LivePlanner } from "./select.ts";
import { counted, newStats, SIGNAL_LABELS } from "./types.ts";

/** Stand-in keys; the assertions grep every log line and error for them. */
const FAKE_KEY = "tsk-test-select-0001";
const FAKE_LLM_KEY = "sk-test-select-0002";

const temporary: string[] = [];

afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A cassette root with nothing in it, so `auto` never finds recordings by accident. */
function emptyCassettes(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-cassettes-"));
  temporary.push(directory);
  return directory;
}

/** A cassette root holding one valid cassette for the mock's model. */
function oneCassette(): string {
  const root = emptyCassettes();
  CassetteStore.forModel(MOCK_MODEL, root).put(
    cassetteOf(
      {
        request: {
          model: MOCK_MODEL,
          state: { machine: "CAU-7" },
          questions: { q: { type: "noul" } },
        },
        response: {
          model: MOCK_MODEL,
          answers: { q: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      {
        model: MOCK_MODEL,
        recordedAt: new Date("2026-09-23T10:00:00.000Z"),
        backendVersion: "1.0.0",
      },
    ),
  );
  return root;
}

function capture(): { log: Logger; text(): string } {
  const lines: string[] = [];
  return {
    log: createLogger({ env: {}, stream: { write: (chunk) => lines.push(chunk) } }),
    text: () => lines.join(""),
  };
}

function config(
  env: Readonly<Record<string, string>> = {},
  argv: readonly string[] = [],
): EvalConfig {
  return loadConfig(argv, env, { cwd: "/tmp" });
}

/** A planner that answers a fixed plan and remembers what it was asked. */
function stubPlanner(): { plan: LivePlanner; asked: LiveBackendName[][] } {
  const asked: LiveBackendName[][] = [];
  return {
    asked,
    plan: (cfg, live) => {
      asked.push([...live]);
      const plan: LivePlan = {
        scenarios: 1,
        rows: live.map((backend) => ({
          backend,
          model: backend === "jev" ? cfg.jevModel : cfg.llmModel,
          calls: 12,
          inputTokens: 18_000,
          outputTokens: backend === "llm" ? 3600 : 0,
          usd: backend === "jev" ? 0.000756 : 0.18,
          pricesAsOf: cfg.prices.asOf,
        })),
      };
      return Promise.resolve(plan);
    },
  };
}

/** True when something still answers HTTP at `url`. */
async function answers(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/healthz`);
    return true;
  } catch {
    return false;
  }
}

describe("resolveJevMode", () => {
  const none = { hasKey: false, cassettes: 0 };

  it("takes an explicit mode as asked", () => {
    for (const mode of ["live", "cassette", "mock"] as const) {
      expect(resolveJevMode(mode, none, MOCK_MODEL)).toEqual({
        mode,
        reason: `EVAL_JEV_MODE=${mode}`,
        passedOver: [],
      });
    }
  });

  it("walks the auto order: live with a key, cassette with recordings, mock otherwise", () => {
    expect([...AVAILABLE_JEV_MODES].sort()).toEqual(["cassette", "live", "mock"]);
    expect(resolveJevMode("auto", { hasKey: true, cassettes: 3 }, MOCK_MODEL)).toEqual({
      mode: "live",
      reason: "EVAL_JEV_MODE=auto: TYPESAFE_API_KEY is set",
      passedOver: [],
    });
    expect(resolveJevMode("auto", { hasKey: false, cassettes: 3 }, MOCK_MODEL)).toEqual({
      mode: "cassette",
      reason: `EVAL_JEV_MODE=auto: 3 cassette(s) exist for ${MOCK_MODEL}`,
      passedOver: [],
    });
    expect(resolveJevMode("auto", none, MOCK_MODEL)).toEqual({
      mode: "mock",
      reason: "EVAL_JEV_MODE=auto: no key and no cassettes",
      passedOver: [],
    });
  });

  it("says what it passed over when a mode is not in the available set", () => {
    const choice = resolveJevMode(
      "auto",
      { hasKey: true, cassettes: 2 },
      MOCK_MODEL,
      new Set(["mock"] as const),
    );
    expect(choice.mode).toBe("mock");
    expect(choice.passedOver).toEqual(["live", "cassette"]);
    expect(choice.reason).toContain("TYPESAFE_API_KEY is set");
    expect(choice.reason).toContain(`2 cassette(s) exist for ${MOCK_MODEL}`);
  });
});

describe("cassetteCount", () => {
  it("counts the JSON files of the model's directory only", () => {
    const root = emptyCassettes();
    mkdirSync(join(root, MOCK_MODEL));
    writeFileSync(join(root, MOCK_MODEL, "a.json"), "{}");
    writeFileSync(join(root, MOCK_MODEL, "b.json"), "{}");
    writeFileSync(join(root, MOCK_MODEL, "notes.txt"), "");
    mkdirSync(join(root, "jev-9.9.9"));
    writeFileSync(join(root, "jev-9.9.9", "c.json"), "{}");

    expect(cassetteCount(MOCK_MODEL, root)).toBe(2);
    expect(cassetteCount("jev-1.0.0", root)).toBe(0);
  });
});

describe("counted", () => {
  const input = {} as DecisionInput;

  it("counts calls and the calls that threw, and rethrows untouched", async () => {
    const failure = new DecisionError("timeout", "no answer");
    const backend: DecisionBackend = {
      name: "jev",
      model: MOCK_MODEL,
      decide: () => Promise.reject(failure),
    };
    const stats = newStats();
    const wrapped = counted(backend, stats);

    expect(wrapped.name).toBe("jev");
    expect(wrapped.model).toBe(MOCK_MODEL);
    await expect(wrapped.decide(input)).rejects.toBe(failure);
    await expect(wrapped.decide(input)).rejects.toBe(failure);
    expect(stats).toEqual({ calls: 2, failures: 2, cassetteMisses: 0 });
  });
});

describe("handles", () => {
  const wall = createFakeWallClock();

  it("builds the rules baseline in process", async () => {
    const handle = createRulesHandle({ wall });
    expect(handle.name).toBe("rules");
    expect(handle.mode).toBe("-");
    expect(handle.model).toBe("rules-v1");
    expect(handle.backend.name).toBe("rules");
    expect(handle.stats).toEqual({ calls: 0, failures: 0, cassetteMisses: 0 });
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it("starts a mock server that accepts only the harness bearer", async () => {
    const handle = await createMockJevHandle({ jevModel: MOCK_MODEL }, { wall });
    try {
      expect(handle.name).toBe("jev");
      expect(handle.mode).toBe("mock");
      expect(handle.model).toBe(MOCK_MODEL);
      expect(handle.server.answerPolicy).toBe(DEFAULT_MOCK_POLICY);
      expect(DEFAULT_MOCK_POLICY).toBe("best-overlap");

      const refused = await fetch(`${handle.server.url}/v1/models`, {
        headers: { authorization: "Bearer not-the-harness" },
      });
      expect(refused.status).toBe(401);
      const accepted = await fetch(`${handle.server.url}/v1/models`, {
        headers: { authorization: `Bearer ${MOCK_API_KEY}` },
      });
      expect(accepted.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("stops the mock server on close, and a second close is harmless", async () => {
    const handle = await createMockJevHandle({ jevModel: MOCK_MODEL }, { wall });
    expect(await answers(handle.server.url)).toBe(true);
    await handle.close();
    await handle.close();
    expect(await answers(handle.server.url)).toBe(false);
  });

  it("takes confident-first when a caller asks for it", async () => {
    const handle = await createMockJevHandle(
      { jevModel: MOCK_MODEL },
      { wall },
      { answerPolicy: "confident-first" },
    );
    try {
      expect(handle.server.answerPolicy).toBe("confident-first");
    } finally {
      await handle.close();
    }
  });

  it("refuses a model the mock does not answer", async () => {
    const error = await createMockJevHandle({ jevModel: "jev-1.14.0" }, { wall }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).flag).toBe("JEV_MODEL");
  });

  it("builds each mode, and names what a mode is missing", async () => {
    const live = await createJevHandle(config({ TYPESAFE_API_KEY: FAKE_KEY }), "live", { wall });
    expect(live.mode).toBe("live");
    await live.close();

    const cassette = await createJevHandle(config(), "cassette", {
      wall,
      cassettesDir: oneCassette(),
    });
    expect(cassette.mode).toBe("cassette");
    await cassette.close();

    const noKey = await createJevHandle(config(), "live", { wall }).catch(
      (caught: unknown) => caught,
    );
    expect((noKey as ConfigError).flag).toBe("TYPESAFE_API_KEY");
    const noCassettes = await createJevHandle(config(), "cassette", {
      wall,
      cassettesDir: emptyCassettes(),
    }).catch((caught: unknown) => caught);
    expect((noCassettes as ConfigError).flag).toBe("EVAL_JEV_MODE");
  });

  it("labels the signals with the register map's names", () => {
    expect(Object.keys(SIGNAL_LABELS).length).toBeGreaterThan(10);
    for (const label of Object.values(SIGNAL_LABELS)) expect(label).not.toBe("");
  });
});

describe("selectBackends", () => {
  const wall = createFakeWallClock();

  it("resolves rules and mock Jev without keys or cassettes, logs both modes and plans nothing", async () => {
    const { log, text } = capture();
    const planner = stubPlanner();
    const handles = await selectBackends(config(), {
      wall,
      log,
      cassettesDir: emptyCassettes(),
      plan: planner.plan,
    });
    try {
      expect(handles.map(({ name, mode, model }) => ({ name, mode, model }))).toEqual([
        { name: "rules", mode: "-", model: "rules-v1" },
        { name: "jev", mode: "mock", model: MOCK_MODEL },
      ]);
      const written = text();
      expect(written).toContain('backend="rules" mode="-" model="rules-v1"');
      expect(written).toContain(`backend="jev" mode="mock" model="${MOCK_MODEL}"`);
      expect(written).toContain("EVAL_JEV_MODE=auto: no key and no cassettes");
      expect(planner.asked).toEqual([]);
    } finally {
      await closeBackends(handles);
    }
  });

  it("keeps the order --backends gives", async () => {
    const handles = await selectBackends(config({}, ["--backends", "jev,rules"]), {
      wall,
      log: capture().log,
      cassettesDir: emptyCassettes(),
    });
    try {
      expect(handles.map((handle) => handle.name)).toEqual(["jev", "rules"]);
    } finally {
      await closeBackends(handles);
    }
  });

  it("replays from cassettes under auto when recordings exist and no key is set", async () => {
    const { log, text } = capture();
    const handles = await selectBackends(config(), { wall, log, cassettesDir: oneCassette() });
    try {
      expect(handles.find((handle) => handle.name === "jev")?.mode).toBe("cassette");
      expect(text()).toContain(`EVAL_JEV_MODE=auto: 1 cassette(s) exist for ${MOCK_MODEL}`);
    } finally {
      await closeBackends(handles);
    }
  });

  it("serves the resample it is asked for from cassettes, and says so in the stats", async () => {
    const handles = await selectBackends(config({}, ["--resample", "2"]), {
      wall,
      log: capture().log,
      cassettesDir: oneCassette(),
    });
    try {
      const jev = handles.find((handle) => handle.name === "jev");
      expect(jev?.mode).toBe("cassette");
      expect(jev?.stats.cassetteResample).toBe(2);
    } finally {
      await closeBackends(handles);
    }
  });

  it("refuses --resample when Jev does not replay cassettes, before building or planning anything", async () => {
    const planner = stubPlanner();
    for (const [env, argv, where] of [
      [{}, ["--resample", "1"], "Jev runs in mock mode"],
      [{ EVAL_JEV_MODE: "mock" }, ["--resample", "1"], "Jev runs in mock mode"],
      [
        { EVAL_JEV_MODE: "live", TYPESAFE_API_KEY: FAKE_KEY },
        ["--resample", "1"],
        "Jev runs in live mode",
      ],
      [{}, ["--resample", "1", "--backends", "rules"], "the run does not name jev"],
    ] as const) {
      const error = await selectBackends(config(env, argv), {
        wall,
        log: capture().log,
        cassettesDir: emptyCassettes(),
        plan: planner.plan,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).flag).toBe("--resample");
      expect((error as Error).message).toContain(where);
    }
    expect(planner.asked).toEqual([]);
  });

  it("plans a live run under auto with a key and refuses it without --confirm-live", async () => {
    const { log, text } = capture();
    const planner = stubPlanner();
    const error = await selectBackends(config({ TYPESAFE_API_KEY: FAKE_KEY }), {
      wall,
      log,
      cassettesDir: emptyCassettes(),
      plan: planner.plan,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).flag).toBe("--confirm-live");
    const message = (error as Error).message;
    expect(message).toContain(`jev (${MOCK_MODEL}): 12 planned call(s)`);
    expect(message).toContain("USD 0.000756");
    expect(message).toContain("nothing was called");
    expect(planner.asked).toEqual([["jev"]]);

    const written = text();
    expect(written).toContain("warn live plan");
    expect(written).toContain("calls=12");
    expect(written).not.toContain("decision backend");
    expect(written).not.toContain(FAKE_KEY);
    expect(message).not.toContain(FAKE_KEY);
  });

  it("refuses an explicit live mode without --confirm-live, before building anything", async () => {
    const error = await selectBackends(
      config({ EVAL_JEV_MODE: "live", TYPESAFE_API_KEY: FAKE_KEY }, ["--backends", "rules,jev"]),
      { wall, log: capture().log, plan: stubPlanner().plan },
    ).catch((caught: unknown) => caught);
    expect((error as ConfigError).flag).toBe("--confirm-live");
  });

  it("builds a live Jev handle with --confirm-live and logs the plan first", async () => {
    const api = await startMockTypeSafe({ port: 0, apiKey: FAKE_KEY });
    const { log, text } = capture();
    try {
      const handles = await selectBackends(
        config({ TYPESAFE_API_KEY: FAKE_KEY, TYPESAFE_BASE_URL: api.url }, ["--confirm-live"]),
        { wall, log, cassettesDir: emptyCassettes(), plan: stubPlanner().plan },
      );
      expect(handles.map((handle) => `${handle.name}:${handle.mode}`)).toEqual([
        "rules:-",
        "jev:live",
      ]);
      const written = text();
      expect(written.indexOf("live plan")).toBeLessThan(
        written.indexOf('backend="jev" mode="live"'),
      );
      expect(written).toContain("confirmed=true");
      expect(written).not.toContain(FAKE_KEY);
      expect(api.requests).toEqual([]);
      await closeBackends(handles);
    } finally {
      await api.close();
    }
  });

  it("drops the llm backend without its key, and warns", async () => {
    const { log, text } = capture();
    const handles = await selectBackends(
      config({ EVAL_JEV_MODE: "mock" }, ["--backends", "rules,llm"]),
      { wall, log, plan: stubPlanner().plan },
    );
    try {
      expect(handles.map((handle) => handle.name)).toEqual(["rules"]);
      expect(text()).toContain("warn llm backend dropped");
      expect(text()).toContain("LLM_API_KEY is not set");
    } finally {
      await closeBackends(handles);
    }
  });

  it("refuses a run whose every backend was dropped", async () => {
    const error = await selectBackends(config({}, ["--backends", "llm"]), {
      wall,
      log: capture().log,
    }).catch((caught: unknown) => caught);
    expect((error as ConfigError).flag).toBe("--backends");
  });

  it("plans the keyed llm backend as live and refuses it without --confirm-live", async () => {
    const { log, text } = capture();
    const planner = stubPlanner();
    const error = await selectBackends(
      config({ EVAL_JEV_MODE: "mock", LLM_API_KEY: FAKE_LLM_KEY }, ["--backends", "rules,jev,llm"]),
      { wall, log, plan: planner.plan },
    ).catch((caught: unknown) => caught);
    expect((error as ConfigError).flag).toBe("--confirm-live");
    expect((error as Error).message).toContain("llm (claude-opus-5): 12 planned call(s)");
    expect(planner.asked).toEqual([["llm"]]);
    expect(text()).not.toContain(FAKE_LLM_KEY);
  });

  it("builds the keyed llm backend live with --confirm-live", async () => {
    const handles = await selectBackends(
      config({ EVAL_JEV_MODE: "mock", LLM_API_KEY: FAKE_LLM_KEY }, [
        "--backends",
        "llm",
        "--confirm-live",
      ]),
      { wall, log: capture().log, plan: stubPlanner().plan },
    );
    try {
      expect(handles.map(({ name, mode, model }) => ({ name, mode, model }))).toEqual([
        { name: "llm", mode: "live", model: "claude-opus-5" },
      ]);
    } finally {
      await closeBackends(handles);
    }
  });
});
