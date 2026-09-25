// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The guards of the held-out set (tools/eval/records/heldout-seal.md).
//
// Nothing here replays a held-out scenario, in any mode: every case either
// stops at the configuration, the loader or the selection, before a row is
// read, or runs on synthetic scenario documents written for it, which name no
// slice of the set and are never replayed either. The committed held-out files
// are only loaded, never bound to a run.
//
// Since the Jev thresholds pre-registration's amendment of 2026-09-24 the one
// run also uses exactly the triple the pre-registered sweep chose, read from
// its committed record (tools/eval/records/jev-thresholds-choice.md). The
// records here are synthetic, written to temporary directories; no sweep is
// replayed.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { selectBackends } from "./backends/select.ts";
import type { LivePlanner } from "./backends/select.ts";
import {
  CHOICE_RECORD_FILE,
  choiceRecordPath,
  committedUnchanged,
  renderChoiceRecord,
} from "./choice.ts";
import type { ChosenTriple } from "./choice.ts";
import { EXIT_USAGE, main } from "./cli.ts";
import { ConfigError, assertFinalHeldoutRun, loadConfig } from "./config.ts";
import type { EvalConfig } from "./config.ts";
import {
  FINAL_RUN_RECORD_FILE,
  HELDOUT_PROFILE,
  finalRunRecordPath,
  isHeldout,
  isHeldoutSlice,
} from "./heldout.ts";
import { createLogger } from "./log.ts";
import { gitSha } from "./report/provenance.ts";
import { createFakeWallClock } from "./runner/host.ts";
import { headlineFailureIds, runEvaluation, selectScenarios } from "./runner/run.ts";
import { PROFILES, ScenarioError, loadAll, loadScenario } from "./scenario/index.ts";
import type { Profile, Scenario } from "./scenario/index.ts";
import { REPO_ROOT } from "./slices.ts";
import { TUNING_SCENARIOS, tuningRejections } from "./tuning.ts";

const CWD = "/work/here";
const FAKE_KEY = "tsk-test-heldout-0001";

const temporary: string[] = [];

afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-heldout-"));
  temporary.push(directory);
  return directory;
}

/** A synthetic held-out scenario; its slice is not one of the set's and is never replayed. */
function heldoutDocument(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "urn:fdp:eval:scenario:v1",
    id: "heldout_example_case",
    title: "A held-out case written for this test",
    group: "negative",
    profiles: ["heldout"],
    split: "heldout",
    positive: false,
    source: { kind: "slice", name: "heldout-example" },
    replay: { from: "2020-01-01T00:00:00.000Z", to: "2020-01-02T00:00:00.000Z" },
    ground_truth: { kind: "negative" },
    expect: {
      tickets: "none",
      fault: "benign_or_none",
      max_false_tickets: 0,
      pass_level: "detection",
    },
    warmup_min: 60,
    seed: 1,
    notes: "A synthetic held-out scenario for the guard tests; nothing ever replays it.",
    ...fields,
  };
}

/** A synthetic dev scenario beside it. */
function devDocument(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return heldoutDocument({
    id: "dev_example_case",
    profiles: ["dev"],
    split: "dev",
    source: { kind: "slice", name: "summer-jul05" },
    ...fields,
  });
}

/** Writes a document as `<id>.json` into `directory` and returns the path. */
function asFile(document: Record<string, unknown>, directory: string = scratch()): string {
  const path = join(directory, `${String(document["id"])}.json`);
  writeFileSync(path, JSON.stringify(document), "utf8");
  return path;
}

function load(document: Record<string, unknown>): Scenario {
  return loadScenario(asFile(document));
}

function scenarioError(run: () => unknown): ScenarioError {
  try {
    run();
  } catch (error) {
    if (error instanceof ScenarioError) return error;
    throw error;
  }
  throw new Error("expected a ScenarioError");
}

function configError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

/** The arguments and environment of an acceptable final run, against an absent record. */
const FINAL_ARGS = ["--profile", "heldout", "--final-heldout", "--confirm-live"] as const;
const FINAL_ENV = { EVAL_JEV_MODE: "live" } as const;

