// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-eval sweep --preregistered`, which `make eval-sweep` runs: the choice
// of Von's gate thresholds and the pipeline's persistence, made the way
// tools/eval/records/von-thresholds-preregistration.md fixed it on 2026-09-23 and
// amended it on 2026-09-24, both before any Von decision on the tuning list
// existed.
//
//   fdp-eval sweep --preregistered [--out <dir>] [--from-runs] [--record-choice]
//
// **What it chooses.** A triple (N, review, ticket): N is GATE_PERSIST_SIM_MIN
// in {0, 1}, which applies to the pipeline as a whole, and the pair is
// Von's own. Each N changes which requests exist, so each N is read from its
// own recording of the tuning list, the recorder run with
// GATE_PERSIST_SIM_MIN = N. One cassette store holds both, and serves a replay
// at N the answers recorded at N only (`backends/cassette.ts`).
//
// **What it reads.** The tuning list, and only it, answered by Von from
// cassettes: nothing here can call an API. Each N's recording is replayed once
// per resample (`--resample r`, `backends/cassette-server.ts`): resample 0 is
// the recording in the order the model answered it, and resample r serves
// every repeated request's recorded answers rotated by r, so over R_N
// resamples every arrival is served every answer the recording holds. R_N is
// the most answers any cassette N's replay hit holds at N. Each replay runs
// the Von gate at 0.60 / 0.85, the pair the recordings were made at, and
// GATE_PERSIST_SIM_MIN = N. `--from-runs` sweeps the resample runs a previous
// invocation left under `--out` instead of replaying them.
//
// **What it computes.** For every triple — the pre-registered grid of pairs
// (review 0.50…0.80, ticket 0.70…0.95, both in steps of 0.05, review < ticket)
// at each N — and every resample of its N's recording, the replay's decisions
// are re-gated (`regate.ts`, the persistence rule respected) and scored by the
// run's own scorer, pooled over the tuning list less the two scenarios it
// reports apart (`unlabelled_leak_may19` and `august_oil_level_aug10`): false
// tickets and false reviews per negative machine-day, and the positives
// passed. The two reported apart are listed on their own, never pooled.
//
// **What it decides.** The selection rule, as amended (`applySelectionRule`):
// the constraint on every resample, the objective on the median resample, the
// ties (then N = 1, then the pair closest to 0.60 / 0.85), and "stay unless
// clearly better" against (N = 1, 0.60 / 0.85). The readings the
// pre-registration leaves to its implementation are fixed below (`READINGS`),
// written before any tuning-list decision of Von had been recorded, and every
// report repeats them. When a recording is missing — an N whose replay had no
// cassette hit at N — no triple is chosen and the report names the recording.
// When a resample could not be read as the model's own answers — a cassette
// miss (the mock answered), a failed decision, or a re-gating that does not
// give the replay back at 0.60 / 0.85 — the table is still written, but no
// triple is chosen.
//
// **What it never does.** It never reads a core-10 scenario: it replays
// `--tuning` only, and refuses a run that is not exactly the tuning list. Its
// figures go to the gitignored `reports/`, because they are Von-derived. It
// changes no default. With `--record-choice` it writes the committed record of
// the choice (tools/eval/records/von-thresholds-choice.md, `choice.ts`): the
// triple as the three variables, and where it came from, without a Von figure.
// Once the record is committed, the triple becomes GATE_PERSIST_SIM_MIN,
// VON_GATE_REVIEW_MIN_CONFIDENCE and VON_GATE_TICKET_MIN_CONFIDENCE, as the
// pre-registration's "After the choice" describes; the held-out set's one run
// reads the record and runs with exactly that triple.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  choiceRecordPath,
  preregistrationCommit as gitPreregistrationCommit,
  renderChoiceRecord,
  repoRelative,
} from "../choice.ts";
import type { ChosenTriple } from "../choice.ts";
import { ConfigError, loadConfig } from "../config.ts";
import type { Env, EvalConfig } from "../config.ts";
import { sweep } from "../metrics/index.ts";
import type { ScenarioMetrics, ThresholdPair } from "../metrics/index.ts";
import { VON_NOTICE } from "../report/markdown.ts";
import { LATEST_JSON_NAME, ReportSchemaError, validateReport } from "../report/json.ts";
import type { ReportScenario, RunReport } from "../report/types.ts";
import { executeRun } from "../runner/run.ts";
import { TUNING_REPORTED_APART, TUNING_REPORTED_ONLY, TUNING_SCENARIOS } from "../tuning.ts";
import { SweepUsageError, backendThresholds, rescoreScenario, sweepRunOf } from "./regate.ts";

/** The file that fixed the procedure, the grid and the rule. */
export const PREREGISTRATION = "tools/eval/records/von-thresholds-preregistration.md";

/** The one backend the pre-registration chooses thresholds for. */
export const PREREGISTERED_BACKEND = "von";

/** The review thresholds of the grid. */
export const REVIEW_AXIS: readonly number[] = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];

/** The ticket thresholds of the grid. */
export const TICKET_AXIS: readonly number[] = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

/**
 * The values of GATE_PERSIST_SIM_MIN the sweep evaluates, each on its own recording of the tuning
 * list (the pre-registration's amendment of 2026-09-24).
 */
export const PERSIST_AXIS: readonly number[] = [0, 1];

/** 0.60 / 0.85 as `[ticketMin, reviewMin]`: the pair of the recordings, and the incumbent's. */
export const INCUMBENT: ThresholdPair = [0.85, 0.6];

/** A point of the sweep: the pipeline's GATE_PERSIST_SIM_MIN and Von's pair. */
export interface Triple {
  readonly persistSimMin: number;
  /** `[ticketMin, reviewMin]`. */
  readonly pair: ThresholdPair;
}

/** (N = 1, 0.60 / 0.85): what the pipeline and Von keep unless a triple is clearly better. */
export const INCUMBENT_TRIPLE: Triple = Object.freeze({ persistSimMin: 1, pair: INCUMBENT });

/** The hard constraint, per negative machine-day, on every resample. */
export const LIMITS = Object.freeze({ falseTicketsPerDay: 0.1, falseReviewsPerDay: 0.5 });

export const PREREGISTERED_JSON_NAME = "preregistered-sweep.json";
export const PREREGISTERED_MD_NAME = "preregistered-sweep.md";

/** The `schema` member of `preregistered-sweep.json`; v2 since the triples of 2026-09-24. */
export const PREREGISTERED_SCHEMA_ID = "urn:fdp:eval:preregistered-sweep:v2";

/** Where the resample runs and the report go when `--out` names nothing else. */
export const DEFAULT_OUT = "reports/eval/sweep";

/** Two figures closer than this are the same figure. */
const EPSILON = 1e-9;

/**
 * How this implementation reads what the pre-registration leaves open. Fixed on 2026-09-24,
 * before any Von decision on the tuning list had been recorded, and repeated in every report;
 * rewritten the same day, still before any recording, for the amendment's triples.
 */
