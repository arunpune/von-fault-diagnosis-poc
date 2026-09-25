// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-eval sweep`: re-gate a stored run over a grid of gate thresholds
// (docs/evaluation.md).
//
//   fdp-eval sweep --run reports/eval/latest.json --grid 0.6:0.95:0.05x0.5:0.8:0.05
//
// Every decision a run stored carries its choice and its confidence, and the
// gate is a pure function of the two, so a run can be re-gated for any pair of
// (GATE_TICKET_MIN_CONFIDENCE, GATE_REVIEW_MIN_CONFIDENCE) without calling a
// model again. For each backend of the run and each pair of the grid, the
// metrics' `sweep()` rebuilds the tickets each episode would have opened, and
// the run's own scorer (`scoreScenario`, then `aggregateScenarios`, exactly as
// the run's summary was built) scores them — the warmup, the excluded windows
// and the abstention rule included — so the row at the run's own thresholds
// must reproduce the run's summary. Two things a re-gating cannot re-run, which
// is why every row is marked approximate. Episode merging: the merges the run
// made are recovered from `run.json` (`mergeTargets`) and held as they were at
// every grid point. And, since decisions wait for their evidence to persist,
// which decisions were taken at all: an episode that owns no ticket is decided
// only once its evidence has held for GATE_PERSIST_SIM_MIN, while one that owns
// a ticket is decided at once, so a pair that opens a ticket sooner or later
// than the run did would have taken other decisions; the run's are held as it
// took them — except that a decision whose evidence had not yet persisted for
// GATE_PERSIST_SIM_MIN (taken only because its episode owned a ticket) never
// opens a ticket at another pair, when the run recorded `persisted_sim_min`.
// Each backend is re-gated around the pair its gate applied
// (`backends[].thresholds`, Jev's own for Jev). The command checks the
// self-test and says so: a row that does not reproduce is reported with the
// figures that differ.
//
// **It reads a tuning run only.** Design tuning reads the explicit tuning list
// (`fdp-eval run --tuning`) and synthetic frames, never `--profile dev` (it
// replays `metropt3_full` and `f4_precursor_jul14`) and never a core-10 result.
// A run whose profile is not `tuning` is refused unless `--allow-test-split` is
// given, which reports and never chooses; a stack run and a run of the held-out
// set are refused outright. The table is a reading, not a proposal: a change of
// a GATE_* default is a separate, recorded decision that cites the tuning run,
// and no threshold is ever lowered to pass E3.
//
// **A design target is reported beside the rows, never inside them.**
// `unlabelled_leak_may19` carries one: for every grid pair the sweep reads the
// first review item and the first ticket-level ticket inside its unlabelled
// episode against the target, in a block of its own marked never counted. The
// rows' figures never read it — the scenario is diagnostic, so it is not even
// among the scored scenarios they pool — and the pre-registered threshold
// selection (tools/eval/records/jev-thresholds-preregistration.md) leaves may19
// out by name.
//
// **`--preregistered` is the one form that chooses** (`preregistered.ts`,
// tools/eval/records/jev-thresholds-preregistration.md): since the amendment of
// 2026-09-24 a triple — GATE_PERSIST_SIM_MIN and Jev's pair — from the tuning
// list's two recordings (N = 0 and N = 1) replayed from cassettes once per
// resample, over the grid and by the rule the pre-registration fixed. `make
// eval-sweep` runs it; it takes `--out`, `--from-runs` and `--record-choice`
// (which writes the committed choice record, `choice.ts`), and refuses
// `--run`, `--grid` and `--allow-test-split`, which would change its data or
// its grid.
//
// Output: a table per backend on stdout, and `sweep.json` and `sweep.md` in
// the run's directory. Exit codes: 0 written, 1 a usage error or a refused
// run, 3 the run could not be read or the files not written.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { CHOICE_RECORD_FILE } from "../choice.ts";
import { EXIT_ABORTED, EXIT_OK, EXIT_USAGE } from "../cli.ts";
import { ConfigError, DEFAULTS, TUNING_PROFILE } from "../config.ts";
import type { Env } from "../config.ts";
import { HELDOUT_PROFILE, HELDOUT_SEAL_FILE, HELDOUT_SPLIT } from "../heldout.ts";
import { aggregateScenarios, designReading, sweep } from "../metrics/index.ts";
import type {
  BackendAggregate,
  DesignLevelReading,
  SweepRow,
  ThresholdPair,
} from "../metrics/index.ts";
import { ReportSchemaError, validateReport } from "../report/json.ts";
import type { ReportBackendSummary, RunReport } from "../report/types.ts";
import { REPO_ROOT } from "../slices.ts";
import { DEFAULT_OUT, PREREGISTRATION, executePreregistered } from "./preregistered.ts";
import type { PreregisteredDeps, PreregisteredRequest } from "./preregistered.ts";
import {
  SweepUsageError,
  backendThresholds,
  bindingOf,
  regatedDecisions,
  rescoreScenario,
  sweepRunOf,
} from "./regate.ts";

