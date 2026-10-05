// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The vocabulary of the metrics library (docs/evaluation.md, "The metrics").
//
// Everything here is plain data, and this module imports nothing at all — not
// even from its own directory. That is deliberate: it makes the dependency
// graph of `src/metrics` a fan, every module pointing at this one and at
// nothing else of its own, so there is no cycle for a reader or for
// dependency-cruiser to unpick. Each module re-exports the shapes it produces,
// so a caller still writes `import type { MatchResult } from "./match.ts"`.
//
// The library never imports the replay engine, the runner, `@fdp/backend` or
// `@fdp/ground-truth`: a run is scored from what a report holds, so a stored
// `run.json` can be re-scored when the labels change or the thresholds move,
// which is the whole point of the threshold sweep. `metrics/purity.test.ts` is
// the mechanical guard.
//
// Instants are `Date` in memory and ISO strings on disk. The conversion belongs
// to whoever reads or writes the JSON (the report writer, the golden fixtures'
// loader), not here, so no function in this library ever parses a string.
//
// Windows are half-open — `from` inclusive, `to` exclusive — exactly as
// `@fdp/ground-truth` defines them. `leadFrom` is `precursor_from` when the
// failure has one, else the window start; the earliest instant a ticket may
// open and still count for the window is `spanFrom` in `match.ts`, which is
// `leadFrom`, or the data onset when the onset is known and earlier (the
// credited span); lead time's native alarm is searched from there as well.

// --- Records in --------------------------------------------------------------

/**
 * The two levels every figure is reported at.
 *
 * `ticket` counts only what an operator was handed as work; `review` counts the review queue
 * beside it, so the gate's job stays visible instead of being hidden in one headline number.
 */
export type Level = "ticket" | "review";

/** The five scenario groups, which decide how a scenario's pass is judged. */
export type ScenarioGroup =
  "recording_positive" | "injected" | "negative" | "abstain" | "diagnostic";

/**
 * The dev/test split — the core-10 is `test`, every tuning run is `dev` — and the held-out
 * set, `heldout`, which no sweep ever reads (tools/eval/records/heldout-seal.md).
 */
export type Split = "dev" | "test" | "heldout";

/** The level a scenario's `expect` block is judged at. */
export type PassLevel = "detection" | "diagnosis";

/**
 * The levels a MetroPT-3 check is read at: a ticket level, or `detection`, where a headline
 * failure counts as found when a suspect event fell in its credited span within its budget:
 * detection-level E3.
 */
export type CheckLevel = Level | "detection";

/**
 * The pass flags a core-10 count can be read at. `review_diagnosis` is the ticket rule at
 * review-or-ticket level, what "detection" meant before E3 moved to detection level; only the
 * rules backend's recorded baseline is counted at it, and no gate reads it.
 */
export type CountLevel = PassLevel | "review_diagnosis";

/** A half-open interval `[from, to)` of sim time. */
export interface Interval {
  readonly from: Date;
  readonly to: Date;
}

/**
 * One window a positive is scored in.
 *
 * `accepted` is the window's accepted fault ids, primary first, as `@fdp/ground-truth` orders
 * them; a ticket naming any of them is correct. `benign: true` marks a window that is not a
 * positive at all (a benign injection, a depot depressurisation): it can never be missed and
 * never appears in a recall denominator, it only says where a benign answer was expected.
 */
export interface ScoringWindow {
  readonly id: string;
  readonly from: Date;
  readonly to: Date;
  /**
   * `precursor_from` when the failure has one, else the window start. The native alarm of the
   * lead time is searched in `[spanFrom, to)`, which starts here unless a known onset is
   * earlier (the credited span).
   */
  readonly leadFrom: Date;
  readonly accepted: readonly string[];
  readonly benign: boolean;
  /**
   * The data onset detection latency is measured from; `from` when the binding has none. When
   * it is known and earlier than `leadFrom`, the true-positive span opens here (`spanFrom`).
   */
  readonly onset?: Date;
  /**
   * False when the onset is a lower bound, which turns the latency into a `≥` figure and keeps
   * the onset from opening the true-positive span.
   */
  readonly onsetKnown: boolean;
  /** The ground truth's own LPS activation for the window, reported beside the CTRL-7 one. */
  readonly nativeLpsFirst?: Date;
  /** True for the four MetroPT-3 headline failures, which the in-sample check scores. */
  readonly headline: boolean;
}