export const READINGS: readonly string[] = [
  "Triples: (N, review, ticket), N = GATE_PERSIST_SIM_MIN in {0, 1} and the 36 pairs of the grid at each N, 72 triples. Each N is read from its own recording of the tuning list, the recorder run with GATE_PERSIST_SIM_MIN = N, replayed at N; the one cassette store serves a replay at N the answers recorded at N and no others. The chosen N applies to the pipeline as a whole; the rules backend is a recorded baseline no gate reads.",
  "Resample: resample 0 replays N's recording in the order the model answered; resample r serves each repeated request's recorded answers rotated by r (the arrival resample 0 answers with answer i gets answer (i + r) mod k). A request recorded once gets its one answer in every resample. N has as many resamples as the fullest cassette its replay hit holds answers at N, so the two N may have different numbers of resamples.",
  "Decisions: each resample's replay runs the Von gate at 0.60 / 0.85, the pair of the recordings, with GATE_PERSIST_SIM_MIN = N; its decisions and episode merges are re-gated as the replay took them, and a decision whose evidence had not persisted for N (taken only because its episode owned a ticket) never opens a ticket at another pair. Every figure is therefore a re-gating, approximate as the threshold sweep is.",
  "False tickets and false reviews: the false positives of the ticket classification, misdiagnoses included and benign, ignored and warm-up tickets not, at ticket level (tickets that reached ticket level) and at review level (every ticket, those that reached ticket level included); each is summed over the counted scenarios and divided by their summed negative machine-days.",
  "Counted scenarios: the ten of the tuning list less unlabelled_leak_may19 (the tuning list's design case) and august_oil_level_aug10 (the amendment of 2026-09-24), which are reported apart and never counted: neither's tickets are false tickets, neither's time is negative time, and neither is a positive. The report lists both separately, with every ticket they opened.",
  "Positives: the counted scenarios that bind a non-benign scoring window (f4b_recurrence_jul17 and the five injections, the dev twin included). One passes when the scenario's own pass rule holds at its expect.pass_level, its budget and false-ticket allowance included: the ticket rule, so a `detection` level reads the review-or-ticket rule that was renamed review_diagnosis on 2026-09-24, when E3's detection level moved to suspect events.",
  "Median resample: the middle value of a triple's per-resample figures over its own N's resamples, the mean of the two middle ones when their number is even. The ties compare the median false reviews, then the median false tickets, per negative machine-day.",
  "Ties after false reviews and false tickets: a triple at N = 1 ranks above one at N = 0, whatever their distances; then the pair closest to 0.60 / 0.85, by the Euclidean distance in (ticket, review). A tie still left after it, which the pre-registration does not settle, goes to the higher ticket threshold and then the higher review threshold (its stated priority: few false alarms first), and the report says when that decided.",
  "Never fewer, across N: a triple at N = 1 is compared with the incumbent resample by resample, both being replays of the one recording. A triple at N = 0 has the resamples of another recording, which pair with none of the incumbent's; it then passes never fewer only when its fewest positives, over its resamples, are at least the incumbent's most: never fewer under any pairing of the two recordings' resamples.",
  "Order: the constraint, the objective and the ties pick the best qualifying triple; clause 4 then decides whether it replaces (N = 1, 0.60 / 0.85).",
  "Withheld: when a recording is missing (an N whose resample 0 had no cassette hit at N and at least one miss), the sweep names it and chooses nothing; when a resample had a cassette miss (the mock answered), a failed decision, or does not give its own run back when re-gated at 0.60 / 0.85, the figures are written and no triple is chosen.",
];

// --- The grid --------------------------------------------------------------------------------

/** Every pair of the grid with review < ticket, ticket-major, as `[ticketMin, reviewMin]`. */
export function preregisteredGrid(): ThresholdPair[] {
  return TICKET_AXIS.flatMap((ticketMin) =>
    REVIEW_AXIS.filter((reviewMin) => reviewMin < ticketMin - EPSILON).map(
      (reviewMin) => [ticketMin, reviewMin] as const,
    ),
  );
}

function samePair(left: ThresholdPair, right: ThresholdPair): boolean {
  return Math.abs(left[0] - right[0]) < EPSILON && Math.abs(left[1] - right[1]) < EPSILON;
}

function sameValue(left: number, right: number): boolean {
  return Math.abs(left - right) < EPSILON;
}

function sameTriple(left: Triple, right: Triple): boolean {
  return sameValue(left.persistSimMin, right.persistSimMin) && samePair(left.pair, right.pair);
}

/** `0.60 / 0.85`: review first, as the pre-registration writes a pair. */
export function pairText(pair: ThresholdPair): string {
  return `${pair[1].toFixed(2)} / ${pair[0].toFixed(2)}`;
}

/** `N = 1, 0.60 / 0.85`. */
export function tripleText(triple: Triple): string {
  return `N = ${String(triple.persistSimMin)}, ${pairText(triple.pair)}`;
}

/** The three variables a triple is set as. */
export function tripleVariables(triple: Triple): string {
  return (
    `GATE_PERSIST_SIM_MIN=${String(triple.persistSimMin)}, ` +
    `VON_GATE_REVIEW_MIN_CONFIDENCE=${triple.pair[1].toFixed(2)}, ` +
    `VON_GATE_TICKET_MIN_CONFIDENCE=${triple.pair[0].toFixed(2)}`
  );
}

// --- Figures ---------------------------------------------------------------------------------

/** One scenario of one resample at one pair. */
export interface ScenarioFigures {
  readonly scenario: string;
  /** Tickets opened after the warmup, at review level. */
  readonly tickets: number;
  readonly falseTickets: number;
  readonly falseReviews: number;
  readonly negativeMachineDays: number;
  /** Whether a positive passed at its level within its budget; `null` for a scenario with no target. */
  readonly passed: boolean | null;
  /** Each scored ticket's fault at open and the level it reached, in opening order. */
  readonly named: readonly string[];
}

/** One resample at one triple, pooled over the counted scenarios. */
export interface ResampleFigures {
  readonly resample: number;
  readonly falseTickets: number;
  readonly falseReviews: number;
  readonly negativeMachineDays: number;
  /** `null` when the counted scenarios hold no negative time. */
  readonly falseTicketsPerDay: number | null;
  readonly falseReviewsPerDay: number | null;
  readonly positivesPassed: number;
  readonly positivesTotal: number;
  /** The counted scenarios, in the run's order. */
  readonly scenarios: readonly ScenarioFigures[];
  /** The scenarios reported apart (`TUNING_REPORTED_ONLY`), never pooled. */
  readonly reportedOnly: readonly ScenarioFigures[];
}

/** One triple over every resample of its N's recording, resamples in order. */
export interface TripleFigures extends Triple {
  readonly resamples: readonly ResampleFigures[];
}

function hasPositiveTarget(scenario: ReportScenario): boolean {
  return scenario.windows.some((window) => !window.benign);
}

/**
 * Whether a positive passed its own ticket rule at its `expect.pass_level`: `diagnosis` as it
 * reads, and `detection` as the ticket rule at review-or-ticket level it named when the
 * pre-registration and `READINGS` were written. Since 2026-09-24 the `detection` flag reads
 * suspect events, which no gate threshold moves, and that ticket rule is
 * `reviewDiagnosis`, its budget and false-ticket allowance included.
 */
function ticketRulePass(metrics: ScenarioMetrics, scenario: ReportScenario): boolean {
  return scenario.expect.pass_level === "diagnosis"
    ? metrics.pass.diagnosis
    : metrics.pass.reviewDiagnosis;
}

/** The same flag as a stored run recorded it; an older report kept it in `detection`. */
function storedTicketRulePass(scenario: ReportScenario): boolean {
  return scenario.expect.pass_level === "diagnosis"
    ? scenario.pass.diagnosis
    : (scenario.pass.review_diagnosis ?? scenario.pass.detection);
}

/** The Von scenarios of a run, in the run's order. */
function vonScenarios(report: RunReport): ReportScenario[] {
  return report.scenarios.filter((scenario) => scenario.backend === PREREGISTERED_BACKEND);
}

/** One scenario re-gated at `pair` and scored by the run's own scorer. */
export function scenarioFigures(
  scenario: ReportScenario,
  report: RunReport,
  pair: ThresholdPair,
): ScenarioFigures {
  const row = sweep(sweepRunOf(scenario, report), [pair]).find(
    (entry) =>
      Math.abs(entry.ticketMin - pair[0]) < EPSILON &&
      Math.abs(entry.reviewMin - pair[1]) < EPSILON,
  );
  if (row === undefined) throw new Error(`sweep() dropped the pair ${pairText(pair)}`);
  const metrics = rescoreScenario(scenario, row, pair, report);
  return {
    scenario: scenario.id,
    tickets: metrics.tickets.length,
    falseTickets: metrics.match.ticket.fp.length,
    falseReviews: metrics.match.review.fp.length,
    negativeMachineDays: scenario.replay.negative_machine_days,
    passed: hasPositiveTarget(scenario) ? ticketRulePass(metrics, scenario) : null,
    named: [...metrics.tickets]
      .sort((left, right) => left.openedSimTs.getTime() - right.openedSimTs.getTime())
      .map((ticket) => `${ticket.faultAtOpen} (${ticket.maxLevel})`),
  };
}

function perDay(count: number, days: number): number | null {
  return days > 0 ? count / days : null;
}