export {
  SweepUsageError,
  backendThresholds,
  bindingOf,
  decisionRecord,
  mergeTargets,
  regatedDecisions,
  rescoreScenario,
  suspectsOf,
  sweepRunOf,
} from "./regate.ts";

/** The default grid: ticket × review floors, both inclusive. */
export const DEFAULT_GRID = "0.6:0.95:0.05x0.5:0.8:0.05";

/** Where the run is read from when `--run` names nothing else. */
export const DEFAULT_RUN = join(DEFAULTS.outDir, "latest.json");

export const SWEEP_JSON_NAME = "sweep.json";
export const SWEEP_MD_NAME = "sweep.md";

/** The `schema` member of `sweep.json`. */
export const SWEEP_SCHEMA_ID = "urn:fdp:eval:sweep:v1";

/** Two figures closer than this are the same figure. */
const TOLERANCE = 1e-12;

/** Decimal places a grid value is rounded to, so 0.6 + 5 × 0.05 is 0.85 and not 0.8500000000000001. */
const GRID_DIGITS = 10;

/**
 * The licence the rendered page carries: evaluation figures are documentation. Fenced off
 * from `reuse lint`, which would otherwise read the literals as this file's own declaration.
 */
/* REUSE-IgnoreStart */
const LICENCE_HEADER: readonly string[] = [
  "<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->",
  "<!-- SPDX-License-Identifier: CC-BY-4.0 -->",
];
/* REUSE-IgnoreEnd */

