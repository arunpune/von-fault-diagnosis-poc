// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-eval run`: replay the scenarios of a profile against every backend,
// score them and write the report (docs/evaluation.md, "Reading a report").
//
// This module is the command's edge and nothing else: it reads the flags and
// the environment into one configuration (`config.ts`), hands it to the run
// (`runner/run.ts`), and turns whatever comes back into an exit code —
//
//   0  the run completed (and, under --fail-on-gate, the gate held; under
//      --exit-eval, no covered condition broke — an incomplete check is 0)
//   1  a usage or configuration error: a bad flag or variable, an unknown
//      scenario id, a backend mode this checkout cannot build
//   2  --fail-on-gate was given and the core-10 gate failed, or --exit-eval
//      was given and a condition the run covered broke
//   3  the run was aborted: a scenario that does not bind, rows that are not
//      on this machine, a catalog that cannot be read, a pipeline failure
//
// Error text never quotes a secret: `ConfigError` names the flag or variable,
// not its value, and the keys live in `EvalSecrets`, which prints as
// `[redacted]` however it is rendered.

import { EXIT_ABORTED, EXIT_OK } from "../cli.ts";
import { CONFIG_USAGE, ConfigError, loadConfig } from "../config.ts";
import type { Env, EvalConfig } from "../config.ts";
import { createLogger } from "../log.ts";
import { executeRun } from "../runner/run.ts";

/** The `--help` text. */
export function usage(): string {
  return [
    "usage: fdp-eval run [options]",
    "",
    "Replays the scenarios of a profile against each backend, scores them against ground",
    "truth and writes <out>/<run id>/run.json, report.md and scenarios/*.jsonl, plus a copy",
    "of run.json as <out>/latest.json.",
    "",
    "options:",
    CONFIG_USAGE,
    "  --help                            print this text",
    "",
    "environment: EVAL_PROFILE, EVAL_JEV_MODE, METROPT_CSV and the backend variables",
    '(docs/evaluation.md, "Running a profile")',
    "",
    "exit codes: 0 completed (and the gate held under --fail-on-gate), 1 usage or",
    "configuration error, 2 gate failed or an --exit-eval condition broke, 3 run aborted;",
    "an --exit-eval check that could not see every condition prints INCOMPLETE, never a pass",
    "",
  ].join("\n");
}

/**
 * The arguments with the `--` terminator dropped.
 *
 * `pnpm --filter @fdp/eval run eval -- --profile smoke` passes the separator through to the
 * script, and the command takes no positional, so a bare `--` means nothing.
 */
function withoutTerminator(args: readonly string[]): string[] {
  return args.filter((argument) => argument !== "--");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `fdp-eval run`.
 *
 * @param args everything after the subcommand name.
 * @param env the environment the configuration is read from.
 * @returns the process exit code.
 */
export async function run(args: readonly string[], env: Env = process.env): Promise<number> {
  let cfg: EvalConfig;
  try {
    cfg = loadConfig(withoutTerminator(args), env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`fdp-eval run: ${error.message}\n\n${usage()}`);
    return error.exitCode;
  }

  if (cfg.help) {
    process.stdout.write(usage());
    return EXIT_OK;
  }

  try {
    return await executeRun(cfg, { log: createLogger({ env }) });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`fdp-eval run: ${error.message}\n`);
      return error.exitCode;
    }
    process.stderr.write(`fdp-eval run: aborted: ${message(error)}\n`);
    return EXIT_ABORTED;
  }
}