/** One window that counts neither as a positive nor as a negative (docs/dataset.md). */
export interface ExcludedWindow {
  readonly id: string;
  readonly from: Date;
  readonly to: Date;
  readonly reason: string;
}

/**
 * One ticket, the unit of scoring.
 *
 * `faultAtOpen` is what the first decision named and is what precision is attributed to;
 * `faultLatest` is what the ticket says now, after every in-place update, and is reported but
 * never scored — a system that opens a wrong ticket and corrects it is penalised, and shown
 * as "recovered".
 */
export interface TicketRecord {
  readonly ticketId: string;
  readonly episodeId: string;
  readonly openedSimTs: Date;
  readonly faultAtOpen: string;
  readonly faultLatest: string;
  /** `review` while the ticket sat in the review queue, `ticket` once it was promoted. */
  readonly maxLevel: Level;
  readonly closedSimTs?: Date;
}

/** The gate outcome of one decision (docs/decision-backends.md). */
export type GateOutcome = "ticket" | "review" | "log";

/** What a decision spent, in the shape `DecisionOutput.usage` reports it. */
export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/**
 * One ok decision, kept whether or not it produced a ticket.
 *
 * Decisions that never opened a ticket are what abstention and cost are measured on, and
 * `choice` plus `confidence` are what the threshold sweep re-gates.
 */
export interface DecisionRecord {
  readonly decisionId: string;
  readonly episodeId: string;
  readonly simTs: Date;
  readonly choice: string;
  readonly confidence: number;
  readonly gate: GateOutcome;
  readonly abstained: boolean;
  readonly usage: Usage;
  readonly backend: string;
  /** True when `choice` names a fault the scenario's ground truth calls benign. */
  readonly benignChoice: boolean;
  /**
   * How long the episode's own symptom had fired without a break when the decision was taken, in
   * sim minutes: the persistence before the first decision. An episode that owns no ticket is
   * decided only once this reaches `GATE_PERSIST_SIM_MIN`, so a re-gating (`sweep.ts`) never opens
   * a ticket on a decision below it. Absent from runs recorded before the pipeline reported it.
   */
  readonly persistedSimMin?: number;
}

/** The choice a backend makes when no candidate fits; it never opens a ticket. */
export const NONE_OF_THESE = "none_of_these";

/**
 * One suspect event detection raised, re-decisions included.
 *
 * The unit E3's detection level is scored on: detection is what the rules layer does, a ticket
 * is a diagnosis. A suspect event is raised by detection alone, before any backend is asked, so
 * every backend of a run sees the same ones.
 */
export interface SuspectRecord {
  readonly eventId: string;
  readonly simTs: Date;
  /** The condition id of the highest-severity rule that fired (`suspect-event.symptom_key`). */
  readonly symptomKey: string;
}

/** One activation of a controller alarm code, in sim time (the harness's CTRL-7 port). */
export interface AlarmActivation {
  readonly code: string;
  readonly simTs: Date;
}

/**
 * The dated prices a run was costed with (`PRICES_AS_OF`).
 *
 * Von bills input tokens only; the LLM comparison bills both. The rules backend is free, so
 * it has no price of its own.
 */
export interface Prices {
  readonly vonInputPerMtok: number;
  readonly llmInputPerMtok: number;
  readonly llmOutputPerMtok: number;
  readonly asOf: string;
}

