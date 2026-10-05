// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `loadConfig` and `loadCatalog`.
//
// The defaults are the numbers the backend documents, a flag beats its
// variable, an empty variable is unset, every bad value names its flag, and no
// way of printing a configuration shows a secret. `--tuning` reads the tuning
// list, and `--exit-eval` checks E3's conditions.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { MINI_CATALOG_PATH, REFERENCE_CATALOG_PATH } from "./catalog/reference.ts";
import { CatalogError } from "./catalog/types.ts";
import { EXIT_USAGE } from "./cli.ts";
import {
  ConfigError,
  DEFAULTS,
  EvalSecrets,
  TUNING_PROFILE,
  gateFor,
  loadCatalog,
  loadConfig,
} from "./config.ts";
import { readChoiceRecord } from "./choice.ts";
import { createLogger } from "./log.ts";
import { REPO_ROOT } from "./slices.ts";

/** Stand-ins that look nothing like a real key, grepped for in every rendering. */
const TYPESAFE_KEY = "tsk-test-config-0001";
const LLM_KEY = "llm-test-config-0002";
const DB_URL = "postgres://eval:pw-test-config-0003@localhost:5432/fdp";

const CWD = "/work/here";

const temporary: string[] = [];

afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-config-"));
  temporary.push(directory);
  return directory;
}

/** The ConfigError `run` throws, for asserting on its flag. */
function configError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("defaults", () => {
  const config = loadConfig([], {}, { cwd: CWD });

  it("are the harness's and the backend's documented values", () => {
    expect(config.profile).toBe("core");
    expect(config.backends).toEqual(["rules", "von"]);
    expect(config.scenarios).toEqual([]);
    expect(config.catalog).toEqual({ kind: "reference" });
    expect(config.record).toBe(false);
    expect(config.confirmLive).toBe(false);
    expect(config.jobs).toBe(1);
    expect(config.seed).toBeUndefined();
    expect(config.failOnGate).toBe(false);
    expect(config.vonMode).toBe("auto");
    expect(config.typesafeBaseUrl).toBe("https://api.typesafe.ai");
    expect(config.vonModel).toBe("von-1.13.0");
    expect(config.llmProvider).toBe("anthropic");
    expect(config.llmModel).toBe("claude-opus-5");
    expect(config.prices).toEqual({
      vonInputPerMtok: 0.042,
      llmInputPerMtok: 5,
      llmOutputPerMtok: 25,
      asOf: "2026-09-19",
    });
    expect(config.gate).toEqual({ ticketMin: 0.85, reviewMin: 0.6 });
    // Von's own pair defaults to the pre-registered choice.
    expect(config.vonGate).toEqual({ ticketMin: 0.85, reviewMin: 0.65 });
    expect(DEFAULTS.vonGate).toEqual({ ticketMin: 0.85, reviewMin: 0.65 });
    expect(config.decisionIntervalSimMin).toBe(30);
    expect(config.episodeClearSimMin).toBe(120);
    expect(config.persistSimMin).toBe(1);
    expect(config.rulesDisabled).toEqual(["flow_pulses_missing"]);
    expect(config.resample).toBe(0);
    expect(config.help).toBe(false);
  });

  it("puts the default paths under the repository, not under the working directory", () => {
    expect(config.outDir).toBe(join(REPO_ROOT, "reports/eval"));
    expect(config.csvPath).toBe(join(REPO_ROOT, "data/metropt3/MetroPT3(AirCompressor).csv"));
  });

  it("holds no secret when none is set", () => {
    expect(config.secrets.typesafeApiKey).toBeUndefined();
    expect(config.secrets.llmApiKey).toBeUndefined();
    expect(config.secrets.dbUrl).toBeUndefined();
  });

  it("is frozen", () => {
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
  });
});

