// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The rules-versus-Von table the README promises, and the aggregation
// behind it.
//
// Every figure is reported for the rules baseline and for Von, at both levels,
// so the comparison is one table rather than two runs somebody has to line up
// by hand. `aggregateScenarios` is what turns one backend's per-scenario
// results into that column, and `summary.ts` uses the same function for the
// per-backend block of `run.json`, so a number in the comparison and the same
// number in the backend section cannot drift apart.
//
// `delta` is always Von minus rules, so a positive delta means Von did better
// on a metric where more is better and worse where less is (the false-ticket
// rate and the cost). The row's `lowerIsBetter` flag says which, because a
// reader of the Markdown table should not have to know.
//
// The confidences themselves are not a row: the rules backend's confidence is a
// calibrated gating quantity and Von's is a different one, and putting them in
// the same column unnamed would compare two things that only share a word.

import type {
  AbstentionResult,
  ByLevel,
  ComparisonRow,
  CostSummary,
  LeadTime,
  Level,
  MatchResult,
  Metropt3Check,
  PrecisionRecall,
  ScenarioMetrics,
  TicketRates,
  TicketRecord,
} from "./types.ts";
import { mergeMatches } from "./match.ts";
import { precisionRecall } from "./precision.ts";
import { ticketRates } from "./rate.ts";
import { mergeAbstention } from "./abstain.ts";
import { mergeCost } from "./cost.ts";
import { metropt3Check } from "./check.ts";

export type { ComparisonRow } from "./types.ts";