/** What a scenario's `expect` block asks of a backend. */
export interface ScenarioExpectation {
  readonly tickets: "at_least_one" | "none";
  readonly fault: "accepted" | "injected" | "benign_or_none" | "any";
  /** The budget after `max(onset, replay.from + warmup)`; absent on negatives and abstains. */
  readonly withinMin?: number;
  readonly maxFalseTickets: number;
  readonly passLevel: PassLevel;
}

/**
 * Everything `scoreScenario` needs about one bound scenario.
 *
 * It is the structural subset of the loader's `BoundScenario` that scoring reads. Keeping it
 * structural rather than imported is what lets the metrics run over a hand-made fixture, over
 * a stored `run.json` and over rows read from a live stack with the same code.
 */
export interface ScenarioBinding {
  readonly id: string;
  readonly group: ScenarioGroup;
  readonly split?: Split;
  /** Defaults to "the group is `recording_positive` or `injected`" when absent. */
  readonly positive?: boolean;
  readonly replay: Interval;
  /** Sim minutes after `replay.from` in which tickets are replayed but not scored. */
  readonly warmupMin: number;
  readonly windows: readonly ScoringWindow[];
  readonly excluded: readonly ExcludedWindow[];
  readonly benignFaultIds: ReadonlySet<string>;
  readonly expect: ScenarioExpectation;
  /** Sampling gaps longer than 60 s, which are not covered machine time. */
  readonly gaps?: readonly Interval[];
  /** Frozen-logger blocks, which are not covered machine time either. */
  readonly frozen?: readonly Interval[];
}

// --- Figures out -------------------------------------------------------------

/** One ticket paired with the window it fell in (`match.ts`). */
export interface Match {
  readonly window: ScoringWindow;
  readonly ticket: TicketRecord;
}

/**
 * The classification of every ticket of one scenario, or of a whole run once merged.
 *
 * `windows` is carried along because recall is measured over windows, not tickets: a later
 * `precisionRecall` or `metropt3Check` call needs the denominators and must not have to be
 * handed the binding a second time.
 */
export interface MatchResult {
  readonly level: Level;
  readonly windows: readonly ScoringWindow[];
  readonly tp: readonly Match[];
  readonly fp: readonly TicketRecord[];
  readonly misdiagnosed: readonly Match[];
  readonly recovered: readonly Match[];
  readonly duplicates: readonly Match[];
  readonly ignored: readonly TicketRecord[];
  readonly benign: readonly TicketRecord[];
  readonly fn: readonly ScoringWindow[];
}

/** The four counters and the two ratios of one fault (`precision.ts`). */
export interface FaultScore {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly windows: number;
  readonly precision: number | null;
  readonly recall: number | null;
}

/** The mean of the defined per-fault ratios; `null` when no fault has one. */
export interface MacroScore {
  readonly precision: number | null;
  readonly recall: number | null;
  /** How many faults each mean was taken over, so a macro of one fault is not read as ten. */
  readonly precisionFaults: number;
  readonly recallFaults: number;
}

/** Per-fault scores with their micro and macro aggregates, at one level. */
export interface PrecisionRecall {
  readonly level: Level;
  readonly perFault: Readonly<Record<string, FaultScore>>;
  readonly micro: FaultScore;
  readonly macro: MacroScore;
}

/** The lead time and latency of one detected window (`leadtime.ts`). */
export interface LeadTime {
  readonly windowId: string;
  /** The fault the first correct ticket named; one of the window's accepted ids. */
  readonly fault: string;
  readonly firstCorrectTicket: Date;
  /** The CTRL-7 code whose first activation is the reference, when there was one. */
  readonly nativeCode?: string;
  readonly nativeFirst?: Date;
  /** Native minus ticket, in minutes; positive means earlier than the controller. */
  readonly leadMinutes?: number;
  readonly lpsFirst?: Date;
  readonly lpsLeadMinutes?: number;
  /** Ticket minus onset, in minutes; negative when the ticket opened in the precursor. */
  readonly latencyMinutes: number;
  /** `>=` when the onset is a lower bound (`onsetKnown: false`), else the empty string. */
  readonly qualifier: "" | ">=";
}

