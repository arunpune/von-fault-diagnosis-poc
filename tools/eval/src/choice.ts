// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The committed record of the pre-registered choice of Jev's thresholds
// (tools/eval/records/jev-thresholds-preregistration.md).
//
// `make eval-sweep` makes the choice from the tuning list's recordings: a
// triple (GATE_PERSIST_SIM_MIN, Jev's review threshold, Jev's ticket
// threshold), since the pre-registration's amendment of 2026-09-24. Its
// report stays in the gitignored reports/, because it carries Jev-derived
// figures. The choice itself is configuration, and it is recorded once, in the
// one file this module names: `fdp-eval sweep --preregistered --record-choice`
// writes it from the sweep's own resample runs, and it is committed by hand.
//
// The held-out set's one run (tools/eval/records/heldout-seal.md) reads it
// back: it runs with exactly the committed triple, and `config.ts` refuses it
// without the record, with the record uncommitted or changed since its commit,
// or with any of the three variables set otherwise. So the triple the final run
// is measured at is the triple the sweep chose, not one typed at the prompt.
//
// The record holds the triple and where it came from — the outcome, the
// pre-registration's commit, the sweep report's path and the resample runs —
// and no figure of Jev's, which stays unpublished. Which clause of the rule
// decided is left out too: each clause is a statement about Jev's figures on
// the tuning list, so it stays in the gitignored sweep report with them.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { REPO_ROOT } from "./slices.ts";

/** Where the choice is recorded, relative to the repository root. */
export const CHOICE_RECORD_FILE = "tools/eval/records/jev-thresholds-choice.md";

/** The pre-registration the choice was made under. */
const PREREGISTRATION_FILE = "tools/eval/records/jev-thresholds-preregistration.md";

/** The three variables the triple is set as, in the order the record writes them. */
export const CHOICE_VARIABLES = [
  "GATE_PERSIST_SIM_MIN",
  "JEV_GATE_REVIEW_MIN_CONFIDENCE",
  "JEV_GATE_TICKET_MIN_CONFIDENCE",
] as const;

/** How long a `git` question may take before the answer is "cannot tell". */
const GIT_TIMEOUT_MS = 5_000;

/** A full commit id. */
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** The chosen triple: the pipeline's persistence and Jev's own pair. */
export interface ChosenTriple {
  readonly persistSimMin: number;
  readonly reviewMin: number;
  readonly ticketMin: number;
}

/** Everything the record says, as the sweep hands it over. */
export interface ChoiceRecordInput {
  readonly triple: ChosenTriple;
  /** `change`: the triple replaces (N = 1, 0.60 / 0.85); `keep`: it is that incumbent. */
  readonly outcome: "change" | "keep";
  readonly recordedAt: Date;
  /** The commit that last changed the pre-registration; `null` when Git could not tell. */
  readonly preregistrationCommit: string | null;
  /** The sweep report, relative to the repository root when it lies inside it. */
  readonly report: string;
  /** Each recording's resample runs, in resample order, and the commit they ran at. */
  readonly recordings: readonly {
    readonly persistSimMin: number;
    readonly runs: readonly string[];
    readonly gitSha: string | null;
  }[];
  readonly catalog: { readonly name: string; readonly sha256: string };
}

/** A choice record that cannot be read, named by its file. */
export class ChoiceRecordError extends Error {
  constructor(source: string, problem: string) {
    super(`${source}: ${problem}`);
    this.name = "ChoiceRecordError";
  }
}

/** The absolute path of the choice record, whether or not it exists. */
export function choiceRecordPath(root: string = REPO_ROOT): string {
  return join(root, CHOICE_RECORD_FILE);
}

/** A path as the record writes it: relative to the repository root when inside it. */
export function repoRelative(path: string, root: string = REPO_ROOT): string {
  const inside = relative(root, path);
  return inside.startsWith("..") || inside === "" ? path : inside;
}

/** A threshold with two decimals, as the pre-registration writes them. */
function threshold(value: number): string {
  return value.toFixed(2);
}

/** A persistence as the environment takes it. */
function persistence(value: number): string {
  return String(value);
}

/** The three `NAME=value` lines of a triple. */
export function tripleLines(triple: ChosenTriple): string[] {
  return [
    `GATE_PERSIST_SIM_MIN=${persistence(triple.persistSimMin)}`,
    `JEV_GATE_REVIEW_MIN_CONFIDENCE=${threshold(triple.reviewMin)}`,
    `JEV_GATE_TICKET_MIN_CONFIDENCE=${threshold(triple.ticketMin)}`,
  ];
}

/** `N = 1, 0.60 / 0.85`: the persistence, then the pair review first. */
export function tripleText(triple: ChosenTriple): string {
  return `N = ${persistence(triple.persistSimMin)}, ${threshold(triple.reviewMin)} / ${threshold(triple.ticketMin)}`;
}

/* REUSE-IgnoreStart */
const LICENCE_HEADER: readonly string[] = [
  "<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->",
  "<!-- SPDX-License-Identifier: CC-BY-4.0 -->",
];
/* REUSE-IgnoreEnd */

