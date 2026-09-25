// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Scoring one scenario, and the run summary the gate is read from
// (docs/evaluation.md, "When a scenario passes, and the gate").
//
// A scenario passes at three levels, and all three are always computed:
//
//   detection         what the rules layer does, and what E3 gates: for a
//                     positive, a suspect event — not a ticket — in the
//                     credited span of a positive window within the budget
//                     (`detection.ts`); for a normal-operation negative (group
//                     `negative`), no suspect event at all; every other case
//                     (the abstain cases) keeps the ticket rule of review
//                     diagnosis below.
//   review diagnosis  the `expect` block holds with any review-or-ticket item
//                     — at least one true positive inside the window and
//                     inside the budget, or, for a negative or abstain case,
//                     no non-benign ticket at all — and the false tickets stay
//                     within the scenario's allowance. It is what "detection"
//                     meant at first; for the rules backend it is a baseline,
//                     reported and never gated.
//   diagnosis         review diagnosis, and the *first* ticket inside the
//                     window at ticket level names an accepted fault. A
//                     backend that opens a wrong ticket first and corrects it
//                     later does not diagnose; the correction is reported as
//                     "recovered". E4 gates Jev here.
//
// The budget runs from `max(onset, replay.from + warmup)`: a scenario that
// starts inside a failure must not be credited for a detection the warmup
// samples had not yet made possible, and tickets and suspect events raised
// during the warmup are replayed but not scored at all.
//
// The gate is deliberately two conditions rather than one:
// ≥ 8 of the 10 core scenarios **and** ≥ 5 of the 6 positives. A backend that
// never opens a ticket passes all four negatives and abstain cases and would
// otherwise sit at 4/10 with a clean sheet; the positive count is what makes
// that impossible. A core-10 scenario the run did not score counts as a
// failure, so a truncated run cannot pass by omission.

import type {
  AbstentionResult,
  AlarmActivation,
  BackendSummary,
  CountLevel,
  DecisionRecord,
  DetectionResult,
  GateCounts,
  Level,
  MatchResult,
  PassLevel,
  Prices,
  RunSummary,
  ScenarioBinding,
  ScenarioMetrics,
  ScenarioPass,
  ScoringWindow,
  SuspectRecord,
  TicketRecord,
} from "./types.ts";
import { deadline, scoreDetection, warmupEnd } from "./detection.ts";
import { matchTickets, mergeMatches, windowForTicket } from "./match.ts";
import { precisionRecall } from "./precision.ts";
import { firstAlarmByWindow, leadTimes, type LpsFirstByWindow } from "./leadtime.ts";
import { coveredMachineDays, negativeMachineDays, ticketRates } from "./rate.ts";
import { abstention, type AbstainCase } from "./abstain.ts";
import { cost } from "./cost.ts";
import { metropt3Check, metropt3DetectionCheck } from "./check.ts";
import { aggregateScenarios, compare } from "./compare.ts";
import { instant } from "./time.ts";

/** The ten scenarios with known ground truth the core-10 gate counts. */
export const CORE_10_SCENARIO_IDS: readonly string[] = [
  "f1_air_leak_apr18",
  "f2_air_leak_may30",
  "f3_air_leak_jun05",
  "f4_air_leak_jul15",
  "inject_oil_cooler_fouling",
  "inject_air_leak_downstream",
  "inject_high_ambient_benign",
  "inject_oil_temperature_sensor_fault",
  "baseline_feb03_normal",
  "depot_lps_jul31",
];

/** The six positives among them; the gate asks for ≥ 5 of these six. */
export const CORE_10_POSITIVE_SCENARIO_IDS: readonly string[] = [
  "f1_air_leak_apr18",
  "f2_air_leak_may30",
  "f3_air_leak_jun05",
  "f4_air_leak_jul15",
  "inject_oil_cooler_fouling",
  "inject_air_leak_downstream",
];

/** The gate's two thresholds; the runner reads them to judge a run that scored part of the ten. */
export const MIN_SCENARIOS = 8;
export const MIN_POSITIVES = 5;

/** The confidence gate's review floor, used when a caller states none. */
const DEFAULT_REVIEW_MIN = 0.6;

/** What `scoreScenario` needs beyond the records themselves. */
export interface ScoreScenarioOptions {
  readonly backend: string;
  /** The scenario's `native_alarm_codes`; empty means "every code that fired". */
  readonly nativeAlarmCodes?: readonly string[];
  /** `GATE_REVIEW_MIN_CONFIDENCE`, the floor an explicit abstention must clear. */
  readonly reviewMin?: number;
  /** Overrides the windows' own LPS reference, for stack mode. */
  readonly lpsFirstByWindow?: LpsFirstByWindow;
  /**
   * Every suspect event the replay raised, warmup included. A caller that has none passes none:
   * detection then fails every positive and never passes one.
   */
  readonly suspects?: readonly SuspectRecord[];
}

