// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What one `fdp-eval run` produced, before any report is written.
//
// The loop in `run.ts` fills these records and the writers in `src/report/`
// read them. They live in a module of their own so that the dependency runs
// one way — the loop imports the writers, the writers import only these
// shapes — and no cycle forms between the two directories.

import type { BackendMode, BackendStats } from "../backends/types.ts";
import type {
  BackendName,
  EvalCatalog,
  ExitEvalName,
  GateThresholds,
  RunProfile,
} from "../config.ts";
import type {
  ByLevel,
  DesignReading,
  GateCounts,
  Metropt3Check,
  RunSummary,
  ScenarioBinding,
  ScenarioMetrics,
  SuspectRecord,
  TicketRecord,
} from "../metrics/index.ts";
import type { AlarmRegistry } from "../replay/index.ts";
import type { BoundScenario } from "../scenario/index.ts";
import type { TuningReport } from "../tuning.ts";
import type { ScenarioRun } from "./host.ts";
import type { ScenarioSummary } from "./recorder.ts";

/** One scenario replayed against one backend, scored. */
export interface ScenarioResult {
  readonly bound: BoundScenario;
  /** What the scorer read: the bound scenario in the metrics library's vocabulary. */
  readonly binding: ScenarioBinding;
  readonly run: ScenarioRun;
  readonly summary: ScenarioSummary;
  readonly metrics: ScenarioMetrics;
  /** False for a diagnostic scenario, which is reported but never enters the summary. */
  readonly scored: boolean;
  /** The event log, relative to the run directory. */
  readonly eventLog: string;
}

/** A backend of the run as it stood when the run ended. */
export interface BackendRecord {
  readonly name: BackendName;
  readonly model: string;
  readonly mode: BackendMode;
  /**
   * False for a mock column, whose answers say nothing about the model, and for a backend
   * whose every decision failed, which answered nothing at all.
   */
  readonly informative: boolean;
  readonly stats: BackendStats;
  /**
   * The pair the gate applied to this backend's decisions: Von's own or `GATE_*`. Absent from a
   * record built without a configuration.
   */
  readonly thresholds?: GateThresholds;
}

/** The two ways a complete run ends and the two ways a partial one does. */
export type JudgedGateKind = "pass" | "fail" | "attainable" | "unattainable";

/**
 * What the gate of a run reads: judged as `judgeGate` judges it, or `not_scored` when every
 * decision of the headline backend failed and there was nothing of the model's to judge.
 */
export type GateVerdictKind = JudgedGateKind | "not_scored";

/** The core-10 gate of the headline backend, read for a complete or a partial run. */
export interface GateVerdict {
  /** The counts `coreGate` produced, unscored scenarios counted as failed. */
  readonly counts: GateCounts;
  /** True when every core-10 scenario was scored. */
  readonly complete: boolean;
  readonly verdict: GateVerdictKind;
  /** What `--fail-on-gate` enforces: `pass`, or `attainable` on a partial run. */
  readonly pass: boolean;
  /** Core-10 scenarios that were scored and failed. */
  readonly scoredFailed: readonly string[];
  readonly scored: number;
  readonly positivesScored: number;
}

/** How one condition of an exit eval reads: shown to hold, shown to break, or not shown. */
export type ExitEvalStatus = "pass" | "fail" | "not_covered";

/** An exit eval's verdict: `pass` only when every condition was covered and held. */
export type ExitEvalVerdict = "pass" | "fail" | "incomplete";

/**
 * The five conditions of detection-level E3: the core-10 counts and the MetroPT-3 check at
 * detection level, no suspect event on the normal-operation negatives, and the abstain cases'
 * ticket rules — no non-benign ticket, and no ticket at all on the depot day.
 */
export type E3ConditionId =
  | "core10_counts"
  | "metropt3_check"
  | "negatives_no_suspect"
  | "abstain_non_benign"
  | "depot_no_ticket";

/** How much of a scenario's own replay range the run replayed. */
export type ReplayCoverage = "whole" | "partial" | "none";

/** One scenario an E3 condition reads, with the tickets or suspect events that decide it. */
export interface E3ScenarioCheck {
  readonly scenarioId: string;
  readonly status: ExitEvalStatus;
  readonly replay: ReplayCoverage;
  /**
   * The tickets that break the condition: non-benign ones on an abstain case, every one on the
   * depot; empty for a condition read on suspect events.
   */
  readonly tickets: readonly TicketRecord[];
  /**
   * The suspect events that break the condition: every one a normal-operation negative raised;
   * empty for a condition read on tickets.
   */
  readonly suspects: readonly SuspectRecord[];
}

/** The core-10 counts for the rules backend at detection level, over the scenarios replayed whole. */
export interface E3CountsCheck {
  readonly status: ExitEvalStatus;
  readonly gate: GateVerdict & { readonly verdict: JudgedGateKind };
}

