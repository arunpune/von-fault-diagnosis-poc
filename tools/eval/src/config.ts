// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The environment and the flags of `fdp-eval run`, read once into one frozen
// value (docs/evaluation.md, "Running a profile", lists them).
//
// Three rules shape this file.
//
// **Flags win over the environment.** `--profile smoke` beats
// `EVAL_PROFILE=core`; every other variable is passed on unchanged to the
// pipeline configuration and the backend factories, with the backend's own
// defaults, so a run and the runtime read the same numbers. An empty variable
// counts as unset, because that is what `.env.example` hands a user who copied
// it without filling it in.
//
// **A bad value is a usage error that names its source.** Every problem throws
// a `ConfigError` whose `flag` is the flag or variable to fix and whose
// `exitCode` is the usage code, so the command prints one line and exits 1.
// No value of a secret variable is ever quoted back, even when it is wrong.
//
// **Secrets are opaque.** The two API keys and the database URL (which carries
// the eval role's password) live on `EvalSecrets`, whose fields are private and
// whose `toJSON`, `toString` and inspector all answer `[redacted]`, so logging
// or serialising a whole configuration cannot leak them. They leave the object
// only through the getters, at the factory that needs them.
//
// The catalog source is parsed here too, and `loadCatalog` turns it into the
// entries the retriever reads: `reference` is the fixture `make manual` writes,
// `file:<path>` is a contracts `catalog` document — validated on load, which is
// how the catalog `fdp-init export-catalog` extracts from the realistic PDF is
// scored as the headline — and `ingested` reads `app.v_catalog_entries` through
// `src/catalog/ingested.ts`.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";

import { validate } from "@fdp/contracts";

import { loadReferenceCatalog, REFERENCE_CATALOG_PATH } from "./catalog/reference.ts";
import { CatalogError } from "./catalog/types.ts";
import type { CatalogEntry, EvalCondition } from "./catalog/types.ts";
import {
  CHOICE_RECORD_FILE,
  ChoiceRecordError,
  choiceRecordPath,
  committedUnchanged,
  readChoiceRecord,
} from "./choice.ts";
import { EXIT_USAGE } from "./cli.ts";
import {
  FINAL_HELDOUT_FLAG,
  FINAL_RUN_RECORD_FILE,
  HELDOUT_PROFILE,
  HELDOUT_SEAL_FILE,
  finalRunRecordPath,
  finalRunRecorded,
} from "./heldout.ts";
import { REDACTED } from "./log.ts";
import type { Prices } from "./metrics/types.ts";
import { PROFILES } from "./scenario/schema.ts";
import type { Profile } from "./scenario/schema.ts";
import { REPO_ROOT } from "./slices.ts";

/** The decision backends a run may compare. */
export const BACKEND_NAMES = ["rules", "von", "llm"] as const;

export type BackendName = (typeof BACKEND_NAMES)[number];

/** How the Von backend is reached; `auto` picks by keys and cassettes. */
export const VON_MODES = ["auto", "live", "cassette", "mock"] as const;

export type VonMode = (typeof VON_MODES)[number];

/** Where the fault catalog of a run comes from. */
export type CatalogSource =
  | { readonly kind: "reference" }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "ingested" };

/**
 * The profile a `--tuning` run is recorded under, and the suffix of its run id. It is not
 * a scenario profile: the run replays the explicit list of `src/tuning.ts`.
 */
export const TUNING_PROFILE = "tuning";

/** What a run replays: a scenario profile, or the tuning list. */
export type RunProfile = Profile | typeof TUNING_PROFILE;

/**
 * The exit evals `--exit-eval` can check beside the core-10 gate's counts. E3 is the only one whose
 * conditions a run of this harness can see; the others are read from other tools.
 */
export const EXIT_EVALS = ["e3"] as const;

export type ExitEvalName = (typeof EXIT_EVALS)[number];

/** The confidence gate's two thresholds. */
export interface GateThresholds {
  readonly ticketMin: number;
  readonly reviewMin: number;
}