/** The record's Markdown, as `--record-choice` writes it. */
export function renderChoiceRecord(input: ChoiceRecordInput): string {
  const { triple } = input;
  const outcome =
    input.outcome === "change"
      ? `**change**: the pipeline and Jev move to ${tripleText(triple)}, which replaces the incumbent N = 1, 0.60 / 0.85.`
      : `**keep**: the pipeline and Jev keep the incumbent, ${tripleText(triple)}.`;
  const runs = input.recordings.flatMap((recording) => [
    `- GATE_PERSIST_SIM_MIN = ${persistence(recording.persistSimMin)}: ${recording.runs.map((run) => `\`${run}\``).join(", ")}` +
      ` (commit ${recording.gitSha === null ? "unknown" : `\`${recording.gitSha}\``})`,
  ]);
  return [
    ...LICENCE_HEADER,
    "",
    "# The Jev thresholds choice",
    "",
    `Recorded on ${input.recordedAt.toISOString().slice(0, 10)} by \`fdp-eval sweep --preregistered --record-choice\`, from the`,
    `pre-registered sweep of the tuning list (\`${PREREGISTRATION_FILE}\`, as amended on 2026-09-24).`,
    "This file is written once and committed. The held-out set's one run reads the triple below and runs with",
    "exactly it (`tools/eval/records/heldout-seal.md`); a new choice is recorded here with its reason.",
    "",
    `**Outcome.** ${outcome}`,
    "",
    "**The triple**, as the three variables the held-out run and the stack are given:",
    "",
    "```text",
    ...tripleLines(triple),
    "```",
    "",
    "**Where it came from.**",
    "",
    `- The pre-registration: \`${PREREGISTRATION_FILE}\`, last changed in commit ${input.preregistrationCommit === null ? "unknown" : `\`${input.preregistrationCommit}\``}.`,
    `- The sweep report: \`${input.report}\` (gitignored, because it carries Jev-derived figures).`,
    `- The catalog the tuning list was replayed with: \`${input.catalog.name}\`, sha256 \`${input.catalog.sha256}\`.`,
    "- The resample runs, each recording replayed from its own cassettes:",
    ...runs.map((line) => `  ${line}`),
    "",
    "**Disclosure.** The pre-registration and every decision it rests on were made",
    "after the E3 and E4 results had been seen, so every figure they move stays in-sample. The held-out set's one run is the",
    "first clean figure.",
    "",
  ].join("\n");
}

/**
 * The triple a record holds: each of the three variables exactly once, as `NAME=value` on a line
 * of its own, with a review threshold at or below the ticket threshold.
 *
 * @throws ChoiceRecordError naming `source` and what is wrong.
 */
export function parseChoiceRecord(text: string, source: string): ChosenTriple {
  const values = new Map<string, number>();
  for (const name of CHOICE_VARIABLES) {
    const lines = [...text.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))];
    if (lines.length !== 1) {
      throw new ChoiceRecordError(
        source,
        `names ${name} ${lines.length} times; the record gives each of ${CHOICE_VARIABLES.join(", ")} once, as NAME=value`,
      );
    }
    const raw = (lines[0]?.[1] ?? "").trim();
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value) || value < 0) {
      throw new ChoiceRecordError(source, `${name}=${raw} is not a number at or above 0`);
    }
    if (name !== "GATE_PERSIST_SIM_MIN" && value > 1) {
      throw new ChoiceRecordError(source, `${name}=${raw} is not a confidence in [0, 1]`);
    }
    values.set(name, value);
  }
  const triple: ChosenTriple = {
    persistSimMin: values.get("GATE_PERSIST_SIM_MIN") ?? 0,
    reviewMin: values.get("JEV_GATE_REVIEW_MIN_CONFIDENCE") ?? 0,
    ticketMin: values.get("JEV_GATE_TICKET_MIN_CONFIDENCE") ?? 0,
  };
  if (triple.reviewMin > triple.ticketMin) {
    throw new ChoiceRecordError(
      source,
      `JEV_GATE_REVIEW_MIN_CONFIDENCE ${threshold(triple.reviewMin)} is above JEV_GATE_TICKET_MIN_CONFIDENCE ${threshold(triple.ticketMin)}`,
    );
  }
  return triple;
}

/**
 * The triple the record at `path` holds, or `undefined` when there is no record.
 *
 * @throws ChoiceRecordError when the record cannot be read as a choice.
 */
export function readChoiceRecord(path: string = choiceRecordPath()): ChosenTriple | undefined {
  if (!existsSync(path)) return undefined;
  return parseChoiceRecord(readFileSync(path, "utf8"), path);
}

/** Runs `git` in `root`; `undefined` when Git is absent, fails or takes too long. */
function git(args: readonly string[], root: string): string | undefined {
  try {
    return execFileSync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
}

/**
 * Whether the file at `path` is tracked and unchanged since HEAD, staged changes included: what
 * "committed" means for the record the final run reads. `false` when Git cannot tell.
 */
export function committedUnchanged(path: string, root: string = REPO_ROOT): boolean {
  const file = repoRelative(path, root);
  if (git(["ls-files", "--error-unmatch", "--", file], root) === undefined) return false;
  return git(["diff", "--quiet", "HEAD", "--", file], root) !== undefined;
}

/** The commit that last changed `file` (relative to `root`), or `null` when Git cannot tell. */
export function lastCommitOf(file: string, root: string = REPO_ROOT): string | null {
  const answer = git(["log", "-1", "--format=%H", "--", file], root)?.trim();
  return answer !== undefined && GIT_SHA_PATTERN.test(answer) ? answer : null;
}

/** The commit that last changed the pre-registration, or `null` when Git cannot tell. */
export function preregistrationCommit(root: string = REPO_ROOT): string | null {
  return lastCommitOf(PREREGISTRATION_FILE, root);
}