function absentRecord(): string {
  return join(scratch(), "heldout-final-run.md");
}

function presentRecord(): string {
  const path = join(scratch(), "heldout-final-run.md");
  writeFileSync(path, "Final run: 20270101-000000-heldout\n", "utf8");
  return path;
}

/** The incumbent triple, which a sweep that keeps it records. */
const KEPT: ChosenTriple = { persistSimMin: 1, reviewMin: 0.6, ticketMin: 0.85 };

/** The triple the committed record chose, which the code defaults now carry. */
const CHOSEN: ChosenTriple = { persistSimMin: 1, reviewMin: 0.65, ticketMin: 0.85 };

/** A synthetic choice record of `triple`, written to a temporary directory. */
function choiceRecord(triple: ChosenTriple = CHOSEN): string {
  const path = join(scratch(), "jev-thresholds-choice.md");
  writeFileSync(
    path,
    renderChoiceRecord({
      triple,
      outcome: triple === KEPT ? "keep" : "change",
      recordedAt: new Date("2026-09-26T08:00:00.000Z"),
      preregistrationCommit: null,
      report: "reports/eval/sweep/preregistered-sweep.md",
      recordings: [],
      catalog: { name: "reference", sha256: "c".repeat(64) },
    }),
    "utf8",
  );
  return path;
}

/** The options of an acceptable final run: no final-run record, a committed choice of `triple`. */
function finalOptions(triple: ChosenTriple = CHOSEN) {
  return {
    cwd: CWD,
    finalRunRecord: absentRecord(),
    choiceRecord: choiceRecord(triple),
    choiceCommitted: () => true,
  };
}

describe("the loader keeps the held-out set in its own profile and on its own slices", () => {
  it("loads a held-out scenario in the heldout profile on a held-out slice", () => {
    const scenario = load(heldoutDocument());
    expect(isHeldout(scenario)).toBe(true);
    expect(scenario.profiles).toEqual([HELDOUT_PROFILE]);
  });

  it.each([[["heldout", "full"]], [["core"]], [["dev"]], [["smoke", "core"]], [["full"]]])(
    "refuses a held-out scenario in the profiles %j",
    (profiles) => {
      const error = scenarioError(() => load(heldoutDocument({ profiles })));
      expect(error.code).toBe("schema");
      expect(error.message).toMatch(/profiles must be exactly \[heldout\]/);
    },
  );

  it.each([
    ["dev", ["dev", "heldout"]],
    ["test", ["core", "full", "heldout"]],
  ])("refuses a %s scenario that lists the heldout profile", (split, profiles) => {
    const error = scenarioError(() => load(devDocument({ split, profiles })));
    expect(error.message).toMatch(/must not include heldout/);
  });

  it("refuses a held-out scenario on a slice the other scenarios use, or on the whole CSV", () => {
    for (const source of [{ kind: "slice", name: "summer-jul05" }, { kind: "csv" }]) {
      const error = scenarioError(() => load(heldoutDocument({ source })));
      expect(error.code).toBe("source");
    }
  });

  it("refuses any other scenario that replays a held-out slice", () => {
    const error = scenarioError(() =>
      load(devDocument({ source: { kind: "slice", name: "heldout-example" } })),
    );
    expect(error.code).toBe("source");
    expect(error.message).toMatch(/only the held-out set may replay/);
  });

  it("refuses a per-profile override of a held-out range", () => {
    const replay = {
      from: "2020-01-01T00:00:00.000Z",
      to: "2020-01-02T00:00:00.000Z",
      overrides: { smoke: { to: "2020-01-01T08:00:00.000Z" } },
    };
    expect(scenarioError(() => load(heldoutDocument({ replay }))).message).toMatch(/override/);
  });

  it("holds every committed scenario to those rules", () => {
    for (const scenario of loadAll()) {
      const onHeldoutSlice =
        scenario.source.kind === "slice" && isHeldoutSlice(scenario.source.name);
      expect(onHeldoutSlice, scenario.id).toBe(isHeldout(scenario));
      expect(scenario.profiles.includes(HELDOUT_PROFILE), scenario.id).toBe(isHeldout(scenario));
    }
  });
});