/** Everything one `fdp-eval run` is configured with. */
export interface EvalConfig {
  /** The profile, or `tuning` when `--tuning` replaced it. */
  readonly profile: RunProfile;
  /** The backends to compare, in the order the report lists them. */
  readonly backends: readonly BackendName[];
  /** `--scenario` ids; empty means every scenario of the profile. */
  readonly scenarios: readonly string[];
  readonly catalog: CatalogSource;
  /** `--record`: write every live answer as a cassette. */
  readonly record: boolean;
  /** `--confirm-live`: the explicit consent a live mode needs before it calls the API. */
  readonly confirmLive: boolean;
  /** Absolute directory the reports are written under. */
  readonly outDir: string;
  readonly jobs: number;
  /** `--seed`, overriding every scenario's own seed when set. */
  readonly seed: number | undefined;
  readonly failOnGate: boolean;
  /**
   * `--final-heldout`: this is the held-out set's one final run
   * (tools/eval/records/heldout-seal.md). The `heldout` profile is refused without it, and it is
   * refused with any other profile.
   */
  readonly finalHeldout: boolean;
  /** `--exit-eval`: the exit eval whose every condition the run checks, or `undefined`. */
  readonly exitEval: ExitEvalName | undefined;
  readonly vonMode: VonMode;
  /** Absolute path of the full MetroPT-3 CSV, for `source.kind = csv`. */
  readonly csvPath: string;
  readonly typesafeBaseUrl: string;
  readonly vonModel: string;
  readonly llmProvider: string;
  readonly llmModel: string;
  readonly prices: Prices;
  /** `GATE_TICKET_MIN_CONFIDENCE` and `GATE_REVIEW_MIN_CONFIDENCE`: the rules and llm backends' pair. */
  readonly gate: GateThresholds;
  /**
   * Von's own pair: `VON_GATE_TICKET_MIN_CONFIDENCE` and `VON_GATE_REVIEW_MIN_CONFIDENCE`, 0.85
   * and 0.65 by default (`DEFAULTS.vonGate`, the pre-registered choice), independent of
   * `GATE_*`. `gateFor` picks a backend's pair.
   */
  readonly vonGate: GateThresholds;
  readonly decisionIntervalSimMin: number;
  readonly episodeClearSimMin: number;
  /**
   * `GATE_PERSIST_SIM_MIN`: sim minutes a symptom's evidence must have held
   * without a break before an episode that owns no ticket is decided; 0 decides at once.
   */
  readonly persistSimMin: number;
  readonly rulesDisabled: readonly string[];
  /**
   * `--resample <n>`: which rotation of each repeated request's recorded answers a cassette run
   * serves (`backends/cassette-server.ts`); 0, the default, replays the recording in the order it
   * was received. Cassette mode only.
   */
  readonly resample: number;
  /**
   * Cassette mode: serve only a recording that says it was made at `persistSimMin`, so a cassette
   * recorded before recordings were told apart is a miss (`backends/cassette.ts`). Set by the
   * pre-registered sweep, which reads each N on the recording made at N and on no other; no flag
   * or variable sets it.
   */
  readonly cassetteOwnRecordingOnly?: boolean;
  /** `--help`: the command prints its usage and runs nothing. */
  readonly help: boolean;
  readonly secrets: EvalSecrets;
}

/** The environment as a process sees it; values may be absent. */
export type Env = Readonly<Record<string, string | undefined>>;

/** Where relative paths are resolved from; the invoking directory by default. */
export interface LoadConfigOptions {
  readonly cwd?: string;
  /** The held-out set's final-run record; `tools/eval/records/heldout-final-run.md` by default. */
  readonly finalRunRecord?: string;
  /**
   * The pre-registered sweep's committed choice, which the held-out set's one run reads;
   * `tools/eval/records/von-thresholds-choice.md` by default.
   */
  readonly choiceRecord?: string;
  /** Whether that record is committed and unchanged since; asks Git by default. */
  readonly choiceCommitted?: (path: string) => boolean;
}

/** A configuration value that cannot be used, named by the flag or variable that set it. */
export class ConfigError extends Error {
  /** The flag (`--jobs`) or variable (`VON_MODEL`) to fix. */
  readonly flag: string;
  /** A usage or configuration error exits 1. */
  readonly exitCode: number = EXIT_USAGE;

  constructor(flag: string, problem: string) {
    super(`${flag}: ${problem}`);
    this.name = "ConfigError";
    this.flag = flag;
  }
}

/** What `EvalSecrets` is built from; any of the three may be absent. */
export interface SecretValues {
  readonly typesafeApiKey?: string;
  readonly llmApiKey?: string;
  readonly dbUrl?: string;
}

/**
 * The values a run must never print: the TypeSafe and LLM keys and the database URL.
 *
 * The fields are private, so spreading or walking the object finds nothing, and every way
 * Node renders a value — `JSON.stringify`, template strings, `util.inspect` — answers
 * `[redacted]`. The getters are the one way out, called where a factory needs the value.
 */
export class EvalSecrets {
  readonly #typesafeApiKey: string | undefined;
  readonly #llmApiKey: string | undefined;
  readonly #dbUrl: string | undefined;

  constructor(values: SecretValues = {}) {
    this.#typesafeApiKey = values.typesafeApiKey;
    this.#llmApiKey = values.llmApiKey;
    this.#dbUrl = values.dbUrl;
  }

  /** `TYPESAFE_API_KEY`, or `undefined` when unset. */
  get typesafeApiKey(): string | undefined {
    return this.#typesafeApiKey;
  }

  /** `LLM_API_KEY`, or `undefined` when unset. */
  get llmApiKey(): string | undefined {
    return this.#llmApiKey;
  }