/** The figures of one resample's run at one pair (the pre-registration's "Procedure"). */
export function resampleFigures(
  report: RunReport,
  pair: ThresholdPair,
  resample: number,
): ResampleFigures {
  const all = vonScenarios(report).map((scenario) => scenarioFigures(scenario, report, pair));
  const counted = all.filter((entry) => !TUNING_REPORTED_ONLY.includes(entry.scenario));
  const reportedOnly = all.filter((entry) => TUNING_REPORTED_ONLY.includes(entry.scenario));
  const falseTickets = counted.reduce((total, entry) => total + entry.falseTickets, 0);
  const falseReviews = counted.reduce((total, entry) => total + entry.falseReviews, 0);
  const negativeMachineDays = counted.reduce(
    (total, entry) => total + entry.negativeMachineDays,
    0,
  );
  const positives = counted.filter((entry) => entry.passed !== null);
  return {
    resample,
    falseTickets,
    falseReviews,
    negativeMachineDays,
    falseTicketsPerDay: perDay(falseTickets, negativeMachineDays),
    falseReviewsPerDay: perDay(falseReviews, negativeMachineDays),
    positivesPassed: positives.filter((entry) => entry.passed === true).length,
    positivesTotal: positives.length,
    scenarios: counted,
    reportedOnly,
  };
}

/** Every pair of the grid at N over every resample of N's recording; `runs[r]` is resample r. */
export function gridFigures(
  persistSimMin: number,
  runs: readonly RunReport[],
  grid: readonly ThresholdPair[] = preregisteredGrid(),
): TripleFigures[] {
  return grid.map((pair) => ({
    persistSimMin,
    pair,
    resamples: runs.map((report, resample) => resampleFigures(report, pair, resample)),
  }));
}

// --- The selection rule ----------------------------------------------------------------------

/** One triple, judged by clauses 1–3. */
export interface TripleVerdict extends Triple {
  /** Clause 1: within both limits on every resample. */
  readonly meetsConstraint: boolean;
  /** Each resample that breaks the constraint, and how. */
  readonly breaches: readonly string[];
  readonly medianPositives: number;
  readonly medianFalseReviewsPerDay: number | null;
  readonly medianFalseTicketsPerDay: number | null;
  /** Euclidean distance of the pair to 0.60 / 0.85 in (ticket, review). */
  readonly distance: number;
}

/**
 * Which clause decided, in words and without a figure: what the committed choice record says
 * (the figures stay in the gitignored `reports/`).
 */
export type SelectionClause =
  | "incumbent-best"
  | "not-one-more"
  | "fewer-on-a-resample"
  | "clearly-better"
  | "incumbent-breaks"
  | "none-qualifies";

/** What the rule decided. */
export interface Selection {
  /** `change`: the pipeline and Von move to `chosen`; `keep`: they keep the incumbent. */
  readonly outcome: "change" | "keep";
  readonly chosen: Triple;
  readonly decidedBy: SelectionClause;
  /** One paragraph: which clause decided, with the figures it read. */
  readonly reason: string;
  readonly incumbentMeetsConstraint: boolean;
  /** The triples that meet the constraint, in the rule's order (best first). */
  readonly qualifying: readonly Triple[];
  /** The best qualifying triple by clauses 2 and 3, before clause 4; absent when none qualifies. */
  readonly best?: Triple;
  /**
   * The qualifying triples still level with the best after clause 3 (N and the distance
   * included); more than one means the residual order — higher ticket, then higher review —
   * decided.
   */
  readonly residualTie: readonly Triple[];
  readonly verdicts: readonly TripleVerdict[];
}

/** The median of a non-empty list: the middle value, or the mean of the two middle ones. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("the median of nothing");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] as number) + upper) / 2;
}

function rate(value: number | null): string {
  return value === null ? "none (no negative machine-day)" : value.toFixed(3);
}

/** Clauses 1–3's reading of one triple. */
export function judgeTriple(
  figures: TripleFigures,
  incumbent: Triple = INCUMBENT_TRIPLE,
  limits: typeof LIMITS = LIMITS,
): TripleVerdict {
  const breaches: string[] = [];
  for (const entry of figures.resamples) {
    const tickets = entry.falseTicketsPerDay;
    const reviews = entry.falseReviewsPerDay;
    if (tickets === null || tickets > limits.falseTicketsPerDay + EPSILON) {
      breaches.push(
        `resample ${entry.resample}: ${rate(tickets)} false tickets per negative machine-day (at most ${limits.falseTicketsPerDay.toFixed(2)})`,
      );
    }
    if (reviews === null || reviews > limits.falseReviewsPerDay + EPSILON) {
      breaches.push(
        `resample ${entry.resample}: ${rate(reviews)} false reviews per negative machine-day (at most ${limits.falseReviewsPerDay.toFixed(2)})`,
      );
    }
  }
  const nullable = (values: readonly (number | null)[]): number | null =>
    values.some((value) => value === null) ? null : median(values as number[]);
  return {
    persistSimMin: figures.persistSimMin,
    pair: figures.pair,
    meetsConstraint: figures.resamples.length > 0 && breaches.length === 0,
    breaches,
    medianPositives: median(figures.resamples.map((entry) => entry.positivesPassed)),
    medianFalseReviewsPerDay: nullable(figures.resamples.map((entry) => entry.falseReviewsPerDay)),
    medianFalseTicketsPerDay: nullable(figures.resamples.map((entry) => entry.falseTicketsPerDay)),
    distance: Math.hypot(figures.pair[0] - incumbent.pair[0], figures.pair[1] - incumbent.pair[1]),
  };
}

/** How a triple breaks the constraint, in one clause: on how many resamples, and at worst how far. */
function breachSummary(figures: TripleFigures, limits: typeof LIMITS): string {
  const broken = figures.resamples.filter(
    (entry) =>
      entry.falseTicketsPerDay === null ||
      entry.falseReviewsPerDay === null ||
      entry.falseTicketsPerDay > limits.falseTicketsPerDay + EPSILON ||
      entry.falseReviewsPerDay > limits.falseReviewsPerDay + EPSILON,
  );
  const worstOf = (values: readonly (number | null)[]): number | null =>
    values.some((value) => value === null) ? null : Math.max(...(values as number[]));
  return (
    `on ${broken.length} of ${figures.resamples.length} resample(s) (at worst ` +
    `${rate(worstOf(figures.resamples.map((entry) => entry.falseTicketsPerDay)))} false tickets ` +
    `and ${rate(worstOf(figures.resamples.map((entry) => entry.falseReviewsPerDay)))} false ` +
    `reviews per negative machine-day, against ${limits.falseTicketsPerDay.toFixed(2)} and ` +
    `${limits.falseReviewsPerDay.toFixed(2)})`
  );
}

/** Negative when `left` is the better figure; 0 when the two are the same figure. */
function ascending(left: number | null, right: number | null): number {
  const a = left ?? Infinity;
  const b = right ?? Infinity;
  if (a === b || Math.abs(a - b) < EPSILON) return 0;
  return a < b ? -1 : 1;
}

/**
 * Clauses 2 and 3 as amended: negative when `left` is the better triple, 0 when they are level.
 * The most positives on the median resample; then fewer false reviews; then fewer false tickets;
 * then the incumbent's N (N = 1); then the pair closest to 0.60 / 0.85.
 */
export function byObjectiveAndTies(
  left: TripleVerdict,
  right: TripleVerdict,
  incumbent: Triple = INCUMBENT_TRIPLE,
): number {
  const preferred = (verdict: TripleVerdict): number =>
    sameValue(verdict.persistSimMin, incumbent.persistSimMin) ? 0 : 1;
  return (
    ascending(right.medianPositives, left.medianPositives) ||
    ascending(left.medianFalseReviewsPerDay, right.medianFalseReviewsPerDay) ||
    ascending(left.medianFalseTicketsPerDay, right.medianFalseTicketsPerDay) ||
    ascending(preferred(left), preferred(right)) ||
    ascending(left.distance, right.distance)
  );
}

/**
 * The residual order, used only when clause 3 leaves a tie: higher ticket, then higher review,
 * then the higher N (which the N clause already settles on the pre-registered axis).
 */
function residual(left: Triple, right: Triple): number {
  return (
    ascending(right.pair[0], left.pair[0]) ||
    ascending(right.pair[1], left.pair[1]) ||
    ascending(right.persistSimMin, left.persistSimMin)
  );
}