describe("no other profile, no --scenario and no tuning run selects a held-out scenario", () => {
  const heldout = load(heldoutDocument());
  const dev = load(devDocument());
  const others = PROFILES.filter((profile) => profile !== HELDOUT_PROFILE);

  it.each(others)("the %s profile leaves the held-out set out", (profile: Profile) => {
    const inProfile = [heldout, dev].filter((scenario) => scenario.profiles.includes(profile));
    expect(inProfile.some(isHeldout)).toBe(false);
  });

  it.each(others)("--scenario under %s refuses a held-out id by name", (profile: Profile) => {
    const error = configError(() => selectScenarios([heldout, dev], profile, [heldout.id]));
    expect(error.flag).toBe("--scenario");
    expect(error.message).toMatch(/is a held-out scenario: it runs only in/);
  });

  it("the tuning guard refuses a held-out id", () => {
    expect(tuningRejections([heldout.id], [heldout, dev], new Set())).toEqual([
      { id: heldout.id, reason: "a held-out scenario (it runs once, in its final run)" },
    ]);
  });

  it("the tuning list names no committed held-out scenario", () => {
    const all = loadAll();
    const heldoutIds = new Set(all.filter(isHeldout).map((scenario) => scenario.id));
    expect(TUNING_SCENARIOS.filter((id) => heldoutIds.has(id))).toEqual([]);
    const reasons = tuningRejections(TUNING_SCENARIOS, all, headlineFailureIds());
    expect(reasons).toEqual([]);
  });
});