describe("flags and the environment", () => {
  it("lets a flag beat its variable", () => {
    expect(loadConfig(["--profile", "smoke"], { EVAL_PROFILE: "full" }, { cwd: CWD }).profile).toBe(
      "smoke",
    );
    expect(loadConfig([], { EVAL_PROFILE: "full" }, { cwd: CWD }).profile).toBe("full");
  });

  it("reads every flag of fdp-eval run", () => {
    const config = loadConfig(
      [
        "--backends",
        "von, rules",
        "--scenario",
        "f3_air_leak_jun05",
        "--scenario",
        "baseline_feb03_normal",
        "--scenario",
        "f3_air_leak_jun05",
        "--record",
        "--confirm-live",
        "--out",
        "out/here",
        "--jobs",
        "4",
        "--seed",
        "11",
        "--fail-on-gate",
        "--help",
      ],
      {},
      { cwd: CWD },
    );
    expect(config.backends).toEqual(["von", "rules"]);
    expect(config.scenarios).toEqual(["f3_air_leak_jun05", "baseline_feb03_normal"]);
    expect(config.record).toBe(true);
    expect(config.confirmLive).toBe(true);
    expect(config.outDir).toBe("/work/here/out/here");
    expect(config.jobs).toBe(4);
    expect(config.seed).toBe(11);
    expect(config.failOnGate).toBe(true);
    expect(config.help).toBe(true);
  });

  it("passes the pipeline and factory variables on", () => {
    const config = loadConfig(
      [],
      {
        EVAL_VON_MODE: "mock",
        METROPT_CSV: "/data/full.csv",
        TYPESAFE_BASE_URL: "http://127.0.0.1:8089",
        VON_MODEL: "von-1.14.2",
        LLM_MODEL: "claude-test",
        VON_PRICE_INPUT_PER_MTOK: "0.05",
        LLM_PRICE_INPUT_PER_MTOK: "3",
        LLM_PRICE_OUTPUT_PER_MTOK: "15",
        PRICES_AS_OF: "2026-10-01",
        GATE_TICKET_MIN_CONFIDENCE: "0.9",
        GATE_REVIEW_MIN_CONFIDENCE: "0.5",
        DECISION_INTERVAL_SIM_MIN: "15",
        EPISODE_CLEAR_SIM_MIN: "60",
        GATE_PERSIST_SIM_MIN: "0",
        RULES_DISABLED: "flow_pulses_missing, low_oil_level",
      },
      { cwd: CWD },
    );
    expect(config.vonMode).toBe("mock");
    expect(config.csvPath).toBe("/data/full.csv");
    expect(config.typesafeBaseUrl).toBe("http://127.0.0.1:8089");
    expect(config.vonModel).toBe("von-1.14.2");
    expect(config.llmModel).toBe("claude-test");
    expect(config.prices).toEqual({
      vonInputPerMtok: 0.05,
      llmInputPerMtok: 3,
      llmOutputPerMtok: 15,
      asOf: "2026-10-01",
    });
    expect(config.gate).toEqual({ ticketMin: 0.9, reviewMin: 0.5 });
    // Unset, Von's pair is the pre-registered choice, wherever the global pair is set.
    expect(config.vonGate).toEqual({ ticketMin: 0.85, reviewMin: 0.65 });
    expect(config.decisionIntervalSimMin).toBe(15);
    expect(config.episodeClearSimMin).toBe(60);
    expect(config.persistSimMin).toBe(0);
    expect(config.rulesDisabled).toEqual(["flow_pulses_missing", "low_oil_level"]);
  });

  it("reads an empty variable as unset", () => {
    const config = loadConfig(
      [],
      { EVAL_PROFILE: "", VON_MODEL: "", RULES_DISABLED: "", TYPESAFE_API_KEY: "" },
      { cwd: CWD },
    );
    expect(config.profile).toBe("core");
    expect(config.vonModel).toBe("von-1.13.0");
    expect(config.rulesDisabled).toEqual(["flow_pulses_missing"]);
    expect(config.secrets.typesafeApiKey).toBeUndefined();
  });

  it("resolves a relative METROPT_CSV against the working directory", () => {
    expect(loadConfig([], { METROPT_CSV: "full.csv" }, { cwd: CWD }).csvPath).toBe(
      "/work/here/full.csv",
    );
  });

  it("takes pnpm's INIT_CWD as the working directory when none is given", () => {
    expect(loadConfig(["--out", "mine"], { INIT_CWD: "/from/pnpm" }).outDir).toBe(
      "/from/pnpm/mine",
    );
  });

  it("reads Von's own pair, defaulting to the pre-registered choice, and gates each backend with its own", () => {
    const config = loadConfig(
      [],
      { VON_GATE_TICKET_MIN_CONFIDENCE: "0.9", VON_GATE_REVIEW_MIN_CONFIDENCE: "" },
      { cwd: CWD },
    );
    expect(config.vonGate).toEqual({ ticketMin: 0.9, reviewMin: 0.65 });
    expect(config.gate).toEqual({ ticketMin: 0.85, reviewMin: 0.6 });
    expect(gateFor(config, "von")).toEqual({ ticketMin: 0.9, reviewMin: 0.65 });
    expect(gateFor(config, "rules")).toEqual({ ticketMin: 0.85, reviewMin: 0.6 });
    expect(gateFor(config, "llm")).toEqual({ ticketMin: 0.85, reviewMin: 0.6 });
  });

  it("never moves Von's default pair with GATE_*, so a rules-only pair still loads", () => {
    const config = loadConfig(
      [],
      { GATE_TICKET_MIN_CONFIDENCE: "0.6", GATE_REVIEW_MIN_CONFIDENCE: "0.5" },
      { cwd: CWD },
    );
    expect(config.gate).toEqual({ ticketMin: 0.6, reviewMin: 0.5 });
    expect(config.vonGate).toEqual({ ticketMin: 0.85, reviewMin: 0.65 });
    // The pair the tuning recordings were made at can still be set explicitly.
    expect(loadConfig([], { VON_GATE_REVIEW_MIN_CONFIDENCE: "0.6" }, { cwd: CWD }).vonGate).toEqual(
      { ticketMin: 0.85, reviewMin: 0.6 },
    );
  });

  it("defaults to exactly the triple of the committed pre-registered choice", () => {
    // tools/eval/records/von-thresholds-choice.md is the source; the code defaults carry it.
    const chosen = readChoiceRecord();
    expect(chosen).toEqual({
      persistSimMin: DEFAULTS.persistSimMin,
      reviewMin: DEFAULTS.vonGate.reviewMin,
      ticketMin: DEFAULTS.vonGate.ticketMin,
    });
    const config = loadConfig([], {}, { cwd: CWD });
    expect({
      persistSimMin: config.persistSimMin,
      reviewMin: config.vonGate.reviewMin,
      ticketMin: config.vonGate.ticketMin,
    }).toEqual(chosen);
  });

  it("reads --resample as a whole number, 0 by default", () => {
    expect(loadConfig(["--resample", "3"], {}, { cwd: CWD }).resample).toBe(3);
    expect(loadConfig(["--resample", "0"], {}, { cwd: CWD }).resample).toBe(0);
  });
});

