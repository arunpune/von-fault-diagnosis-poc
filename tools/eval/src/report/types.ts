// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `run.json`, as TypeScript.
//
// `schemas/report.schema.json` (`urn:fdp:eval:report:v1`) is the source of
// truth and these types are its hand-kept mirror, as `scenario/schema.ts` is
// for the scenario schema; `json.test.ts` keeps the two in step by validating
// a built report through the schema.
//
// The vocabulary is the one on disk everywhere else in this package: snake
// case, ISO instants, `null` for a figure with no denominator. The records a
// stored run needs to be re-scored — windows, excluded windows, the benign
// causes, every decision with its choice and confidence, the covered and
// negative machine-days — use the field names of `fixtures/metrics/`, so the
// threshold sweep reads a scenario of `run.json` the way the metrics
// tests read a hand-made run.
//
// Nothing here carries a key, a header, a raw provider body or the state a
// backend saw: a decision appears with its `state_digest` only.

/** The `schema` member every report repeats. */
export const REPORT_SCHEMA_ID = "urn:fdp:eval:report:v1";

/** How a figure with no denominator is written: `null`, never 0 or NaN. */
export type Ratio = number | null;

/** The dated prices a run was costed at (`PRICES_AS_OF` and the price variables). */
export interface ReportPrices {
  readonly jev_input_per_mtok: number;
  readonly llm_input_per_mtok: number;
  readonly llm_output_per_mtok: number;
  readonly as_of: string;
}

/** Which catalog the retriever ranked: its source, its name and its digest. */
export interface ReportCatalog {
  readonly source: "reference" | "file" | "ingested";
  /** `reference`, `file:<absolute path>` or `ingested`. */
  readonly name: string;
  readonly sha256: string;
  readonly entries: number;
  readonly faults: number;
}

/** The controller registry the replay evaluated; `off` when it evaluated none. */
export interface ReportAlarmRegistry {
  readonly source: "manual" | "provisional" | "off";
  readonly sha256: string | null;
}

/** Who and what produced the run. */
export interface ReportRunInfo {
  readonly id: string;
  /** `in_process` for `fdp-eval run`; `stack` is reserved for `score-stack`. */
  readonly mode: "in_process" | "stack";
  readonly profile: string;
  /** The `--scenario` ids; empty when the whole profile ran. */
  readonly scenario_filter: readonly string[];
  readonly started_wall_ts: string;
  readonly finished_wall_ts: string;
  readonly git_sha: string | null;
  readonly node: string;
  readonly backend_version: string;
  readonly ground_truth: {
    readonly package_version: string;
    readonly failures_sha256: string;
    readonly injections_sha256: string | null;
  };
  readonly catalog: ReportCatalog;
  readonly alarm_registry: ReportAlarmRegistry;
  readonly thresholds: {
    /** `GATE_TICKET_MIN_CONFIDENCE`; a backend with its own pair states it in `backends[]`. */
    readonly ticket_min: number;
    /** `GATE_REVIEW_MIN_CONFIDENCE`; a backend with its own pair states it in `backends[]`. */
    readonly review_min: number;
    readonly decision_interval_sim_min: number;
    readonly episode_clear_sim_min: number;
    /** `GATE_PERSIST_SIM_MIN`; absent from reports written before it existed. */
    readonly persist_sim_min?: number;
  };
  readonly rules_disabled: readonly string[];
  readonly prices: ReportPrices;
  /** `--seed`, or `null` when every scenario kept its own. */
  readonly seed: number | null;
}

/** The live queue's counters of one backend (`backends/ratelimit.ts`). */
export interface ReportRateLimit {
  /** Requests sent to the API, the runner's retries included. */
  readonly calls: number;
  /** Requests repeated after the SDK had given up on a 429 or a 529. */
  readonly retries: number;
  readonly waited_ms: number;
}

/** Why some of a backend's decisions failed: `<kind>: <message>`, and how many. */
export interface ReportFailureReason {
  readonly reason: string;
  readonly count: number;
}