describe("--profile heldout is the one final run and nothing else", () => {
  const refusals: readonly {
    readonly name: string;
    readonly argv: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly flag: string;
  }[] = [
    {
      name: "the heldout profile without --final-heldout",
      argv: ["--profile", "heldout"],
      flag: "--profile",
    },
    {
      name: "the heldout profile from EVAL_PROFILE",
      argv: ["--final-heldout", "--confirm-live"],
      env: { EVAL_PROFILE: "heldout", EVAL_JEV_MODE: "live" },
      flag: "EVAL_PROFILE",
    },
    {
      name: "--final-heldout with another profile",
      argv: ["--profile", "core", "--final-heldout"],
      flag: "--final-heldout",
    },
    {
      name: "--final-heldout with --tuning",
      argv: ["--tuning", "--final-heldout"],
      flag: "--final-heldout",
    },
    {
      name: "--final-heldout alone, on the default profile",
      argv: ["--final-heldout"],
      flag: "--final-heldout",
    },
    {
      name: "a --scenario narrowing",
      argv: [...FINAL_ARGS, "--scenario", "heldout_example_case"],
      flag: "--scenario",
    },
    { name: "a --seed override", argv: [...FINAL_ARGS, "--seed", "3"], flag: "--seed" },
    { name: "the core-10 gate", argv: [...FINAL_ARGS, "--fail-on-gate"], flag: "--fail-on-gate" },
    { name: "the E3 check", argv: [...FINAL_ARGS, "--exit-eval", "e3"], flag: "--exit-eval" },
    { name: "a run without Jev", argv: [...FINAL_ARGS, "--backends", "rules"], flag: "--backends" },
    {
      name: "Jev in mock mode",
      argv: FINAL_ARGS,
      env: { EVAL_JEV_MODE: "mock" },
      flag: "EVAL_JEV_MODE",
    },
    {
      name: "Jev from cassettes",
      argv: FINAL_ARGS,
      env: { EVAL_JEV_MODE: "cassette" },
      flag: "EVAL_JEV_MODE",
    },
    { name: "Jev in auto mode", argv: FINAL_ARGS, env: {}, flag: "EVAL_JEV_MODE" },
    {
      name: "a live run not confirmed up front",
      argv: ["--profile", "heldout", "--final-heldout"],
      flag: "--confirm-live",
    },
  ];

  it.each(refusals)("refuses $name and names $flag", ({ argv, env = FINAL_ENV, flag }) => {
    const error = configError(() => loadConfig(argv, env, finalOptions()));
    expect(error.flag).toBe(flag);
    expect(error.exitCode).toBe(EXIT_USAGE);
  });

  it("takes the final run, and only that run, with --final-heldout", () => {
    const cfg = loadConfig(FINAL_ARGS, FINAL_ENV, finalOptions());
    expect(cfg.profile).toBe(HELDOUT_PROFILE);
    expect(cfg.finalHeldout).toBe(true);
    expect(cfg.confirmLive).toBe(true);
    expect(loadConfig([], {}, { cwd: CWD }).finalHeldout).toBe(false);
  });

  it("refuses the final run again once its record exists", () => {
    const error = configError(() =>
      loadConfig(FINAL_ARGS, FINAL_ENV, { ...finalOptions(), finalRunRecord: presentRecord() }),
    );
    expect(error.flag).toBe("--final-heldout");
    expect(error.message).toContain(FINAL_RUN_RECORD_FILE);
    expect(error.message).toMatch(/has had its one run/);
  });

  it("reads the committed record at tools/eval/records/heldout-final-run.md by default", () => {
    expect(FINAL_RUN_RECORD_FILE).toBe("tools/eval/records/heldout-final-run.md");
    expect(finalRunRecordPath()).toBe(join(REPO_ROOT, FINAL_RUN_RECORD_FILE));
  });

  it("holds a configuration built by hand to the same rules", () => {
    const absent = absentRecord();
    const present = presentRecord();
    const committed = { path: choiceRecord(), committed: () => true };
    const hand = (fields: { profile: EvalConfig["profile"]; finalHeldout: boolean }) => ({
      ...fields,
      persistSimMin: 1,
      jevGate: { ticketMin: 0.85, reviewMin: 0.65 },
    });
    expect(() =>
      assertFinalHeldoutRun(hand({ profile: "core", finalHeldout: false }), present),
    ).not.toThrow();
    expect(
      configError(() =>
        assertFinalHeldoutRun(hand({ profile: "heldout", finalHeldout: false }), absent, committed),
      ).flag,
    ).toBe("--profile");
    expect(
      configError(() =>
        assertFinalHeldoutRun(hand({ profile: "heldout", finalHeldout: true }), present, committed),
      ).flag,
    ).toBe("--final-heldout");
    expect(() =>
      assertFinalHeldoutRun(hand({ profile: "heldout", finalHeldout: true }), absent, committed),
    ).not.toThrow();
    // The same triple rule as the configuration's: another N is refused by name.
    expect(
      configError(() =>
        assertFinalHeldoutRun(
          { ...hand({ profile: "heldout", finalHeldout: true }), persistSimMin: 0 },
          absent,
          committed,
        ),
      ).flag,
    ).toBe("GATE_PERSIST_SIM_MIN");
    expect(
      configError(() =>
        assertFinalHeldoutRun(hand({ profile: "heldout", finalHeldout: true }), absent, {
          path: join(scratch(), "jev-thresholds-choice.md"),
          committed: () => true,
        }),
      ).flag,
    ).toBe("--final-heldout");
  });

  it("exits 1 through the CLI before anything is replayed", async () => {
    const written: string[] = [];
    const stderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    };
    let code: number;
    try {
      code = await main(["run", "--profile", "heldout"], {});
    } finally {
      process.stderr.write = stderr;
    }
    expect(code).toBe(EXIT_USAGE);
    expect(written.join("")).toContain("--final-heldout");
  });
});