/** One backend's scenarios pooled into the figures a report and a comparison need. */
export interface BackendAggregate {
  readonly backend: string;
  readonly scenarios: number;
  readonly match: ByLevel<MatchResult>;
  readonly precisionRecall: ByLevel<PrecisionRecall>;
  readonly leadTimes: readonly LeadTime[];
  readonly rates: TicketRates;
  readonly abstention: AbstentionResult;
  readonly cost: CostSummary;
  readonly metropt3Check: ByLevel<Metropt3Check>;
  /** Scenarios passed at detection level: suspect events. */
  readonly detectionPassed: number;
  /** Scenarios passed by the ticket rule at review-or-ticket level (E3's earlier reading). */
  readonly reviewDiagnosisPassed: number;
  readonly diagnosisPassed: number;
  readonly tickets: readonly TicketRecord[];
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function matchAt(scenarios: readonly ScenarioMetrics[], level: Level): MatchResult {
  return mergeMatches(
    scenarios.map((scenario) =>
      level === "ticket" ? scenario.match.ticket : scenario.match.review,
    ),
    level,
  );
}

/**
 * One backend's per-scenario results pooled.
 *
 * @throws TypeError when the scenarios do not all name the same backend, which would produce
 * a column mixing two systems.
 */
export function aggregateScenarios(scenarios: readonly ScenarioMetrics[]): BackendAggregate {
  const first = scenarios[0];
  if (first === undefined) throw new TypeError("cannot aggregate an empty scenario list");
  const backend = first.backend;
  for (const scenario of scenarios) {
    if (scenario.backend !== backend) {
      throw new TypeError(
        `scenario ${scenario.scenarioId} was scored against ${scenario.backend}, not ${backend}`,
      );
    }
  }

  const ticketMatch = matchAt(scenarios, "ticket");
  const reviewMatch = matchAt(scenarios, "review");
  const tickets = scenarios.flatMap((scenario) => scenario.tickets);

  const covered = scenarios.reduce((total, s) => total + s.rates.coveredMachineDays, 0);
  const negative = scenarios.reduce((total, s) => total + s.rates.negativeMachineDays, 0);

  return {
    backend,
    scenarios: scenarios.length,
    match: { ticket: ticketMatch, review: reviewMatch },
    precisionRecall: {
      ticket: precisionRecall(ticketMatch, "ticket"),
      review: precisionRecall(reviewMatch, "review"),
    },
    leadTimes: scenarios.flatMap((scenario) => scenario.leadTimes),
    rates: ticketRates(tickets, reviewMatch.fp, covered, negative),
    abstention: mergeAbstention(
      scenarios
        .map((scenario) => scenario.abstention)
        .filter((result): result is AbstentionResult => result !== null),
    ),
    cost: mergeCost(
      scenarios.map((scenario) => scenario.cost),
      backend,
      first.cost.prices,
      tickets.length,
    ),
    metropt3Check: {
      ticket: metropt3Check(ticketMatch.windows, ticketMatch, "ticket"),
      review: metropt3Check(reviewMatch.windows, reviewMatch, "review"),
    },
    detectionPassed: scenarios.filter((scenario) => scenario.pass.detection).length,
    reviewDiagnosisPassed: scenarios.filter((scenario) => scenario.pass.reviewDiagnosis).length,
    diagnosisPassed: scenarios.filter((scenario) => scenario.pass.diagnosis).length,
    tickets,
  };
}

interface RowSpec {
  readonly metric: string;
  readonly lowerIsBetter?: boolean;
  readonly of: (aggregate: BackendAggregate) => number | null;
}

const ROWS: readonly RowSpec[] = [
  { metric: "scenarios", of: (a) => a.scenarios },
  { metric: "scenarios passed (detection)", of: (a) => a.detectionPassed },
  { metric: "scenarios passed (review diagnosis)", of: (a) => a.reviewDiagnosisPassed },
  { metric: "scenarios passed (diagnosis)", of: (a) => a.diagnosisPassed },
  { metric: "precision (ticket, micro)", of: (a) => a.precisionRecall.ticket.micro.precision },
  { metric: "recall (ticket, micro)", of: (a) => a.precisionRecall.ticket.micro.recall },
  { metric: "precision (ticket, macro)", of: (a) => a.precisionRecall.ticket.macro.precision },
  { metric: "recall (ticket, macro)", of: (a) => a.precisionRecall.ticket.macro.recall },
  { metric: "precision (review, micro)", of: (a) => a.precisionRecall.review.micro.precision },
  { metric: "recall (review, micro)", of: (a) => a.precisionRecall.review.micro.recall },
  { metric: "true positives (ticket)", of: (a) => a.match.ticket.tp.length },
  {
    metric: "false positives (ticket)",
    lowerIsBetter: true,
    of: (a) => a.match.ticket.fp.length,
  },
  {
    metric: "false negatives (ticket)",
    lowerIsBetter: true,
    of: (a) => a.match.ticket.fn.length,
  },
  {
    metric: "misdiagnosed windows (ticket)",
    lowerIsBetter: true,
    of: (a) => a.match.ticket.misdiagnosed.length,
  },
  { metric: "recovered windows (ticket)", of: (a) => a.match.ticket.recovered.length },
  { metric: "tickets per machine-day", of: (a) => a.rates.ticketsPerMachineDay },
  {
    metric: "false tickets per machine-day",
    lowerIsBetter: true,
    of: (a) => a.rates.falseTicketsPerMachineDay,
  },
  {
    metric: "mean lead time vs native alarm (min)",
    of: (a) =>
      mean(
        a.leadTimes
          .map((lead) => lead.leadMinutes)
          .filter((value): value is number => value !== undefined),
      ),
  },
  {
    metric: "mean detection latency (min)",
    lowerIsBetter: true,
    of: (a) => mean(a.leadTimes.map((lead) => lead.latencyMinutes)),
  },
  { metric: "abstention accuracy", of: (a) => a.abstention.accuracy },
  { metric: "explicit abstention rate", of: (a) => a.abstention.explicitRate },
  { metric: "cost (USD)", lowerIsBetter: true, of: (a) => a.cost.usd },
  { metric: "cost per ticket (USD)", lowerIsBetter: true, of: (a) => a.cost.perTicket },
];

function valueOf(scenarios: readonly ScenarioMetrics[] | undefined, row: RowSpec): number | null {
  if (scenarios === undefined || scenarios.length === 0) return null;
  return row.of(aggregateScenarios(scenarios));
}

/**
 * The comparison table: one row per metric, one column per backend.
 *
 * @param rulesMetrics the rules baseline's scenarios.
 * @param vonMetrics Von's scenarios.
 * @param llmMetrics the optional LLM column; the `llm` field is absent when it is not given.
 * @returns one row per metric, in a fixed order so two reports diff cleanly.
 */
export function compare(
  rulesMetrics: readonly ScenarioMetrics[],
  vonMetrics: readonly ScenarioMetrics[],
  llmMetrics?: readonly ScenarioMetrics[],
): ComparisonRow[] {
  const rulesAggregate = rulesMetrics.length === 0 ? undefined : aggregateScenarios(rulesMetrics);
  const vonAggregate = vonMetrics.length === 0 ? undefined : aggregateScenarios(vonMetrics);

  return ROWS.map((row) => {
    const rules = rulesAggregate === undefined ? null : row.of(rulesAggregate);
    const von = vonAggregate === undefined ? null : row.of(vonAggregate);
    const llm = valueOf(llmMetrics, row);
    return {
      metric: row.metric,
      rules,
      von,
      ...(llmMetrics === undefined ? {} : { llm }),
      delta: rules === null || von === null ? null : von - rules,
      lowerIsBetter: row.lowerIsBetter === true,
    };
  });
}