/** One backend of the run, with its counters. */
export interface ReportBackend {
  readonly name: string;
  readonly model: string;
  readonly mode: "live" | "cassette" | "mock" | "-";
  /**
   * False for a mock column, whose answers say nothing about the model, and for a backend whose
   * every decision failed, which answered nothing.
   */
  readonly informative: boolean;
  readonly calls: number;
  readonly failures: number;
  /**
   * Why the failed decisions failed, most frequent first; empty when none did. Absent from a
   * report written before it existed.
   */
  readonly failure_reasons?: readonly ReportFailureReason[];
  /** Requests a cassette answered; 0 outside cassette mode. */
  readonly cassette_hits: number;
  /** Requests no cassette answered, which the mock answered instead; 0 outside cassette mode. */
  readonly cassette_misses: number;
  /** The request digest of every miss, in arrival order: what to re-record. */
  readonly cassette_miss_digests: readonly string[];
  /**
   * Hits past the last answer their cassette recorded, answered with that answer again: the
   * recording kept fewer answers of the request than the run asked for, so those decisions need
   * not be the live run's. 0 outside cassette mode; absent from a report written before it existed.
   */
  readonly cassette_reused?: number;
  /**
   * `--resample`: which rotation of each repeated request's recorded answers the cassette server
   * served; 0 is the recording's own order. Cassette mode only.
   */
  readonly cassette_resample?: number;
  /** The most recorded answers any cassette the run hit held: the resamples it can give. */
  readonly cassette_answers_max?: number;
  /**
   * The pair the gate applied to this backend's decisions (Jev has its own pair); absent from a
   * report written before it existed, where `run.thresholds` was every backend's.
   */
  readonly thresholds?: { readonly ticket_min: number; readonly review_min: number };
  /** The live queue's counters; `null` for a backend that is not live. */
  readonly rate_limit: ReportRateLimit | null;
}

/** A scoring window. */
export interface ReportWindow {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly lead_from: string;
  readonly accepted: readonly string[];
  readonly benign: boolean;
  readonly onset: string | null;
  readonly onset_known: boolean;
  readonly native_lps_first: string | null;
  readonly headline: boolean;
}