const OPTIONS = {
  run: { type: "string" },
  grid: { type: "string" },
  "allow-test-split": { type: "boolean" },
  preregistered: { type: "boolean" },
  "from-runs": { type: "boolean" },
  "record-choice": { type: "boolean" },
  out: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/** The `--help` text. */
export function usage(): string {
  return [
    "usage: fdp-eval sweep [options]",
    "       fdp-eval sweep --preregistered [--out <dir>] [--from-runs] [--record-choice]",
    "",
    "Re-gates the decisions of a stored --tuning run over a grid of gate thresholds and writes",
    "sweep.json and sweep.md into the run's directory.",
    "",
    "With --preregistered it makes the choice tools/eval/records/jev-thresholds-preregistration.md fixed",
    "(amended 2026-09-24): a triple (GATE_PERSIST_SIM_MIN, Jev's review and ticket thresholds).",
    "It replays the tuning list with Jev from cassettes, each GATE_PERSIST_SIM_MIN of 0 and 1 from",
    "its own recording, once per resample that recording holds (no API call), re-gates every",
    "resample over the pre-registered grid, applies the selection rule and writes",
    "preregistered-sweep.json and .md under --out (what make eval-sweep runs).",
    "",
    "options:",
    `  --run <path>          the run.json or latest.json to read (default ${DEFAULT_RUN})`,
    `  --grid <t>x<r>        ticket and review floors as from:to:step (default ${DEFAULT_GRID})`,
    "  --allow-test-split    read a run whose profile is not tuning; reports, never chooses",
    "  --preregistered       the pre-registered choice of Jev's thresholds; not with the three above",
    `  --out <dir>           --preregistered: where the resample runs and the report go (default ${DEFAULT_OUT})`,
    "  --from-runs           --preregistered: sweep the resample runs already under --out, replay nothing",
    `  --record-choice       --preregistered: write the choice record, ${CHOICE_RECORD_FILE}, once`,
    "  --help                print this text",
    "",
    "exit codes: 0 written, 1 usage error or refused run, 3 unreadable run or unwritable files",
    "",
  ].join("\n");
}

function rounded(value: number): number {
  return Number(value.toFixed(GRID_DIGITS));
}

/** `from:to:step`, inclusive at both ends, every value in `[0, 1]`. */
function parseAxis(text: string, axis: string): number[] {
  const parts = text.split(":").map((part) => Number(part));
  const [from, to, step] = parts;
  if (
    parts.length !== 3 ||
    from === undefined ||
    to === undefined ||
    step === undefined ||
    parts.some((value) => !Number.isFinite(value))
  ) {
    throw new SweepUsageError(`--grid: the ${axis} axis '${text}' is not from:to:step`);
  }
  if (from < 0 || to > 1 || from > to || step <= 0) {
    throw new SweepUsageError(
      `--grid: the ${axis} axis '${text}' must run upwards inside [0, 1] with a positive step`,
    );
  }
  const count = Math.floor((to - from) / step + 1e-9);
  return Array.from({ length: count + 1 }, (_, index) => rounded(from + index * step));
}

/**
 * The threshold pairs a grid names: every ticket floor with every review floor at or below it.
 *
 * @throws SweepUsageError when the grid is not `<from:to:step>x<from:to:step>` inside `[0, 1]`.
 */
export function parseGrid(text: string): ThresholdPair[] {
  const axes = text.split("x");
  const [ticketAxis, reviewAxis] = axes;
  if (axes.length !== 2 || ticketAxis === undefined || reviewAxis === undefined) {
    throw new SweepUsageError(
      `--grid: '${text}' is not <ticket from:to:step>x<review from:to:step>`,
    );
  }
  const tickets = parseAxis(ticketAxis, "ticket");
  const reviews = parseAxis(reviewAxis, "review");
  return tickets.flatMap((ticketMin) =>
    reviews
      .filter((reviewMin) => reviewMin <= ticketMin)
      .map((reviewMin) => [ticketMin, reviewMin] as const),
  );
}

// --- The sweep ------------------------------------------------------------------------------

/** The figures of one backend at one pair of thresholds. */
export interface SweepFigures {
  readonly ticketMin: number;
  readonly reviewMin: number;
  readonly tickets: number;
  readonly precision: { readonly ticket: number | null; readonly review: number | null };
  readonly recall: { readonly ticket: number | null; readonly review: number | null };
  readonly falseTicketsPerMachineDay: number | null;
  readonly abstentionAccuracy: number | null;
  readonly abstained: number;
}

/** Whether the row at the run's own thresholds gives back the run's summary. */
export interface SelfCheck {
  readonly ticketMin: number;
  readonly reviewMin: number;
  readonly reproduces: boolean;
  /** One line per figure that differs; empty when the row reproduces the run. */
  readonly differences: readonly string[];
}

/** One backend of the run, swept. */
export interface BackendSweep {
  readonly backend: string;
  readonly mode: string;
  readonly scenarios: number;
  /** Episodes the run merged; re-gating rebuilds them unmerged. */
  readonly mergedEpisodes: number;
  readonly rows: readonly SweepFigures[];
  readonly own: SelfCheck;
}

/** A design target read at one grid pair. */
export interface DesignSweepRow {
  readonly ticketMin: number;
  readonly reviewMin: number;
  readonly review: DesignLevelReading;
  readonly ticket: DesignLevelReading;
}

/** One backend's reading of one scenario's design target over the grid: reported, never counted. */
export interface DesignSweep {
  readonly backend: string;
  readonly scenario: string;
  readonly accepted: readonly string[];
  readonly provenance: string;
  /** Always false: no row figure, gate or threshold selection reads it. */
  readonly gated: false;
  readonly rows: readonly DesignSweepRow[];
}

/** A whole run, swept. */
export interface SweepResult {
  readonly runId: string;
  readonly profile: string;
  readonly thresholds: { readonly ticketMin: number; readonly reviewMin: number };
  readonly grid: readonly ThresholdPair[];
  readonly allowTestSplit: boolean;
  readonly backends: readonly BackendSweep[];
  /** The design targets of the run's scenarios over the grid; empty when none carries one. */
  readonly designTargets: readonly DesignSweep[];
}

function figures(
  pair: ThresholdPair,
  aggregate: BackendAggregate,
  abstained: number,
): SweepFigures {
  const { ticket, review } = aggregate.precisionRecall;
  return {
    ticketMin: pair[0],
    reviewMin: pair[1],
    tickets: aggregate.rates.tickets,
    precision: { ticket: ticket.micro.precision, review: review.micro.precision },
    recall: { ticket: ticket.micro.recall, review: review.micro.recall },
    falseTicketsPerMachineDay: aggregate.rates.falseTicketsPerMachineDay,
    abstentionAccuracy: aggregate.abstention.accuracy,
    abstained,
  };
}

/**
 * Every design target of the run read over the grid: per backend and scenario carrying one,
 * the first review item and ticket-level ticket inside its unlabelled episodes at each pair. It
 * reads the scenarios whether or not they are scored — a design case is a diagnostic scenario —
 * and nothing it returns reaches a row.
 */
export function sweepDesignTargets(
  report: RunReport,
  grid: readonly ThresholdPair[],
  allowTestSplit: boolean,
): DesignSweep[] {
  return report.scenarios.flatMap((scenario) => {
    const target = scenario.design_target;
    if (target === undefined) return [];
    const binding = bindingOf(scenario);
    const swept: readonly SweepRow[] = sweep(sweepRunOf(scenario, report), grid, {
      allowTestSplit,
    });
    const rows = swept.map((row): DesignSweepRow => {
      const pair = [row.ticketMin, row.reviewMin] as const;
      const metrics = rescoreScenario(scenario, row, pair, report);
      const reading = designReading({
        scenarioId: scenario.id,
        backend: scenario.backend,
        target,
        excluded: binding.excluded,
        tickets: metrics.tickets,
        decisions: regatedDecisions(scenario, pair),
        benignFaultIds: binding.benignFaultIds,
      });
      return {
        ticketMin: row.ticketMin,
        reviewMin: row.reviewMin,
        review: reading.review,
        ticket: reading.ticket,
      };
    });
    return [
      {
        backend: scenario.backend,
        scenario: scenario.id,
        accepted: [...target.accepted],
        provenance: target.provenance,
        gated: false,
        rows,
      },
    ];
  });
}

function same(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= TOLERANCE;
}

/** The figures of the run's own row against the run's own summary of the backend. */
function selfCheck(row: SweepFigures, summary: ReportBackendSummary | undefined): SelfCheck {
  const differences: string[] = [];
  if (summary === undefined) {
    differences.push("the run has no summary for this backend");
  } else {
    const pairs: readonly [string, number | null, number | null][] = [
      [
        "precision (ticket, micro)",
        row.precision.ticket,
        summary.precision_recall.ticket.micro.precision,
      ],
      ["recall (ticket, micro)", row.recall.ticket, summary.precision_recall.ticket.micro.recall],
      [
        "precision (review, micro)",
        row.precision.review,
        summary.precision_recall.review.micro.precision,
      ],
      ["recall (review, micro)", row.recall.review, summary.precision_recall.review.micro.recall],
      [
        "false tickets per machine-day",
        row.falseTicketsPerMachineDay,
        summary.rates.false_tickets_per_machine_day,
      ],
      ["abstention accuracy", row.abstentionAccuracy, summary.abstention.accuracy],
      ["tickets", row.tickets, summary.rates.tickets],
    ];
    for (const [metric, swept, stored] of pairs) {
      if (!same(swept, stored))
        differences.push(`${metric}: sweep ${String(swept)}, run ${String(stored)}`);
    }
  }
  return {
    ticketMin: row.ticketMin,
    reviewMin: row.reviewMin,
    reproduces: differences.length === 0,
    differences,
  };
}

function sweepBackend(
  report: RunReport,
  backend: RunReport["backends"][number],
  grid: readonly ThresholdPair[],
  allowTestSplit: boolean,
): BackendSweep | undefined {
  const scenarios = report.scenarios.filter(
    (scenario) => scenario.backend === backend.name && scenario.scored,
  );
  if (scenarios.length === 0) return undefined;

  const perScenario = scenarios.map((scenario) => ({
    scenario,
    rows: sweep(sweepRunOf(scenario, report), grid, { allowTestSplit }),
  }));
  const pairs = (perScenario[0]?.rows ?? []).map((row) => [row.ticketMin, row.reviewMin] as const);
  const rows = pairs.map((pair, index) => {
    const metrics = perScenario.map(({ scenario, rows: swept }) =>
      rescoreScenario(scenario, swept[index] ?? { tickets: [] }, pair, report),
    );
    const abstained = perScenario.reduce(
      (total, { rows: swept }) => total + (swept[index]?.abstained ?? 0),
      0,
    );
    return figures(pair, aggregateScenarios(metrics), abstained);
  });

  const { ticketMin, reviewMin } = backendThresholds(report, backend.name);
  const own = rows.find((row) => same(row.ticketMin, ticketMin) && same(row.reviewMin, reviewMin));
  if (own === undefined) throw new Error("sweep() dropped the run's own thresholds");
  return {
    backend: backend.name,
    mode: backend.mode,
    scenarios: scenarios.length,
    mergedEpisodes: scenarios.reduce((total, scenario) => total + scenario.episodes.merged, 0),
    rows,
    own: selfCheck(
      own,
      report.summary?.backends.find((entry) => entry.backend === backend.name),
    ),
  };
}

/**
 * Sweeps every backend of a stored run over a grid.
 *
 * @throws SweepUsageError for a stack run and for a run of the held-out set, whatever the
 * options, and for a run whose profile is not `tuning` or that scored a test-split scenario,
 * unless `allowTestSplit` is set.
 */
export function sweepReport(
  report: RunReport,
  grid: readonly ThresholdPair[],
  options: { readonly allowTestSplit?: boolean } = {},
): SweepResult {
  const allowTestSplit = options.allowTestSplit === true;
  if (report.run.mode === "stack") {
    throw new SweepUsageError(
      "a stack run carries no tuning split; sweep a run of `fdp-eval run --tuning`",
    );
  }
  const heldout = report.scenarios.filter((scenario) => scenario.split === HELDOUT_SPLIT);
  if (report.run.profile === HELDOUT_PROFILE || heldout.length > 0) {
    throw new SweepUsageError(
      `run ${report.run.id} replayed the held-out set, which is read once at thresholds ` +
        `already fixed and never re-gated, --allow-test-split or not (${HELDOUT_SEAL_FILE})`,
    );
  }
  if (report.run.profile !== TUNING_PROFILE && !allowTestSplit) {
    throw new SweepUsageError(
      `run ${report.run.id} has profile '${report.run.profile}': the sweep reads a run of the ` +
        "explicit tuning list only (`fdp-eval run --tuning`); --allow-test-split reports " +
        "another run but never chooses a threshold",
    );
  }
  const testSplit = report.scenarios
    .filter((scenario) => scenario.scored && scenario.split === "test")
    .map((scenario) => scenario.id);
  if (testSplit.length > 0 && !allowTestSplit) {
    throw new SweepUsageError(
      `run ${report.run.id} scored test-split scenarios (${[...new Set(testSplit)].join(", ")}); ` +
        "thresholds are never tuned on the core-10",
    );
  }
  return {
    runId: report.run.id,
    profile: report.run.profile,
    thresholds: {
      ticketMin: report.run.thresholds.ticket_min,
      reviewMin: report.run.thresholds.review_min,
    },
    grid,
    allowTestSplit,
    backends: report.backends
      .map((backend) => sweepBackend(report, backend, grid, allowTestSplit))
      .filter((entry): entry is BackendSweep => entry !== undefined),
    designTargets: sweepDesignTargets(report, grid, allowTestSplit),
  };
}

// --- Rendering ------------------------------------------------------------------------------

const DASH = "—";

function ratio(value: number | null): string {
  return value === null ? DASH : value.toFixed(3);
}

const HEADER = [
  "Ticket ≥",
  "Review ≥",
  "Tickets",
  "Precision (ticket)",
  "Recall (ticket)",
  "Precision (review)",
  "Recall (review)",
  "False tickets / machine-day",
  "Abstention accuracy",
] as const;

function cells(row: SweepFigures, own: boolean): string[] {
  return [
    `${row.ticketMin.toFixed(2)}${own ? " *" : ""}`,
    row.reviewMin.toFixed(2),
    String(row.tickets),
    ratio(row.precision.ticket),
    ratio(row.recall.ticket),
    ratio(row.precision.review),
    ratio(row.recall.review),
    ratio(row.falseTicketsPerMachineDay),
    ratio(row.abstentionAccuracy),
  ];
}

function isOwn(row: SweepFigures, own: SelfCheck): boolean {
  return same(row.ticketMin, own.ticketMin) && same(row.reviewMin, own.reviewMin);
}

function selfCheckLine(entry: BackendSweep): string {
  const where = `at the run's own thresholds (${entry.own.ticketMin}, ${entry.own.reviewMin})`;
  if (entry.own.reproduces) return `The row ${where} reproduces the run's summary.`;
  const merged =
    entry.mergedEpisodes > 0
      ? ` The run merged ${entry.mergedEpisodes} episode(s), which re-gating rebuilds unmerged.`
      : "";
  return `The row ${where} does NOT reproduce the run's summary: ${entry.own.differences.join("; ")}.${merged}`;
}

/** The notice every sweep carries. */
function notice(result: SweepResult): string {
  const source =
    result.profile === TUNING_PROFILE
      ? `the tuning run \`${result.runId}\``
      : `run \`${result.runId}\`, profile \`${result.profile}\`, read with --allow-test-split: a report, never a basis for a threshold`;
  return (
    `Re-gated from ${source}. Every row is approximate: the run's episode merges are held as ` +
    "the run made them, not re-run at each pair, and so are its decisions. An episode that owns " +
    "no ticket is decided only once its evidence has held for GATE_PERSIST_SIM_MIN, and one " +
    "that owns a ticket is decided at once, so a pair that opens a ticket sooner or " +
    "later than the run did would have taken other decisions; the run's decisions are held as " +
    "the run took them, except that a decision taken on evidence younger than " +
    "GATE_PERSIST_SIM_MIN, which only an episode that owned a ticket could take, never opens a " +
    "ticket at another pair (when the run recorded how long each decision's evidence had held). " +
    "This is a reading, not a proposal — changing GATE_TICKET_MIN_CONFIDENCE or " +
    "GATE_REVIEW_MIN_CONFIDENCE is a separate, recorded decision that cites the tuning run, and " +
    "no threshold is lowered to pass E3."
  );
}

function markdownRow(values: readonly string[]): string {
  return `| ${values.join(" | ")} |`;
}

/** A design target's cell: the first item's cause and whether it is on target. */
function designCell(reading: DesignLevelReading): string {
  if (reading.first === undefined) return DASH;
  return `${reading.first.faultAtOpen} (${reading.met ? "on target" : "off target"})`;
}

const DESIGN_HEADER = [
  "Ticket ≥",
  "Review ≥",
  "First review item",
  "Review items on / off target",
  "First ticket-level",
  "Ticket-level on / off target",
] as const;

function designCells(row: DesignSweepRow): string[] {
  return [
    row.ticketMin.toFixed(2),
    row.reviewMin.toFixed(2),
    designCell(row.review),
    `${row.review.onTarget} / ${row.review.offTarget}`,
    designCell(row.ticket),
    `${row.ticket.onTarget} / ${row.ticket.offTarget}`,
  ];
}

/** The design-target section of `sweep.md`: apart from the rows, and never counted. */
function designMarkdown(designs: readonly DesignSweep[]): string[] {
  if (designs.length === 0) return [];
  const lines = [
    "## Design targets: reported, never counted",
    "",
    "A design target is a design aid on a diagnostic scenario, inferred and unverified: the rows above never read it, and the pre-registered threshold selection leaves its scenario out. Each table reads the scenario's tickets inside its unlabelled episode against the target at every pair.",
    "",
  ];
  for (const design of designs) {
    lines.push(
      `### \`${design.scenario}\` · ${design.backend}: ${design.accepted.map((id) => `\`${id}\``).join(" or ")}`,
      "",
      `Provenance: ${design.provenance}.`,
      "",
      markdownRow(DESIGN_HEADER),
      markdownRow(DESIGN_HEADER.map(() => "---")),
      ...design.rows.map((row) => markdownRow(designCells(row))),
      "",
    );
  }
  return lines;
}

/** `sweep.md`: the notice, then one table per backend with its self-check. */
export function renderSweepMarkdown(result: SweepResult): string {
  const lines = [
    ...LICENCE_HEADER,
    "",
    `# Threshold sweep of \`${result.runId}\``,
    "",
    notice(result),
    "",
  ];
  for (const entry of result.backends) {
    lines.push(
      `## ${entry.backend}${entry.mode === "-" ? "" : ` (${entry.mode})`}`,
      "",
      `${entry.scenarios} scored scenario(s); \`*\` marks the run's own thresholds. ${selfCheckLine(entry)}`,
      "",
      markdownRow(HEADER),
      markdownRow(HEADER.map(() => "---")),
      ...entry.rows.map((row) => markdownRow(cells(row, isOwn(row, entry.own)))),
      "",
    );
  }
  if (result.backends.length === 0)
    lines.push("The run scored no scenario, so there is nothing to sweep.", "");
  lines.push(...designMarkdown(result.designTargets));
  return lines.join("\n");
}