  /** `--db-url`, the eval role's connection string, or `undefined` when not given. */
  get dbUrl(): string | undefined {
    return this.#dbUrl;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

/** The defaults of the harness and the backend. */
export const DEFAULTS = Object.freeze({
  profile: "core" as Profile,
  backends: Object.freeze(["rules", "von"] as BackendName[]),
  vonMode: "auto" as VonMode,
  outDir: "reports/eval",
  jobs: 1,
  csvPath: "data/metropt3/MetroPT3(AirCompressor).csv",
  typesafeBaseUrl: "https://api.typesafe.ai",
  vonModel: "von-1.13.0",
  llmProvider: "anthropic",
  llmModel: "claude-opus-5",
  prices: Object.freeze({
    vonInputPerMtok: 0.042,
    llmInputPerMtok: 5,
    llmOutputPerMtok: 25,
    asOf: "2026-09-19",
  }),
  gate: Object.freeze({ ticketMin: 0.85, reviewMin: 0.6 }),
  /** Von's own pair, not GATE_*: the choice in tools/eval/records/von-thresholds-choice.md. */
  vonGate: Object.freeze({ ticketMin: 0.85, reviewMin: 0.65 }),
  decisionIntervalSimMin: 30,
  episodeClearSimMin: 120,
  persistSimMin: 1,
  rulesDisabled: Object.freeze(["flow_pulses_missing"]),
});

/** The one LLM provider the backend implements. */
const LLM_PROVIDERS = ["anthropic"] as const;

/** A pinned Von version; aliases such as `von-latest` would make a run unrepeatable. */
const VON_MODEL_PATTERN = /^von-\d+\.\d+\.\d+$/;

/** The scenario id grammar of `scenario.schema.json`. */
const SCENARIO_ID_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

/** `PRICES_AS_OF`: a calendar day. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The `--catalog` prefix of a catalog document on disk. */
const FILE_PREFIX = "file:";

/** The flags of `fdp-eval run`, for `parseArgs` and for the usage text. */
const OPTIONS = {
  profile: { type: "string" },
  backends: { type: "string" },
  scenario: { type: "string", multiple: true },
  catalog: { type: "string" },
  "db-url": { type: "string" },
  record: { type: "boolean" },
  "confirm-live": { type: "boolean" },
  out: { type: "string" },
  jobs: { type: "string" },
  seed: { type: "string" },
  "fail-on-gate": { type: "boolean" },
  "exit-eval": { type: "string" },
  tuning: { type: "boolean" },
  resample: { type: "string" },
  "final-heldout": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** One line per flag, for the `--help` of the commands that read this configuration. */
export const CONFIG_USAGE = [
  "  --profile <smoke|core|dev|full|heldout>",
  "                                    scenarios to run (EVAL_PROFILE, default core);",
  "                                    heldout only with --final-heldout",
  "  --tuning                          replay the tuning list instead of a profile;",
  "                                    not with --profile or --scenario",
  "  --backends <rules,von[,llm]>      backends to compare (default rules,von)",
  "  --scenario <id>                   only this scenario; repeatable",
  "  --catalog <reference|file:<path>|ingested>   fault catalog source (default reference)",
  "  --db-url <url>                    eval-role database URL, for --catalog ingested",
  "  --record                          record live Von answers as cassettes",
  "  --confirm-live                    allow a live mode to call the API",
  "  --out <dir>                       report directory (default reports/eval)",
  "  --jobs <n>                        parallel workers (default 1)",
  "  --seed <n>                        override every scenario's seed",
  "  --fail-on-gate                    exit 2 when the core-10 gate fails",
  "  --exit-eval <e3>                  check every E3 condition the run can see; exit 2 when one fails",
  "  --resample <n>                    cassette mode: serve the n-th rotation of each repeated",
  "                                    request's recorded answers (default 0, as recorded)",
  "  --final-heldout                   the held-out set's one run, once the Von thresholds are",
  "                                    fixed (tools/eval/records/heldout-seal.md); refused once",
  "                                    recorded",
].join("\n");

/** An environment value, with the empty string read as unset. */
function envValue(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ConfigError(flag, `'${value}' is not one of ${allowed.join(", ")}`);
}

/** A finite number from `text`, checked against `[min, max]`. */
function numberIn(text: string, flag: string, min: number, max = Infinity): number {
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value) || value < min || value > max) {
    const range = max === Infinity ? `at least ${min}` : `between ${min} and ${max}`;
    throw new ConfigError(flag, `'${text}' is not a number ${range}`);
  }
  return value;
}

/** A whole number from `text`, at least `min`. */
function integerFrom(text: string, flag: string, min: number): number {
  const value = numberIn(text, flag, min);
  if (!Number.isInteger(value)) throw new ConfigError(flag, `'${text}' is not a whole number`);
  return value;
}

/** A number from a variable, or its default when the variable is unset. */
function envNumber(env: Env, name: string, fallback: number, min: number, max?: number): number {
  const text = envValue(env, name);
  return text === undefined ? fallback : numberIn(text, name, min, max);
}

/** A strictly positive number from a variable, or its default when the variable is unset. */
function envPositive(env: Env, name: string, fallback: number): number {
  const text = envValue(env, name);
  if (text === undefined) return fallback;
  const value = numberIn(text, name, 0);
  if (value === 0) throw new ConfigError(name, `'${text}' is not above zero`);
  return value;
}

/** A comma-separated list, trimmed, with empty items dropped. */
function list(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function parseBackends(text: string | undefined): BackendName[] {
  if (text === undefined) return [...DEFAULTS.backends];
  const names = list(text).map((name) => oneOf(name, BACKEND_NAMES, "--backends"));
  if (names.length === 0) throw new ConfigError("--backends", "names no backend");
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) throw new ConfigError("--backends", `names '${repeated}' twice`);
  return names;
}

/**
 * What the run replays: the tuning list under `--tuning`, else `--profile`, else `EVAL_PROFILE`.
 *
 * `--tuning` replays exactly the list of `src/tuning.ts`, so it cannot be narrowed by
 * `--scenario` or replaced by `--profile`; as any flag beats its variable, `EVAL_PROFILE` is not
 * read at all under it.
 */
function parseProfile(
  flags: {
    readonly profile?: string;
    readonly scenario?: readonly string[];
    readonly tuning?: boolean;
  },
  env: Env,
): RunProfile {
  if (flags.tuning === true) {
    if (flags.profile !== undefined) {
      throw new ConfigError(
        "--tuning",
        "replays the tuning list and cannot be combined with --profile",
      );
    }
    if ((flags.scenario ?? []).length > 0) {
      throw new ConfigError(
        "--tuning",
        "replays the tuning list and cannot be combined with --scenario",
      );
    }
    return TUNING_PROFILE;
  }
  const text = flags.profile ?? envValue(env, "EVAL_PROFILE") ?? DEFAULTS.profile;
  return oneOf(text, PROFILES, flags.profile === undefined ? "EVAL_PROFILE" : "--profile");
}

/**
 * `--exit-eval`: the one exit eval named, which must be able to read the backend it judges.
 *
 * E3 is a rules-only exit eval (docs/evaluation.md), so a run that does not
 * replay the rules backend could cover none of its conditions and is refused before it starts.
 */
function parseExitEval(
  text: string | undefined,
  backends: readonly BackendName[],
): ExitEvalName | undefined {
  if (text === undefined) return undefined;
  const name = oneOf(text, EXIT_EVALS, "--exit-eval");
  if (!backends.includes("rules")) {
    throw new ConfigError(
      "--exit-eval",
      `${name} judges the rules backend, so --backends must name rules`,
    );
  }
  return name;
}

/** The flags the held-out set's one run never takes, and why. */
const NOT_WITH_FINAL_HELDOUT = [
  ["scenario", "it replays every sealed scenario"],
  ["seed", "every scenario keeps its sealed seed"],
  ["fail-on-gate", "the core-10 gate is not what the held-out set measures"],
  ["exit-eval", "E3 is judged on the core-10, not on the held-out set"],
] as const;

/** Where the held-out set's one run reads the pre-registered choice, and how it asks "committed". */
export interface ChoiceGuard {
  /** The choice record; `tools/eval/records/von-thresholds-choice.md` by default. */
  readonly path?: string;
  /** Whether the record is committed and unchanged since; asks Git by default. */
  readonly committed?: (path: string) => boolean;
}

/** The triple a run is configured with: the pipeline's persistence and Von's own pair. */
interface ConfiguredTriple {
  readonly persistSimMin: number;
  readonly vonGate: GateThresholds;
}

/**
 * The Von thresholds pre-registration, as amended on 2026-09-24: the held-out set's one run uses
 * exactly the triple the pre-registered sweep chose, read from its committed record
 * (tools/eval/records/von-thresholds-choice.md, `choice.ts`), and nothing else.
 *
 * @throws ConfigError on `--final-heldout` when there is no record, it cannot be read, or it is
 * not committed and unchanged since; on the first variable that differs from the record otherwise.
 */
function checkChosenTriple(configured: ConfiguredTriple, guard: ChoiceGuard): void {
  const path = guard.path ?? choiceRecordPath();
  let chosen: ReturnType<typeof readChoiceRecord>;
  try {
    chosen = readChoiceRecord(path);
  } catch (error) {
    if (!(error instanceof ChoiceRecordError)) throw error;
    throw new ConfigError(
      FINAL_HELDOUT_FLAG,
      `the pre-registered choice cannot be read (${error.message})`,
    );
  }
  if (chosen === undefined) {
    throw new ConfigError(
      FINAL_HELDOUT_FLAG,
      `the Von thresholds are not fixed: ${CHOICE_RECORD_FILE}, the pre-registered sweep's ` +
        "committed choice, does not exist. The held-out set runs once, after the choice is " +
        "recorded (fdp-eval sweep --preregistered --from-runs --record-choice) and committed " +
        `(${HELDOUT_SEAL_FILE})`,
    );
  }
  if (!(guard.committed ?? committedUnchanged)(path)) {
    throw new ConfigError(
      FINAL_HELDOUT_FLAG,
      `${CHOICE_RECORD_FILE} is not committed, or has changed since its commit: the held-out ` +
        "set's one run reads the committed choice and nothing else; commit it first",
    );
  }
  const differences = [
    {
      name: "GATE_PERSIST_SIM_MIN",
      chosen: chosen.persistSimMin,
      given: configured.persistSimMin,
      text: (value: number) => String(value),
    },
    {
      name: "VON_GATE_REVIEW_MIN_CONFIDENCE",
      chosen: chosen.reviewMin,
      given: configured.vonGate.reviewMin,
      text: (value: number) => value.toFixed(2),
    },
    {
      name: "VON_GATE_TICKET_MIN_CONFIDENCE",
      chosen: chosen.ticketMin,
      given: configured.vonGate.ticketMin,
      text: (value: number) => value.toFixed(2),
    },
  ].filter((entry) => Math.abs(entry.chosen - entry.given) > 1e-9);
  const [first] = differences;
  if (first !== undefined) {
    throw new ConfigError(
      first.name,
      `the held-out set's one run uses exactly the triple the pre-registered sweep chose ` +
        `(${CHOICE_RECORD_FILE}): ` +
        differences
          .map(
            (entry) => `${entry.name}=${entry.text(entry.chosen)}, not ${entry.text(entry.given)}`,
          )
          .join("; "),
    );
  }
}

/** What `checkHeldout` reads beside the flags. */
interface HeldoutContext {
  readonly env: Env;
  readonly backends: readonly BackendName[];
  /** The absolute path of the final run's record. */
  readonly record: string;
  /** The triple the run is configured with, held to the committed choice. */
  readonly triple: ConfiguredTriple;
  readonly choice: ChoiceGuard;
}

/**
 * `--profile heldout` is the held-out set's one final run and nothing else
 * (tools/eval/records/heldout-seal.md).
 *
 * It is refused without an explicit `--profile heldout --final-heldout`, and refused for good
 * once the final run's record exists. The run replays every sealed scenario as sealed, so no flag
 * that narrows or re-seeds it is taken, nor one that judges the core-10. It is the clean E4
 * figure, so it asks Von live and is confirmed up front: no cassette holds a held-out request, a
 * mock column is not informative, and the live plan's mock replay must never run on its own.
 * Last, it runs with exactly the triple the pre-registered sweep chose (`checkChosenTriple`).
 *
 * @throws ConfigError naming the flag or variable to fix.
 */
function checkHeldout(
  profile: RunProfile,
  flags: ReturnType<typeof parseFlags>,
  context: HeldoutContext,
): void {
  const final = flags["final-heldout"] === true;
  if (profile !== HELDOUT_PROFILE) {
    if (final) {
      throw new ConfigError(
        FINAL_HELDOUT_FLAG,
        `runs the held-out set only; give it with --profile ${HELDOUT_PROFILE}`,
      );
    }
    return;
  }
  if (flags.profile === undefined) {
    throw new ConfigError(
      "EVAL_PROFILE",
      `${HELDOUT_PROFILE} is selected only by the explicit --profile ${HELDOUT_PROFILE} ` +
        `${FINAL_HELDOUT_FLAG} of its one final run (${HELDOUT_SEAL_FILE})`,
    );
  }
  if (!final) {
    throw new ConfigError(
      "--profile",
      `${HELDOUT_PROFILE} replays the held-out set, which runs once, after the Von thresholds ` +
        `are fixed under the pre-registration (${HELDOUT_SEAL_FILE}); that one run gives ` +
        FINAL_HELDOUT_FLAG,
    );
  }
  if (finalRunRecorded(context.record)) {
    throw new ConfigError(
      FINAL_HELDOUT_FLAG,
      `the held-out set has had its one run: ${FINAL_RUN_RECORD_FILE} records it, and a second ` +
        "run is a separate decision, recorded there",
    );
  }
  for (const [name, why] of NOT_WITH_FINAL_HELDOUT) {
    const value = flags[name];
    const given = Array.isArray(value) ? value.length > 0 : value !== undefined;
    if (given) {
      throw new ConfigError(`--${name}`, `not taken by the held-out set's one run: ${why}`);
    }
  }
  if (!context.backends.includes("von")) {
    throw new ConfigError(
      "--backends",
      "the held-out set's one run measures Von (the clean E4 figure); name von",
    );
  }
  if (envValue(context.env, "EVAL_VON_MODE") !== "live") {
    throw new ConfigError(
      "EVAL_VON_MODE",
      "the held-out set's one run asks Von live (no cassette holds a held-out request, and a " +
        "mock column is not informative); set it to live",
    );
  }
  if (flags["confirm-live"] !== true) {
    throw new ConfigError(
      "--confirm-live",
      "the held-out set's one run is live: confirm it up front, so that its live plan never " +
        "replays the set without the run going on",
    );
  }
  checkChosenTriple(context.triple, context.choice);
}

/**
 * The run-time half of `checkHeldout`, for a configuration that did not come from `loadConfig`:
 * a `heldout` run without `--final-heldout`, once the final run's record exists, or with another
 * triple than the pre-registered sweep's committed choice, is refused.
 *
 * @throws ConfigError naming `--profile`, `--final-heldout` or the variable that differs.
 */
export function assertFinalHeldoutRun(
  cfg: Pick<EvalConfig, "profile" | "finalHeldout" | "persistSimMin" | "vonGate">,
  record: string = finalRunRecordPath(),
  choice: ChoiceGuard = {},
): void {
  if (cfg.profile !== HELDOUT_PROFILE) return;
  if (!cfg.finalHeldout) {
    throw new ConfigError(
      "--profile",
      `${HELDOUT_PROFILE} runs only as the held-out set's one final run (${FINAL_HELDOUT_FLAG})`,
    );
  }
  if (finalRunRecorded(record)) {
    throw new ConfigError(
      FINAL_HELDOUT_FLAG,
      `the held-out set has had its one run: ${FINAL_RUN_RECORD_FILE} records it`,
    );
  }
  checkChosenTriple(cfg, choice);
}

function parseScenarios(ids: readonly string[] | undefined): string[] {
  for (const id of ids ?? []) {
    if (!SCENARIO_ID_PATTERN.test(id)) {
      throw new ConfigError("--scenario", `'${id}' is not a scenario id`);
    }
  }
  return [...new Set(ids ?? [])];
}

function parseCatalog(
  text: string | undefined,
  cwd: string,
  dbUrl: string | undefined,
): CatalogSource {
  if (text === undefined || text === "reference") return { kind: "reference" };
  if (text === "ingested") {
    if (dbUrl === undefined) {
      throw new ConfigError("--db-url", "--catalog ingested reads the database; pass --db-url");
    }
    return { kind: "ingested" };
  }
  if (text.startsWith(FILE_PREFIX)) {
    const given = text.slice(FILE_PREFIX.length);
    if (given === "") throw new ConfigError("--catalog", "file: names no path");
    const path = resolve(cwd, given);
    if (!existsSync(path)) throw new ConfigError("--catalog", `${path} does not exist`);
    return { kind: "file", path };
  }
  throw new ConfigError("--catalog", `'${text}' is not reference, file:<path> or ingested`);
}

function parseVonModel(env: Env): string {
  const model = envValue(env, "VON_MODEL") ?? DEFAULTS.vonModel;
  if (!VON_MODEL_PATTERN.test(model)) {
    throw new ConfigError("VON_MODEL", `'${model}' is not a pinned version such as von-1.13.0`);
  }
  return model;
}

function parseBaseUrl(env: Env): string {
  const text = envValue(env, "TYPESAFE_BASE_URL") ?? DEFAULTS.typesafeBaseUrl;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError("TYPESAFE_BASE_URL", `'${text}' is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("TYPESAFE_BASE_URL", `'${text}' is not an http(s) URL`);
  }
  return text;
}

function parsePrices(env: Env): Prices {
  const asOf = envValue(env, "PRICES_AS_OF") ?? DEFAULTS.prices.asOf;
  if (!DAY_PATTERN.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) {
    throw new ConfigError("PRICES_AS_OF", `'${asOf}' is not a YYYY-MM-DD day`);
  }
  return {
    vonInputPerMtok: envNumber(env, "VON_PRICE_INPUT_PER_MTOK", DEFAULTS.prices.vonInputPerMtok, 0),
    llmInputPerMtok: envNumber(env, "LLM_PRICE_INPUT_PER_MTOK", DEFAULTS.prices.llmInputPerMtok, 0),
    llmOutputPerMtok: envNumber(
      env,
      "LLM_PRICE_OUTPUT_PER_MTOK",
      DEFAULTS.prices.llmOutputPerMtok,
      0,
    ),
    asOf,
  };
}

function parseGate(env: Env): GateThresholds {
  const ticketMin = envNumber(env, "GATE_TICKET_MIN_CONFIDENCE", DEFAULTS.gate.ticketMin, 0, 1);
  const reviewMin = envNumber(env, "GATE_REVIEW_MIN_CONFIDENCE", DEFAULTS.gate.reviewMin, 0, 1);
  if (reviewMin > ticketMin) {
    throw new ConfigError(
      "GATE_REVIEW_MIN_CONFIDENCE",
      `${reviewMin} is above the ticket threshold ${ticketMin}`,
    );
  }
  return { ticketMin, reviewMin };
}

/**
 * Von's own pair, defaulting to the pre-registered choice (`DEFAULTS.vonGate`) and never to
 * `GATE_*`, as the backend's `loadEnv` reads it.
 */
function parseVonGate(env: Env): GateThresholds {
  const ticketMin = envNumber(
    env,
    "VON_GATE_TICKET_MIN_CONFIDENCE",
    DEFAULTS.vonGate.ticketMin,
    0,
    1,
  );
  const reviewMin = envNumber(
    env,
    "VON_GATE_REVIEW_MIN_CONFIDENCE",
    DEFAULTS.vonGate.reviewMin,
    0,
    1,
  );
  if (reviewMin > ticketMin) {
    throw new ConfigError(
      "VON_GATE_REVIEW_MIN_CONFIDENCE",
      `Von's review threshold ${reviewMin} is above its ticket threshold ${ticketMin} ` +
        "(VON_GATE_* default to 0.65 / 0.85)",
    );
  }
  return { ticketMin, reviewMin };
}