/** Each N's triples share one list of resamples; a triple of another N may hold another. */
function checkResampleCounts(triples: readonly TripleFigures[]): void {
  if (triples.length === 0) throw new RangeError("no triple to judge");
  const counts = new Map<number, number>();
  for (const entry of triples) {
    const count = entry.resamples.length;
    const known = [...counts.entries()].find(([persist]) =>
      sameValue(persist, entry.persistSimMin),
    );
    if (count === 0 || (known !== undefined && known[1] !== count)) {
      throw new RangeError(
        `the triples at GATE_PERSIST_SIM_MIN ${String(entry.persistSimMin)} need the same, non-empty list of resamples`,
      );
    }
    if (known === undefined) counts.set(entry.persistSimMin, count);
  }
}

/**
 * The pre-registered selection rule, as amended on 2026-09-24, over every triple.
 *
 * 1. Constraint: at most `LIMITS` false tickets and false reviews per negative machine-day, on
 *    every resample. 2. Objective: among the triples that meet it, the most positives passed on
 *    the median resample. 3. Ties: fewer false reviews, then fewer false tickets, then N = 1,
 *    then the pair closest to 0.60 / 0.85. 4. Stay unless clearly better: a triple replaces
 *    (N = 1, 0.60 / 0.85) only if it meets the constraint and passes at least one more positive
 *    on the median resample and never fewer on any resample (across N: under any pairing of the
 *    two recordings' resamples, `READINGS`); if the incumbent itself breaks the constraint, the
 *    qualifying triple with the most positives wins; if none qualifies, the incumbent stays and
 *    the finding is recorded.
 *
 * @throws RangeError when the triples do not hold the incumbent, or one N's triples do not share
 * one list of resamples.
 */
export function applySelectionRule(
  triples: readonly TripleFigures[],
  incumbent: Triple = INCUMBENT_TRIPLE,
  limits: typeof LIMITS = LIMITS,
): Selection {
  checkResampleCounts(triples);
  const incumbentFigures = triples.find((entry) => sameTriple(entry, incumbent));
  if (incumbentFigures === undefined) {
    throw new RangeError(`the triples do not hold ${tripleText(incumbent)}`);
  }
  const verdicts = triples.map((entry) => judgeTriple(entry, incumbent, limits));
  const incumbentVerdict = judgeTriple(incumbentFigures, incumbent, limits);
  const ranked = (left: TripleVerdict, right: TripleVerdict): number =>
    byObjectiveAndTies(left, right, incumbent) || residual(left, right);
  const qualifying = verdicts.filter((verdict) => verdict.meetsConstraint).sort(ranked);
  const best = qualifying[0];
  const residualTie =
    best === undefined
      ? []
      : qualifying.filter((verdict) => byObjectiveAndTies(verdict, best, incumbent) === 0);
  const asTriple = (verdict: TripleVerdict): Triple => ({
    persistSimMin: verdict.persistSimMin,
    pair: verdict.pair,
  });
  const base = {
    incumbentMeetsConstraint: incumbentVerdict.meetsConstraint,
    qualifying: qualifying.map(asTriple),
    residualTie: residualTie.length > 1 ? residualTie.map(asTriple) : [],
    verdicts,
    ...(best === undefined ? {} : { best: asTriple(best) }),
  };
  const tieNote =
    residualTie.length > 1
      ? ` Clause 3 left ${residualTie.map((verdict) => tripleText(verdict)).join(", ")} level; the residual order (higher ticket, then higher review threshold), which the pre-registration does not settle, decided.`
      : "";
  const keep = (decidedBy: SelectionClause, reason: string): Selection => ({
    ...base,
    outcome: "keep",
    chosen: incumbent,
    decidedBy,
    reason,
  });

  if (!incumbentVerdict.meetsConstraint) {
    const broken = `${tripleText(incumbent)} breaks the constraint ${breachSummary(incumbentFigures, limits)}`;
    if (best === undefined) {
      return keep(
        "none-qualifies",
        `${broken}, and so does every triple of the grid: no triple qualifies, so the pipeline and Von stay at ${tripleText(incumbent)} and the finding is recorded.`,
      );
    }
    return {
      ...base,
      outcome: "change",
      chosen: asTriple(best),
      decidedBy: "incumbent-breaks",
      reason:
        `${broken}. The qualifying triple with the most positives passed on the median resample ` +
        `wins: ${tripleText(best)}, ${best.medianPositives} on the median resample.${tieNote}`,
    };
  }

  if (best === undefined || sameTriple(best, incumbent)) {
    return keep(
      "incumbent-best",
      `${tripleText(incumbent)} meets the constraint on every resample and no qualifying triple ranks above it on the objective and the ties (${incumbentVerdict.medianPositives} positives passed on the median resample).`,
    );
  }
  const margin = best.medianPositives - incumbentVerdict.medianPositives;
  if (margin < 1 - EPSILON) {
    return keep(
      "not-one-more",
      `The best qualifying triple, ${tripleText(best)}, passes ${best.medianPositives} positives on the median resample against ${incumbentVerdict.medianPositives} for ${tripleText(incumbent)}: not at least one more, so the incumbent stays.${tieNote}`,
    );
  }
  const incumbentByResample = incumbentFigures.resamples.map((entry) => entry.positivesPassed);
  const bestFigures = triples.find((entry) => sameTriple(entry, best));
  const bestByResample = (bestFigures?.resamples ?? []).map((entry) => entry.positivesPassed);
  if (sameValue(best.persistSimMin, incumbent.persistSimMin)) {
    const fewer = bestByResample
      .map((passed, resample) => ({
        passed,
        resample,
        incumbent: incumbentByResample[resample] ?? 0,
      }))
      .filter((entry) => entry.passed < entry.incumbent);
    if (fewer.length > 0) {
      const where = fewer
        .map((entry) => `resample ${entry.resample}: ${entry.passed} against ${entry.incumbent}`)
        .join("; ");
      return keep(
        "fewer-on-a-resample",
        `The best qualifying triple, ${tripleText(best)}, passes more positives on the median resample (${best.medianPositives} against ${incumbentVerdict.medianPositives}) but fewer than ${tripleText(incumbent)} on some resample (${where}), so the incumbent stays.${tieNote}`,
      );
    }
  } else {
    const fewest = Math.min(...bestByResample);
    const most = Math.max(...incumbentByResample);
    if (fewest < most) {
      return keep(
        "fewer-on-a-resample",
        `The best qualifying triple, ${tripleText(best)}, passes more positives on the median resample (${best.medianPositives} against ${incumbentVerdict.medianPositives}), but it is replayed from another recording than ${tripleText(incumbent)}, whose resamples pair with none of its own, and its fewest (${fewest}) is below the incumbent's most (${most}): under some pairing of the two recordings' resamples it passes fewer, so the incumbent stays.${tieNote}`,
      );
    }
  }
  return {
    ...base,
    outcome: "change",
    chosen: asTriple(best),
    decidedBy: "clearly-better",
    reason:
      `${tripleText(best)} meets the constraint on every resample, passes ${best.medianPositives} ` +
      `positives on the median resample against ${incumbentVerdict.medianPositives} for ` +
      `${tripleText(incumbent)} and never fewer on any resample, so it replaces ` +
      `${tripleText(incumbent)}.${tieNote}`,
  };
}

// --- The runs --------------------------------------------------------------------------------

/** One N's resample runs, `runs[r]` being resample r of the recording made at that N. */
export interface RecordingRuns {
  readonly persistSimMin: number;
  readonly runs: readonly RunReport[];
}

/** How one resample's run reads, before any triple is scored. */
export interface RunCheck {
  readonly persistSimMin: number;
  readonly resample: number;
  readonly runId: string;
  readonly cassetteHits: number;
  readonly cassetteMisses: number;
  readonly cassetteReused: number;
  readonly failures: number;
  /** Whether the re-gating at the run's own pair gives its figures back, scenario by scenario. */
  readonly reproduces: boolean;
  readonly differences: readonly string[];
  /** Why this run's answers cannot be read as the model's; empty when they can. */
  readonly withheld: readonly string[];
}