describe("--tuning and --exit-eval", () => {
  it("are off by default", () => {
    const config = loadConfig([], {}, { cwd: CWD });
    expect(config.exitEval).toBeUndefined();
    expect(config.profile).not.toBe(TUNING_PROFILE);
  });

  it("records a --tuning run under the tuning profile", () => {
    expect(loadConfig(["--tuning"], {}, { cwd: CWD }).profile).toBe(TUNING_PROFILE);
    expect(TUNING_PROFILE).toBe("tuning");
  });

  it("lets --tuning beat EVAL_PROFILE, which it does not read at all", () => {
    expect(loadConfig(["--tuning"], { EVAL_PROFILE: "core" }, { cwd: CWD }).profile).toBe(
      TUNING_PROFILE,
    );
    expect(loadConfig(["--tuning"], { EVAL_PROFILE: "nightly" }, { cwd: CWD }).profile).toBe(
      TUNING_PROFILE,
    );
  });

  it("reads --exit-eval e3, with --fail-on-gate or without it", () => {
    expect(loadConfig(["--exit-eval", "e3"], {}, { cwd: CWD })).toMatchObject({
      exitEval: "e3",
      failOnGate: false,
    });
    expect(
      loadConfig(["--exit-eval", "e3", "--fail-on-gate", "--backends", "rules"], {}, { cwd: CWD }),
    ).toMatchObject({ exitEval: "e3", failOnGate: true, backends: ["rules"] });
  });

  it("takes --exit-eval and --tuning together", () => {
    expect(loadConfig(["--tuning", "--exit-eval", "e3"], {}, { cwd: CWD })).toMatchObject({
      profile: TUNING_PROFILE,
      exitEval: "e3",
    });
  });
});