/**
 * The pair the gate applies to a backend's decisions: Von's own, `GATE_*` for the rules and llm
 * backends, as the runtime's `gateThresholds` picks it.
 */
export function gateFor(
  cfg: Pick<EvalConfig, "gate" | "vonGate">,
  backend: BackendName,
): GateThresholds {
  return backend === "von" ? cfg.vonGate : cfg.gate;
}

/** A path as given, made absolute against `cwd`; a default is made absolute against the repository. */
function pathFrom(given: string | undefined, fallback: string, cwd: string): string {
  if (given === undefined) return resolve(REPO_ROOT, fallback);
  return isAbsolute(given) ? given : resolve(cwd, given);
}

function parseFlags(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: false, strict: true })
      .values;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Node names the offending option first, quoted: "Option '--profile <value>' …".
    const flag = /'(--?[A-Za-z][\w-]*)/.exec(message)?.[1] ?? "arguments";
    throw new ConfigError(flag, message);
  }
}

/**
 * Reads the configuration of one run from its flags and its environment.
 *
 * @param argv the arguments after the subcommand name.
 * @param env the process environment; only the harness's variables are read.
 * @param options `cwd` resolves relative paths; pnpm's `INIT_CWD` (the directory the user ran
 * the command from) and then `process.cwd()` by default, because `pnpm --filter` runs scripts
 * inside `tools/eval`.
 * @throws ConfigError naming the flag or variable of the first value that cannot be used.
 */