/** True when the group is one the ten-scenario gate counts as a positive. */
function isPositive(binding: ScenarioBinding): boolean {
  return (
    binding.positive ?? (binding.group === "recording_positive" || binding.group === "injected")
  );
}

/** The first ticket that opened inside any positive window, at this level. */
function firstInWindow(
  positives: readonly ScoringWindow[],
  level: Level,
  tickets: readonly TicketRecord[],
): TicketRecord | undefined {
  const participating =
    level === "ticket" ? tickets.filter((entry) => entry.maxLevel === "ticket") : tickets;
  return participating
    .filter((ticket) => windowForTicket(positives, ticket) !== undefined)
    .sort(
      (left, right) =>
        instant(left.openedSimTs, `ticket ${left.ticketId}`) -
          instant(right.openedSimTs, `ticket ${right.ticketId}`) ||
        left.ticketId.localeCompare(right.ticketId),
    )[0];
}

interface PassInput {
  readonly binding: ScenarioBinding;
  readonly positives: readonly ScoringWindow[];
  /** The review-level classification; review diagnosis is judged at review-or-ticket level. */
  readonly review: MatchResult;
  /** Every scored ticket; diagnosis re-reads them at ticket level. */
  readonly tickets: readonly TicketRecord[];
  /** The suspect events read against the windows; detection is judged on them. */
  readonly detection: DetectionResult;
}

/**
 * The detection level E3 gates; returns the reasons it failed, empty when it held. A positive is
 * judged on its suspect events, a normal-operation negative on raising none, and every other
 * case (the abstain cases) on the ticket rule it has always had.
 */
function detectionReasons(input: PassInput): string[] {
  const { binding, detection } = input;
  if (isPositive(binding)) {
    if (detection.windows.length === 0) return ["no positive window to detect in"];
    if (detection.windows.some((window) => window.detected)) return [];
    const late = detection.windows
      .filter((window) => window.first !== undefined && window.deadline !== undefined)
      .sort(
        (left, right) => (left.first?.simTs.getTime() ?? 0) - (right.first?.simTs.getTime() ?? 0),
      )[0];
    if (late?.first === undefined || late.deadline === undefined) {
      return ["no suspect event after the warmup in the credited span of a positive window"];
    }
    return [
      `the first suspect event in the span, at ${late.first.simTs.toISOString()}, came after the budget ended at ${late.deadline.toISOString()}`,
    ];
  }
  if (binding.group === "negative") {
    return detection.outsideWindows === 0
      ? []
      : [
          `${detection.outsideWindows} suspect event(s) in a normal-operation case that expects none`,
        ];
  }
  return reviewDiagnosisReasons(input);
}

/**
 * The ticket rule at review-or-ticket level — what "detection" meant at first — returning the
 * reasons it failed, empty when it held.
 */
function reviewDiagnosisReasons(input: PassInput): string[] {
  const { binding, positives, review } = input;
  const reasons: string[] = [];
  const falseTickets = review.fp.length;

  if (binding.expect.tickets === "none") {
    if (falseTickets > 0) {
      reasons.push(`${falseTickets} non-benign ticket(s) in a case that expects none`);
    }
    return reasons;
  }

  const by = deadline(binding, positives);
  const inTime = review.tp.filter(
    ({ ticket }) => by === undefined || ticket.openedSimTs.getTime() <= by.getTime(),
  );
  if (review.tp.length === 0) {
    reasons.push("no true positive at review level");
  } else if (inTime.length === 0 && by !== undefined) {
    reasons.push(`the first true positive opened after the budget ended at ${by.toISOString()}`);
  }
  if (falseTickets > binding.expect.maxFalseTickets) {
    reasons.push(
      `${falseTickets} false ticket(s), above the allowance of ${binding.expect.maxFalseTickets}`,
    );
  }
  return reasons;
}

/** The diagnosis half: the first in-window ticket at ticket level must name the right fault. */
function diagnosisReasons(input: PassInput): string[] {
  const { binding, positives, tickets } = input;
  if (binding.expect.tickets === "none") return [];

  const first = firstInWindow(positives, "ticket", tickets);
  if (first === undefined) return ["no ticket-level ticket inside the window"];

  const reasons: string[] = [];
  const by = deadline(binding, positives);
  if (by !== undefined && first.openedSimTs.getTime() > by.getTime()) {
    reasons.push(
      `the first ticket in the window opened after the budget ended at ${by.toISOString()}`,
    );
  }

  if (binding.expect.fault === "any") return reasons;

  if (binding.expect.fault === "benign_or_none") {
    if (!binding.benignFaultIds.has(first.faultAtOpen)) {
      reasons.push(
        `the first ticket in the window names the non-benign fault ${first.faultAtOpen}`,
      );
    }
    return reasons;
  }

  const window = windowForTicket(positives, first);
  if (window === undefined || !window.accepted.includes(first.faultAtOpen)) {
    reasons.push(
      `the first ticket in the window names ${first.faultAtOpen}, which is not accepted`,
    );
  }
  return reasons;
}