/** How one N's recording reads: missing, or its resample runs. */
export interface RecordingCheck {
  readonly persistSimMin: number;
  /** No recording at this N: its replay had no cassette hit at N, and at least one miss. */
  readonly missing: boolean;
  readonly runs: readonly RunCheck[];
}

/** The command that records the tuning list at N, for the message that names a missing one. */
export function recordCommand(persistSimMin: number): string {
  return `GATE_PERSIST_SIM_MIN=${String(persistSimMin)} pnpm --filter @fdp/eval run record -- --tuning --confirm-live`;
}

/**
 * Refuses a run the pre-registered sweep may not read: not a `--tuning` run of exactly the tuning
 * list, a test-split scenario, Von not replayed from cassettes, a resample other than the one
 * expected, a gate other than 0.60 / 0.85, no GATE_PERSIST_SIM_MIN (a run from before the
 * persistence rule), or a GATE_PERSIST_SIM_MIN other than its recording's.
 *
 * @throws SweepUsageError naming the run and what is wrong with it.
 */
export function refuseForeignRun(report: RunReport, resample: number, persistSimMin: number): void {
  const name = `run ${report.run.id} (GATE_PERSIST_SIM_MIN ${String(persistSimMin)}, resample ${resample})`;
  if (report.run.mode !== "in_process" || report.run.profile !== "tuning") {
    throw new SweepUsageError(
      `${name} is not a --tuning run: the pre-registered sweep reads the tuning list only`,
    );
  }
  const testSplit = report.scenarios.filter((scenario) => scenario.split === "test");
  if (testSplit.length > 0) {
    throw new SweepUsageError(
      `${name} replayed test-split scenarios (${testSplit.map((scenario) => scenario.id).join(", ")}); thresholds are never chosen on the core-10`,
    );
  }
  const ids = vonScenarios(report).map((scenario) => scenario.id);
  const expected = [...TUNING_SCENARIOS];
  if (ids.length !== expected.length || expected.some((id) => !ids.includes(id))) {
    throw new SweepUsageError(
      `${name} did not replay exactly the tuning list for von (it replayed ${ids.join(", ") || "nothing"})`,
    );
  }
  const von = report.backends.find((backend) => backend.name === PREREGISTERED_BACKEND);
  if (von?.mode !== "cassette") {
    throw new SweepUsageError(
      `${name} did not replay Von from cassettes (mode ${von?.mode ?? "absent"}): the pre-registered sweep reads recorded answers only`,
    );
  }
  if ((von.cassette_resample ?? 0) !== resample) {
    throw new SweepUsageError(
      `${name} served resample ${von.cassette_resample ?? 0}, not ${resample}`,
    );
  }
  const own = backendThresholds(report, PREREGISTERED_BACKEND);
  if (!samePair([own.ticketMin, own.reviewMin], INCUMBENT)) {
    throw new SweepUsageError(
      `${name} gated Von at ${pairText([own.ticketMin, own.reviewMin])}; the pre-registered sweep re-gates decisions taken at ${pairText(INCUMBENT)}, the pair of the recording`,
    );
  }
  const persist = report.run.thresholds.persist_sim_min;
  if (persist === undefined) {
    throw new SweepUsageError(
      `${name} carries no GATE_PERSIST_SIM_MIN: it was written before the persistence rule and cannot be read under it`,
    );
  }
  if (!sameValue(persist, persistSimMin)) {
    throw new SweepUsageError(
      `${name} ran at GATE_PERSIST_SIM_MIN ${String(persist)}, not ${String(persistSimMin)}: each N is read from its own recording, replayed at N`,
    );
  }
}

/** The run's own figures, scenario by scenario, against the re-gating at its own pair. */
function selfCheck(report: RunReport): string[] {
  const own = backendThresholds(report, PREREGISTERED_BACKEND);
  const pair: ThresholdPair = [own.ticketMin, own.reviewMin];
  const differences: string[] = [];
  for (const scenario of vonScenarios(report)) {
    const regated = scenarioFigures(scenario, report, pair);
    const stored = {
      falseTickets: scenario.metrics.match.ticket.fp,
      falseReviews: scenario.metrics.match.review.fp,
      tickets: scenario.metrics.rates.tickets,
      passed: hasPositiveTarget(scenario) ? storedTicketRulePass(scenario) : null,
    };
    for (const key of ["falseTickets", "falseReviews", "tickets", "passed"] as const) {
      if (regated[key] !== stored[key]) {
        differences.push(
          `${scenario.id}: ${key} ${String(regated[key])} re-gated, ${String(stored[key])} in the run`,
        );
      }
    }
  }
  return differences;
}

/** Reads one resample's run of N's recording: its counters, its self-check and why it cannot be read. */
export function checkRun(report: RunReport, resample: number, persistSimMin: number): RunCheck {
  const von = report.backends.find((backend) => backend.name === PREREGISTERED_BACKEND);
  const differences = selfCheck(report);
  const misses = von?.cassette_misses ?? 0;
  const failures = von?.failures ?? 0;
  const where = `GATE_PERSIST_SIM_MIN = ${String(persistSimMin)}, resample ${resample}`;
  const withheld = [
    ...(misses > 0
      ? [
          `${where}: ${misses} request(s) had no cassette at this N and were answered by the mock, not the model`,
        ]
      : []),
    ...(failures > 0 ? [`${where}: ${failures} decision(s) failed`] : []),
    ...(differences.length > 0
      ? [
          `${where}: re-gated at its own pair, the run is not given back (${differences.join("; ")})`,
        ]
      : []),
  ];
  return {
    persistSimMin,
    resample,
    runId: report.run.id,
    cassetteHits: von?.cassette_hits ?? 0,
    cassetteMisses: misses,
    cassetteReused: von?.cassette_reused ?? 0,
    failures,
    reproduces: differences.length === 0,
    differences,
    withheld,
  };
}

/** Whether N's replay found no recording at N: no hit, and at least one miss. */
function recordingMissing(report: RunReport): boolean {
  const von = report.backends.find((backend) => backend.name === PREREGISTERED_BACKEND);
  return (von?.cassette_hits ?? 0) === 0 && (von?.cassette_misses ?? 0) > 0;
}

/** The message that names a missing recording. */
function missingMessage(report: RunReport, persistSimMin: number): string {
  const von = report.backends.find((backend) => backend.name === PREREGISTERED_BACKEND);
  return (
    `GATE_PERSIST_SIM_MIN = ${String(persistSimMin)}: the tuning list has no recording at this N ` +
    `(none of the ${von?.cassette_misses ?? 0} request(s) of its replay found a cassette recorded at N = ${String(persistSimMin)}), ` +
    `so no triple is chosen; record it with ${recordCommand(persistSimMin)} (a paid run, started by hand), then run make eval-sweep again`
  );
}

/** Everything one pre-registered sweep read and decided. */
export interface PreregisteredResult {
  readonly recordings: readonly RecordingCheck[];
  readonly grid: readonly ThresholdPair[];
  /** Every triple of every recorded N, N by N; none for a missing recording. */
  readonly triples: readonly TripleFigures[];
  /** Clauses 1–3's reading of every triple, in the order of `triples`. */
  readonly verdicts: readonly TripleVerdict[];
  /** `null` when a recording is missing: the rule is not applied at all. */
  readonly selection: Selection | null;
  /** The N whose recording is missing, in axis order. */
  readonly missing: readonly number[];
  /** Why no triple is chosen; empty when the selection stands. */
  readonly withheld: readonly string[];
}

/**
 * The pre-registered sweep over resample runs already read: one recording per N of
 * `PERSIST_AXIS`, `runs[r]` being its resample r.
 *
 * @throws SweepUsageError when an N of the axis has no run, an N off the axis is given, or a run
 * the procedure may not read.
 */