export function loadConfig(
  argv: readonly string[],
  env: Env,
  options: LoadConfigOptions = {},
): EvalConfig {
  const cwd = options.cwd ?? envValue(env, "INIT_CWD") ?? process.cwd();
  const flags = parseFlags(argv);

  const secrets = new EvalSecrets({
    ...optional("typesafeApiKey", envValue(env, "TYPESAFE_API_KEY")),
    ...optional("llmApiKey", envValue(env, "LLM_API_KEY")),
    ...optional("dbUrl", flags["db-url"] === "" ? undefined : flags["db-url"]),
  });

  const jobsText = flags.jobs;
  const seedText = flags.seed;
  const rulesDisabled = envValue(env, "RULES_DISABLED");
  const backends = parseBackends(flags.backends);
  const gate = parseGate(env);
  const vonGate = parseVonGate(env);
  const persistSimMin = envNumber(env, "GATE_PERSIST_SIM_MIN", DEFAULTS.persistSimMin, 0);
  const profile = parseProfile(flags, env);
  checkHeldout(profile, flags, {
    env,
    backends,
    record: options.finalRunRecord ?? finalRunRecordPath(),
    triple: { persistSimMin, vonGate },
    choice: {
      ...(options.choiceRecord === undefined ? {} : { path: options.choiceRecord }),
      ...(options.choiceCommitted === undefined ? {} : { committed: options.choiceCommitted }),
    },
  });

  const config: EvalConfig = {
    profile,
    backends,
    scenarios: parseScenarios(flags.scenario),
    catalog: parseCatalog(flags.catalog, cwd, secrets.dbUrl),
    record: flags.record ?? false,
    confirmLive: flags["confirm-live"] ?? false,
    outDir: pathFrom(flags.out === "" ? undefined : flags.out, DEFAULTS.outDir, cwd),
    jobs: jobsText === undefined ? DEFAULTS.jobs : integerFrom(jobsText, "--jobs", 1),
    seed: seedText === undefined ? undefined : integerFrom(seedText, "--seed", 0),
    failOnGate: flags["fail-on-gate"] ?? false,
    finalHeldout: flags["final-heldout"] ?? false,
    exitEval: parseExitEval(flags["exit-eval"], backends),
    vonMode: oneOf(envValue(env, "EVAL_VON_MODE") ?? DEFAULTS.vonMode, VON_MODES, "EVAL_VON_MODE"),
    csvPath: pathFrom(envValue(env, "METROPT_CSV"), DEFAULTS.csvPath, cwd),
    typesafeBaseUrl: parseBaseUrl(env),
    vonModel: parseVonModel(env),
    llmProvider: oneOf(
      envValue(env, "LLM_PROVIDER") ?? DEFAULTS.llmProvider,
      LLM_PROVIDERS,
      "LLM_PROVIDER",
    ),
    llmModel: envValue(env, "LLM_MODEL") ?? DEFAULTS.llmModel,
    prices: parsePrices(env),
    gate,
    vonGate,
    decisionIntervalSimMin: envPositive(
      env,
      "DECISION_INTERVAL_SIM_MIN",
      DEFAULTS.decisionIntervalSimMin,
    ),
    episodeClearSimMin: envPositive(env, "EPISODE_CLEAR_SIM_MIN", DEFAULTS.episodeClearSimMin),
    persistSimMin,
    rulesDisabled: rulesDisabled === undefined ? [...DEFAULTS.rulesDisabled] : list(rulesDisabled),
    resample: flags.resample === undefined ? 0 : integerFrom(flags.resample, "--resample", 0),
    help: flags.help ?? false,
    secrets,
  };
  return Object.freeze(config);
}