function judgePass(input: PassInput): ScenarioPass {
  const detection = detectionReasons(input);
  const review = reviewDiagnosisReasons(input);
  const diagnosis = review.length > 0 ? [] : diagnosisReasons(input);
  return {
    detection: detection.length === 0,
    reviewDiagnosis: review.length === 0,
    diagnosis: review.length === 0 && diagnosis.length === 0,
    reasons: [
      ...detection.map((reason) => `detection: ${reason}`),
      ...review.map((reason) => `review diagnosis: ${reason}`),
      ...diagnosis.map((reason) => `diagnosis: ${reason}`),
    ],
  };
}

/**
 * Scores one scenario against one backend.
 *
 * @param bound the scenario, its windows and its excluded windows, as the loader binds them.
 * @param tickets every ticket the run produced for it.
 * @param decisions every ok decision, ticket or not; abstention and cost are measured on them.
 * @param alarms the CTRL-7 activations of the replay, for the lead time.
 * @param prices the run's dated prices.
 * @param options the backend name, the scenario's alarm codes and review floor, and the suspect
 * events detection is judged on.
 * @returns everything `run.json` stores about the pair, at every level.
 */
export function scoreScenario(
  bound: ScenarioBinding,
  tickets: readonly TicketRecord[],
  decisions: readonly DecisionRecord[],
  alarms: readonly AlarmActivation[],
  prices: Prices,
  options: ScoreScenarioOptions,
): ScenarioMetrics {
  const warmupEnds = warmupEnd(bound);
  const warmupTickets = tickets.filter(
    (ticket) => ticket.openedSimTs.getTime() < warmupEnds.getTime(),
  );
  const scored = tickets.filter((ticket) => ticket.openedSimTs.getTime() >= warmupEnds.getTime());

  const positives = bound.windows.filter((window) => !window.benign);
  const ticketMatch = matchTickets(
    bound.windows,
    bound.excluded,
    scored,
    bound.benignFaultIds,
    "ticket",
  );
  const reviewMatch = matchTickets(
    bound.windows,
    bound.excluded,
    scored,
    bound.benignFaultIds,
    "review",
  );

  const covered = coveredMachineDays(bound.replay, bound.gaps, bound.frozen, bound.excluded);
  const negative = negativeMachineDays(
    bound.replay,
    positives,
    bound.gaps,
    bound.frozen,
    bound.excluded,
  );

  const detection = scoreDetection(bound, options.suspects ?? []);

  const abstainCase: AbstainCase = {
    id: bound.id,
    tickets: scored,
    decisions,
    benignFaultIds: bound.benignFaultIds,
    reviewMin: options.reviewMin ?? DEFAULT_REVIEW_MIN,
  };

  return {
    scenarioId: bound.id,
    group: bound.group,
    backend: options.backend,
    ...(bound.split === undefined ? {} : { split: bound.split }),
    positive: isPositive(bound),
    replay: bound.replay,
    windows: bound.windows,
    tickets: scored,
    warmupTickets,
    openAtEnd: scored.filter((ticket) => ticket.closedSimTs === undefined).length,
    match: { ticket: ticketMatch, review: reviewMatch },
    precisionRecall: {
      ticket: precisionRecall(ticketMatch, "ticket"),
      review: precisionRecall(reviewMatch, "review"),
    },
    detection,
    leadTimes: leadTimes(
      reviewMatch,
      firstAlarmByWindow(bound.windows, alarms, options.nativeAlarmCodes ?? []),
      options.lpsFirstByWindow,
    ),
    rates: ticketRates(scored, reviewMatch.fp, covered, negative),
    abstention: bound.group === "abstain" ? abstention([abstainCase]) : null,
    cost: cost(decisions, prices, options.backend, scored),
    pass: judgePass({
      binding: bound,
      positives,
      review: reviewMatch,
      tickets: scored,
      detection,
    }),
  };
}

/** How the run summary picks the gate's level and its headline backend. */
export interface SummariseOptions {
  /** The level the phase requires; per backend by default. */
  readonly gateLevel?: PassLevel;
  /** The backend whose gate and MetroPT-3 check become the headline ones. */
  readonly headlineBackend?: string;
}

/** The level a backend is gated at when the caller states none. */
function levelFor(backend: string, options: SummariseOptions): PassLevel {
  return options.gateLevel ?? (backend === "rules" ? "detection" : "diagnosis");
}

/** Whether one scenario passed at `level`. */
function passed(scenario: ScenarioMetrics, level: CountLevel): boolean {
  if (level === "detection") return scenario.pass.detection;
  if (level === "review_diagnosis") return scenario.pass.reviewDiagnosis;
  return scenario.pass.diagnosis;
}

