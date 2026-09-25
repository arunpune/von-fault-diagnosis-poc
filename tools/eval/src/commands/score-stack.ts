// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-eval score-stack`: score a run of the Compose stack from what its
// database holds (E5).
//
//   fdp-eval score-stack --db-url postgres://eval:…@host:port/fdp [--from <iso>] [--to <iso>]
//
// It connects as role `eval` (`--db-url`, else `DATABASE_URL_EVAL`; `make
// eval-stack` passes the URL `scripts/smoke.sh --keep` wrote), reads the
// catalog the stack ranked and everything `src/stack/db.ts` names inside one
// read-only transaction, scores it with the in-process metrics and writes the
// usual `run.json` and `report.md` with `run.mode: "stack"` under
// `<out>/<yyyymmdd-hhmmss>-stack/`, beside `stack.json`. It writes nothing to
// the database, and the URL — it carries the role's password — is handed to the
// driver and never printed.
//
// Exit codes, those of `fdp-eval run`: 0 scored, 1 a usage error (a flag, a
// missing URL, an instant that is not one), 3 aborted (the database could not
// be read, or holds nothing replayed or decided to score).

import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { readIngestedCatalog, withReadOnlyTransaction } from "../catalog/ingested.ts";
import type { IngestedCatalog } from "../catalog/ingested.ts";
import { EXIT_ABORTED, EXIT_OK, EXIT_USAGE } from "../cli.ts";
import { ConfigError, DEFAULTS, loadConfig } from "../config.ts";
import type { EvalCatalog, EvalConfig, Env } from "../config.ts";
import { runId as makeRunId } from "../ids.ts";
import { createLogger } from "../log.ts";
import type { Logger } from "../log.ts";
import { alarmsEnabled, defaultAlarmRegistry } from "../replay/index.ts";
import { collectProvenance } from "../report/provenance.ts";
import type { Provenance } from "../report/provenance.ts";
import { SCENARIO_LOG_DIR, allocateRunDir, defaultNativeAlarmCodes } from "../runner/run.ts";
import { REPO_ROOT } from "../slices.ts";
import { readStack } from "../stack/db.ts";
import type { StackRange, StackRows } from "../stack/db.ts";
import { renderStackConsole, writeStackRun } from "../stack/report.ts";
import type { StackRunFiles, StackRunInput } from "../stack/report.ts";
import {
  STACK_PROFILE,
  StackError,
  scoreStack,
  stackPersistence,
  stackPrices,
  stackThresholds,
} from "../stack/score.ts";
import type { StackScore } from "../stack/score.ts";

/** The variable `--db-url` falls back to. */
export const DB_URL_ENV = "DATABASE_URL_EVAL";