describe("the one run uses exactly the triple the pre-registered sweep chose", () => {
  const CHANGED: ChosenTriple = { persistSimMin: 0, reviewMin: 0.55, ticketMin: 0.9 };
  const CHANGED_ENV = {
    ...FINAL_ENV,
    GATE_PERSIST_SIM_MIN: "0",
    JEV_GATE_REVIEW_MIN_CONFIDENCE: "0.55",
    JEV_GATE_TICKET_MIN_CONFIDENCE: "0.9",
  };

  it("reads the committed record at tools/eval/records/jev-thresholds-choice.md by default", () => {
    expect(CHOICE_RECORD_FILE).toBe("tools/eval/records/jev-thresholds-choice.md");
    expect(choiceRecordPath()).toBe(join(REPO_ROOT, CHOICE_RECORD_FILE));
  });

  it("takes the chosen triple, set as the three variables", () => {
    const cfg = loadConfig(FINAL_ARGS, CHANGED_ENV, finalOptions(CHANGED));
    expect(cfg.persistSimMin).toBe(0);
    expect(cfg.jevGate).toEqual({ ticketMin: 0.9, reviewMin: 0.55 });
    // The rules and llm backends keep their own pair; the chosen N is the pipeline's.
    expect(cfg.gate).toEqual({ ticketMin: 0.85, reviewMin: 0.6 });
  });

  it("takes the committed choice with nothing set: each variable's default is the chosen triple", () => {
    const cfg = loadConfig(FINAL_ARGS, FINAL_ENV, finalOptions(CHOSEN));
    expect(cfg.persistSimMin).toBe(1);
    expect(cfg.jevGate).toEqual({ ticketMin: 0.85, reviewMin: 0.65 });
  });

  it("refuses a kept incumbent with nothing set, and takes it with its review threshold set", () => {
    // Jev's default review threshold is the choice's 0.65, so a record that kept 0.60 is refused.
    const error = configError(() => loadConfig(FINAL_ARGS, FINAL_ENV, finalOptions(KEPT)));
    expect(error.flag).toBe("JEV_GATE_REVIEW_MIN_CONFIDENCE");
    expect(error.message).toContain("JEV_GATE_REVIEW_MIN_CONFIDENCE=0.60, not 0.65");
    const cfg = loadConfig(
      FINAL_ARGS,
      { ...FINAL_ENV, JEV_GATE_REVIEW_MIN_CONFIDENCE: "0.6" },
      finalOptions(KEPT),
    );
    expect(cfg.jevGate).toEqual({ ticketMin: 0.85, reviewMin: 0.6 });
  });

  it.each([
    ["GATE_PERSIST_SIM_MIN", { GATE_PERSIST_SIM_MIN: "1" }, "GATE_PERSIST_SIM_MIN=0, not 1"],
    [
      "JEV_GATE_REVIEW_MIN_CONFIDENCE",
      { JEV_GATE_REVIEW_MIN_CONFIDENCE: "0.6" },
      "JEV_GATE_REVIEW_MIN_CONFIDENCE=0.55, not 0.60",
    ],
    [
      "JEV_GATE_TICKET_MIN_CONFIDENCE",
      { JEV_GATE_TICKET_MIN_CONFIDENCE: "0.95" },
      "JEV_GATE_TICKET_MIN_CONFIDENCE=0.90, not 0.95",
    ],
  ])("refuses any other %s, naming it", (flag, change, text) => {
    const error = configError(() =>
      loadConfig(FINAL_ARGS, { ...CHANGED_ENV, ...change }, finalOptions(CHANGED)),
    );
    expect(error.flag).toBe(flag);
    expect(error.exitCode).toBe(EXIT_USAGE);
    expect(error.message).toContain(text);
    expect(error.message).toContain(CHOICE_RECORD_FILE);
  });

  it("refuses the run before the choice is recorded", () => {
    const error = configError(() =>
      loadConfig(FINAL_ARGS, FINAL_ENV, {
        ...finalOptions(),
        choiceRecord: join(scratch(), "jev-thresholds-choice.md"),
      }),
    );
    expect(error.flag).toBe("--final-heldout");
    expect(error.message).toContain("the Jev thresholds are not fixed");
    expect(error.message).toContain("--record-choice");
  });

  it("refuses a record that is not committed, or changed since its commit", () => {
    const seen: string[] = [];
    const options = {
      ...finalOptions(),
      choiceCommitted: (path: string) => {
        seen.push(path);
        return false;
      },
    };
    const error = configError(() => loadConfig(FINAL_ARGS, FINAL_ENV, options));
    expect(error.flag).toBe("--final-heldout");
    expect(error.message).toMatch(/is not committed, or has changed since its commit/);
    expect(seen).toEqual([options.choiceRecord]);
  });

  it("refuses a record it cannot read as a triple, naming the file", () => {
    const path = join(scratch(), "jev-thresholds-choice.md");
    writeFileSync(path, "GATE_PERSIST_SIM_MIN=1\n", "utf8");
    const error = configError(() =>
      loadConfig(FINAL_ARGS, FINAL_ENV, { ...finalOptions(), choiceRecord: path }),
    );
    expect(error.flag).toBe("--final-heldout");
    expect(error.message).toContain(path);
  });

  it("never reads the record for any other run", () => {
    const unread = join(scratch(), "jev-thresholds-choice.md");
    writeFileSync(unread, "not a record\n", "utf8");
    const options = { cwd: CWD, choiceRecord: unread, choiceCommitted: () => false };
    expect(() => loadConfig(["--tuning"], { GATE_PERSIST_SIM_MIN: "0" }, options)).not.toThrow();
    expect(() => loadConfig(["--profile", "core"], {}, options)).not.toThrow();
  });

  const inRepository = gitSha() !== null;

  it.skipIf(!inRepository)("reads 'committed' as tracked and unchanged since HEAD", () => {
    // A sealed held-out file is tracked and never edited; a scratch file is not tracked.
    const sealed = join(REPO_ROOT, "tools/eval/scenarios/heldout_normal_aug01.json");
    expect(committedUnchanged(sealed)).toBe(true);
    expect(committedUnchanged(choiceRecord())).toBe(false);
    expect(committedUnchanged(join(REPO_ROOT, "tools/eval/records/no-such-record.md"))).toBe(false);
  });
});