/** Tickets and false tickets per machine-day; `null` when the denominator is empty. */
export interface TicketRates {
  readonly tickets: number;
  readonly falseTickets: number;
  readonly coveredMachineDays: number;
  readonly negativeMachineDays: number;
  readonly ticketsPerMachineDay: number | null;
  readonly falseTicketsPerMachineDay: number | null;
}

/** Why one abstain case was judged correct or incorrect (`abstain.ts`). */
export interface AbstainVerdict {
  readonly id: string;
  readonly correct: boolean;
  /** One line per rule that failed; empty when the case is correct. */
  readonly reasons: readonly string[];
}

/** Abstention accuracy over a set of cases, with the explicit rate beside it. */
export interface AbstentionResult {
  readonly correct: number;
  readonly total: number;
  readonly accuracy: number | null;
  readonly decisions: number;
  readonly explicit: number;
  readonly explicitRate: number | null;
  readonly cases: readonly AbstainVerdict[];
}

/** The two prices one backend is billed at, and the date they were read (`cost.ts`). */
export interface BackendPrices {
  readonly inputPerMtok: number;
  readonly outputPerMtok: number;
  readonly asOf: string;
}

/** The cost of a scenario, a backend or a whole run. */
export interface CostSummary {
  readonly backend: string;
  readonly usd: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly calls: number;
  readonly perDecision: number | null;
  readonly perTicket: number | null;
  readonly prices: BackendPrices;
}

/** The result of the MetroPT-3 check, always labelled in-sample (`check.ts`). */
export interface Metropt3Check {
  readonly level: CheckLevel;
  readonly detected: readonly string[];
  readonly missed: readonly string[];
  readonly pass: boolean;
  /** Always true: the detection rules were designed after inspecting F1–F4. */
  readonly in_sample: true;
}

/** One row of the comparison table (`compare.ts`). */
export interface ComparisonRow {
  readonly metric: string;
  readonly rules: number | null;
  readonly von: number | null;
  readonly llm?: number | null;
  /** Von minus rules; `null` when either side has no value. */
  readonly delta: number | null;
  /** True for the metrics a smaller number is better on (false tickets, cost). */
  readonly lowerIsBetter: boolean;
}

// --- Scored results ----------------------------------------------------------
//
// `ScenarioMetrics` and `RunSummary` are the shapes `run.json` stores;
// `summary.ts` assembles them.

/** One figure reported at both levels. */
export interface ByLevel<T> {
  readonly ticket: T;
  readonly review: T;
}

/**
 * One positive window read at detection level: the first scored suspect event inside its
 * credited span `[spanFrom, to)`, and whether it came within the scenario's budget.
 */
export interface WindowDetection {
  readonly windowId: string;
  /** True for the four MetroPT-3 headline failures, which the detection-level check reads. */
  readonly headline: boolean;
  /** The first suspect event after the warmup inside the span, when there was one. */
  readonly first?: SuspectRecord;
  /** The last instant a suspect event may fall and still be in time; absent when unbounded. */
  readonly deadline?: Date;
  /** True when `first` exists and falls at or before `deadline`. */
  readonly detected: boolean;
}

/** What a scenario's suspect events add up to at detection level. */
export interface DetectionResult {
  /** Suspect events at or after the end of the warmup: the ones that are scored. */
  readonly suspects: number;
  /** Suspect events raised inside the warmup: replayed, never scored. */
  readonly warmupSuspects: number;
  /**
   * Scored suspect events outside every positive window's span and every excluded window: what
   * a normal-operation case must not raise.
   */
  readonly outsideWindows: number;
  /** One entry per non-benign positive window, in the binding's order. */
  readonly windows: readonly WindowDetection[];
}