/** The console table: one block per backend, columns padded. */
export function renderSweepConsole(
  result: SweepResult,
  files: { readonly json: string; readonly md: string },
): string {
  const lines = [
    `fdp-eval sweep ${result.runId} (profile ${result.profile}; * = the run's own thresholds)`,
  ];
  for (const entry of result.backends) {
    const rows = [[...HEADER], ...entry.rows.map((row) => cells(row, isOwn(row, entry.own)))];
    const widths = HEADER.map((_, column) =>
      Math.max(...rows.map((row) => (row[column] ?? "").length)),
    );
    lines.push(
      "",
      `${entry.backend}${entry.mode === "-" ? "" : ` (${entry.mode})`}:`,
      ...rows.map((row) =>
        row
          .map((cell, column) => cell.padEnd(widths[column] ?? 0))
          .join("  ")
          .trimEnd(),
      ),
      selfCheckLine(entry),
    );
  }
  for (const design of result.designTargets) {
    const own = design.rows.find(
      (row) =>
        same(row.ticketMin, result.thresholds.ticketMin) &&
        same(row.reviewMin, result.thresholds.reviewMin),
    );
    lines.push(
      "",
      `design target (reported, never counted) ${design.scenario} ${design.backend}: ` +
        `${design.accepted.join(" or ")}; at the run's own thresholds the first review item is ` +
        `${own === undefined ? DASH : designCell(own.review)}, the first ticket-level ` +
        `${own === undefined ? DASH : designCell(own.ticket)} (every pair in sweep.md)`,
    );
  }
  lines.push("", `sweep.json: ${files.json}`, `sweep.md: ${files.md}`);
  return `${lines.join("\n")}\n`;
}