/**
 * The core-10 gate over one backend's scenarios.
 *
 * A core-10 id the run never scored is listed in `missing` and counts against the totals, so
 * a run that skipped half the profile cannot report 5/5. `review_diagnosis` is the level only
 * the rules backend's recorded baseline is counted at; no gate reads it.
 */
export function coreGate(
  scenarios: readonly ScenarioMetrics[],
  backend: string,
  level: CountLevel,
): GateCounts {
  const byId = new Map(scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const missing = CORE_10_SCENARIO_IDS.filter((id) => !byId.has(id));
  const failed = CORE_10_SCENARIO_IDS.filter((id) => {
    const scenario = byId.get(id);
    return scenario === undefined || !passed(scenario, level);
  });

  const passedCount = CORE_10_SCENARIO_IDS.length - failed.length;
  const positivesPassed = CORE_10_POSITIVE_SCENARIO_IDS.filter((id) => {
    const scenario = byId.get(id);
    return scenario !== undefined && passed(scenario, level);
  }).length;

  return {
    level,
    backend,
    scenarios: CORE_10_SCENARIO_IDS,
    passed: passedCount,
    total: CORE_10_SCENARIO_IDS.length,
    positivesPassed,
    positivesTotal: CORE_10_POSITIVE_SCENARIO_IDS.length,
    failed,
    missing,
    pass: passedCount >= MIN_SCENARIOS && positivesPassed >= MIN_POSITIVES,
  };
}

function backendSummary(
  scenarios: readonly ScenarioMetrics[],
  options: SummariseOptions,
): BackendSummary {
  const aggregate = aggregateScenarios(scenarios);
  const level = levelFor(aggregate.backend, options);
  const checkLevel: Level = level === "detection" ? "review" : "ticket";
  const match = checkLevel === "ticket" ? aggregate.match.ticket : aggregate.match.review;

  return {
    backend: aggregate.backend,
    scenarios: aggregate.scenarios,
    perFault: aggregate.precisionRecall.ticket.perFault,
    precisionRecall: aggregate.precisionRecall,
    leadTimes: aggregate.leadTimes,
    rates: aggregate.rates,
    abstention: aggregate.abstention,
    cost: aggregate.cost,
    metropt3Check: metropt3Check(match.windows, match, checkLevel),
    metropt3Detection: metropt3DetectionCheck(
      scenarios.flatMap((scenario) => scenario.detection.windows),
    ),
    gate: coreGate(scenarios, aggregate.backend, level),
  };
}

/**
 * The `summary` block of `run.json`: one section per backend, the comparison and the gate.
 *
 * @param scenarioMetrics every (scenario, backend) pair the run scored, in any order.
 * @param options the gate level and which backend's gate is the headline one; by default the
 * headline is `jev` when it ran and `rules` otherwise, and the level is each backend's own.
 * @throws TypeError when the list is empty — a run summary over nothing would report a gate
 * result nobody measured.
 */
export function summarise(
  scenarioMetrics: readonly ScenarioMetrics[],
  options: SummariseOptions = {},
): RunSummary {
  if (scenarioMetrics.length === 0) {
    throw new TypeError("cannot summarise a run with no scored scenarios");
  }

  const names = [...new Set(scenarioMetrics.map((scenario) => scenario.backend))].sort();
  const byBackend = new Map(
    names.map((name) => [name, scenarioMetrics.filter((scenario) => scenario.backend === name)]),
  );
  const backends = names.map((name) => backendSummary(byBackend.get(name) ?? [], options));

  const headlineName =
    options.headlineBackend ?? (byBackend.has("jev") ? "jev" : (names[0] as string));
  const headline = backends.find((summary) => summary.backend === headlineName) ?? backends[0];
  if (headline === undefined) throw new TypeError("cannot summarise a run with no backends");

  return {
    backends,
    comparison: compare(
      byBackend.get("rules") ?? [],
      byBackend.get("jev") ?? [],
      byBackend.get("llm"),
    ),
    gate: headline.gate,
    metropt3Check: headline.metropt3Check,
    core10: CORE_10_SCENARIO_IDS,
  };
}

/** One match result over every scenario of one backend, at one level; used by the report. */
export function runMatch(scenarioMetrics: readonly ScenarioMetrics[], level: Level): MatchResult {
  return mergeMatches(
    scenarioMetrics.map((scenario) =>
      level === "ticket" ? scenario.match.ticket : scenario.match.review,
    ),
    level,
  );
}

/** The abstention result of a run, pooled from the scenarios that carried one. */
export function runAbstention(scenarioMetrics: readonly ScenarioMetrics[]): AbstentionResult {
  return aggregateScenarios(scenarioMetrics).abstention;
}