/**
 * Whether a scenario's `expect` block held at each level, and why not.
 *
 * - `detection`: for a positive, a suspect event in the credited span of a positive window within
 *   the `within_min` budget; for a normal-operation negative (group `negative`), no suspect event;
 *   for every other case (the abstain cases), the ticket rule of `reviewDiagnosis`. It is what the
 *   rules backend is gated on (E3).
 * - `reviewDiagnosis`: the ticket rule at review-or-ticket level — a ticket naming an accepted fault
 *   in the span and within the budget and the false tickets within the allowance, or, for a case
 *   that expects none, no non-benign ticket. It is what `detection` meant before E3 moved to
 *   detection level, and for the rules backend a recorded baseline that no gate reads.
 * - `diagnosis`: `reviewDiagnosis`, and the first ticket-level ticket inside the window names an
 *   accepted fault. E4 gates Von on it; for the rules backend it is a baseline too.
 */
export interface ScenarioPass {
  readonly detection: boolean;
  readonly reviewDiagnosis: boolean;
  readonly diagnosis: boolean;
  /** One line per unmet condition, prefixed with its level; empty when every level passes. */
  readonly reasons: readonly string[];
}

/** Everything one scenario, scored against one backend, contributes to a report. */
export interface ScenarioMetrics {
  readonly scenarioId: string;
  readonly group: ScenarioGroup;
  readonly backend: string;
  readonly split?: Split;
  readonly positive: boolean;
  readonly replay: Interval;
  readonly windows: readonly ScoringWindow[];
  /** The tickets that were scored: everything the warmup did not swallow. */
  readonly tickets: readonly TicketRecord[];
  /** Tickets opened inside the warmup, replayed but not scored. */
  readonly warmupTickets: readonly TicketRecord[];
  /** Tickets still open when the replay ended; listed in the report. */
  readonly openAtEnd: number;
  readonly match: ByLevel<MatchResult>;
  readonly precisionRecall: ByLevel<PrecisionRecall>;
  /** The suspect events read at detection level. */
  readonly detection: DetectionResult;
  readonly leadTimes: readonly LeadTime[];
  readonly rates: TicketRates;
  /** Present only for abstain cases; `null` everywhere else. */
  readonly abstention: AbstentionResult | null;
  readonly cost: CostSummary;
  readonly pass: ScenarioPass;
}

/** The core-10 gate: ≥ 8 of 10 scenarios and ≥ 5 of the 6 positives. */
export interface GateCounts {
  /** A backend's gate is at `detection` or `diagnosis`; `review_diagnosis` only counts a baseline. */
  readonly level: CountLevel;
  readonly backend: string;
  readonly scenarios: readonly string[];
  readonly passed: number;
  readonly total: number;
  readonly positivesPassed: number;
  readonly positivesTotal: number;
  readonly failed: readonly string[];
  /** Core-10 ids the run did not score at all; they count as failures. */
  readonly missing: readonly string[];
  readonly pass: boolean;
}

/** Everything one backend's scenarios add up to. */
export interface BackendSummary {
  readonly backend: string;
  readonly scenarios: number;
  readonly perFault: Readonly<Record<string, FaultScore>>;
  readonly precisionRecall: ByLevel<PrecisionRecall>;
  readonly leadTimes: readonly LeadTime[];
  readonly rates: TicketRates;
  readonly abstention: AbstentionResult;
  readonly cost: CostSummary;
  /** The ticket-level check: review level for a backend gated at detection, else ticket level. */
  readonly metropt3Check: Metropt3Check;
  /** The same four failures read at detection level, from the suspect events. */
  readonly metropt3Detection: Metropt3Check;
  readonly gate: GateCounts;
}

/** The `summary` block of `run.json`. */
export interface RunSummary {
  readonly backends: readonly BackendSummary[];
  readonly comparison: readonly ComparisonRow[];
  /** The gate of the headline backend; the others are in `backends[]`. */
  readonly gate: GateCounts;
  /** The headline backend's MetroPT-3 check, always `in_sample: true`. */
  readonly metropt3Check: Metropt3Check;
  /** The ten scenario ids the gate is counted over. */
  readonly core10: readonly string[];
}