/** `sweep.json`. */
export function sweepDocument(result: SweepResult): unknown {
  return {
    schema: SWEEP_SCHEMA_ID,
    run: {
      id: result.runId,
      profile: result.profile,
      thresholds: {
        ticket_min: result.thresholds.ticketMin,
        review_min: result.thresholds.reviewMin,
      },
    },
    grid: result.grid.map(([ticketMin, reviewMin]) => [ticketMin, reviewMin]),
    allow_test_split: result.allowTestSplit,
    approximate: true,
    backends: result.backends.map((entry) => ({
      backend: entry.backend,
      mode: entry.mode,
      scenarios: entry.scenarios,
      merged_episodes: entry.mergedEpisodes,
      rows: entry.rows.map((row) => ({
        ticket_min: row.ticketMin,
        review_min: row.reviewMin,
        tickets: row.tickets,
        precision: { ...row.precision },
        recall: { ...row.recall },
        false_tickets_per_machine_day: row.falseTicketsPerMachineDay,
        abstention_accuracy: row.abstentionAccuracy,
        abstained: row.abstained,
      })),
      own: {
        ticket_min: entry.own.ticketMin,
        review_min: entry.own.reviewMin,
        reproduces: entry.own.reproduces,
        differences: [...entry.own.differences],
      },
    })),
    design_targets: result.designTargets.map((design) => ({
      scenario: design.scenario,
      backend: design.backend,
      gated: false,
      accepted: [...design.accepted],
      provenance: design.provenance,
      rows: design.rows.map((row) => ({
        ticket_min: row.ticketMin,
        review_min: row.reviewMin,
        review: designLevelDocument(row.review),
        ticket: designLevelDocument(row.ticket),
      })),
    })),
  };
}

