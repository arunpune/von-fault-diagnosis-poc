// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The scenario loop, the core-10 gate and the E3 check of `--exit-eval e3`.
//
// The loop is driven over the committed scenarios with its seams stubbed: the
// backends answer nothing, the host returns an empty event log, and the rows
// are never read, so these tests need neither the dataset nor a network port.
// The real host, the real backends and the real rows are the smoke E2E's
// (`test/e2e/smoke.test.ts`); this file pins the loop's own decisions — what
// it selects, what it writes, which backend's gate it reads and how it reads
// a gate that is only partly measured.
//
// The E3 check is proved on hand-made runs: the committed scenarios, bound
// against the committed ground truth and scored by the real metrics, with
// tickets written by hand. No core-10 scenario is replayed for it, so the test
// split's outcomes never become a tuning signal.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionBackend } from "@fdp/backend/pipeline";
import { afterAll, describe, expect, it } from "vitest";

import type { BackendHandle, BackendMode } from "../backends/types.ts";
import type { BackendName, EvalCatalog, EvalConfig } from "../config.ts";
import { ConfigError, loadConfig } from "../config.ts";
import { EXIT_GATE_FAILED, EXIT_OK } from "../cli.ts";
import { TEST_PRICES, suspect, ticket } from "../metrics/fixtures.ts";
import {
  CORE_10_POSITIVE_SCENARIO_IDS,
  CORE_10_SCENARIO_IDS,
  MS_PER_MINUTE,
  coreGate,
  scoreScenario,
} from "../metrics/index.ts";
import type { ScenarioMetrics, SuspectRecord, TicketRecord } from "../metrics/index.ts";
import { defaultAlarmRegistry } from "../replay/index.ts";
import { validateReport } from "../report/json.ts";
import type { RunReport } from "../report/types.ts";
import { bindScenario, loadAll } from "../scenario/index.ts";
import type { BoundScenario, Profile } from "../scenario/index.ts";
import { TUNING_SCENARIOS } from "../tuning.ts";
import { createFakeWallClock } from "./host.ts";
import type { ScenarioRun, TimedOutput } from "./host.ts";
import {
  E3_DEPOT_SCENARIO,
  SCENARIO_LOG_DIR,
  allocateRunDir,
  backendRecord,
  defaultNativeAlarmCodes,
  designTargets,
  e3AbstainCases,
  e3Negatives,
  evaluateE3,
  executeRun,
  exitCodeFor,
  headlineBackend,
  headlineFailureIds,
  judgeGate,
  judgeRunGate,
  notScoredGate,
  replayCoverage,
  runEvaluation,
  runExitCode,
  selectScenarios,
  toBinding,
} from "./run.ts";
import type { E3Context, RunDeps, RunResult, ScenarioResult } from "./run.ts";

const SMOKE_IDS = [
  "baseline_feb03_normal",
  "depot_lps_jul31",
  "f3_air_leak_jun05",
  "inject_oil_cooler_fouling",
  "inject_oil_temperature_sensor_fault",
];

const STARTED = new Date("2026-09-22T12:00:00.000Z");
const FINISHED = new Date("2026-09-22T12:01:30.000Z");

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-eval-run-"));
  directories.push(directory);
  return directory;
}

function config(argv: readonly string[], out: string = temporaryDirectory()): EvalConfig {
  return loadConfig([...argv, "--out", out], { EVAL_JEV_MODE: "mock" });
}

/** A backend that must never be asked: the host is stubbed, so nothing calls `decide`. */
const SILENT: DecisionBackend = {
  name: "rules",
  model: "rules-v1",
  decide: () => Promise.reject(new Error("the stubbed host never decides")),
};

interface StubHandle extends BackendHandle {
  closed: number;
}

function stubHandle(name: BackendName, mode: BackendMode): StubHandle {
  const handle: StubHandle = {
    name,
    model: name === "rules" ? "rules-v1" : "jev-1.13.0",
    mode,
    backend: SILENT,
    stats: { calls: 0, failures: 0, cassetteMisses: 0 },
    closed: 0,
    close: () => {
      handle.closed += 1;
      return Promise.resolve();
    },
  };
  return handle;
}

const CATALOG: EvalCatalog = {
  source: "reference",
  name: "reference",
  sha256: "0".repeat(64),
  entries: [],
  conditions: [],
};

/** An empty replay: no output, and the stats of a run that pushed nothing. */
function emptyRun(bound: BoundScenario, handle: BackendHandle): ScenarioRun {
  return {
    scenarioId: bound.scenario.id,
    backend: handle.name,
    model: handle.model,
    mode: handle.mode,
    seed: bound.scenario.seed,
    events: [],
    alarms: [],
    firstAlarms: [],
    alarmTransitions: [],
    stats: {
      samples: 0,
      batches: 0,
      discontinuities: 0,
      wallMs: 0,
      samplesPerS: null,
      decisions: 0,
      failures: 0,
    },
  };
}

interface Harness {
  readonly deps: RunDeps;
  readonly handles: StubHandle[];
  readonly calls: string[];
  selected: number;
}

function harness(modes: Partial<Record<BackendName, BackendMode>> = {}): Harness {
  const handles = [stubHandle("rules", "-"), stubHandle("jev", modes.jev ?? "mock")];
  const state: Harness = {
    handles,
    calls: [],
    selected: 0,
    deps: {
      log: { level: "warn", debug: () => undefined, info: () => undefined, warn: () => undefined },
      now: (() => {
        const stamps = [STARTED, FINISHED];
        return () => stamps.shift() ?? FINISHED;
      })(),
      wall: createFakeWallClock(),
      loadCatalog: () => Promise.resolve(CATALOG),
      selectBackends: () => {
        state.selected += 1;
        return Promise.resolve(handles);
      },
      runScenario: (bound, handle) => {
        state.calls.push(`${bound.scenario.id}.${handle.name}`);
        return Promise.resolve(emptyRun(bound, handle));
      },
      requireRows: () => undefined,
    },
  };
  return state;
}

/** A scored scenario reduced to what `coreGate` reads: its id and its three pass flags. */
function passed(id: string, pass: boolean): ScenarioMetrics {
  return {
    scenarioId: id,
    pass: { detection: pass, reviewDiagnosis: pass, diagnosis: pass, reasons: [] },
  } as unknown as ScenarioMetrics;
}

describe("selectScenarios", () => {
  const all = loadAll();

  it("takes the profile's scenarios in id order", () => {
    expect(selectScenarios(all, "smoke", []).map((scenario) => scenario.id)).toEqual(SMOKE_IDS);
    expect(
      selectScenarios(all, "core", [])
        .map((scenario) => scenario.id)
        .sort(),
    ).toEqual([...CORE_10_SCENARIO_IDS].sort());
  });

  it("narrows the profile to the --scenario list", () => {
    const picked = selectScenarios(all, "smoke", ["f3_air_leak_jun05", "depot_lps_jul31"]);
    expect(picked.map((scenario) => scenario.id)).toEqual(["depot_lps_jul31", "f3_air_leak_jun05"]);
  });

  it("refuses an id that names no scenario, naming the flag", () => {
    expect(() => selectScenarios(all, "smoke", ["no_such_scenario"])).toThrow(ConfigError);
    try {
      selectScenarios(all, "smoke", ["no_such_scenario"]);
    } catch (error) {
      expect((error as ConfigError).flag).toBe("--scenario");
      expect((error as ConfigError).exitCode).toBe(1);
    }
  });

  it("refuses a scenario the profile does not replay", () => {
    expect(() => selectScenarios(all, "smoke", ["f1_air_leak_apr18"])).toThrow(
      /not in the smoke profile/,
    );
  });
});