describe("validation", () => {
  const cases: readonly {
    readonly name: string;
    readonly argv?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly flag: string;
  }[] = [
    { name: "an unknown profile", argv: ["--profile", "nightly"], flag: "--profile" },
    { name: "an unknown profile variable", env: { EVAL_PROFILE: "nightly" }, flag: "EVAL_PROFILE" },
    { name: "an unknown backend", argv: ["--backends", "rules,gpt"], flag: "--backends" },
    { name: "an empty backend list", argv: ["--backends", " , "], flag: "--backends" },
    { name: "a repeated backend", argv: ["--backends", "von,von"], flag: "--backends" },
    { name: "a malformed scenario id", argv: ["--scenario", "F3"], flag: "--scenario" },
    { name: "an unknown catalog source", argv: ["--catalog", "pdf"], flag: "--catalog" },
    { name: "a file: catalog with no path", argv: ["--catalog", "file:"], flag: "--catalog" },
    {
      name: "a file: catalog that does not exist",
      argv: ["--catalog", "file:/no/such/catalog.json"],
      flag: "--catalog",
    },
    {
      name: "the ingested catalog without --db-url",
      argv: ["--catalog", "ingested"],
      flag: "--db-url",
    },
    { name: "zero jobs", argv: ["--jobs", "0"], flag: "--jobs" },
    { name: "fractional jobs", argv: ["--jobs", "1.5"], flag: "--jobs" },
    { name: "a negative seed", argv: ["--seed", "-3"], flag: "--seed" },
    { name: "a seed that is not a number", argv: ["--seed", "seven"], flag: "--seed" },
    { name: "an unknown flag", argv: ["--verbose"], flag: "--verbose" },
    { name: "a flag without its value", argv: ["--profile"], flag: "--profile" },
    { name: "a positional argument", argv: ["smoke"], flag: "arguments" },
    { name: "an unknown Von mode", env: { EVAL_VON_MODE: "replay" }, flag: "EVAL_VON_MODE" },
    { name: "a Von alias", env: { VON_MODEL: "von-latest" }, flag: "VON_MODEL" },
    {
      name: "a base URL that is not one",
      env: { TYPESAFE_BASE_URL: "api" },
      flag: "TYPESAFE_BASE_URL",
    },
    {
      name: "a base URL that is not http",
      env: { TYPESAFE_BASE_URL: "ftp://api.example" },
      flag: "TYPESAFE_BASE_URL",
    },
    { name: "another LLM provider", env: { LLM_PROVIDER: "other" }, flag: "LLM_PROVIDER" },
    {
      name: "a negative price",
      env: { VON_PRICE_INPUT_PER_MTOK: "-1" },
      flag: "VON_PRICE_INPUT_PER_MTOK",
    },
    {
      name: "a price day that is not one",
      env: { PRICES_AS_OF: "2026-13-45" },
      flag: "PRICES_AS_OF",
    },
    {
      name: "a threshold above one",
      env: { GATE_TICKET_MIN_CONFIDENCE: "1.2" },
      flag: "GATE_TICKET_MIN_CONFIDENCE",
    },
    {
      name: "a review threshold above the ticket threshold",
      env: { GATE_TICKET_MIN_CONFIDENCE: "0.5", GATE_REVIEW_MIN_CONFIDENCE: "0.7" },
      flag: "GATE_REVIEW_MIN_CONFIDENCE",
    },
    {
      name: "a Von threshold above one",
      env: { VON_GATE_TICKET_MIN_CONFIDENCE: "1.2" },
      flag: "VON_GATE_TICKET_MIN_CONFIDENCE",
    },
    {
      name: "a Von review threshold above the ticket threshold Von resolves to",
      env: { VON_GATE_REVIEW_MIN_CONFIDENCE: "0.9" },
      flag: "VON_GATE_REVIEW_MIN_CONFIDENCE",
    },
    {
      name: "a Von ticket threshold set alone below Von's default review threshold",
      env: { VON_GATE_TICKET_MIN_CONFIDENCE: "0.6" },
      flag: "VON_GATE_REVIEW_MIN_CONFIDENCE",
    },
    { name: "a negative resample", argv: ["--resample", "-1"], flag: "--resample" },
    { name: "a resample that is not a number", argv: ["--resample", "two"], flag: "--resample" },
    { name: "a fractional resample", argv: ["--resample", "1.5"], flag: "--resample" },
    {
      name: "a zero decision interval",
      env: { DECISION_INTERVAL_SIM_MIN: "0" },
      flag: "DECISION_INTERVAL_SIM_MIN",
    },
    {
      name: "an episode clear time that is not a number",
      env: { EPISODE_CLEAR_SIM_MIN: "two hours" },
      flag: "EPISODE_CLEAR_SIM_MIN",
    },
    {
      name: "a negative persistence before the ticket",
      env: { GATE_PERSIST_SIM_MIN: "-1" },
      flag: "GATE_PERSIST_SIM_MIN",
    },
    { name: "--tuning with --profile", argv: ["--tuning", "--profile", "dev"], flag: "--tuning" },
    {
      name: "--tuning with --scenario",
      argv: ["--tuning", "--scenario", "frozen_logger_jun22"],
      flag: "--tuning",
    },
    { name: "an exit eval other than e3", argv: ["--exit-eval", "x"], flag: "--exit-eval" },
    {
      name: "an exit eval without the rules backend it judges",
      argv: ["--exit-eval", "e3", "--backends", "von"],
      flag: "--exit-eval",
    },
  ];

  it.each(cases)("refuses $name and names $flag", ({ argv = [], env = {}, flag }) => {
    const error = configError(() => loadConfig(argv, env, { cwd: CWD }));
    expect(error.flag).toBe(flag);
    expect(error.message.startsWith(`${flag}: `)).toBe(true);
    expect(error.exitCode).toBe(EXIT_USAGE);
    expect(EXIT_USAGE).toBe(1);
  });

  it("never quotes a secret back in an error", () => {
    const error = configError(() =>
      loadConfig(
        ["--catalog", "pdf"],
        { TYPESAFE_API_KEY: TYPESAFE_KEY, LLM_API_KEY: LLM_KEY },
        {
          cwd: CWD,
        },
      ),
    );
    expect(error.message).not.toContain(TYPESAFE_KEY);
    expect(error.message).not.toContain(LLM_KEY);
  });
});