function designLevelDocument(reading: DesignLevelReading): unknown {
  return {
    first_fault: reading.first?.faultAtOpen ?? null,
    first_opened_sim_ts: reading.first?.openedSimTs.toISOString() ?? null,
    met: reading.met,
    on_target: reading.onTarget,
    off_target: reading.offTarget,
    benign: reading.benign,
    outside: reading.outside,
  };
}

// --- The command ----------------------------------------------------------------------------

/** What a sweep is asked for. */
export interface SweepRequest {
  /** Absolute path of the run.json or latest.json to read. */
  readonly runPath: string;
  readonly grid: readonly ThresholdPair[];
  readonly allowTestSplit: boolean;
}

function parseFlags(args: readonly string[]) {
  try {
    return parseArgs({ args: [...args], options: OPTIONS, allowPositionals: false, strict: true })
      .values;
  } catch (error) {
    throw new SweepUsageError(error instanceof Error ? error.message : String(error));
  }
}

/** A path as given, made absolute against pnpm's `INIT_CWD` or the working directory. */
function pathFrom(given: string, env: Env): string {
  const initCwd = env["INIT_CWD"];
  const cwd = initCwd === undefined || initCwd === "" ? process.cwd() : initCwd;
  return isAbsolute(given) ? given : resolve(cwd, given);
}