/** `{ [key]: value }` when the value is present, `{}` otherwise, for optional members. */
function optional<K extends keyof SecretValues>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, string>>);
}

// --- Catalog sources ---------------------------------------------------------

/** The fault catalog a run scores with, whichever source it came from. */
export interface EvalCatalog {
  readonly source: CatalogSource["kind"];
  /** `reference`, `file:<absolute path>` or `ingested`, as the report header names it. */
  readonly name: string;
  /** SHA-256 of the document, or of the sorted entries for the ingested source. */
  readonly sha256: string;
  readonly entries: readonly CatalogEntry[];
  /**
   * The conditions with their symptom sentences, which the entries do not carry and the
   * retrieval query reads (the backend's retrieval stage); the host hands them to the
   * retriever beside the entries.
   */
  readonly conditions: readonly EvalCondition[];
}

/**
 * A contracts `catalog` document on disk, validated whole before it is mapped.
 *
 * The reference loader tolerates older shapes; a `file:` catalog is the output of
 * `fdp-init export-catalog` and must be exactly the contract, or the headline number would be
 * measured on something the pipeline never ships.
 */
function loadCatalogFile(path: string): EvalCatalog {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CatalogError(path, `is not a readable JSON document (${String(error)})`);
  }
  const result = validate("catalog", document);
  if (!result.ok) {
    const issues = result.errors.map((issue) => issue.text).join("; ");
    throw new CatalogError(path, `is not a contracts catalog document: ${issues}`);
  }
  const mapped = loadReferenceCatalog(path);
  return {
    source: "file",
    name: `${FILE_PREFIX}${path}`,
    sha256: mapped.sha256,
    entries: mapped.entries,
    conditions: mapped.conditionTable,
  };
}