describe("secrets", () => {
  const config = loadConfig(
    ["--catalog", "ingested", "--db-url", DB_URL],
    { TYPESAFE_API_KEY: TYPESAFE_KEY, LLM_API_KEY: LLM_KEY },
    { cwd: CWD },
  );

  it("hands each value out through its getter", () => {
    expect(config.secrets.typesafeApiKey).toBe(TYPESAFE_KEY);
    expect(config.secrets.llmApiKey).toBe(LLM_KEY);
    expect(config.secrets.dbUrl).toBe(DB_URL);
    expect(config.catalog).toEqual({ kind: "ingested" });
  });

  it("redacts them in every rendering of the configuration", () => {
    const renderings = [
      JSON.stringify(config),
      JSON.stringify(config.secrets),
      String(config.secrets),
      `${config.secrets}`,
      inspect(config, { depth: 10, showHidden: true }),
      inspect(config.secrets),
      JSON.stringify({ ...config.secrets }),
    ];
    for (const text of renderings) {
      expect(text).not.toContain(TYPESAFE_KEY);
      expect(text).not.toContain(LLM_KEY);
      expect(text).not.toContain("pw-test-config-0003");
    }
    expect(JSON.parse(JSON.stringify(config)).secrets).toBe("[redacted]");
  });

  it("stays redacted through the harness logger", () => {
    const lines: string[] = [];
    const log = createLogger({ env: {}, stream: { write: (chunk) => lines.push(chunk) } });
    log.info("configuration", { config });
    const written = lines.join("");
    expect(written).toContain("[redacted]");
    expect(written).not.toContain(TYPESAFE_KEY);
    expect(written).not.toContain(LLM_KEY);
    expect(written).not.toContain("pw-test-config-0003");
  });

  it("builds an empty set by default", () => {
    const secrets = new EvalSecrets();
    expect(secrets.typesafeApiKey).toBeUndefined();
    expect(JSON.stringify(secrets)).toBe('"[redacted]"');
  });
});