/**
 * The pre-registered form's request. Its grid, its backend and its data are the
 * pre-registration's, so the flags that would change them are refused rather than ignored.
 */
function preregisteredRequest(
  values: ReturnType<typeof parseFlags>,
  env: Env,
): PreregisteredRequest {
  for (const flag of ["run", "grid", "allow-test-split"] as const) {
    if (values[flag] !== undefined) {
      throw new SweepUsageError(
        `--preregistered fixes its own runs, grid and data (${PREREGISTRATION}); --${flag} is not allowed with it`,
      );
    }
  }
  const out = values.out === undefined || values.out === "" ? undefined : values.out;
  return {
    outDir: out === undefined ? resolve(REPO_ROOT, DEFAULT_OUT) : pathFrom(out, env),
    fromRuns: values["from-runs"] === true,
    env,
    recordChoice: values["record-choice"] === true,
  };
}

function parseRequest(
  args: readonly string[],
  env: Env,
): SweepRequest | { readonly preregistered: PreregisteredRequest } | "help" {
  const values = parseFlags(args);
  if (values.help === true) return "help";
  if (values.preregistered === true) return { preregistered: preregisteredRequest(values, env) };
  for (const flag of ["from-runs", "record-choice", "out"] as const) {
    if (values[flag] !== undefined) {
      throw new SweepUsageError(`--${flag} belongs to --preregistered`);
    }
  }

  const given = values.run === undefined || values.run === "" ? undefined : values.run;
  return {
    runPath: given === undefined ? resolve(REPO_ROOT, DEFAULT_RUN) : pathFrom(given, env),
    grid: parseGrid(values.grid ?? DEFAULT_GRID),
    allowTestSplit: values["allow-test-split"] === true,
  };
}