describe("toBinding", () => {
  const scenario = loadAll().find((entry) => entry.id === "f3_air_leak_jun05");
  if (scenario === undefined) throw new Error("the F3 scenario is committed");
  const bound = bindScenario(scenario, { profile: "smoke" });
  const binding = toBinding(bound);

  it("carries the scenario's identity, range, warmup and expectation", () => {
    expect(binding).toMatchObject({
      id: "f3_air_leak_jun05",
      group: "recording_positive",
      split: "test",
      positive: true,
      warmupMin: scenario.warmup_min,
      expect: {
        tickets: "at_least_one",
        fault: "accepted",
        withinMin: 120,
        maxFalseTickets: 0,
        passLevel: "diagnosis",
      },
    });
    expect(binding.replay).toEqual(bound.replay);
    expect(binding.windows).toBe(bound.windows);
    expect(binding.benignFaultIds).toBe(bound.benignFaultIds);
  });

  it("names every excluded window after its reason and start", () => {
    const ids = binding.excluded.map((window) => window.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [index, window] of binding.excluded.entries()) {
      const source = bound.excluded[index];
      expect(window.id).toBe(`${source?.reason}@${source?.from.toISOString()}`);
    }
  });
});

describe("defaultNativeAlarmCodes", () => {
  it("takes the evaluable warnings and shutdowns of the registry, W116 aside", () => {
    const registry = defaultAlarmRegistry();
    if (registry === undefined) throw new Error("the checkout carries an alarm registry");
    const codes = defaultNativeAlarmCodes(registry);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes).not.toContain("W116");
    for (const code of codes) {
      const alarm = registry.alarms.find((entry) => entry.code === code);
      expect(["warning", "shutdown_warning", "shutdown"]).toContain(alarm?.type);
    }
  });

  it("is empty when no registry is evaluated, which the lead-time metric reads as any code", () => {
    expect(defaultNativeAlarmCodes(undefined)).toEqual([]);
  });
});

describe("headlineBackend", () => {
  it("is Jev only when Jev's answers are informative", () => {
    const rules = { name: "rules" as const, mode: "-" as const };
    expect(headlineBackend([rules, { name: "jev", mode: "live" }])).toBe("jev");
    expect(headlineBackend([rules, { name: "jev", mode: "cassette" }])).toBe("jev");
    expect(headlineBackend([rules, { name: "jev", mode: "mock" }])).toBe("rules");
    expect(headlineBackend([rules])).toBe("rules");
    expect(headlineBackend([{ name: "jev", mode: "mock" }])).toBe("jev");
    expect(headlineBackend([])).toBeUndefined();
  });
});

describe("judgeGate", () => {
  const all = (failing: readonly string[]) =>
    CORE_10_SCENARIO_IDS.map((id) => passed(id, !failing.includes(id)));

  it("passes a complete run at 8 of 10 with 5 of the 6 positives", () => {
    const [positive] = CORE_10_POSITIVE_SCENARIO_IDS;
    const negative = CORE_10_SCENARIO_IDS.find((id) => !CORE_10_POSITIVE_SCENARIO_IDS.includes(id));
    const gate = judgeGate(coreGate(all([positive ?? "", negative ?? ""]), "rules", "detection"));
    expect(gate).toMatchObject({ complete: true, verdict: "pass", pass: true, scored: 10 });
    expect(gate.counts).toMatchObject({ passed: 8, positivesPassed: 5 });
  });

  it("fails a complete run that reaches 8 of 10 without 5 of the 6 positives", () => {
    const failing = CORE_10_POSITIVE_SCENARIO_IDS.slice(0, 2);
    const gate = judgeGate(coreGate(all(failing), "rules", "detection"));
    expect(gate).toMatchObject({ complete: true, verdict: "fail", pass: false });
    expect(gate.counts).toMatchObject({ passed: 8, positivesPassed: 4 });
    expect(gate.scoredFailed).toEqual(failing);
  });

  it("keeps a partial run attainable while its failures leave room for the thresholds", () => {
    const scored = [passed("f3_air_leak_jun05", false), passed("baseline_feb03_normal", true)];
    const gate = judgeGate(coreGate(scored, "rules", "detection"));
    expect(gate).toMatchObject({
      complete: false,
      verdict: "attainable",
      pass: true,
      scored: 2,
      positivesScored: 1,
      scoredFailed: ["f3_air_leak_jun05"],
    });
    expect(gate.counts.missing).toHaveLength(8);
  });

  it("rules a partial run out once two of its positives failed", () => {
    const scored = [
      passed("f3_air_leak_jun05", false),
      passed("inject_oil_cooler_fouling", false),
      passed("baseline_feb03_normal", true),
    ];
    const gate = judgeGate(coreGate(scored, "rules", "detection"));
    expect(gate).toMatchObject({ complete: false, verdict: "unattainable", pass: false });
  });

  it("rules a partial run out once three of its scenarios failed", () => {
    const scored = ["baseline_feb03_normal", "depot_lps_jul31", "inject_high_ambient_benign"].map(
      (id) => passed(id, false),
    );
    expect(judgeGate(coreGate(scored, "rules", "detection")).verdict).toBe("unattainable");
  });
});

describe("judgeRunGate and backendRecord, when decisions failed", () => {
  const all = CORE_10_SCENARIO_IDS.map((id) => passed(id, id === "baseline_feb03_normal"));
  const counts = coreGate(all, "jev", "diagnosis");
  const record = (calls: number, failures: number) => ({
    name: "jev" as const,
    stats: { calls, failures, cassetteMisses: 0 },
  });

  it("does not score the gate of a headline backend whose every decision failed", () => {
    const gate = judgeRunGate(counts, [record(151, 151)]);
    expect(gate).toMatchObject({
      verdict: "not_scored",
      pass: false,
      complete: false,
      scored: 0,
      positivesScored: 0,
      scoredFailed: [],
    });
    expect(gate.counts).toMatchObject({ passed: 0, positivesPassed: 0, failed: [], pass: false });
    expect(gate.counts.missing).toEqual([...CORE_10_SCENARIO_IDS]);
    expect(gate).toEqual(notScoredGate(counts));
    expect(exitCodeFor({ gate }, true)).toBe(EXIT_GATE_FAILED);
  });

  it("judges the gate as usual when only some decisions failed, or none was asked", () => {
    expect(judgeRunGate(counts, [record(151, 150)])).toEqual(judgeGate(counts));
    expect(judgeRunGate(counts, [record(0, 0)])).toEqual(judgeGate(counts));
    expect(judgeRunGate(counts, [])).toEqual(judgeGate(counts));
  });

  it("marks a backend whose every decision failed not informative, as it does a mock", () => {
    const handle = (mode: BackendMode, calls: number, failures: number): BackendHandle => ({
      ...stubHandle("jev", mode),
      stats: { calls, failures, cassetteMisses: 0 },
    });
    expect(backendRecord(handle("cassette", 151, 151)).informative).toBe(false);
    expect(backendRecord(handle("live", 151, 3)).informative).toBe(true);
    expect(backendRecord(handle("cassette", 0, 0)).informative).toBe(true);
    expect(backendRecord(handle("mock", 5, 0)).informative).toBe(false);
  });
});

describe("exitCodeFor", () => {
  const verdict = (pass: boolean) => ({ gate: { pass } as RunResult["gate"] });

  it("is 0 without --fail-on-gate, whatever the gate says", () => {
    expect(exitCodeFor(verdict(false), false)).toBe(EXIT_OK);
    expect(exitCodeFor({ gate: null }, false)).toBe(EXIT_OK);
  });

  it("is 2 under --fail-on-gate when the gate does not hold or was not measured", () => {
    expect(exitCodeFor(verdict(true), true)).toBe(EXIT_OK);
    expect(exitCodeFor(verdict(false), true)).toBe(EXIT_GATE_FAILED);
    expect(exitCodeFor({ gate: null }, true)).toBe(EXIT_GATE_FAILED);
  });
});