export function preregisteredSweep(recordings: readonly RecordingRuns[]): PreregisteredResult {
  for (const recording of recordings) {
    if (!PERSIST_AXIS.some((value) => sameValue(value, recording.persistSimMin))) {
      throw new SweepUsageError(
        `GATE_PERSIST_SIM_MIN ${String(recording.persistSimMin)} is not on the pre-registered axis (${PERSIST_AXIS.join(", ")})`,
      );
    }
  }
  const grid = preregisteredGrid();
  const checks: RecordingCheck[] = [];
  const triples: TripleFigures[] = [];
  const missingMessages: string[] = [];
  for (const persistSimMin of PERSIST_AXIS) {
    const recording = recordings.find((entry) => sameValue(entry.persistSimMin, persistSimMin));
    const first = recording?.runs[0];
    if (recording === undefined || first === undefined) {
      throw new SweepUsageError(
        `no resample run at GATE_PERSIST_SIM_MIN ${String(persistSimMin)}: the sweep reads one recording per N of ${PERSIST_AXIS.join(", ")}`,
      );
    }
    recording.runs.forEach((report, resample) => {
      refuseForeignRun(report, resample, persistSimMin);
    });
    if (recordingMissing(first)) {
      missingMessages.push(missingMessage(first, persistSimMin));
      checks.push({
        persistSimMin,
        missing: true,
        runs: [checkRun(first, 0, persistSimMin)],
      });
      continue;
    }
    const held = first.backends.find(
      (backend) => backend.name === PREREGISTERED_BACKEND,
    )?.cassette_answers_max;
    const expected = Math.max(1, held ?? 1);
    if (recording.runs.length !== expected) {
      throw new SweepUsageError(
        `the recording at GATE_PERSIST_SIM_MIN ${String(persistSimMin)} holds up to ${expected} answer(s) of a request, so the sweep reads ${expected} resample run(s) at GATE_PERSIST_SIM_MIN ${String(persistSimMin)}, not ${recording.runs.length}`,
      );
    }
    checks.push({
      persistSimMin,
      missing: false,
      runs: recording.runs.map((report, resample) => checkRun(report, resample, persistSimMin)),
    });
    triples.push(...gridFigures(persistSimMin, recording.runs, grid));
  }
  const missing = checks.filter((check) => check.missing).map((check) => check.persistSimMin);
  const verdicts = triples.map((entry) => judgeTriple(entry));
  return {
    recordings: checks,
    grid,
    triples,
    verdicts,
    selection: missing.length > 0 ? null : applySelectionRule(triples),
    missing,
    withheld: [
      ...missingMessages,
      ...checks
        .filter((check) => !check.missing)
        .flatMap((check) => check.runs.flatMap((run) => run.withheld)),
    ],
  };
}

// --- Rendering -------------------------------------------------------------------------------

/* REUSE-IgnoreStart */
const LICENCE_HEADER: readonly string[] = [
  "<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->",
  "<!-- SPDX-License-Identifier: CC-BY-4.0 -->",
];
/* REUSE-IgnoreEnd */

const DISCLOSURE =
  "Every decision behind this procedure — Von's own thresholds, the pre-registration and its " +
  "amendment of 2026-09-24 (N chosen with the pair, august reported apart), the persistence " +
  "before the first decision and the changes that came with it — was made on 2026-09-23/24 " +
  "after the E3 and E4 results had been seen, so every figure they move stays labelled " +
  "in-sample. The tuning list is not the core-10, and no core-10 scenario, report or cassette " +
  "is read here.";

function ratio(value: number | null): string {
  return value === null ? "—" : value.toFixed(3);
}

function worst(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  return Math.max(...(values as number[]));
}

/** The triple a result moves to, or keeps; `undefined` when it chooses nothing. */
function settled(result: PreregisteredResult): Selection | undefined {
  return result.selection !== null && result.withheld.length === 0 ? result.selection : undefined;
}

/** The outcome in one line, as the console and the page open with it. */
export function outcomeLine(result: PreregisteredResult): string {
  if (result.missing.length > 0) {
    const named = result.missing
      .map((persist) => `GATE_PERSIST_SIM_MIN = ${String(persist)}`)
      .join(" and ");
    return `No triple chosen: the tuning list's recording at ${named} is missing.`;
  }
  const selection = settled(result);
  if (selection === undefined) {
    return "No triple chosen: the resample runs cannot all be read as the model's own answers.";
  }
  return selection.outcome === "change"
    ? `Chosen: ${tripleVariables(selection.chosen)} (${tripleText(selection.chosen)}).`
    : `Kept: ${tripleText(INCUMBENT_TRIPLE)} (${tripleVariables(INCUMBENT_TRIPLE)}).`;
}

const TABLE_HEADER = [
  "N",
  "Review ≥",
  "Ticket ≥",
  "Constraint",
  "False tickets / day (worst)",
  "False reviews / day (worst)",
  "Positives passed (median)",
  "Per resample",
] as const;

/** The triple a result moves to; `undefined` when it keeps the incumbent or chooses nothing. */
function movedTo(result: PreregisteredResult): Triple | undefined {
  const selection = settled(result);
  return selection?.outcome === "change" ? selection.chosen : undefined;
}

function tableCells(
  figures: TripleFigures,
  verdict: TripleVerdict,
  chosen: Triple | undefined,
): string[] {
  const marks = [
    sameTriple(figures, INCUMBENT_TRIPLE) ? "incumbent" : "",
    chosen !== undefined && sameTriple(figures, chosen) ? "chosen" : "",
  ].filter((mark) => mark !== "");
  return [
    String(figures.persistSimMin),
    `${figures.pair[1].toFixed(2)}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}`,
    figures.pair[0].toFixed(2),
    verdict.meetsConstraint ? "met" : "broken",
    ratio(worst(figures.resamples.map((entry) => entry.falseTicketsPerDay))),
    ratio(worst(figures.resamples.map((entry) => entry.falseReviewsPerDay))),
    `${verdict.medianPositives} of ${figures.resamples[0]?.positivesTotal ?? 0}`,
    figures.resamples.map((entry) => String(entry.positivesPassed)).join(" "),
  ];
}

function markdownRow(values: readonly string[]): string {
  return `| ${values.join(" | ")} |`;
}

function scenarioTable(figures: TripleFigures): string[] {
  const lines = [
    markdownRow(["Resample", "Scenario", "Tickets", "False tickets", "False reviews", "Positive"]),
    markdownRow(["---", "---", "---", "---", "---", "---"]),
  ];
  for (const entry of figures.resamples) {
    for (const scenario of entry.scenarios) {
      lines.push(
        markdownRow([
          String(entry.resample),
          `\`${scenario.scenario}\``,
          String(scenario.tickets),
          String(scenario.falseTickets),
          String(scenario.falseReviews),
          scenario.passed === null ? "—" : scenario.passed ? "passed" : "not passed",
        ]),
      );
    }
  }
  return lines;
}

/** The scenarios reported apart at one triple: every ticket each opened, never pooled. */
function reportedApartTable(figures: TripleFigures): string[] {
  const lines = [
    markdownRow(["Resample", "Scenario", "Tickets", "Faults named (level reached)"]),
    markdownRow(["---", "---", "---", "---"]),
  ];
  for (const entry of figures.resamples) {
    for (const scenario of entry.reportedOnly) {
      lines.push(
        markdownRow([
          String(entry.resample),
          `\`${scenario.scenario}\``,
          String(scenario.tickets),
          scenario.named.length === 0 ? "—" : scenario.named.join(", "),
        ]),
      );
    }
  }
  return lines;
}

/** The triples a page details: the incumbent and, when the rule moves, the chosen one. */
function detailed(result: PreregisteredResult): TripleFigures[] {
  const chosen = movedTo(result);
  return [INCUMBENT_TRIPLE, ...(chosen === undefined ? [] : [chosen])].flatMap((wanted) =>
    result.triples.filter((entry) => sameTriple(entry, wanted)),
  );
}