/**
 * The directory a run's own files live in: a `run.json`'s directory, or for `latest.json` the
 * run directory beside it that its id names, falling back to the file's directory.
 */
export function runDirectoryOf(runPath: string, runId: string): string {
  const directory = dirname(runPath);
  if (basename(runPath) === "run.json") return directory;
  const named = join(directory, runId);
  return existsSync(named) ? named : directory;
}

/**
 * Reads a run, sweeps it and writes `sweep.json` and `sweep.md` beside it.
 *
 * @throws SweepUsageError when the file is missing, is not a run, or is refused.
 */
export function executeSweep(
  request: SweepRequest,
  stdout: { write(chunk: string): unknown } = process.stdout,
): { readonly result: SweepResult; readonly json: string; readonly md: string } {
  if (!existsSync(request.runPath)) {
    throw new SweepUsageError(
      `--run: ${request.runPath} does not exist; run \`fdp-eval run --tuning\` first`,
    );
  }
  let report: RunReport;
  try {
    report = validateReport(JSON.parse(readFileSync(request.runPath, "utf8")));
  } catch (error) {
    if (error instanceof ReportSchemaError || error instanceof SyntaxError) {
      throw new SweepUsageError(`--run: ${request.runPath} is not a run.json: ${error.message}`);
    }
    throw error;
  }
  const result = sweepReport(report, request.grid, { allowTestSplit: request.allowTestSplit });
  const directory = runDirectoryOf(request.runPath, report.run.id);
  const json = join(directory, SWEEP_JSON_NAME);
  const md = join(directory, SWEEP_MD_NAME);
  writeFileSync(json, `${JSON.stringify(sweepDocument(result), null, 2)}\n`, "utf8");
  writeFileSync(md, renderSweepMarkdown(result), "utf8");
  stdout.write(renderSweepConsole(result, { json, md }));
  return { result, json, md };
}

/**
 * Runs `fdp-eval sweep`.
 *
 * @param args everything after the subcommand name; a bare `--` from pnpm is dropped.
 * @returns the exit code: 0 written, 1 usage error or refused run, 3 aborted.
 */
export async function run(
  args: readonly string[],
  env: Env = process.env,
  deps: PreregisteredDeps = {},
): Promise<number> {
  try {
    const request = parseRequest(
      args.filter((argument) => argument !== "--"),
      env,
    );
    if (request === "help") {
      process.stdout.write(usage());
      return EXIT_OK;
    }
    if ("preregistered" in request) {
      await executePreregistered(request.preregistered, deps);
    } else {
      executeSweep(request);
    }
    return EXIT_OK;
  } catch (error) {
    if (error instanceof SweepUsageError) {
      process.stderr.write(`fdp-eval sweep: ${error.message}\n\n${usage()}`);
      return EXIT_USAGE;
    }
    if (error instanceof ConfigError) {
      // A replay the configuration cannot drive, e.g. no cassette recorded yet.
      process.stderr.write(`fdp-eval sweep: ${error.message}\n`);
      return error.exitCode;
    }
    process.stderr.write(
      `fdp-eval sweep: aborted: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_ABORTED;
  }
}