describe("allocateRunDir", () => {
  it("suffixes the id when a run of the same second already owns the directory", () => {
    const out = join(temporaryDirectory(), "nested", "reports");
    const first = allocateRunDir(out, "20260922-120000-smoke");
    const second = allocateRunDir(out, "20260922-120000-smoke");
    expect(first.id).toBe("20260922-120000-smoke");
    expect(second.id).toBe("20260922-120000-smoke-2");
    expect(existsSync(second.dir)).toBe(true);
  });
});

describe("runEvaluation over the smoke profile", () => {
  const stubs = harness();
  const out = temporaryDirectory();
  const result = runEvaluation(config(["--profile", "smoke"], out), stubs.deps);

  it("replays every scenario against every backend, scenario by scenario", async () => {
    const run = await result;
    expect(stubs.calls).toEqual(SMOKE_IDS.flatMap((id) => [`${id}.rules`, `${id}.jev`]));
    expect(run.results).toHaveLength(10);
    expect(run.results.every((entry) => entry.scored)).toBe(true);
  });

  it("names the run after its start and profile and writes one event log per pair", async () => {
    const run = await result;
    expect(run.runId).toBe("20260922-120000-smoke");
    expect(run.runDir).toBe(join(out, run.runId));
    expect(run.startedAt).toEqual(STARTED);
    expect(run.finishedAt).toEqual(FINISHED);
    for (const entry of run.results) {
      const name = `${entry.bound.scenario.id}.${entry.run.backend}.jsonl`;
      expect(entry.eventLog).toBe(`${SCENARIO_LOG_DIR}/${name}`);
      expect(readFileSync(join(run.runDir, entry.eventLog), "utf8")).toBe("");
    }
  });

  it("records the backends as they ended, a mock column as not informative", async () => {
    const run = await result;
    expect(
      run.backends.map(({ name, mode, informative }) => ({ name, mode, informative })),
    ).toEqual([
      { name: "rules", mode: "-", informative: true },
      { name: "jev", mode: "mock", informative: false },
    ]);
    expect(stubs.handles.map((handle) => handle.closed)).toEqual([1, 1]);
  });

  it("reads the gate of the rules baseline at detection level while Jev is a mock", async () => {
    const run = await result;
    expect(run.summary?.gate).toMatchObject({ backend: "rules", level: "detection" });
    expect(run.summary?.backends.map((backend) => backend.backend)).toEqual(["jev", "rules"]);
  });

  it("judges the smoke subset as a partial run of the core-10", async () => {
    const run = await result;
    // Nothing was decided, so the two positives failed and the three quiet cases passed.
    expect(run.gate).toMatchObject({
      complete: false,
      verdict: "unattainable",
      pass: false,
      scored: 5,
      positivesScored: 2,
      scoredFailed: ["f3_air_leak_jun05", "inject_oil_cooler_fouling"],
    });
    expect(exitCodeFor(run, true)).toBe(EXIT_GATE_FAILED);
    expect(exitCodeFor(run, false)).toBe(EXIT_OK);
  });
});

