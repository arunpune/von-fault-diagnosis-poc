// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The metrics library (docs/evaluation.md, "The metrics"), in one import.
//
// Everything below is a pure function over plain data. Nothing here reaches
// the replay engine, the runner, `@fdp/backend` or `@fdp/ground-truth`, which
// is what lets a stored `run.json` be re-scored months later against new
// labels or new thresholds, and what `purity.test.ts` enforces mechanically.
//
// The three entry points a caller usually wants are `scoreScenario` (one
// scenario against one backend), `summarise` (the run's gate and comparison)
// and `sweep` (what other thresholds would have produced).

export type {
  AlarmActivation,
  BackendSummary,
  ByLevel,
  CheckLevel,
  CountLevel,
  DecisionRecord,
  ExcludedWindow,
  GateCounts,
  GateOutcome,
  Interval,
  Level,
  PassLevel,
  Prices,
  RunSummary,
  ScenarioBinding,
  ScenarioExpectation,
  ScenarioGroup,
  ScenarioMetrics,
  ScenarioPass,
  ScoringWindow,
  Split,
  TicketRecord,
  Usage,
} from "./types.ts";
export { NONE_OF_THESE } from "./types.ts";

export { covers, matchTickets, mergeMatches, spanFrom, windowForTicket } from "./match.ts";
export type { Match, MatchResult, SpanFields } from "./match.ts";

export { deadline, scoreDetection, warmupEnd } from "./detection.ts";
export type { DetectionResult, SuspectRecord, WindowDetection } from "./detection.ts";

export { UNLABELLED_EPISODE_REASON, designEpisodes, designReading } from "./design.ts";
export type { DesignInput, DesignLevelReading, DesignReading, DesignTarget } from "./design.ts";

export { precisionRecall } from "./precision.ts";
export type { FaultScore, MacroScore, PrecisionRecall } from "./precision.ts";

export { firstAlarmByWindow, leadTimes } from "./leadtime.ts";
export type { AlarmFirstByWindow, LeadTime, LpsFirstByWindow } from "./leadtime.ts";

export { coveredMachineDays, negativeMachineDays, ticketRates } from "./rate.ts";
export type { TicketRates } from "./rate.ts";

export { abstention, mergeAbstention } from "./abstain.ts";
export type { AbstainCase, AbstainVerdict, AbstentionResult } from "./abstain.ts";

export { cost, mergeCost, pricesFor } from "./cost.ts";
export type { BackendPrices, CostResult, CostSummary, DecisionCost } from "./cost.ts";

export { metropt3Check, metropt3DetectionCheck } from "./check.ts";
export type { Metropt3Check } from "./check.ts";

export { aggregateScenarios, compare } from "./compare.ts";
export type { BackendAggregate, ComparisonRow } from "./compare.ts";

export { couldOpen, gate, sweep } from "./sweep.ts";
export type {
  GateVerdict,
  SweepEpisode,
  SweepOptions,
  SweepRow,
  SweepRun,
  ThresholdPair,
} from "./sweep.ts";

export {
  CORE_10_POSITIVE_SCENARIO_IDS,
  CORE_10_SCENARIO_IDS,
  MIN_POSITIVES,
  MIN_SCENARIOS,
  coreGate,
  runAbstention,
  runMatch,
  scoreScenario,
  summarise,
} from "./summary.ts";
export type { ScoreScenarioOptions, SummariseOptions } from "./summary.ts";

export { MS_PER_DAY, MS_PER_MINUTE, minutesBetween } from "./time.ts";