const OPTIONS = {
  "db-url": { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  out: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/** The `--help` text. */
export function usage(): string {
  return [
    "usage: fdp-eval score-stack [options]",
    "",
    "Scores a run of the Compose stack from its database, as role eval and read-only, and",
    "writes <out>/<run id>/run.json (run.mode stack), report.md and stack.json.",
    "",
    "options:",
    `  --db-url <url>   the eval role's connection string (default: ${DB_URL_ENV})`,
    "  --from <iso>     score only sim time at or after this instant",
    "  --to <iso>       score only sim time before this instant",
    "  --out <dir>      report directory (default reports/eval)",
    "  --help           print this text",
    "",
    "exit codes: 0 scored, 1 usage error, 3 aborted (unreadable database, nothing to score)",
    "",
  ].join("\n");
}

/** What one scoring is asked for. */
export interface ScoreStackRequest {
  readonly dbUrl: string;
  readonly range: StackRange;
  /** Absolute directory the run directory is created under. */
  readonly outDir: string;
}

/** The seams of a scoring; each defaults to the real thing. */
export interface ScoreStackDeps {
  readonly now?: () => Date;
  readonly provenance?: () => Provenance;
  readonly stdout?: { write(chunk: string): unknown };
  readonly log?: Logger;
}

/** What a scoring produced. */
export interface ScoreStackOutcome {
  readonly score: StackScore;
  readonly files: StackRunFiles;
}

/** A usage problem, named by the flag or variable to fix. */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function instantFlag(flag: string, text: string | undefined): Date | undefined {
  if (text === undefined) return undefined;
  const value = new Date(text);
  if (Number.isNaN(value.getTime())) throw new UsageError(`--${flag}: '${text}' is not an instant`);
  return value;
}

function valueOf(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function parseFlags(args: readonly string[]) {
  try {
    return parseArgs({ args: [...args], options: OPTIONS, allowPositionals: false, strict: true })
      .values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The request the flags and the environment describe.
 *
 * @throws UsageError for an unknown flag, a missing URL or a range that is not one.
 */
function parseRequest(args: readonly string[], env: Env): ScoreStackRequest | "help" {
  const values = parseFlags(args);
  if (values.help === true) return "help";

  const given = values["db-url"];
  const dbUrl = given !== undefined && given !== "" ? given : valueOf(env, DB_URL_ENV);
  if (dbUrl === undefined) {
    throw new UsageError(`--db-url: pass the eval role's URL or set ${DB_URL_ENV}`);
  }
  const from = instantFlag("from", values.from);
  const to = instantFlag("to", values.to);
  if (from !== undefined && to !== undefined && from.getTime() >= to.getTime()) {
    throw new UsageError("--from: must be before --to");
  }

  const cwd = valueOf(env, "INIT_CWD") ?? process.cwd();
  const out = values.out === undefined || values.out === "" ? undefined : values.out;
  let outDir = resolve(REPO_ROOT, DEFAULTS.outDir);
  if (out !== undefined) outDir = isAbsolute(out) ? out : resolve(cwd, out);

  return {
    dbUrl,
    range: { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) },
    outDir,
  };
}

/** The catalog the stack ranked, in the shape a report header names. */
function evalCatalog(catalog: IngestedCatalog): EvalCatalog {
  return {
    source: "ingested",
    name: "ingested",
    sha256: catalog.sha256,
    entries: catalog.entries,
    conditions: catalog.conditions,
  };
}

/**
 * Reads, scores and writes one stack run.
 *
 * @param request the URL, the range and where to write.
 * @param env the environment the defaults are read from: the gate thresholds and prices a stack
 * whose decisions and ledger state none fall back to, and the episode timings the report restates.
 * @throws ConfigError for an unusable environment value, StackError when the database holds
 * nothing to score, and whatever the driver throws when it cannot be read.
 */
export async function executeScoreStack(
  request: ScoreStackRequest,
  env: Env,
  deps: ScoreStackDeps = {},
): Promise<ScoreStackOutcome> {
  const base: EvalConfig = loadConfig([], env);
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? createLogger({ env });
  const startedAt = now();

  const { catalog, rows } = await withReadOnlyTransaction(
    request.dbUrl,
    async (db): Promise<{ catalog: IngestedCatalog; rows: StackRows }> => ({
      catalog: await readIngestedCatalog(db),
      rows: await readStack(db, request.range),
    }),
  );

  const thresholds = stackThresholds(rows.decisions, base.gate);
  const prices = stackPrices(rows.ledger, base.prices);
  const registry = alarmsEnabled() ? defaultAlarmRegistry() : undefined;
  const score = scoreStack(rows, {
    catalog,
    prices,
    thresholds: thresholds.thresholds,
    nativeAlarmCodes: defaultNativeAlarmCodes(registry),
  });

  const { id, dir } = allocateRunDir(request.outDir, makeRunId(STACK_PROFILE, startedAt));
  const scenariosDir = join(dir, SCENARIO_LOG_DIR);
  mkdirSync(scenariosDir);
  log.info("stack", {
    id,
    unit: score.unitId,
    backends: score.backends.map((entry) => entry.backend),
    windows: score.windows.length,
    out: dir,
  });

  const input: StackRunInput = {
    score,
    runId: id,
    runDir: dir,
    startedAt,
    finishedAt: now(),
    catalog: evalCatalog(catalog),
    alarmRegistry: registry,
    range: request.range,
    thresholdsSource: thresholds.source,
    config: {
      scenarios: [],
      gate: thresholds.thresholds,
      decisionIntervalSimMin: base.decisionIntervalSimMin,
      episodeClearSimMin: base.episodeClearSimMin,
      persistSimMin: stackPersistence(rows.decisions, base.persistSimMin),
      rulesDisabled: base.rulesDisabled,
      prices,
      seed: undefined,
      failOnGate: false,
    },
    provenance: (deps.provenance ?? collectProvenance)(),
  };
  const files = writeStackRun(input, scenariosDir);
  (deps.stdout ?? process.stdout).write(renderStackConsole(files, input));
  return { score, files };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `fdp-eval score-stack`.
 *
 * @param args everything after the subcommand name; a bare `--` from pnpm is dropped.
 * @param env the environment `DATABASE_URL_EVAL` and the defaults are read from.
 * @returns the exit code.
 */
export async function run(args: readonly string[], env: Env = process.env): Promise<number> {
  let request: ScoreStackRequest | "help";
  try {
    request = parseRequest(
      args.filter((argument) => argument !== "--"),
      env,
    );
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`fdp-eval score-stack: ${error.message}\n\n${usage()}`);
    return EXIT_USAGE;
  }
  if (request === "help") {
    process.stdout.write(usage());
    return EXIT_OK;
  }

  try {
    await executeScoreStack(request, env);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`fdp-eval score-stack: ${error.message}\n`);
      return error.exitCode;
    }
    const reason = error instanceof StackError ? "nothing to score" : "aborted";
    process.stderr.write(`fdp-eval score-stack: ${reason}: ${message(error)}\n`);
    return EXIT_ABORTED;
  }
}