async function loadIngested(dbUrl: string | undefined): Promise<EvalCatalog> {
  if (dbUrl === undefined) {
    throw new ConfigError("--db-url", "--catalog ingested reads the database; pass --db-url");
  }
  // Imported on demand, so only a run that reads the database loads `pg`.
  const { loadIngestedCatalog } = await import("./catalog/ingested.ts");
  const catalog = await loadIngestedCatalog(dbUrl);
  return {
    source: "ingested",
    name: "ingested",
    sha256: catalog.sha256,
    entries: catalog.entries,
    conditions: catalog.conditions,
  };
}

/**
 * Loads the catalog a configuration names.
 *
 * @throws CatalogError when a document is missing, malformed or not mappable, and ConfigError
 * when the ingested source is asked for without a database URL.
 */
export async function loadCatalog(
  source: CatalogSource,
  secrets: EvalSecrets,
  referencePath: string = REFERENCE_CATALOG_PATH,
): Promise<EvalCatalog> {
  switch (source.kind) {
    case "reference": {
      const reference = loadReferenceCatalog(referencePath);
      return {
        source: "reference",
        name: "reference",
        sha256: reference.sha256,
        entries: reference.entries,
        conditions: reference.conditionTable,
      };
    }
    case "file":
      return loadCatalogFile(source.path);
    case "ingested":
      return await loadIngested(secrets.dbUrl);
  }
}