/** `preregistered-sweep.md`. */
export function renderPreregisteredMarkdown(result: PreregisteredResult): string {
  const verdictOf = (figures: TripleFigures): TripleVerdict | undefined =>
    result.verdicts.find((verdict) => sameTriple(verdict, figures));
  const runCount = result.recordings.reduce((total, check) => total + check.runs.length, 0);
  const lines = [
    ...LICENCE_HEADER,
    "",
    "# Pre-registered sweep of Von's gate thresholds and the persistence",
    "",
    VON_NOTICE,
    "",
    `The procedure and the rule are \`${PREREGISTRATION}\`'s, as amended on 2026-09-24. ${runCount} resample run(s) of the tuning list, Von from cassettes, each GATE_PERSIST_SIM_MIN of ${PERSIST_AXIS.join(", ")} from its own recording; ${result.triples.length} triples.`,
    "",
    `**${outcomeLine(result)}**`,
    "",
  ];
  const selection = settled(result);
  if (selection === undefined) {
    lines.push("Why no triple is chosen:", "", ...result.withheld.map((line) => `- ${line}`), "");
  } else {
    lines.push(selection.reason, "");
  }
  lines.push(
    `**Disclosure.** ${DISCLOSURE}`,
    "",
    "## Recordings and their resample runs",
    "",
    markdownRow([
      "N",
      "Resample",
      "Run",
      "Cassette hits",
      "Misses",
      "Reused",
      "Failed",
      "Self-check",
    ]),
    markdownRow(["---", "---", "---", "---", "---", "---", "---", "---"]),
    ...result.recordings.flatMap((check) =>
      check.runs.map((run) =>
        markdownRow([
          String(check.persistSimMin),
          String(run.resample),
          `\`${run.runId}\``,
          String(run.cassetteHits),
          String(run.cassetteMisses),
          String(run.cassetteReused),
          String(run.failures),
          check.missing
            ? "no recording at this N"
            : run.reproduces
              ? "gives the run back"
              : "does NOT give the run back",
        ]),
      ),
    ),
    "",
    "## Every triple",
    "",
    `The constraint is at most ${LIMITS.falseTicketsPerDay.toFixed(2)} false tickets and ${LIMITS.falseReviewsPerDay.toFixed(2)} false reviews per negative machine-day on every resample of the triple's own N.`,
    "",
    markdownRow(TABLE_HEADER),
    markdownRow(TABLE_HEADER.map(() => "---")),
  );
  for (const figures of result.triples) {
    const verdict = verdictOf(figures);
    if (verdict !== undefined) {
      lines.push(markdownRow(tableCells(figures, verdict, movedTo(result))));
    }
  }
  lines.push("");
  for (const figures of detailed(result)) {
    lines.push(`## ${tripleText(figures)} by scenario`, "", ...scenarioTable(figures), "");
  }
  lines.push(
    "## Reported apart, never counted",
    "",
    ...TUNING_REPORTED_APART.map((entry) => `- \`${entry.scenario}\`: ${entry.reason}`),
    "",
  );
  for (const figures of detailed(result)) {
    lines.push(`### At ${tripleText(figures)}`, "", ...reportedApartTable(figures), "");
  }
  lines.push("## Readings", "", ...READINGS.map((reading) => `- ${reading}`), "");
  return lines.join("\n");
}

/** The console summary. */
export function renderPreregisteredConsole(
  result: PreregisteredResult,
  files: { readonly json: string; readonly md: string },
): string {
  const runCount = result.recordings.reduce((total, check) => total + check.runs.length, 0);
  const lines = [
    `fdp-eval sweep --preregistered: von, ${result.triples.length} triples over ${runCount} resample run(s) of the tuning list, GATE_PERSIST_SIM_MIN ${PERSIST_AXIS.join(" and ")} each from its own recording (${PREREGISTRATION})`,
  ];
  const rows = [
    [...TABLE_HEADER],
    ...result.triples.flatMap((figures) => {
      const verdict = result.verdicts.find((entry) => sameTriple(entry, figures));
      return verdict === undefined ? [] : [tableCells(figures, verdict, movedTo(result))];
    }),
  ];
  const widths = TABLE_HEADER.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  const selection = settled(result);
  lines.push(
    "",
    ...rows.map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    ),
    "",
    outcomeLine(result),
    ...(selection === undefined ? result.withheld : [selection.reason]),
    "",
    `${PREREGISTERED_JSON_NAME}: ${files.json}`,
    `${PREREGISTERED_MD_NAME}: ${files.md}`,
  );
  return `${lines.join("\n")}\n`;
}

function tripleJson(triple: Triple): {
  persist_sim_min: number;
  ticket_min: number;
  review_min: number;
} {
  return {
    persist_sim_min: triple.persistSimMin,
    ticket_min: triple.pair[0],
    review_min: triple.pair[1],
  };
}

function scenarioJson(entry: ScenarioFigures) {
  return {
    scenario: entry.scenario,
    tickets: entry.tickets,
    false_tickets: entry.falseTickets,
    false_reviews: entry.falseReviews,
    negative_machine_days: entry.negativeMachineDays,
    passed: entry.passed,
    named: [...entry.named],
  };
}

/** `preregistered-sweep.json`. */
export function preregisteredDocument(result: PreregisteredResult): unknown {
  const selection = settled(result);
  const status =
    selection === undefined ? "withheld" : selection.outcome === "change" ? "chosen" : "kept";
  return {
    schema: PREREGISTERED_SCHEMA_ID,
    preregistration: PREREGISTRATION,
    backend: PREREGISTERED_BACKEND,
    persist_axis: [...PERSIST_AXIS],
    incumbent: tripleJson(INCUMBENT_TRIPLE),
    limits: {
      false_tickets_per_negative_machine_day: LIMITS.falseTicketsPerDay,
      false_reviews_per_negative_machine_day: LIMITS.falseReviewsPerDay,
    },
    reported_apart: TUNING_REPORTED_APART.map((entry) => ({ ...entry })),
    approximate: true,
    recordings: result.recordings.map((check) => ({
      persist_sim_min: check.persistSimMin,
      missing: check.missing,
      runs: check.runs.map((run) => ({
        resample: run.resample,
        run_id: run.runId,
        cassette_hits: run.cassetteHits,
        cassette_misses: run.cassetteMisses,
        cassette_reused: run.cassetteReused,
        failures: run.failures,
        reproduces: run.reproduces,
        differences: [...run.differences],
      })),
    })),
    triples: result.triples.map((figures) => {
      const verdict = result.verdicts.find((entry) => sameTriple(entry, figures));
      return {
        ...tripleJson(figures),
        meets_constraint: verdict?.meetsConstraint ?? false,
        breaches: [...(verdict?.breaches ?? [])],
        median_positives_passed: verdict?.medianPositives ?? null,
        median_false_reviews_per_day: verdict?.medianFalseReviewsPerDay ?? null,
        median_false_tickets_per_day: verdict?.medianFalseTicketsPerDay ?? null,
        distance: verdict?.distance ?? null,
        resamples: figures.resamples.map((entry) => ({
          resample: entry.resample,
          false_tickets: entry.falseTickets,
          false_reviews: entry.falseReviews,
          negative_machine_days: entry.negativeMachineDays,
          false_tickets_per_day: entry.falseTicketsPerDay,
          false_reviews_per_day: entry.falseReviewsPerDay,
          positives_passed: entry.positivesPassed,
          positives_total: entry.positivesTotal,
          scenarios: entry.scenarios.map(scenarioJson),
          reported_only: entry.reportedOnly.map(scenarioJson),
        })),
      };
    }),
    selection: {
      status,
      chosen: selection === undefined ? null : tripleJson(selection.chosen),
      reason: selection === undefined ? null : selection.reason,
      decided_by: selection === undefined ? null : selection.decidedBy,
      withheld: [...result.withheld],
      missing_recordings: [...result.missing],
      incumbent_meets_constraint: result.selection?.incumbentMeetsConstraint ?? null,
      qualifying: (result.selection?.qualifying ?? []).map(tripleJson),
      residual_tie: (result.selection?.residualTie ?? []).map(tripleJson),
    },
    readings: [...READINGS],
    disclosure: DISCLOSURE,
  };
}

// --- The choice record -------------------------------------------------------------------------

/** The chosen triple as the choice record writes it. */
function chosenTriple(triple: Triple): ChosenTriple {
  return {
    persistSimMin: triple.persistSimMin,
    reviewMin: triple.pair[1],
    ticketMin: triple.pair[0],
  };
}

/**
 * The committed record of a settled choice (`choice.ts`): the triple, where it came from, and no
 * Von figure, the clause that decided included.
 *
 * @throws SweepUsageError when no triple is chosen (a recording missing, or a resample withheld).
 */