describe("catalog sources", () => {
  const secrets = new EvalSecrets();

  it("parses reference, file:<path> and ingested", () => {
    expect(loadConfig(["--catalog", "reference"], {}, { cwd: CWD }).catalog).toEqual({
      kind: "reference",
    });
    expect(
      loadConfig(["--catalog", `file:${REFERENCE_CATALOG_PATH}`], {}, { cwd: CWD }).catalog,
    ).toEqual({ kind: "file", path: REFERENCE_CATALOG_PATH });
    expect(
      loadConfig(["--catalog", "ingested", "--db-url", DB_URL], {}, { cwd: CWD }).catalog,
    ).toEqual({ kind: "ingested" });
  });

  it("resolves a relative file: path against the working directory", () => {
    const directory = scratch();
    writeFileSync(join(directory, "catalog.json"), "{}", "utf8");
    expect(loadConfig(["--catalog", "file:catalog.json"], {}, { cwd: directory }).catalog).toEqual({
      kind: "file",
      path: join(directory, "catalog.json"),
    });
  });

  it("loads the reference catalog", async () => {
    const catalog = await loadCatalog({ kind: "reference" }, secrets, MINI_CATALOG_PATH);
    expect(catalog.source).toBe("reference");
    expect(catalog.name).toBe("reference");
    expect(catalog.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(catalog.entries.length).toBeGreaterThan(0);
  });

  it("loads a contracts catalog document named by file:", async () => {
    const catalog = await loadCatalog({ kind: "file", path: REFERENCE_CATALOG_PATH }, secrets);
    expect(catalog.source).toBe("file");
    expect(catalog.name).toBe(`file:${REFERENCE_CATALOG_PATH}`);
    expect(catalog.entries.length).toBeGreaterThan(0);
  });

  it("exposes the reference catalog's conditions with their symptoms", async () => {
    const catalog = await loadCatalog({ kind: "reference" }, secrets, MINI_CATALOG_PATH);
    expect(catalog.conditions.map((condition) => condition.condition_id)).toEqual([
      "low_line_pressure",
      "continuous_load",
      "purge_pressure_high",
      "oil_temperature_high",
    ]);
    for (const condition of catalog.conditions) {
      expect(condition.symptoms.length).toBeGreaterThan(0);
    }
  });

  it("exposes a file: catalog's conditions with their symptom sentence", async () => {
    const catalog = await loadCatalog({ kind: "file", path: REFERENCE_CATALOG_PATH }, secrets);
    const document = JSON.parse(readFileSync(REFERENCE_CATALOG_PATH, "utf8")) as {
      conditions: { id: string; symptom: string }[];
    };
    expect(catalog.conditions.map((condition) => condition.condition_id)).toEqual(
      document.conditions.map((condition) => condition.id),
    );
    expect(catalog.conditions.map((condition) => condition.symptoms)).toEqual(
      document.conditions.map((condition) => [condition.symptom]),
    );
  });

  it("adds a file: condition's further wordings after its symptom", async () => {
    const document = JSON.parse(readFileSync(REFERENCE_CATALOG_PATH, "utf8")) as {
      conditions: { symptom: string; symptoms?: string[] }[];
    };
    const first = document.conditions[0];
    if (first === undefined) throw new Error("the reference catalog declares no condition");
    first.symptoms = ["Consumers complain of weak tools.", first.symptom];
    const path = join(scratch(), "with-wordings.json");
    writeFileSync(path, JSON.stringify(document), "utf8");

    const catalog = await loadCatalog({ kind: "file", path }, secrets);
    expect(catalog.conditions[0]?.symptoms).toEqual([
      first.symptom,
      "Consumers complain of weak tools.",
    ]);
  });

  it("refuses a file: document that is not a contracts catalog", async () => {
    // The committed mini catalog is an older shape: fine for the reference loader, not
    // the document `fdp-init export-catalog` writes.
    await expect(loadCatalog({ kind: "file", path: MINI_CATALOG_PATH }, secrets)).rejects.toThrow(
      CatalogError,
    );

    const directory = scratch();
    const broken = join(directory, "broken.json");
    writeFileSync(broken, "{ not json", "utf8");
    await expect(loadCatalog({ kind: "file", path: broken }, secrets)).rejects.toThrow(
      /not a readable JSON document/,
    );
  });

  it("validates the whole document, not only its causes", async () => {
    const directory = scratch();
    const document = JSON.parse(readFileSync(REFERENCE_CATALOG_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    delete document["alarms"];
    const path = join(directory, "no-alarms.json");
    writeFileSync(path, JSON.stringify(document), "utf8");
    await expect(loadCatalog({ kind: "file", path }, secrets)).rejects.toThrow(
      /not a contracts catalog document/,
    );
  });

  it("asks for a database URL before reading the ingested catalog", async () => {
    await expect(loadCatalog({ kind: "ingested" }, secrets)).rejects.toThrow(ConfigError);
  });
});