/** A stretch that counts neither as a positive nor as a negative. */
export interface ReportExcluded {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

/**
 * What became of one ticket, at review level (every ticket participates).
 *
 * The six scoring outcomes — `tp`, `fp`, `misdiagnosed`, `recovered` (a correct ticket
 * after a misdiagnosis of the same window), `ignored` (opened in an excluded window) and
 * `benign` — plus `duplicate` (a second correct ticket for a window already detected) and
 * `warmup` (opened before the warmup ended, replayed but never scored).
 */
export type TicketVerdict =
  "tp" | "recovered" | "duplicate" | "misdiagnosed" | "fp" | "ignored" | "benign" | "warmup";

/** One ticket, the unit of scoring. */
export interface ReportTicket {
  readonly ticket_id: string;
  readonly episode_id: string;
  readonly opened_sim_ts: string;
  readonly fault_at_open: string;
  readonly fault_latest: string;
  /** `review` while it sat in the review status, `ticket` once it was open. */
  readonly max_level: "review" | "ticket";
  readonly closed_sim_ts: string | null;
  readonly open_at_end: boolean;
  readonly verdict: TicketVerdict;
  /** The window it was scored against, for `tp`, `recovered`, `duplicate` and `misdiagnosed`. */
  readonly window_id: string | null;
}

/** One suspect event detection raised: what detection level is scored on. */
export interface ReportSuspect {
  readonly event_id: string;
  readonly sim_ts: string;
  readonly symptom_key: string;
}

/** One positive window read at detection level: its first suspect event in the credited span. */
export interface ReportWindowDetection {
  readonly window_id: string;
  readonly headline: boolean;
  /** The first suspect event after the warmup in `[span_from, to)`, or `null`. */
  readonly first_suspect: ReportSuspect | null;
  /** The budget's last instant, or `null` when the scenario states none. */
  readonly deadline: string | null;
  readonly detected: boolean;
}

/** A scenario's suspect events read at detection level. */
export interface ReportDetection {
  readonly suspects: number;
  readonly warmup_suspects: number;
  readonly outside_windows: number;
  readonly windows: readonly ReportWindowDetection[];
}

/** A design target as a scenario file states it: reported, never scored. */
export interface ReportDesignTarget {
  readonly accepted: readonly string[];
  readonly provenance: string;
}

/** One answered decision: what the sweep re-gates and what abstention is measured on. */
export interface ReportDecision {
  readonly decision_id: string;
  readonly episode_id: string;
  readonly sim_ts: string;
  readonly choice: string;
  readonly confidence: number;
  readonly gate: "ticket" | "review" | "log";
  readonly abstained: boolean;
  readonly benign_choice: boolean;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  readonly backend: string;
  /** The digest of the state the backend saw; the state itself never leaves the process. */
  readonly state_digest: string | null;
  /**
   * How long the episode's own symptom had fired without a break at the decision, in sim
   * minutes; the sweep never opens a ticket on a decision below `persist_sim_min`. Absent from a
   * report written before it existed.
   */
  readonly persisted_sim_min?: number;
}

/** Counters and ratios of one fault. */
export interface ReportFaultScore {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly windows: number;
  readonly precision: Ratio;
  readonly recall: Ratio;
}

/** Per-fault precision and recall with their aggregates, at one level. */
export interface ReportPrecisionRecall {
  readonly level: "ticket" | "review";
  readonly per_fault: Readonly<Record<string, ReportFaultScore>>;
  readonly micro: ReportFaultScore;
  readonly macro: {
    readonly precision: Ratio;
    readonly recall: Ratio;
    readonly precision_faults: number;
    readonly recall_faults: number;
  };
}

/** How many tickets fell in each outcome, at one level. */
export interface ReportMatchCounts {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly misdiagnosed: number;
  readonly recovered: number;
  readonly duplicates: number;
  readonly ignored: number;
  readonly benign: number;
}

/** The lead time and latency of one detected window. */
export interface ReportLeadTime {
  readonly window_id: string;
  readonly fault: string;
  readonly first_correct_ticket: string;
  readonly native_code: string | null;
  readonly native_first: string | null;
  /** Native alarm minus ticket, in minutes; positive means earlier than the controller. */
  readonly lead_minutes: Ratio;
  readonly lps_first: string | null;
  readonly lps_lead_minutes: Ratio;
  readonly latency_minutes: number;
  /** `>=` when the onset is a lower bound (F1). */
  readonly qualifier: "" | ">=";
}

/** Tickets and false tickets per machine-day. */
export interface ReportRates {
  readonly tickets: number;
  readonly false_tickets: number;
  readonly covered_machine_days: number;
  readonly negative_machine_days: number;
  readonly tickets_per_machine_day: Ratio;
  readonly false_tickets_per_machine_day: Ratio;
}

/** Abstention accuracy and the explicit rate beside it. */
export interface ReportAbstention {
  readonly correct: number;
  readonly total: number;
  readonly accuracy: Ratio;
  readonly decisions: number;
  readonly explicit: number;
  readonly explicit_rate: Ratio;
  readonly cases: readonly {
    readonly id: string;
    readonly correct: boolean;
    readonly reasons: readonly string[];
  }[];
}

/** What a scenario, a backend or a run cost. */
export interface ReportCost {
  readonly backend: string;
  readonly usd: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly calls: number;
  readonly per_decision: Ratio;
  readonly per_ticket: Ratio;
  readonly prices: {
    readonly input_per_mtok: number;
    readonly output_per_mtok: number;
    readonly as_of: string;
  };
}

/** The MetroPT-3 check, always labelled in-sample. */
export interface ReportMetropt3Check {
  /** A ticket level, or `detection`: a suspect event in the credited span within the budget. */
  readonly level: "ticket" | "review" | "detection";
  readonly detected: readonly string[];
  readonly missed: readonly string[];
  readonly pass: boolean;
  readonly in_sample: true;
}

/** One backend's core-10 gate, unscored scenarios counted as failed. */
export interface ReportGateCounts {
  readonly backend: string;
  readonly level: "detection" | "diagnosis";
  readonly scenarios: readonly string[];
  readonly passed: number;
  readonly total: number;
  readonly positives_passed: number;
  readonly positives_total: number;
  readonly failed: readonly string[];
  readonly missing: readonly string[];
  readonly pass: boolean;
}

/** One scenario replayed against one backend. */
export interface ReportScenario {
  readonly id: string;
  readonly title: string;
  readonly group: "recording_positive" | "injected" | "negative" | "abstain" | "diagnostic";
  readonly split: "dev" | "test" | "heldout";
  readonly positive: boolean;
  readonly backend: string;
  readonly model: string;
  readonly mode: "live" | "cassette" | "mock" | "-";
  readonly seed: number;
  /** False for a diagnostic scenario: reported here, never part of the summary. */
  readonly scored: boolean;
  readonly expect: {
    readonly tickets: "at_least_one" | "none";
    readonly fault: "accepted" | "injected" | "benign_or_none" | "any";
    readonly within_min: number | null;
    readonly max_false_tickets: number;
    readonly pass_level: "detection" | "diagnosis";
  };
  readonly replay: {
    readonly from: string;
    readonly to: string;
    readonly samples: number;
    readonly batches: number;
    readonly discontinuities: number;
    readonly covered_machine_days: number;
    readonly negative_machine_days: number;
  };
  readonly warmup_min: number;
  /** The event log, relative to the run directory. */
  readonly events_file: string;
  readonly windows: readonly ReportWindow[];
  readonly excluded: readonly ReportExcluded[];
  readonly benign_fault_ids: readonly string[];
  /** The scenario file's design target; reported beside the figures, never scored. */
  readonly design_target?: ReportDesignTarget;
  readonly tickets: readonly ReportTicket[];
  /**
   * Every suspect event the replay raised, warmup included, so detection level can be re-scored
   * from the report. Absent from a report written before suspect events were recorded.
   */
  readonly suspect_events?: readonly ReportSuspect[];
  readonly decisions: readonly ReportDecision[];
  readonly decisions_summary: {
    readonly count: number;
    readonly failed: number;
    readonly abstained: number;
    readonly by_choice: Readonly<Record<string, number>>;
    readonly by_gate: { readonly ticket: number; readonly review: number; readonly log: number };
  };
  readonly suspects: number;
  readonly episodes: {
    readonly opened: number;
    readonly merged: number;
    readonly closed: number;
    readonly aborted: number;
  };
  readonly alarms: {
    readonly raised: number;
    readonly first_by_code: readonly { readonly code: string; readonly sim_ts: string }[];
  };
  readonly metrics: {
    readonly match: { readonly ticket: ReportMatchCounts; readonly review: ReportMatchCounts };
    readonly precision_recall: {
      readonly ticket: ReportPrecisionRecall;
      readonly review: ReportPrecisionRecall;
    };
    readonly lead_times: readonly ReportLeadTime[];
    readonly rates: ReportRates;
    readonly abstention: ReportAbstention | null;
    readonly cost: ReportCost;
    /** The suspect events read at detection level; absent from an older report. */
    readonly detection?: ReportDetection;
  };
  readonly pass: {
    /**
     * The detection level (suspect events; the ticket rule for abstain cases). A report written
     * before E3 moved to detection level carries the ticket rule here, which `review_diagnosis`
     * names since.
     */
    readonly detection: boolean;
    /** The ticket rule at review-or-ticket level; absent from an older report. */
    readonly review_diagnosis?: boolean;
    readonly diagnosis: boolean;
    readonly reasons: readonly string[];
  };
}

/** One backend's scenarios pooled. */
export interface ReportBackendSummary {
  readonly backend: string;
  readonly scenarios: number;
  readonly precision_recall: {
    readonly ticket: ReportPrecisionRecall;
    readonly review: ReportPrecisionRecall;
  };
  readonly lead_times: readonly ReportLeadTime[];
  readonly rates: ReportRates;
  readonly abstention: ReportAbstention;
  readonly cost: ReportCost;
  readonly metropt3_check: ReportMetropt3Check;
  /** The same check at detection level; absent from an older report. */
  readonly metropt3_detection?: ReportMetropt3Check;
  readonly gate: ReportGateCounts;
}

/** One row of the rules-versus-Jev comparison; `delta` is Jev minus rules. */
export interface ReportComparisonRow {
  readonly metric: string;
  readonly rules: Ratio;
  readonly jev: Ratio;
  readonly llm: Ratio;
  readonly delta: Ratio;
  readonly lower_is_better: boolean;
}

/** The summary block: every scored pair pooled per backend, and the comparison. */
export interface ReportSummary {
  readonly headline_backend: string;
  readonly core10: readonly string[];
  readonly backends: readonly ReportBackendSummary[];
  readonly comparison: readonly ReportComparisonRow[];
  readonly metropt3_check: ReportMetropt3Check;
}

/** The headline backend's core-10 gate, as `--fail-on-gate` reads it. */
export interface ReportGate {
  readonly backend: string;
  readonly level: "detection" | "diagnosis";
  /** True when the run was started with `--fail-on-gate`. */
  readonly enforced: boolean;
  /** True when every core-10 scenario was scored. */
  readonly complete: boolean;
  /** `not_scored` when every decision of the backend failed: nothing was scored, nothing passed. */
  readonly verdict: "pass" | "fail" | "attainable" | "unattainable" | "not_scored";
  readonly pass: boolean;
  readonly passed: number;
  readonly scored: number;
  readonly total: number;
  readonly positives_passed: number;
  readonly positives_scored: number;
  readonly positives_total: number;
  /** Core-10 scenarios that were scored and failed. */
  readonly failed: readonly string[];
  /** Core-10 scenarios the run did not score. */
  readonly missing: readonly string[];
  /**
   * The two headline counts, `n/10`, or `null` for a backend that did not run or whose every
   * decision failed.
   */
  readonly core10: {
    readonly rules_detection: string | null;
    readonly jev_diagnosis: string | null;
  };
}

/** How one condition of an exit eval reads: shown to hold, shown to break, or not shown. */
export type ReportExitEvalStatus = "pass" | "fail" | "not_covered";

/** The five conditions of detection-level E3, as `run.json` names them. */
export type ReportE3Condition =
  | "core10_counts"
  | "metropt3_check"
  | "negatives_no_suspect"
  | "abstain_non_benign"
  | "depot_no_ticket";

/** One scenario an E3 condition reads. */
export interface ReportE3Scenario {
  readonly scenario: string;
  readonly status: ReportExitEvalStatus;
  /** How much of the scenario's own range the run replayed; only `whole` covers it. */
  readonly replay: "whole" | "partial" | "none";
  /** The tickets that break the condition, each as `scenarios[]` reports it, verdict included. */
  readonly tickets: readonly ReportTicket[];
  /** The suspect events that break the condition; empty for a condition read on tickets. */
  readonly suspects: readonly ReportSuspect[];
}

/** One core-10 count of the rules backend's diagnosis baseline: reported, never gated. */
export interface ReportBaselineCounts {
  readonly level: "review_diagnosis" | "diagnosis";
  readonly passed: number;
  readonly total: number;
  readonly positives_passed: number;
  readonly positives_total: number;
  readonly failed: readonly string[];
  readonly not_replayed: readonly string[];
}

/** A condition the run could not show, with the scenarios or failures it would have needed. */
export interface ReportExitEvalGap {
  readonly condition: ReportE3Condition;
  readonly missing: readonly string[];
}

/** The MetroPT-3 check an exit eval reads, with the failures no scenario of the run replayed. */
export interface ReportE3Metropt3 {
  readonly level: "detection" | "review";
  readonly detected: readonly string[];
  readonly missed: readonly string[];
  /** Headline failures no core-10 scenario of the run replayed whole. */
  readonly not_replayed: readonly string[];
  readonly in_sample: true;
}

/**
 * `--exit-eval e3`: every E3 condition as the run shows it, read from the rules backend, at
 * detection level: detection gated, the rules diagnosis a baseline.
 */
export interface ReportExitEval {
  readonly name: "e3";
  readonly backend: "rules";
  /** `pass` only when every condition was covered and held; `incomplete` is never a pass. */
  readonly verdict: "pass" | "fail" | "incomplete";
  readonly failed: readonly ReportE3Condition[];
  readonly not_covered: readonly ReportExitEvalGap[];
  readonly conditions: {
    /** The core-10 gate's counts at detection level over the scenarios replayed whole. */
    readonly core10_counts: {
      readonly status: ReportExitEvalStatus;
      readonly level: "detection";
      readonly gate_verdict: "pass" | "fail" | "attainable" | "unattainable";
      readonly passed: number;
      readonly total: number;
      readonly positives_passed: number;
      readonly positives_total: number;
      /** Core-10 scenarios replayed whole that failed. */
      readonly failed: readonly string[];
      /** Core-10 scenarios the run did not replay whole. */
      readonly not_replayed: readonly string[];
    };
    /** The MetroPT-3 check at detection level over the core-10 scenarios replayed whole. */
    readonly metropt3_check: ReportE3Metropt3 & {
      readonly status: ReportExitEvalStatus;
      readonly level: "detection";
    };
    /** No suspect event on the normal-operation negatives, the warmup included. */
    readonly negatives_no_suspect: {
      readonly status: ReportExitEvalStatus;
      readonly scenarios: readonly ReportE3Scenario[];
    };
    /** No non-benign ticket on the abstain cases but the depot day, the warmup included. */
    readonly abstain_non_benign: {
      readonly status: ReportExitEvalStatus;
      readonly scenarios: readonly ReportE3Scenario[];
    };
    readonly depot_no_ticket: ReportE3Scenario;
  };
  /**
   * The rules backend's diagnosis figures over the same scenarios — tickets naming an accepted
   * fault — recorded beside E3 and never part of its verdict.
   */
  readonly baseline: {
    readonly gated: false;
    readonly review_diagnosis: ReportBaselineCounts;
    readonly diagnosis: ReportBaselineCounts;
    readonly metropt3_check: ReportE3Metropt3 & { readonly level: "review" };
  };
}

/** A tuning scenario whose slice a core-10 scenario also replays: reported, never refused. */
export interface ReportSharedSlice {
  readonly scenario: string;
  readonly slice: string;
  readonly core10: readonly string[];
}

/** `--tuning`: the list the run replayed, and the slices it shares with the core-10. */
export interface ReportTuning {
  readonly scenarios: readonly string[];
  readonly shared_slices: readonly ReportSharedSlice[];
}

/** A ticket opened inside an unlabelled episode of the failure table. */
export interface ReportUnlabelledDetection {
  readonly ticket_id: string;
  readonly opened_sim_ts: string;
  readonly fault_at_open: string;
  readonly max_level: "review" | "ticket";
  readonly episode_from: string;
  readonly episode_to: string;
}

/** E6: what one backend's replay of the whole recording shows (`metropt3_full`). */
export interface ReportFullRecording {
  readonly scenario: string;
  readonly backend: string;
  readonly replay: { readonly from: string; readonly to: string };
  /** The MetroPT-3 check over the recording's headline windows, at both levels. */
  readonly metropt3_check: {
    readonly ticket: ReportMetropt3Check;
    readonly review: ReportMetropt3Check;
  };
  readonly false_tickets: { readonly ticket: number; readonly review: number };
  readonly covered_machine_days: number;
  readonly negative_machine_days: number;
  readonly false_tickets_per_machine_day: { readonly ticket: Ratio; readonly review: Ratio };
  /** Listed apart and never counted as false positives. */
  readonly unlabelled_detections: readonly ReportUnlabelledDetection[];
}

/** One backend's tickets at one level against a design target. */
export interface ReportDesignLevel {
  readonly on_target: number;
  readonly off_target: number;
  readonly benign: number;
  readonly outside: number;
  /** The first ticket at this level inside a design episode, or `null`. */
  readonly first: {
    readonly ticket_id: string;
    readonly opened_sim_ts: string;
    readonly fault_at_open: string;
  } | null;
  /** True when that first ticket names an accepted cause of the target. */
  readonly met: boolean;
}

/** One pair's reading of its scenario's design target: reported, never gated or counted. */
export interface ReportDesignReading {
  readonly scenario: string;
  readonly backend: string;
  readonly gated: false;
  readonly accepted: readonly string[];
  readonly provenance: string;
  readonly episodes: readonly { readonly from: string; readonly to: string }[];
  readonly review: ReportDesignLevel;
  readonly ticket: ReportDesignLevel;
  readonly decisions: {
    readonly total: number;
    readonly on_target: number;
    readonly by_choice: Readonly<Record<string, number>>;
  };
}

/** `run.json`. */
export interface RunReport {
  readonly schema: typeof REPORT_SCHEMA_ID;
  readonly run: ReportRunInfo;
  readonly backends: readonly ReportBackend[];
  readonly scenarios: readonly ReportScenario[];
  /** `null` when the run scored nothing. */
  readonly summary: ReportSummary | null;
  readonly gate: ReportGate | null;
  /** Present when the run was started with `--tuning`. */
  readonly tuning?: ReportTuning;
  /** Present when the run was started with `--exit-eval`. */
  readonly exit_eval?: ReportExitEval;
  /** Present when the run replayed the whole recording (the `full` profile, E6). */
  readonly full_recording?: readonly ReportFullRecording[];
  /** Present when a replayed scenario carries a design target; never gated or counted. */
  readonly design_targets?: readonly ReportDesignReading[];
}
