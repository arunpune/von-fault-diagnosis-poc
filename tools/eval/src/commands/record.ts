// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-eval record`: a run with Von live and every answer recorded as a
// cassette (tools/eval/CASSETTES.md).
//
//   fdp-eval record --profile core [--scenario <id>]... [--confirm-live]
//   fdp-eval record --tuning [--confirm-live]
//
// `--tuning` records the tuning list, the recording the Von thresholds
// pre-registration waits on (see "Prerequisites" in
// tools/eval/records/von-thresholds-preregistration.md); `make eval-sweep` then
// replays it from the cassettes. It warns when Von's own pair is not
// 0.60 / 0.85, the pair that sweep replays. Since the pre-registration's
// amendment of 2026-09-24 the list is recorded twice, once with
// GATE_PERSIST_SIM_MIN=0 and once with 1, into one cassette store that keeps
// each run's answers under its N (`backends/cassette.ts`); the plan and the
// recording run at the environment's N, and it warns at an N the sweep does not
// replay.
//
// It is `fdp-eval run` with `EVAL_VON_MODE=live` and `--record` forced on,
// and nothing else: the same configuration, the same loop, the same reports.
// Three things come first.
//
// **No key, no run.** Without `TYPESAFE_API_KEY` it prints one line naming
// the variable and exits 1, before reading anything else.
//
// **No consent, no call.** The selection behind the run
// (`backends/select.ts`) replays the scenarios once against the contracts'
// mock, prints the planned call count and the estimated cost, and without
// `--confirm-live` stops there with exit 1, having called nothing. Recording
// the core profile is a paid, one-off step, run by hand once the printed
// estimate has been read and accepted.
//
// **Cassettes stay private.** They are written under the gitignored
// `tools/eval/fixtures/cassettes/<model>/` until the vendor's publication
// terms allow committing them; `tools/eval/CASSETTES.md` has the workflow.

import { EXIT_ABORTED, EXIT_OK, EXIT_USAGE } from "../cli.ts";
import { CONFIG_USAGE, ConfigError, TUNING_PROFILE, loadConfig } from "../config.ts";
import type { Env, EvalConfig } from "../config.ts";
import { createLogger } from "../log.ts";
import { executeRun } from "../runner/run.ts";
import { INCUMBENT, PERSIST_AXIS, PREREGISTRATION } from "./preregistered.ts";

/** The variable a recording cannot run without. */
const KEY_VARIABLE = "TYPESAFE_API_KEY";

/** The `--help` text. */
export function usage(): string {
  return [
    "usage: fdp-eval record [options]",
    "",
    "Runs the scenarios with Von live and writes every answer as a cassette under",
    "tools/eval/fixtures/cassettes/<model>/, then the reports of fdp-eval run. It needs",
    "TYPESAFE_API_KEY. It first replays the scenarios against the contracts mock and prints",
    "the planned calls and the estimated cost; without --confirm-live it stops there and",
    "calls nothing. Workflow: tools/eval/CASSETTES.md.",
    "",
    "The tuning list (--tuning) is recorded once per GATE_PERSIST_SIM_MIN the pre-registered",
    "sweep replays, 0 and 1; the store keeps each run's answers under its own value.",
    "",
    "options:",
    CONFIG_USAGE,
    "  --help                            print this text",
    "",
    "exit codes: 0 recorded (and the gate held under --fail-on-gate), 1 no key, no",
    "--confirm-live, or another usage or configuration error, 2 gate failed, 3 run aborted",
    "",
  ].join("\n");
}

/** The arguments with the `--` terminator pnpm passes through dropped. */
function withoutTerminator(args: readonly string[]): string[] {
  return args.filter((argument) => argument !== "--");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The run a recording is: Von live, every answer recorded. */
function recordingOf(cfg: EvalConfig): EvalConfig {
  return Object.freeze({ ...cfg, vonMode: "live", record: true });
}

/**
 * Runs `fdp-eval record`.
 *
 * @param args everything after the subcommand name.
 * @param env the environment the configuration is read from.
 * @returns the process exit code.
 */
export async function run(args: readonly string[], env: Env = process.env): Promise<number> {
  const argv = withoutTerminator(args);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return EXIT_OK;
  }
  const key = env[KEY_VARIABLE];
  if (key === undefined || key === "") {
    process.stderr.write(
      `fdp-eval record: ${KEY_VARIABLE} is not set; recording calls the live Von API\n`,
    );
    return EXIT_USAGE;
  }

  let cfg: EvalConfig;
  try {
    cfg = loadConfig(argv, env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`fdp-eval record: ${error.message}\n\n${usage()}`);
    return error.exitCode;
  }
  if (!cfg.backends.includes("von")) {
    process.stderr.write("fdp-eval record: --backends: a recording records Von; name von\n");
    return EXIT_USAGE;
  }

  const log = createLogger({ env });
  if (cfg.vonMode !== "auto" && cfg.vonMode !== "live") {
    log.warn("record runs Von live", { ignored: `EVAL_VON_MODE=${cfg.vonMode}` });
  }
  if (
    cfg.profile === TUNING_PROFILE &&
    (cfg.vonGate.ticketMin !== INCUMBENT[0] || cfg.vonGate.reviewMin !== INCUMBENT[1])
  ) {
    // The pre-registered sweep replays this recording at 0.60 / 0.85; recorded at another pair,
    // its decisions fall at other times, their requests find no cassette, and it chooses nothing.
    // Since Von's default pair became the choice (0.65 / 0.85), a re-recording of the tuning list
    // sets VON_GATE_REVIEW_MIN_CONFIDENCE=0.60, or this warns.
    log.warn("the tuning list is recorded at a Von pair the pre-registered sweep does not replay", {
      von_gate: `${cfg.vonGate.reviewMin} / ${cfg.vonGate.ticketMin}`,
      replayed_at: `${INCUMBENT[1]} / ${INCUMBENT[0]}`,
      preregistration: PREREGISTRATION,
    });
  }
  if (cfg.profile === TUNING_PROFILE && !PERSIST_AXIS.includes(cfg.persistSimMin)) {
    // The sweep replays one recording at each N of its axis (the pre-registration's amendment of
    // 2026-09-24); a recording at another N is never read by it.
    log.warn(
      "the tuning list is recorded at a GATE_PERSIST_SIM_MIN the pre-registered sweep does not replay",
      {
        persist_sim_min: cfg.persistSimMin,
        replayed_at: PERSIST_AXIS.join(", "),
        preregistration: PREREGISTRATION,
      },
    );
  }
  try {
    return await executeRun(recordingOf(cfg), { log });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`fdp-eval record: ${error.message}\n`);
      return error.exitCode;
    }
    process.stderr.write(`fdp-eval record: aborted: ${message(error)}\n`);
    return EXIT_ABORTED;
  }
}