export function choiceRecordOf(
  result: PreregisteredResult,
  context: {
    readonly recordedAt: Date;
    readonly preregistrationCommit: string | null;
    readonly report: string;
    readonly runs: readonly RecordingRuns[];
  },
): string {
  const selection = settled(result);
  if (selection === undefined) {
    throw new SweepUsageError(
      `--record-choice: no triple is chosen (${outcomeLine(result)}), so there is no choice to record`,
    );
  }
  const first = context.runs[0]?.runs[0];
  return renderChoiceRecord({
    triple: chosenTriple(selection.chosen),
    outcome: selection.outcome,
    recordedAt: context.recordedAt,
    preregistrationCommit: context.preregistrationCommit,
    report: context.report,
    recordings: context.runs.map((recording) => ({
      persistSimMin: recording.persistSimMin,
      runs: recording.runs.map((report) => report.run.id),
      gitSha: recording.runs[0]?.run.git_sha ?? null,
    })),
    catalog: {
      name: first?.run.catalog.name ?? "unknown",
      sha256: first?.run.catalog.sha256 ?? "unknown",
    },
  });
}

// --- The command -----------------------------------------------------------------------------

/** The directory resample r of N's recording is written under. */
export function resampleDirectory(outDir: string, persistSimMin: number, resample: number): string {
  return join(outDir, `persist-${String(persistSimMin)}`, `resample-${resample}`);
}

/**
 * The configuration of resample r's replay of N's recording: the tuning list, Von alone, from
 * cassettes, gated at 0.60 / 0.85, at GATE_PERSIST_SIM_MIN = N, whatever `EVAL_VON_MODE`,
 * `--backends`, `VON_GATE_*` or `GATE_PERSIST_SIM_MIN` the environment carries. Only a recording
 * that says it was made at N is served (`cassetteOwnRecordingOnly`): a cassette that does not say
 * its value cannot show it is N's, so it is a miss, and a miss withholds the choice.
 */
export function resampleConfig(
  env: Env,
  outDir: string,
  persistSimMin: number,
  resample: number,
): EvalConfig {
  const cfg = loadConfig(
    [
      "--tuning",
      "--backends",
      PREREGISTERED_BACKEND,
      "--resample",
      String(resample),
      "--out",
      resampleDirectory(outDir, persistSimMin, resample),
    ],
    env,
  );
  return Object.freeze({
    ...cfg,
    vonMode: "cassette",
    record: false,
    confirmLive: false,
    vonGate: { ticketMin: INCUMBENT[0], reviewMin: INCUMBENT[1] },
    persistSimMin,
    cassetteOwnRecordingOnly: true,
  });
}

/** Reads the `latest.json` resample r of N's recording left under `--out`. */
export function readResampleRun(
  outDir: string,
  persistSimMin: number,
  resample: number,
): RunReport {
  const path = join(resampleDirectory(outDir, persistSimMin, resample), LATEST_JSON_NAME);
  if (!existsSync(path)) {
    throw new SweepUsageError(
      `${path} does not exist; replay the resample first (make eval-sweep)`,
    );
  }
  try {
    return validateReport(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof ReportSchemaError || error instanceof SyntaxError) {
      throw new SweepUsageError(`${path} is not a run.json: ${error.message}`);
    }
    throw error;
  }
}

/** Replays resample r of N's recording with `fdp-eval run`'s own loop and returns the run. */
async function replayResample(
  env: Env,
  outDir: string,
  persistSimMin: number,
  resample: number,
): Promise<RunReport> {
  await executeRun(resampleConfig(env, outDir, persistSimMin, resample), {
    stdout: { write: () => true },
  });
  return readResampleRun(outDir, persistSimMin, resample);
}

/** What the command reaches for; each seam defaults to the real thing. */
export interface PreregisteredDeps {
  /** Replays resample r of N's recording and returns its run; `fdp-eval run` in cassette mode. */
  readonly replay?: (persistSimMin: number, resample: number) => Promise<RunReport>;
  /** Reads resample r of N's recording from disk, for `--from-runs`. */
  readonly read?: (persistSimMin: number, resample: number) => RunReport;
  readonly stdout?: { write(chunk: string): unknown };
  /** When the choice is recorded; the process clock by default. */
  readonly now?: () => Date;
  /** The pre-registration's last commit; `git log` by default. */
  readonly preregistrationCommit?: () => string | null;
}

/** What the command is asked. */
export interface PreregisteredRequest {
  /** Absolute directory the resample runs and the report go under. */
  readonly outDir: string;
  /** `--from-runs`: sweep the resample runs already under `outDir`, replay nothing. */
  readonly fromRuns: boolean;
  readonly env: Env;
  /** `--record-choice`: write the committed record of a settled choice. */
  readonly recordChoice?: boolean;
  /** Where the record goes; `tools/eval/records/von-thresholds-choice.md` by default. */
  readonly choicePath?: string;
}

/**
 * Runs the pre-registered sweep: for each N of the axis, resample 0 of N's recording, then as many
 * more resamples as it holds, each replayed (or read, under `--from-runs`); then the triples, the
 * rule and the report; then, under `--record-choice`, the choice record.
 *
 * @throws SweepUsageError for a run the procedure may not read, and under `--record-choice` when
 * a record already exists or no triple is chosen; whatever replaying throws (a ConfigError when
 * no cassette exists, for instance).
 */
export async function executePreregistered(
  request: PreregisteredRequest,
  deps: PreregisteredDeps = {},
): Promise<{ readonly result: PreregisteredResult; readonly json: string; readonly md: string }> {
  const choicePath = request.choicePath ?? choiceRecordPath();
  if (request.recordChoice === true && existsSync(choicePath)) {
    // Checked before anything is replayed: the choice is made once.
    throw new SweepUsageError(
      `--record-choice: ${choicePath} already records the choice; it is made once, and a new one is a separate decision, recorded with its reason`,
    );
  }
  const obtain = request.fromRuns
    ? (persistSimMin: number, resample: number) =>
        Promise.resolve(
          (deps.read ?? ((n, r) => readResampleRun(request.outDir, n, r)))(persistSimMin, resample),
        )
    : (deps.replay ??
      ((persistSimMin: number, resample: number) =>
        replayResample(request.env, request.outDir, persistSimMin, resample)));
  const recordings: RecordingRuns[] = [];
  for (const persistSimMin of PERSIST_AXIS) {
    const first = await obtain(persistSimMin, 0).catch((error: unknown) => {
      // An empty store: the cassette handle refuses before anything is replayed, and no N has a
      // recording. Say which recordings are missing and how each is made.
      if (error instanceof ConfigError && error.flag === "EVAL_VON_MODE") {
        throw new ConfigError(
          "EVAL_VON_MODE",
          `the cassette store holds no recording (${error.message}), so the tuning list's ` +
            `recordings at ${PERSIST_AXIS.map((value) => `GATE_PERSIST_SIM_MIN = ${String(value)}`).join(" and ")} ` +
            `are all missing and no triple is chosen; record them with ` +
            PERSIST_AXIS.map(recordCommand).join(" and ") +
            " (paid runs, started by hand), then run make eval-sweep again",
        );
      }
      throw error;
    });
    const held =
      first.backends.find((backend) => backend.name === PREREGISTERED_BACKEND)
        ?.cassette_answers_max ?? 1;
    const runs = [first];
    for (let resample = 1; resample < Math.max(1, held); resample += 1) {
      runs.push(await obtain(persistSimMin, resample));
    }
    recordings.push({ persistSimMin, runs });
  }
  const result = preregisteredSweep(recordings);
  mkdirSync(request.outDir, { recursive: true });
  const json = join(request.outDir, PREREGISTERED_JSON_NAME);
  const md = join(request.outDir, PREREGISTERED_MD_NAME);
  writeFileSync(json, `${JSON.stringify(preregisteredDocument(result), null, 2)}\n`, "utf8");
  writeFileSync(md, renderPreregisteredMarkdown(result), "utf8");
  const stdout = deps.stdout ?? process.stdout;
  stdout.write(renderPreregisteredConsole(result, { json, md }));
  if (request.recordChoice === true) {
    const record = choiceRecordOf(result, {
      recordedAt: (deps.now ?? (() => new Date()))(),
      preregistrationCommit: (deps.preregistrationCommit ?? gitPreregistrationCommit)(),
      report: repoRelative(md),
      runs: recordings,
    });
    writeFileSync(choicePath, record, "utf8");
    stdout.write(`choice record: ${choicePath} (commit it; the held-out set's one run reads it)\n`);
  }
  return { result, json, md };
}