describe("executeRun", () => {
  const provenance = () => ({
    git_sha: null,
    node: process.version,
    backend_version: "1.0.0",
    ground_truth: {
      package_version: "1.0.0",
      failures_sha256: "c".repeat(64),
      injections_sha256: null,
    },
  });

  async function execute(argv: readonly string[]) {
    const out = temporaryDirectory();
    const printed: string[] = [];
    const code = await executeRun(config(argv, out), {
      ...harness().deps,
      provenance,
      stdout: { write: (chunk: string) => printed.push(chunk) },
    });
    return { out, code, printed: printed.join("") };
  }

  it("writes run.json, its latest.json copy and report.md, and prints the summary", async () => {
    const { out, code, printed } = await execute(["--profile", "smoke"]);
    expect(code).toBe(EXIT_OK);
    const runDir = join(out, "20260922-120000-smoke");
    const runJson = readFileSync(join(runDir, "run.json"), "utf8");
    expect(readFileSync(join(out, "latest.json"), "utf8")).toBe(runJson);
    expect(JSON.parse(runJson)).toMatchObject({
      schema: "urn:fdp:eval:report:v1",
      run: { id: "20260922-120000-smoke", profile: "smoke" },
      gate: { backend: "rules", verdict: "unattainable", enforced: false },
    });
    expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain("## Comparison");
    expect(printed).toContain("gate: UNATTAINABLE");
    expect(printed).toContain(`report.md: ${join(runDir, "report.md")}`);
  });

  it("exits 2 under --fail-on-gate when the gate is out of reach", async () => {
    const { code } = await execute(["--profile", "smoke", "--fail-on-gate"]);
    expect(code).toBe(EXIT_GATE_FAILED);
  });

  /** A failed Jev decision, as the pipeline records a 500 from the API. */
  function failedDecision(bound: BoundScenario): TimedOutput {
    return {
      type: "decision",
      decision: {
        decision_id: `00000000-0000-4000-8000-${String(bound.scenario.seed).padStart(12, "0")}`,
        episode_id: "00000000-0000-4000-8000-000000000001",
        sim_ts: bound.replay.from.toISOString(),
        backend: "jev",
        status: "failed",
        choice: "none_of_these",
        confidence: 0,
        gate: { outcome: "log", abstained: false },
        usage: { input_tokens: 0, output_tokens: 0 },
        state_digest: "0".repeat(64),
        error: { kind: "unknown", status: 500, message: "the TypeSafe API answered 500" },
      },
      output: null,
      gate: null,
      batchSimTs: bound.replay.from.toISOString(),
    } as unknown as TimedOutput;
  }

  /**
   * A smoke run whose Jev backend ran in `mode` and failed `failed` of its decisions: one decision
   * per scenario, the first `failed` scenarios' ones failing with a 500.
   */
  async function executeWithFailures(mode: BackendMode, failed: number, argv: readonly string[]) {
    const out = temporaryDirectory();
    const printed: string[] = [];
    const warnings: string[] = [];
    const stubs = harness({ jev: mode });
    const jev = stubs.handles[1] as StubHandle;
    Object.assign(jev, { stats: { calls: SMOKE_IDS.length, failures: failed, cassetteMisses: 0 } });
    let seen = 0;
    const code = await executeRun(config(["--profile", "smoke", ...argv], out), {
      ...stubs.deps,
      log: { ...stubs.deps.log!, warn: (message: string) => warnings.push(message) },
      runScenario: (bound, handle) => {
        const run = emptyRun(bound, handle);
        if (handle.name !== "jev" || seen >= failed) return Promise.resolve(run);
        seen += 1;
        return Promise.resolve({
          ...run,
          events: [failedDecision(bound)],
          stats: { ...run.stats, decisions: 1, failures: 1 },
        });
      },
      provenance: () => ({
        git_sha: null,
        node: process.version,
        backend_version: "1.0.0",
        ground_truth: {
          package_version: "1.0.0",
          failures_sha256: "c".repeat(64),
          injections_sha256: null,
        },
      }),
      stdout: { write: (chunk: string) => printed.push(chunk) },
    });
    const runDir = join(out, "20260922-120000-smoke");
    return {
      code,
      printed: printed.join(""),
      warnings,
      report: validateReport(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"))),
      markdown: readFileSync(join(runDir, "report.md"), "utf8"),
    };
  }

  it("does not score, and says loudly, a Jev run whose every decision failed", async () => {
    const { code, printed, warnings, report, markdown } = await executeWithFailures(
      "cassette",
      SMOKE_IDS.length,
      ["--fail-on-gate"],
    );
    expect(code).toBe(EXIT_GATE_FAILED);
    expect(report.backends[1]).toMatchObject({
      name: "jev",
      mode: "cassette",
      informative: false,
      calls: 5,
      failures: 5,
      failure_reasons: [{ reason: "unknown: the TypeSafe API answered 500", count: 5 }],
    });
    expect(report.gate).toMatchObject({
      backend: "jev",
      verdict: "not_scored",
      pass: false,
      passed: 0,
      scored: 0,
      failed: [],
      core10: { jev_diagnosis: null },
    });
    expect(report.gate?.missing).toHaveLength(10);

    const warning =
      "jev (cassette): every one of its 5 decision(s) failed — unknown: the TypeSafe API answered 500 ×5. Its column is not informative and its core-10 gate is not scored.";
    expect(printed).toContain(
      `WARNING: ${warning}\ngate: NOT SCORED: every decision of jev failed`,
    );
    expect(printed).toMatch(
      /^scenario +split +rules +jev \(cassette — not informative, every decision failed\)$/m,
    );
    expect(printed).toContain(
      "MetroPT-3 check (in-sample): not measured, every decision of jev failed",
    );
    expect(printed).not.toContain("gate: FAIL");

    expect(markdown).toContain(`## Headline\n\n**Failed decisions — ${warning}**`);
    expect(markdown).toContain("**Core-10 gate: NOT SCORED** — every decision of jev failed");
    expect(markdown).toContain("jev at diagnosis level not scored (every decision failed)");
    expect(markdown).toContain("| jev · cassette — not informative, every decision failed |");
    expect(markdown).toContain("**MetroPT-3 check (in-sample)**: not measured");
    expect(warnings).toContain(
      "every decision of a backend failed: its column is not informative and its gate is not scored",
    );
  });

  it("scores a Jev run with some failed decisions and still names them on every channel", async () => {
    const { printed, warnings, report, markdown } = await executeWithFailures("live", 2, []);
    expect(report.backends[1]).toMatchObject({
      informative: true,
      failures: 2,
      failure_reasons: [{ reason: "unknown: the TypeSafe API answered 500", count: 2 }],
    });
    expect(report.gate).toMatchObject({ backend: "jev", verdict: "unattainable" });
    const warning =
      "jev (live): 2 of its 5 decision(s) failed — unknown: the TypeSafe API answered 500 ×2. A failed decision has no choice, so its figures count those as missing.";
    expect(printed).toContain(`WARNING: ${warning}\ngate: UNATTAINABLE`);
    expect(markdown).toContain(`**Failed decisions — ${warning}**`);
    expect(warnings).toContain("decisions of a backend failed: they are missing from its figures");
  });

  it("prints no warning when no decision failed", async () => {
    const { printed, markdown } = await executeWithFailures("cassette", 0, []);
    expect(printed).not.toContain("WARNING");
    expect(markdown).not.toContain("Failed decisions");
  });
});

describe("runEvaluation over a profile with diagnostic scenarios", () => {
  it("replays and writes them but keeps them out of the summary", async () => {
    const stubs = harness({ jev: "live" });
    const run = await runEvaluation(config(["--profile", "dev", "--backends", "rules"]), {
      ...stubs.deps,
      selectBackends: () => Promise.resolve([stubHandle("rules", "-")]),
    });
    const diagnostic = run.results.filter((entry) => entry.bound.scenario.group === "diagnostic");
    expect(diagnostic.length).toBeGreaterThan(0);
    expect(diagnostic.every((entry) => !entry.scored)).toBe(true);
    const scored = run.results.length - diagnostic.length;
    expect(run.summary?.backends[0]?.scenarios).toBe(scored);
  });
});

describe("runEvaluation --tuning", () => {
  async function tuningRun(argv: readonly string[] = [], env: Record<string, string> = {}) {
    const stubs = harness();
    const out = temporaryDirectory();
    const cfg = loadConfig(["--tuning", "--backends", "rules", ...argv, "--out", out], {
      EVAL_JEV_MODE: "mock",
      ...env,
    });
    const result = await runEvaluation(cfg, {
      ...stubs.deps,
      selectBackends: () => Promise.resolve([stubHandle("rules", "-")]),
    });
    return { stubs, result };
  }

  it("replays exactly the ten scenarios of the list, in its order, over their dev ranges", async () => {
    const { stubs, result } = await tuningRun();
    expect(stubs.calls).toEqual(TUNING_SCENARIOS.map((id) => `${id}.rules`));
    for (const entry of result.results) {
      expect(entry.bound.scenario.split).toBe("dev");
      expect(entry.bound.profile).toBe("dev");
      expect(replayCoverage(entry)).toBe("whole");
    }
  });

  it("records tuning as the run's profile and run-id suffix, whatever EVAL_PROFILE says", async () => {
    const { result } = await tuningRun([], { EVAL_PROFILE: "core" });
    expect(result.profile).toBe("tuning");
    expect(result.runId).toBe("20260922-120000-tuning");
  });

  it("reports the four dev injections that share baseline-feb03 with the core-10", async () => {
    const { result } = await tuningRun();
    expect(result.tuning?.scenarios).toEqual(TUNING_SCENARIOS);
    expect(result.tuning?.sharedSlices.map((entry) => [entry.scenario, entry.slice])).toEqual([
      ["inject_dryer_tower_switching_failure", "baseline-feb03"],
      ["inject_intake_valve_sticking", "baseline-feb03"],
      ["inject_motor_overload", "baseline-feb03"],
      ["inject_separator_drain_blocked", "baseline-feb03"],
    ]);
  });

  it("keeps the gate's partial-run reading: nothing of the core-10 was replayed", async () => {
    const { result } = await tuningRun();
    expect(result.gate).toMatchObject({ complete: false, verdict: "attainable", scored: 0 });
    expect(result.summary?.metropt3Check).toMatchObject({ detected: [], missed: [] });
  });

  it("leaves profile runs without a tuning report", async () => {
    const stubs = harness();
    const run = await runEvaluation(config(["--profile", "smoke"]), stubs.deps);
    expect(run.tuning).toBeUndefined();
    expect(run.exitEval).toBeUndefined();
  });
});

describe("runEvaluation refuses before it replays anything", () => {
  it("a scenario id the profile does not have, without building a backend", async () => {
    const stubs = harness();
    await expect(
      runEvaluation(config(["--profile", "smoke", "--scenario", "f1_air_leak_apr18"]), stubs.deps),
    ).rejects.toThrow(ConfigError);
    expect(stubs.selected).toBe(0);
  });

  it("more than one worker", async () => {
    const stubs = harness();
    await expect(
      runEvaluation(config(["--profile", "smoke", "--jobs", "2"]), stubs.deps),
    ).rejects.toThrow(/--jobs/);
    expect(stubs.calls).toEqual([]);
  });

  it("rows that are not on this machine, naming the scenario's source", async () => {
    const stubs = harness();
    await expect(
      runEvaluation(config(["--profile", "smoke"]), {
        ...stubs.deps,
        requireRows: (bound) => {
          throw new Error(`no rows for ${bound.scenario.id}`);
        },
      }),
    ).rejects.toThrow(/no rows for baseline_feb03_normal/);
    expect(stubs.selected).toBe(0);
  });
});

describe("runEvaluation closes its backends", () => {
  it("when a replay fails half way", async () => {
    const stubs = harness();
    await expect(
      runEvaluation(config(["--profile", "smoke"]), {
        ...stubs.deps,
        runScenario: () => Promise.reject(new Error("the pipeline rejected a push")),
      }),
    ).rejects.toThrow(/rejected a push/);
    expect(stubs.handles.map((handle) => handle.closed)).toEqual([1, 1]);
  });
});

// --- E3 on hand-made runs ---------------------------------------------------------

const SCENARIO_FILES = loadAll();

const E3_CONTEXT: E3Context = {
  scenarios: SCENARIO_FILES,
  headlineFailureIds: headlineFailureIds(),
};

/** The committed scenario named `id`, bound for `profile`. */
function boundFor(id: string, profile: Profile): BoundScenario {
  const scenario = SCENARIO_FILES.find((entry) => entry.id === id);
  if (scenario === undefined) throw new Error(`no committed scenario ${id}`);
  return bindScenario(scenario, { profile });
}

/**
 * One scenario scored by the real metrics with the tickets and suspect events given, as a run's
 * pair for `backend`. A core-10 scenario is bound for the core profile and a dev one for the dev
 * profile, so both replay their whole range unless `profile` says otherwise.
 */
function pair(
  id: string,
  tickets: readonly TicketRecord[] = [],
  options: { profile?: Profile; backend?: BackendName; suspects?: readonly SuspectRecord[] } = {},
): ScenarioResult {
  const backend = options.backend ?? "rules";
  const suspects = options.suspects ?? [];
  const split = SCENARIO_FILES.find((entry) => entry.id === id)?.split;
  const bound = boundFor(id, options.profile ?? (split === "test" ? "core" : "dev"));
  const binding = toBinding(bound);
  const handle = stubHandle(backend, backend === "rules" ? "-" : "mock");
  return {
    bound,
    binding,
    run: emptyRun(bound, handle),
    summary: {
      tickets,
      decisions: [],
      failedDecisions: 0,
      suspects: suspects.length,
      suspectEvents: suspects,
      episodes: { opened: tickets.length, merged: 0, closed: 0, aborted: 0 },
      openAtEnd: tickets.map((entry) => entry.ticketId),
    },
    metrics: scoreScenario(binding, tickets, [], [], TEST_PRICES, {
      backend,
      nativeAlarmCodes: [],
      reviewMin: 0.6,
      suspects,
    }),
    scored: bound.scenario.group !== "diagnostic",
    eventLog: `${SCENARIO_LOG_DIR}/${id}.${backend}.jsonl`,
  };
}

/** `minutes` after the instant `from`. */
function after(from: Date, minutes: number): Date {
  return new Date(from.getTime() + minutes * MS_PER_MINUTE);
}

/** Where a positive scenario's budget starts: its onset, or the end of its warmup if later. */
function budgetStartOf(id: string): { readonly start: Date; readonly accepted: string } {
  const bound = boundFor(id, "core");
  const window = bound.windows.find((entry) => !entry.benign);
  if (window === undefined) throw new Error(`${id} has no positive window`);
  const warmupEnds = after(bound.replay.from, bound.scenario.warmup_min);
  const onset = window.onset ?? window.from;
  const start = onset.getTime() > warmupEnds.getTime() ? onset : warmupEnds;
  return { start, accepted: window.accepted[0] ?? "" };
}

/** A suspect event `minutes` into a positive scenario's budget. */
function suspectIn(id: string, minutes: number): SuspectRecord {
  return suspect({ eventId: `s-${id}-${minutes}`, simTs: after(budgetStartOf(id).start, minutes) });
}

/**
 * A positive scenario detected in time — a suspect event 20 min into its budget — and diagnosed:
 * a ticket naming its accepted fault 30 min in.
 */
function detected(id: string): ScenarioResult {
  const { start, accepted } = budgetStartOf(id);
  return pair(
    id,
    [ticket({ ticketId: `t-${id}`, openedSimTs: after(start, 30), faultAtOpen: accepted })],
    { suspects: [suspectIn(id, 20)] },
  );
}

/** A positive scenario detected in time — a suspect event 20 min in — that opened no ticket. */
function detectedOnly(id: string): ScenarioResult {
  return pair(id, [], { suspects: [suspectIn(id, 20)] });
}

/** A ticket `minutes` into a scenario's replay, naming `fault`. */
function ticketIn(id: string, ticketId: string, minutes: number, fault: string): TicketRecord {
  const bound = boundFor(
    id,
    SCENARIO_FILES.find((entry) => entry.id === id)?.split === "test" ? "core" : "dev",
  );
  return ticket({ ticketId, openedSimTs: after(bound.replay.from, minutes), faultAtOpen: fault });
}

/** A non-benign cause the committed injection catalog names. */
const NON_BENIGN = "airend_bearing_wear";

/** A cause the injection catalog marks benign (heavy air demand). */
const BENIGN = "high_air_demand";

/**
 * A core run with every positive detected and every negative quiet, with `replace` swapped in
 * by scenario id and `drop` left out; `frozen_logger_jun22` is added quiet unless dropped.
 */
function run(
  replace: Readonly<Record<string, ScenarioResult>> = {},
  drop: readonly string[] = [],
): ScenarioResult[] {
  const ids = [...CORE_10_SCENARIO_IDS, "frozen_logger_jun22"].filter((id) => !drop.includes(id));
  return ids.map(
    (id) => replace[id] ?? (CORE_10_POSITIVE_SCENARIO_IDS.includes(id) ? detected(id) : pair(id)),
  );
}

/** The core-10 gate `--fail-on-gate` reads for the same pairs, for comparison. */
function failOnGateCode(results: readonly ScenarioResult[]): number {
  const gate = judgeGate(
    coreGate(
      results.map((result) => result.metrics),
      "rules",
      "detection",
    ),
  );
  return exitCodeFor({ gate }, true);
}

describe("the E3 hand-made runs", () => {
  it("detect every positive in time and keep every negative quiet", () => {
    for (const result of run()) {
      expect(result.metrics.pass.detection, result.metrics.pass.reasons.join("; ")).toBe(true);
    }
  });
});

describe("e3Negatives and e3AbstainCases", () => {
  it("read the normal-operation negatives from the scenario files, then the frozen logger", () => {
    expect(e3Negatives(SCENARIO_FILES)).toEqual(["baseline_feb03_normal", "frozen_logger_jun22"]);
  });

  it("read the abstain cases that keep the ticket rule, the depot day aside", () => {
    expect(e3AbstainCases(SCENARIO_FILES)).toEqual([
      "inject_high_ambient_benign",
      "inject_oil_temperature_sensor_fault",
    ]);
  });

  it("leave no core-10 scenario that is not a positive out of E3", () => {
    const read = new Set([
      ...e3Negatives(SCENARIO_FILES),
      ...e3AbstainCases(SCENARIO_FILES),
      E3_DEPOT_SCENARIO,
    ]);
    const quiet = CORE_10_SCENARIO_IDS.filter((id) => !CORE_10_POSITIVE_SCENARIO_IDS.includes(id));
    for (const id of quiet) expect(read.has(id), id).toBe(true);
  });
});

describe("headlineFailureIds", () => {
  it("takes the failure table's in_headline flag, which leaves F4b out", () => {
    expect([...headlineFailureIds()].sort()).toEqual(["F1", "F2", "F3", "F4"]);
    expect(
      headlineFailureIds({
        failures: [
          { id: "F9", in_headline: true },
          { id: "F9b", in_headline: false },
        ],
      } as unknown as Parameters<typeof headlineFailureIds>[0]),
    ).toEqual(new Set(["F9"]));
  });
});

describe("replayCoverage", () => {
  it("is whole over the scenario's own range, partial under a profile override, none when absent", () => {
    expect(replayCoverage(pair("baseline_feb03_normal"))).toBe("whole");
    expect(replayCoverage(pair("baseline_feb03_normal", [], { profile: "smoke" }))).toBe("partial");
    expect(replayCoverage(undefined)).toBe("none");
  });
});

describe("evaluateE3", () => {
  it("passes only when every condition was covered and held", () => {
    const e3 = evaluateE3(run(), E3_CONTEXT);
    expect(e3).toMatchObject({ name: "e3", backend: "rules", verdict: "pass", failed: [] });
    expect(e3.notCovered).toEqual([]);
    expect(e3.conditions.core10Counts.gate.counts).toMatchObject({
      level: "detection",
      passed: 10,
      positivesPassed: 6,
    });
    expect(e3.conditions.metropt3Check.check).toMatchObject({
      level: "detection",
      detected: ["F1", "F2", "F3", "F4"],
    });
    expect(runExitCode({ gate: null, exitEval: e3 }, false)).toBe(EXIT_OK);
  });

  it("passes on detection alone: the rules backend's tickets are a baseline, never gated", () => {
    const results = run(
      Object.fromEntries(CORE_10_POSITIVE_SCENARIO_IDS.map((id) => [id, detectedOnly(id)])),
    );
    const e3 = evaluateE3(results, E3_CONTEXT);
    expect(e3).toMatchObject({ verdict: "pass", failed: [], notCovered: [] });
    // Read at ticket level, as E3 once was, this run fails: no positive was diagnosed at review
    // level.
    expect(e3.baseline.reviewDiagnosis).toMatchObject({
      level: "review_diagnosis",
      passed: 4,
      positivesPassed: 0,
      pass: false,
    });
    expect(e3.baseline.diagnosis).toMatchObject({ passed: 4, positivesPassed: 0 });
    expect(e3.baseline.metropt3Check).toMatchObject({
      level: "review",
      detected: [],
      missed: ["F1", "F2", "F3", "F4"],
      pass: false,
    });
  });

  it("records a diagnosed run's baseline beside the verdict, which it never changes", () => {
    const e3 = evaluateE3(run(), E3_CONTEXT);
    expect(e3.baseline.reviewDiagnosis).toMatchObject({ passed: 10, positivesPassed: 6 });
    expect(e3.baseline.metropt3Check.detected).toEqual(["F1", "F2", "F3", "F4"]);
    const undiagnosed = evaluateE3(
      run(Object.fromEntries(CORE_10_POSITIVE_SCENARIO_IDS.map((id) => [id, detectedOnly(id)]))),
      E3_CONTEXT,
    );
    expect(undiagnosed.verdict).toBe(e3.verdict);
  });

  it("fails a positive that opened a correct ticket but raised no suspect event in time", () => {
    const f4 = pair("f4_air_leak_jul15", [
      ticket({
        ticketId: "t-f4",
        openedSimTs: after(budgetStartOf("f4_air_leak_jul15").start, 10),
        faultAtOpen: budgetStartOf("f4_air_leak_jul15").accepted,
      }),
    ]);
    expect(f4.metrics.pass).toMatchObject({ detection: false, reviewDiagnosis: true });
    const e3 = evaluateE3(run({ f4_air_leak_jul15: f4 }), E3_CONTEXT);
    expect(e3).toMatchObject({ verdict: "fail", failed: ["metropt3_check"] });
    expect(e3.conditions.metropt3Check.check.missed).toEqual(["F4"]);
    expect(e3.baseline.metropt3Check.detected).toEqual(["F1", "F2", "F3", "F4"]);
  });

  it("misses a failure whose first suspect event came after its budget", () => {
    const late = pair("f4_air_leak_jul15", [], {
      suspects: [suspectIn("f4_air_leak_jul15", 61)],
    });
    expect(late.metrics.detection.windows[0]).toMatchObject({ windowId: "F4", detected: false });
    const e3 = evaluateE3(run({ f4_air_leak_jul15: late }), E3_CONTEXT);
    expect(e3.conditions.metropt3Check.check.missed).toEqual(["F4"]);
  });

  it("fails at 8/10 and 5/6 — what --fail-on-gate accepts — when the MetroPT-3 check is 3/4", () => {
    const results = run({
      f4_air_leak_jul15: pair("f4_air_leak_jul15"),
      inject_oil_temperature_sensor_fault: pair("inject_oil_temperature_sensor_fault", [
        ticketIn("inject_oil_temperature_sensor_fault", "t-oil", 300, NON_BENIGN),
      ]),
    });
    expect(failOnGateCode(results)).toBe(EXIT_OK);

    const e3 = evaluateE3(results, E3_CONTEXT);
    const { core10Counts, metropt3Check } = e3.conditions;
    expect(core10Counts.status).toBe("pass");
    expect(core10Counts.gate.counts).toMatchObject({ passed: 8, positivesPassed: 5 });
    expect(metropt3Check).toMatchObject({ status: "fail", notReplayed: [] });
    expect(metropt3Check.check).toMatchObject({ detected: ["F1", "F2", "F3"], missed: ["F4"] });
    expect(e3.verdict).toBe("fail");
    expect(e3.failed).toContain("metropt3_check");
    expect(runExitCode({ gate: null, exitEval: e3 }, false)).toBe(EXIT_GATE_FAILED);
  });

  it("fails on the MetroPT-3 check alone when everything else holds", () => {
    const e3 = evaluateE3(run({ f4_air_leak_jul15: pair("f4_air_leak_jul15") }), E3_CONTEXT);
    expect(e3.conditions.core10Counts.gate.counts).toMatchObject({ passed: 9, positivesPassed: 5 });
    expect(e3).toMatchObject({ verdict: "fail", failed: ["metropt3_check"], notCovered: [] });
  });

  it("fails at 8/10 and 6/6 when both abstain cases open a non-benign ticket", () => {
    const results = run({
      inject_high_ambient_benign: pair("inject_high_ambient_benign", [
        ticketIn("inject_high_ambient_benign", "t-ambient", 240, NON_BENIGN),
      ]),
      inject_oil_temperature_sensor_fault: pair("inject_oil_temperature_sensor_fault", [
        ticketIn("inject_oil_temperature_sensor_fault", "t-sensor", 240, NON_BENIGN),
      ]),
    });
    expect(failOnGateCode(results)).toBe(EXIT_OK);

    const e3 = evaluateE3(results, E3_CONTEXT);
    expect(e3.conditions.core10Counts).toMatchObject({ status: "pass" });
    expect(e3.conditions.core10Counts.gate.counts).toMatchObject({ passed: 8, positivesPassed: 6 });
    expect(e3).toMatchObject({ verdict: "fail", failed: ["abstain_non_benign"] });
    const failing = e3.conditions.abstainNonBenign.scenarios.filter((s) => s.status === "fail");
    expect(failing.map((check) => check.scenarioId)).toEqual([
      "inject_high_ambient_benign",
      "inject_oil_temperature_sensor_fault",
    ]);
  });

  it("fails on one non-benign ticket on inject_high_ambient_benign, naming it with its evidence", () => {
    const results = run({
      inject_high_ambient_benign: pair("inject_high_ambient_benign", [
        ticketIn("inject_high_ambient_benign", "t-ambient", 240, NON_BENIGN),
        ticketIn("inject_high_ambient_benign", "t-warm-room", 300, "high_ambient_temperature"),
      ]),
    });
    const e3 = evaluateE3(results, E3_CONTEXT);
    expect(e3.conditions.core10Counts.gate.counts).toMatchObject({ passed: 9, positivesPassed: 6 });
    expect(e3).toMatchObject({ verdict: "fail", failed: ["abstain_non_benign"] });
    const ambient = e3.conditions.abstainNonBenign.scenarios.find(
      (check) => check.scenarioId === "inject_high_ambient_benign",
    );
    expect(ambient).toMatchObject({ status: "fail", replay: "whole", suspects: [] });
    expect(ambient?.tickets.map((entry) => [entry.ticketId, entry.faultAtOpen])).toEqual([
      ["t-ambient", NON_BENIGN],
    ]);
  });

  it("lets an abstain case raise suspect events: it keeps its ticket rule", () => {
    const ambient = pair("inject_high_ambient_benign", [], {
      suspects: [
        suspect({
          eventId: "s-hot",
          simTs: after(boundFor("inject_high_ambient_benign", "core").replay.from, 240),
        }),
      ],
    });
    expect(ambient.metrics.pass.detection).toBe(true);
    const e3 = evaluateE3(run({ inject_high_ambient_benign: ambient }), E3_CONTEXT);
    expect(e3.verdict).toBe("pass");
  });

  it("fails a normal-operation negative on one suspect event, whatever its tickets", () => {
    const when = after(boundFor("baseline_feb03_normal", "core").replay.from, 300);
    const baseline = pair("baseline_feb03_normal", [], {
      suspects: [suspect({ eventId: "s-cycling", simTs: when, symptomKey: "frequent_cycling" })],
    });
    expect(baseline.metrics.pass).toMatchObject({ detection: false, reviewDiagnosis: true });
    const e3 = evaluateE3(run({ baseline_feb03_normal: baseline }), E3_CONTEXT);
    expect(e3.conditions.core10Counts.gate.counts).toMatchObject({ passed: 9, positivesPassed: 6 });
    expect(e3).toMatchObject({ verdict: "fail", failed: ["negatives_no_suspect"] });
    const check = e3.conditions.negativesNoSuspect.scenarios[0];
    expect(check).toMatchObject({
      scenarioId: "baseline_feb03_normal",
      status: "fail",
      tickets: [],
    });
    expect(check?.suspects.map((entry) => entry.eventId)).toEqual(["s-cycling"]);
  });

  it("counts a suspect event the warmup swallowed, which the scenario's own pass ignores", () => {
    const frozen = pair("frozen_logger_jun22", [], {
      suspects: [
        suspect({
          eventId: "s-early",
          simTs: after(boundFor("frozen_logger_jun22", "dev").replay.from, 10),
        }),
      ],
    });
    expect(frozen.metrics.pass.detection).toBe(true);
    const e3 = evaluateE3(run({ frozen_logger_jun22: frozen }), E3_CONTEXT);
    expect(e3).toMatchObject({ verdict: "fail", failed: ["negatives_no_suspect"] });
  });

  it("counts a non-benign ticket the warmup swallowed on an abstain case", () => {
    const sensor = pair("inject_oil_temperature_sensor_fault", [
      ticketIn("inject_oil_temperature_sensor_fault", "t-early", 10, NON_BENIGN),
    ]);
    expect(sensor.metrics.pass.detection).toBe(true);
    const e3 = evaluateE3(run({ inject_oil_temperature_sensor_fault: sensor }), E3_CONTEXT);
    expect(e3).toMatchObject({ verdict: "fail", failed: ["abstain_non_benign"] });
  });

  it("fails on any ticket on the depot day, benign ones included", () => {
    const depot = pair(E3_DEPOT_SCENARIO, [ticketIn(E3_DEPOT_SCENARIO, "t-depot", 180, BENIGN)]);
    expect(depot.metrics.pass.detection).toBe(true);
    const results = run({ [E3_DEPOT_SCENARIO]: depot });
    expect(failOnGateCode(results)).toBe(EXIT_OK);

    const e3 = evaluateE3(results, E3_CONTEXT);
    expect(e3.conditions.core10Counts.gate.counts).toMatchObject({
      passed: 10,
      positivesPassed: 6,
    });
    expect(e3).toMatchObject({ verdict: "fail", failed: ["depot_no_ticket"], notCovered: [] });
    expect(e3.conditions.depotNoTicket).toMatchObject({ status: "fail", replay: "whole" });
    expect(e3.conditions.depotNoTicket.tickets.map((entry) => entry.ticketId)).toEqual(["t-depot"]);
  });

  it("reads a core run without frozen_logger_jun22 as incomplete, naming it, and exits 0", () => {
    const e3 = evaluateE3(run({}, ["frozen_logger_jun22"]), E3_CONTEXT);
    expect(e3).toMatchObject({ verdict: "incomplete", failed: [] });
    expect(e3.notCovered).toEqual([
      { condition: "negatives_no_suspect", missing: ["frozen_logger_jun22"] },
    ]);
    const frozen = e3.conditions.negativesNoSuspect.scenarios.find(
      (check) => check.scenarioId === "frozen_logger_jun22",
    );
    expect(frozen).toMatchObject({
      status: "not_covered",
      replay: "none",
      tickets: [],
      suspects: [],
    });
    expect(runExitCode({ gate: null, exitEval: e3 }, false)).toBe(EXIT_OK);
  });

  it("still fails an incomplete run when a covered condition breaks", () => {
    const e3 = evaluateE3(
      run({ f4_air_leak_jul15: pair("f4_air_leak_jul15") }, ["frozen_logger_jun22"]),
      E3_CONTEXT,
    );
    expect(e3.verdict).toBe("fail");
    expect(e3.failed).toEqual(["metropt3_check"]);
    expect(e3.notCovered.map((gap) => gap.condition)).toEqual(["negatives_no_suspect"]);
  });

  it("covers only the frozen logger in the dev run of E3's recipe", () => {
    const e3 = evaluateE3([pair("frozen_logger_jun22")], E3_CONTEXT);
    expect(e3.verdict).toBe("incomplete");
    expect(e3.conditions.negativesNoSuspect.scenarios.map((s) => [s.scenarioId, s.status])).toEqual(
      [
        ["baseline_feb03_normal", "not_covered"],
        ["frozen_logger_jun22", "pass"],
      ],
    );
    expect(e3.notCovered).toEqual([
      { condition: "core10_counts", missing: CORE_10_SCENARIO_IDS },
      { condition: "metropt3_check", missing: ["F1", "F2", "F3", "F4"] },
      { condition: "negatives_no_suspect", missing: ["baseline_feb03_normal"] },
      {
        condition: "abstain_non_benign",
        missing: ["inject_high_ambient_benign", "inject_oil_temperature_sensor_fault"],
      },
      { condition: "depot_no_ticket", missing: [E3_DEPOT_SCENARIO] },
    ]);
  });

  it("never counts a shortened replay as covering a condition", () => {
    const smoke = (id: string) => pair(id, [], { profile: "smoke" });
    const e3 = evaluateE3(
      run({
        baseline_feb03_normal: smoke("baseline_feb03_normal"),
        f3_air_leak_jun05: smoke("f3_air_leak_jun05"),
      }),
      E3_CONTEXT,
    );
    expect(e3.verdict).toBe("incomplete");
    expect(e3.conditions.core10Counts).toMatchObject({ status: "not_covered" });
    expect(e3.conditions.core10Counts.gate.counts.missing).toEqual([
      "f3_air_leak_jun05",
      "baseline_feb03_normal",
    ]);
    expect(e3.conditions.metropt3Check).toMatchObject({
      status: "not_covered",
      notReplayed: ["F3"],
    });
    const baseline = e3.conditions.negativesNoSuspect.scenarios[0];
    expect(baseline).toMatchObject({
      scenarioId: "baseline_feb03_normal",
      status: "not_covered",
      replay: "partial",
    });
  });

  it("reads the rules backend only", () => {
    const jevTicket = ticketIn("baseline_feb03_normal", "t-jev", 300, NON_BENIGN);
    const results = [
      ...run(),
      pair("baseline_feb03_normal", [jevTicket], {
        backend: "jev",
        suspects: [suspect({ eventId: "s-jev", simTs: jevTicket.openedSimTs })],
      }),
      pair("f4_air_leak_jul15", [], { backend: "jev" }),
    ];
    expect(evaluateE3(results, E3_CONTEXT).verdict).toBe("pass");
  });

  it("never reads a design target: a run with the design case gives the same verdict", () => {
    const may19 = pair("unlabelled_leak_may19", [
      ticketIn("unlabelled_leak_may19", "t-purge", 300, "dryer_purge_leak"),
    ]);
    expect(may19.bound.scenario.design_target).toBeDefined();
    const withDesign = evaluateE3([...run(), may19], E3_CONTEXT);
    const stripped = SCENARIO_FILES.map((scenario) => {
      const copy = { ...scenario };
      delete copy.design_target;
      return copy;
    });
    const withoutDesign = evaluateE3(run(), { ...E3_CONTEXT, scenarios: stripped });
    expect(withDesign).toEqual(withoutDesign);
  });
});

describe("designTargets", () => {
  it("reads the design case's pairs, and only them, beside the run", () => {
    const may19 = pair("unlabelled_leak_may19", [
      ticketIn("unlabelled_leak_may19", "t-purge", 300, "dryer_purge_leak"),
    ]);
    const readings = designTargets([...run(), may19]);
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({
      scenarioId: "unlabelled_leak_may19",
      backend: "rules",
      gated: false,
      target: { accepted: ["dryer_purge_leak", "downstream_air_leak"] },
    });
    expect(readings[0]?.episodes).toEqual([
      {
        from: new Date("2020-05-19T22:22:17.000Z"),
        to: new Date("2020-05-20T23:02:33.000Z"),
      },
    ]);
    expect(readings[0]?.review).toMatchObject({ onTarget: 1, met: true });
    expect(designTargets(run())).toEqual([]);
  });

  it("leaves the design case's own scoring as it would be without a target", () => {
    const tickets = [ticketIn("unlabelled_leak_may19", "t-purge", 300, "dryer_purge_leak")];
    const may19 = pair("unlabelled_leak_may19", tickets);
    expect(may19.scored).toBe(false);
    expect(may19.binding).not.toHaveProperty("designTarget");
    expect(may19.binding).not.toHaveProperty("design_target");
    expect(may19.metrics.match.review.ignored.map((entry) => entry.ticketId)).toEqual(["t-purge"]);
  });
});

describe("runExitCode", () => {
  const e3 = (verdict: "pass" | "fail" | "incomplete") =>
    ({ verdict }) as unknown as NonNullable<RunResult["exitEval"]>;
  const gate = (pass: boolean) => ({ pass }) as RunResult["gate"];

  it("is exitCodeFor's code when the run has no exit eval, so --fail-on-gate is unchanged", () => {
    for (const failOnGate of [false, true]) {
      for (const result of [{ gate: gate(true) }, { gate: gate(false) }, { gate: null }]) {
        expect(runExitCode(result, failOnGate)).toBe(exitCodeFor(result, failOnGate));
      }
    }
  });

  it("is 2 on a failed exit eval, with or without --fail-on-gate", () => {
    expect(runExitCode({ gate: gate(true), exitEval: e3("fail") }, false)).toBe(EXIT_GATE_FAILED);
    expect(runExitCode({ gate: gate(true), exitEval: e3("fail") }, true)).toBe(EXIT_GATE_FAILED);
  });

  it("leaves an incomplete or passing exit eval to the gate", () => {
    expect(runExitCode({ gate: gate(true), exitEval: e3("incomplete") }, true)).toBe(EXIT_OK);
    expect(runExitCode({ gate: gate(false), exitEval: e3("incomplete") }, false)).toBe(EXIT_OK);
    expect(runExitCode({ gate: gate(false), exitEval: e3("pass") }, true)).toBe(EXIT_GATE_FAILED);
  });
});

describe("executeRun --exit-eval e3", () => {
  const provenance = () => ({
    git_sha: null,
    node: process.version,
    backend_version: "1.0.0",
    ground_truth: {
      package_version: "1.0.0",
      failures_sha256: "c".repeat(64),
      injections_sha256: null,
    },
  });

  async function execute(argv: readonly string[], rulesOnly = false) {
    const out = temporaryDirectory();
    const printed: string[] = [];
    const stubs = harness();
    const code = await executeRun(config(argv, out), {
      ...stubs.deps,
      ...(rulesOnly ? { selectBackends: () => Promise.resolve([stubHandle("rules", "-")]) } : {}),
      provenance,
      stdout: { write: (chunk: string) => printed.push(chunk) },
    });
    const runs = readdirSync(out, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    expect(runs).toHaveLength(1);
    const runDir = join(out, runs[0]?.name ?? "");
    const report = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunReport;
    const markdown = readFileSync(join(runDir, "report.md"), "utf8");
    return { code, printed: printed.join(""), report, markdown };
  }

  it("exits 2 without --fail-on-gate when a covered condition breaks, and says so everywhere", async () => {
    // Nothing is decided on the stubbed host, so every positive is missed.
    const { code, printed, report, markdown } = await execute([
      "--profile",
      "core",
      "--exit-eval",
      "e3",
    ]);
    expect(code).toBe(EXIT_GATE_FAILED);
    expect(() => validateReport(report)).not.toThrow();
    expect(report.gate?.enforced).toBe(false);
    expect(report.exit_eval).toMatchObject({
      verdict: "fail",
      failed: ["core10_counts", "metropt3_check"],
      not_covered: [{ condition: "negatives_no_suspect", missing: ["frozen_logger_jun22"] }],
      baseline: { gated: false, review_diagnosis: { passed: 4, positives_passed: 0 } },
    });
    const line =
      "E3 FAIL — broken: core10_counts, metropt3_check; not covered: negatives_no_suspect (frozen_logger_jun22)";
    expect(printed).toContain(line);
    expect(markdown).toContain(`**${line}**`);
  });

  it("exits 0 on the dev run of frozen_logger_jun22, which is incomplete and never a pass", async () => {
    const { code, printed, report, markdown } = await execute(
      [
        "--profile",
        "dev",
        "--scenario",
        "frozen_logger_jun22",
        "--backends",
        "rules",
        "--exit-eval",
        "e3",
      ],
      true,
    );
    expect(code).toBe(EXIT_OK);
    expect(() => validateReport(report)).not.toThrow();
    expect(report.exit_eval?.verdict).toBe("incomplete");
    expect(printed).toContain("E3 INCOMPLETE — not a pass; not covered: core10_counts (");
    expect(markdown).toContain("**E3 INCOMPLETE — not a pass; not covered: core10_counts (");
  });

  it("writes a tuning run's list and shared slices to run.json, report.md and the console", async () => {
    const { code, printed, report, markdown } = await execute(
      ["--tuning", "--backends", "rules", "--exit-eval", "e3"],
      true,
    );
    expect(code).toBe(EXIT_OK);
    expect(() => validateReport(report)).not.toThrow();
    expect(report.run.profile).toBe("tuning");
    expect(report.tuning?.scenarios).toEqual(TUNING_SCENARIOS);
    expect(report.tuning?.shared_slices).toHaveLength(4);
    expect(printed).toContain(
      "tuning list: 10 scenarios; 4 share a slice with the core-10 (allowed by the dev/test split, reported only)",
    );
    expect(printed).toContain(
      "  inject_motor_overload shares baseline-feb03 with baseline_feb03_normal, inject_air_leak_downstream,",
    );
    expect(markdown).toContain(
      "- 4 tuning scenario(s) replay a slice a core-10 scenario also replays; the dev/test split allows them, so they are reported, not refused:",
    );
    expect(markdown).toContain(
      "  - `inject_separator_drain_blocked` on `baseline-feb03`, shared with",
    );
    // The tuning list holds the one dev negative E3 names, so a tuning run covers it.
    const frozen = report.exit_eval?.conditions.negatives_no_suspect.scenarios.find(
      (check) => check.scenario === "frozen_logger_jun22",
    );
    expect(frozen).toMatchObject({ status: "pass", replay: "whole" });
    // The design case's target is not read: the stubbed host opened nothing inside the episode.
    expect(report.design_targets).toEqual([
      expect.objectContaining({
        scenario: "unlabelled_leak_may19",
        backend: "rules",
        gated: false,
      }),
    ]);
    expect(printed).toContain(
      "design target (reported only, never gated) unlabelled_leak_may19 rules: dryer_purge_leak or downstream_air_leak;",
    );
  });

  it("writes no exit_eval block without the flag", async () => {
    const { report, printed } = await execute(["--profile", "smoke"]);
    expect(report).not.toHaveProperty("exit_eval");
    expect(report).not.toHaveProperty("tuning");
    expect(printed).not.toContain("E3");
  });
});
