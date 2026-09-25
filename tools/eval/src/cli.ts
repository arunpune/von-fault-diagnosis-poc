// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-eval`: the dispatcher, and nothing else.
//
// The subcommand names are fixed here but their implementations are not: each
// one lives in `src/commands/<name>.ts` and is loaded by name when it is asked
// for. That is what lets a subcommand be added without editing this file — a
// name with no module is not a crash, it is "not implemented yet" and exit 3.
//
// Exit codes: 0 the run completed (and the gate passed when
// `--fail-on-gate` was given), 1 a usage or configuration error, 2 the gate
// failed, 3 the run was aborted (a scenario error, a missing fixture, a
// subcommand that does not exist yet).
//
// Flags beyond `--help` and `--out` belong to the subcommands, so they are
// passed through untouched rather than declared here.

import { existsSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";

import { createLogger } from "./log.ts";

/** The exit codes every subcommand shares. */
export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_GATE_FAILED = 2;
export const EXIT_ABORTED = 3;

/** The subcommands `fdp-eval` answers to, in the order `--help` lists them. */
export const COMMANDS = ["run", "validate", "record", "score-stack", "sweep"] as const;

export type CommandName = (typeof COMMANDS)[number];

/** What every `src/commands/<name>.ts` module exports. */
export interface CommandModule {
  run(args: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<number>;
}

const SUMMARY: Readonly<Record<CommandName, string>> = {
  run: "replay the scenarios of a profile and write a report",
  validate: "check the scenario files against the schema and ground truth",
  record: "record model answers into cassettes (needs --confirm-live)",
  "score-stack": "score a run of the Compose stack from the database",
  sweep: "re-gate a stored run over a grid of gate thresholds",
};

export function isCommandName(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

export function usage(): string {
  const lines = [
    "usage: fdp-eval <command> [options]",
    "",
    "commands:",
    ...COMMANDS.map((name) => `  ${name.padEnd(12)} ${SUMMARY[name]}`),
    "",
    "global options:",
    "  --help        print this text",
    "  --out <dir>   where a command writes its output (default reports/eval)",
    "",
    "profiles, scenarios and metrics: docs/evaluation.md",
    "",
  ];
  return lines.join("\n");
}

/** The module file a subcommand would live in, whether or not it has been written. */
export function commandModuleUrl(name: CommandName): URL {
  return new URL(`./commands/${name}.ts`, import.meta.url);
}

async function loadCommand(name: CommandName): Promise<CommandModule | undefined> {
  const url = commandModuleUrl(name);
  if (!existsSync(url)) return undefined;

  const loaded = (await import(url.href)) as Partial<CommandModule>;
  if (typeof loaded.run !== "function") {
    throw new TypeError(`${url.pathname} does not export run(args, env)`);
  }
  return { run: loaded.run };
}

/**
 * Runs one `fdp-eval` invocation and returns its exit code.
 *
 * `args` is everything after the script name. The first positional is the subcommand; the
 * rest is handed to its module verbatim, so a subcommand owns its own flags and its own
 * `--help`.
 */
export async function main(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      help: { type: "boolean", short: "h" },
      out: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const wantsHelp = parsed.values["help"] === true;
  const name = parsed.positionals[0];

  if (name === undefined) {
    if (wantsHelp) {
      process.stdout.write(usage());
      return EXIT_OK;
    }
    process.stderr.write(`fdp-eval: no command\n\n${usage()}`);
    return EXIT_USAGE;
  }

  if (!isCommandName(name)) {
    process.stderr.write(`fdp-eval: unknown command '${name}'\n\n${usage()}`);
    return EXIT_USAGE;
  }

  const command = await loadCommand(name);
  if (command === undefined) {
    if (wantsHelp) {
      process.stdout.write(usage());
      return EXIT_OK;
    }
    process.stderr.write(
      `fdp-eval ${name}: not implemented yet (src/commands/${name}.ts is not written)\n`,
    );
    return EXIT_ABORTED;
  }

  return await command.run(args.slice(args.indexOf(name) + 1), env);
}

/**
 * True when this file is the program Node was started with, rather than an import.
 *
 * `import.meta.filename` is the real path of this module, while `process.argv[1]` is only
 * made absolute, so the two differ as soon as the package is reached through a symlink —
 * which is exactly what pnpm's `node_modules` and a Git worktree are made of.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === import.meta.filename;
  } catch {
    return false;
  }
}

// A promise chain rather than a top-level `await`: a command module that imports this file
// (for the exit codes, as `config.ts` does) would otherwise wait on an entry module that is
// itself waiting on the command, and Node would exit 13 on the unsettled await.
if (isEntryPoint()) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      createLogger().warn("fdp-eval aborted", { error: String(error) });
      process.exitCode = EXIT_ABORTED;
    },
  );
}