describe("a held-out run is stopped before its first row", () => {
  /** A dev configuration turned into a held-out one by hand, which `loadConfig` would refuse. */
  function handMade(fields: Partial<EvalConfig>, env: Record<string, string> = {}): EvalConfig {
    const base = loadConfig(["--profile", "dev", "--backends", "jev"], env, { cwd: CWD });
    return { ...base, profile: HELDOUT_PROFILE, ...fields };
  }

  it("never selects, binds or replays without --final-heldout", async () => {
    const directory = scratch();
    asFile(heldoutDocument(), directory);
    const untouched = (): never => {
      throw new Error("a held-out scenario reached the replay");
    };
    const run = runEvaluation(handMade({ finalHeldout: false }), {
      scenariosDir: directory,
      log: createLogger({ env: {} }),
      requireRows: untouched,
      runScenario: untouched,
      loadCatalog: untouched,
      selectBackends: untouched,
    });
    await expect(run).rejects.toThrow(ConfigError);
    await expect(run).rejects.toThrow(/--final-heldout/);
  });

  it("is never planned by a mock replay that would not go on to run", async () => {
    const asked: unknown[] = [];
    const planner: LivePlanner = (_cfg, live) => {
      asked.push(live);
      return Promise.reject(new Error("the held-out set was planned"));
    };
    const cfg = handMade(
      { finalHeldout: true, confirmLive: false },
      { TYPESAFE_API_KEY: FAKE_KEY, EVAL_JEV_MODE: "live" },
    );
    const selection = selectBackends(cfg, {
      wall: createFakeWallClock(),
      log: createLogger({ env: {} }),
      plan: planner,
    });
    await expect(selection).rejects.toThrow(ConfigError);
    await expect(selection).rejects.toThrow(/--confirm-live/);
    expect(asked).toEqual([]);
  });
});