/** The MetroPT-3 check at detection level over the core-10 scenarios replayed whole. */
export interface E3Metropt3Check {
  readonly status: ExitEvalStatus;
  readonly check: Metropt3Check;
  /** Headline failures no core-10 scenario of the run replayed whole. */
  readonly notReplayed: readonly string[];
}

/** One per-scenario condition over several scenarios: the negatives, or the abstain cases. */
export interface E3NegativesCheck {
  readonly status: ExitEvalStatus;
  readonly scenarios: readonly E3ScenarioCheck[];
}

/**
 * The rules backend's diagnosis figures on the scenarios the E3 check read: tickets naming an
 * accepted fault. Computed and reported beside E3 as a recorded baseline, never gated.
 */
export interface E3DiagnosisBaseline {
  /** The core-10 counted at review diagnosis, the ticket rule E3 read at ticket level. */
  readonly reviewDiagnosis: GateCounts;
  /** The core-10 counted at diagnosis level, E4's rule. */
  readonly diagnosis: GateCounts;
  /** The ticket-level MetroPT-3 check at review-or-ticket level, E3's earlier check. */
  readonly metropt3Check: Metropt3Check;
}

/** A condition the run could not show, with the scenarios or failures it would have needed. */
export interface ExitEvalGap {
  readonly condition: E3ConditionId;
  readonly missing: readonly string[];
}

/** Every E3 condition as one run shows it; read from the rules backend alone. */
export interface ExitEvalResult {
  readonly name: ExitEvalName;
  readonly backend: "rules";
  readonly verdict: ExitEvalVerdict;
  /** The conditions that were covered and broke, in the order of `E3ConditionId`. */
  readonly failed: readonly E3ConditionId[];
  readonly notCovered: readonly ExitEvalGap[];
  readonly conditions: {
    readonly core10Counts: E3CountsCheck;
    readonly metropt3Check: E3Metropt3Check;
    readonly negativesNoSuspect: E3NegativesCheck;
    readonly abstainNonBenign: E3NegativesCheck;
    readonly depotNoTicket: E3ScenarioCheck;
  };
  /** The rules backend's ticket figures: reported, never part of the verdict. */
  readonly baseline: E3DiagnosisBaseline;
}

/** One ticket opened inside an unlabelled episode of the failure table. */
export interface UnlabelledDetection {
  readonly ticket: TicketRecord;
  readonly episodeFrom: Date;
  readonly episodeTo: Date;
}

/** What the whole MetroPT-3 recording shows for one backend (E6, `src/runner/full.ts`). */
export interface FullRecordingResult {
  readonly scenarioId: string;
  readonly backend: string;
  readonly replay: { readonly from: Date; readonly to: Date };
  /** The MetroPT-3 check over the recording's headline windows, always in-sample. */
  readonly metropt3: ByLevel<Metropt3Check>;
  /** False positives, misdiagnoses included, as the scenario's own match counted them. */
  readonly falseTickets: ByLevel<number>;
  readonly coveredMachineDays: number;
  readonly negativeMachineDays: number;
  /** False tickets over the negative time; `null` when there is none. */
  readonly falseTicketsPerMachineDay: ByLevel<number | null>;
  /** Tickets opened inside an unlabelled episode: listed, never counted as false. */
  readonly unlabelled: readonly UnlabelledDetection[];
}

/** Everything one run produced, before any report is written. */
export interface RunResult {
  readonly runId: string;
  /** The absolute directory the run's files are written to. */
  readonly runDir: string;
  /** The profile, `tuning` for a `--tuning` run, or `stack` for `score-stack`. */
  readonly profile: RunProfile | "stack";
  /** How the pairs were produced: replayed in process (the default) or read from a stack. */
  readonly mode?: "in_process" | "stack";
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly catalog: EvalCatalog;
  /** The controller registry the replay evaluated, or `undefined` when none was. */
  readonly alarmRegistry: AlarmRegistry | undefined;
  readonly backends: readonly BackendRecord[];
  readonly results: readonly ScenarioResult[];
  /** `null` when the run scored nothing, which only a diagnostic-only selection can do. */
  readonly summary: RunSummary | null;
  readonly gate: GateVerdict | null;
  /** The tuning list and the slices it shares with the core-10; present on a `--tuning` run. */
  readonly tuning?: TuningReport;
  /** The `--exit-eval` check; absent when the run was started without the flag. */
  readonly exitEval?: ExitEvalResult;
  /** The whole-recording summary of E6; present when the run replayed `metropt3_full`. */
  readonly fullRecording?: readonly FullRecordingResult[];
  /**
   * One reading per pair whose scenario carries a design target: reported beside the run's
   * figures, never inside them. Absent when no replayed scenario carries one.
   */
  readonly designTargets?: readonly DesignReading[];
}
