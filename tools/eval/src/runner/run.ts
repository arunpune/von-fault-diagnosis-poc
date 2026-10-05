// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The scenario loop: every scenario of a profile, replayed against every
// backend of the run, scored, and the run judged by the core-10 gate.
//
//   for scenario in profile order (or the --scenario list, or the --tuning list):
//     bound := load + bind
//     for backend in backends:
//       events  := host.run(bound, backend)      a fresh replay and pipeline
//       records := recorder.summarise(events)
//       scored  := metrics.scoreScenario(bound, records)
//       write scenarios/<id>.<backend>.jsonl
//   summary := metrics.summarise(every scored pair)
//   write run.json (schema-checked first), latest.json and report.md,
//   print the summary table, exit 0 or 2
//
// Six decisions sit in this file rather than in the libraries it composes.
//
// **Everything that can fail on configuration fails before the first row.**
// The scenarios are loaded and bound, their rows located, the catalog loaded
// and the backends built before anything is replayed, so a typo in a scenario
// or a slice nobody cut is an immediate error rather than the end of an hour.
// The tuning guard of `--tuning` (`src/tuning.ts`) runs there too.
//
// **Diagnostic scenarios are reported, never scored.** They are replayed
// and written like the others, and they have their own section in the report,
// but they stay out of the summary: their windows are unlabelled, so every
// ticket they produce would count as a false positive against the backend.
//
// **The headline backend is the one whose answer is informative.** The gate is
// counted per backend at its own level — rules at detection, Von at
// diagnosis — and the headline is Von only when Von ran live or from
// cassettes. A mock Von column is "not informative", so a run with the mock
// is judged on the rules baseline, which is exactly E3's reading of
// `--backends rules,von --fail-on-gate` (docs/evaluation.md).
//
// **A backend whose every decision failed answered nothing, and says so.** Its
// column is not informative either, and when it is the headline backend the
// gate is `not_scored` — never a pass, never a FAIL that reads like the
// model's verdict — with nothing counted as scored. The run was asked about
// that backend, so it does not fall back to the rules baseline the way a mock
// run does. A backend with some failed decisions is scored on the rest, and
// the reports and the log name its failures and their reasons.
//
// **A run that scored part of the ten cannot pass by omission, nor fail by it.**
// The gate is ≥ 8 of the core-10 and ≥ 5 of its 6 positives, with an
// unscored scenario counted as failed. A profile that replays a subset — the
// smoke profile, a `--scenario` list — is judged on whether the gate is still
// *attainable*: it fails only when the scenarios it did score already rule the
// gate out. A complete run is judged by the rule itself.
//
// **`--exit-eval e3` checks every E3 condition the run can see, and names the
// ones it cannot.** `--fail-on-gate` enforces the core-10 counts and nothing
// else. E3 gates the rules layer's detection, not its diagnosis: the core-10
// counts and the MetroPT-3 check 4/4 are read at detection level — a
// suspect event in each positive's credited span within its budget — the
// normal-operation negatives raise no suspect event, and the abstain cases keep
// their ticket rules (no non-benign ticket, and no ticket at all on the depot
// day). The rules backend's diagnosis figures — tickets naming an accepted
// fault — are computed beside the verdict as a recorded baseline and never
// change it. The check reads the rules backend only, because E3 is the
// rules-only exit eval, and it reads a scenario only when the run replayed its
// whole range: a smoke override or a scenario the run left out covers nothing,
// so the condition is `not_covered` and the verdict `incomplete` — never a
// pass. A ticket or a suspect event that breaks a condition is a fail wherever
// it was seen, the warmup included, because a replay is causal and a longer
// one would have raised it too.
//
// **A design target is read beside the run, never inside it.** A diagnostic
// scenario may carry one (`unlabelled_leak_may19`); each of its pairs gets a
// `DesignReading` in `designTargets`, and nothing that scores, gates or checks
// E3 reads it.

import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { loadFailureTable } from "@fdp/ground-truth";
import type { GtFailureTable } from "@fdp/ground-truth";

import { closeBackends, selectBackends as selectBackendsIn } from "../backends/select.ts";
import type { SelectDeps } from "../backends/select.ts";
import { allDecisionsFailed } from "../backends/types.ts";
import type { BackendHandle } from "../backends/types.ts";
import { EXIT_GATE_FAILED, EXIT_OK } from "../cli.ts";
import {
  ConfigError,
  TUNING_PROFILE,
  assertFinalHeldoutRun,
  gateFor,
  loadCatalog as loadCatalogIn,
} from "../config.ts";
import type {
  BackendName,
  CatalogSource,
  EvalCatalog,
  EvalConfig,
  EvalSecrets,
  GateThresholds,
} from "../config.ts";
import { FINAL_HELDOUT_FLAG, HELDOUT_PROFILE, HELDOUT_SEAL_FILE, isHeldout } from "../heldout.ts";
import { runId as makeRunId } from "../ids.ts";
import { createLogger } from "../log.ts";
import type { Logger } from "../log.ts";
import {
  CORE_10_POSITIVE_SCENARIO_IDS,
  MIN_POSITIVES,
  MIN_SCENARIOS,
  coreGate,
  designReading,
  metropt3Check,
  metropt3DetectionCheck,
  runMatch,
  scoreScenario,
  summarise as summariseRun,
} from "../metrics/index.ts";
import type {
  DesignReading,
  GateCounts,
  Metropt3Check,
  ScenarioBinding,
  SuspectRecord,
  TicketRecord,
} from "../metrics/index.ts";
import { alarmsEnabled, defaultAlarmRegistry } from "../replay/index.ts";
import type { AlarmRegistry } from "../replay/index.ts";
import { renderConsoleSummary } from "../report/console.ts";
import { eventLogName, writeEventLog } from "../report/events.ts";
import { buildRunReport, failureReasonsOf, writeRunJson } from "../report/json.ts";
import { writeMarkdownReport } from "../report/markdown.ts";
import { collectProvenance } from "../report/provenance.ts";
import type { Provenance } from "../report/provenance.ts";
import { bindScenario, inProfile, loadAll } from "../scenario/index.ts";
import type { BoundScenario, Profile, Scenario } from "../scenario/index.ts";
import { REPO_ROOT, requireSlice } from "../slices.ts";
import { parseIsoMs } from "../time.ts";
import { TUNING_BIND_PROFILE, selectTuning, sharedSlices } from "../tuning.ts";
import type { TuningReport } from "../tuning.ts";
import { createMonthTracker, fullRecordingSummary } from "./full.ts";
import { MissingCsvError, createFakeWallClock, runScenario as runScenarioIn } from "./host.ts";
import type { FakeWallClock, HostCatalog, HostConfig, HostOptions, ScenarioRun } from "./host.ts";
import { benignCauses, summarise } from "./recorder.ts";
import type {
  BackendRecord,
  E3ConditionId,
  E3CountsCheck,
  E3DiagnosisBaseline,
  E3Metropt3Check,
  E3NegativesCheck,
  E3ScenarioCheck,
  ExitEvalGap,
  ExitEvalResult,
  ExitEvalStatus,
  GateVerdict,
  JudgedGateKind,
  ReplayCoverage,
  RunResult,
  ScenarioResult,
} from "./types.ts";

/** The directory under a run's own that holds one event log per scenario and backend. */
export const SCENARIO_LOG_DIR = "scenarios";

/** The alarm types the default native reference is drawn from. */
const NATIVE_ALARM_TYPES: ReadonlySet<string> = new Set([
  "warning",
  "shutdown_warning",
  "shutdown",
]);

/** The one evaluable code left out of that default: a maintenance state, not a fault. */
const NATIVE_ALARM_EXCLUDED: ReadonlySet<string> = new Set(["W116"]);

/** How many directories a run id may be suffixed through before two runs are a real clash. */
const MAX_RUN_DIR_ATTEMPTS = 100;

/**
 * The abstention case E3 states apart: `depot_lps_jul31` opens no ticket at all, benign ones
 * included.
 */
export const E3_DEPOT_SCENARIO = "depot_lps_jul31";

/**
 * The dev-split negative E3 names beside the core-10 ones: E3 asks `frozen_logger_jun22`, a
 * normal-operation negative, to raise no suspect event too. A core run never replays it (it is
 * in the dev split), so E3 needs the second run of its recipe,
 * `--profile dev --scenario frozen_logger_jun22 --exit-eval e3`.
 */
export const E3_DEV_NEGATIVES: readonly string[] = ["frozen_logger_jun22"];

export type {
  BackendRecord,
  E3ConditionId,
  ExitEvalResult,
  ExitEvalStatus,
  GateVerdict,
  GateVerdictKind,
  JudgedGateKind,
  RunResult,
  ScenarioResult,
} from "./types.ts";

/** What a run reaches for; each seam defaults to the real thing and exists for the tests. */
export interface RunDeps {
  readonly log?: Logger;
  /** The real clock, for the run id and its wall stamps; never read by the pipeline. */
  readonly now?: () => Date;
  /** The fake wall clock every backend and pipeline of the run shares. */
  readonly wall?: FakeWallClock;
  readonly scenariosDir?: string;
  readonly loadCatalog?: (source: CatalogSource, secrets: EvalSecrets) => Promise<EvalCatalog>;
  readonly selectBackends?: (cfg: EvalConfig, deps: SelectDeps) => Promise<BackendHandle[]>;
  readonly runScenario?: (
    bound: BoundScenario,
    handle: BackendHandle,
    cfg: HostConfig,
    catalog: HostCatalog,
    options: HostOptions,
  ) => Promise<ScenarioRun>;
  /** Checks that a scenario's rows are on this machine; throws when they are not. */
  readonly requireRows?: (bound: BoundScenario, csvPath: string) => void;
}

/**
 * The scenarios a run replays: the profile's, narrowed to `--scenario` when it names any.
 *
 * @throws ConfigError when an id names no scenario, a held-out scenario under any profile but
 * `heldout`, or one outside the profile, whose replay range the profile would not define,
 * and when the selection is empty.
 */
export function selectScenarios(
  all: readonly Scenario[],
  profile: Profile,
  ids: readonly string[],
): Scenario[] {
  const inRun = all.filter((scenario) => inProfile(scenario, profile));
  const byId = new Map(all.map((scenario) => [scenario.id, scenario]));
  for (const id of ids) {
    const scenario = byId.get(id);
    if (scenario === undefined) throw new ConfigError("--scenario", `no scenario named '${id}'`);
    if (isHeldout(scenario) && profile !== HELDOUT_PROFILE) {
      throw new ConfigError(
        "--scenario",
        `'${id}' is a held-out scenario: it runs only in the held-out set's one final run, ` +
          `--profile ${HELDOUT_PROFILE} ${FINAL_HELDOUT_FLAG} (${HELDOUT_SEAL_FILE})`,
      );
    }
    if (!inProfile(scenario, profile)) {
      throw new ConfigError(
        "--scenario",
        `'${id}' is not in the ${profile} profile (it is in ${scenario.profiles.join(", ")})`,
      );
    }
  }
  const wanted = new Set(ids);
  const selected = ids.length === 0 ? inRun : inRun.filter((scenario) => wanted.has(scenario.id));
  if (selected.length === 0) {
    throw new ConfigError("--profile", `the ${profile} profile selects no scenario`);
  }
  return selected;
}

/** What a run replays, over which profile's replay ranges, and the tuning report if it is one. */
interface Selection {
  readonly scenarios: readonly Scenario[];
  readonly bindProfile: Profile;
  readonly tuning?: TuningReport;
}

/**
 * The run's scenarios: the tuning list after its guard under `--tuning`, else the profile's,
 * narrowed to `--scenario`. The held-out profile is selected only for its one final run
 * (`assertFinalHeldoutRun`), before anything is bound.
 *
 * @throws ConfigError from the held-out guard, the tuning guard or `selectScenarios`.
 */
function selectRun(
  cfg: EvalConfig,
  all: readonly Scenario[],
  headlineFailures: ReadonlySet<string>,
): Selection {
  assertFinalHeldoutRun(cfg);
  if (cfg.profile !== TUNING_PROFILE) {
    return {
      scenarios: selectScenarios(all, cfg.profile, cfg.scenarios),
      bindProfile: cfg.profile,
    };
  }
  const scenarios = selectTuning(all, headlineFailures);
  return {
    scenarios,
    bindProfile: TUNING_BIND_PROFILE,
    tuning: {
      scenarios: scenarios.map((scenario) => scenario.id),
      sharedSlices: sharedSlices(scenarios, all),
    },
  };
}

/** A bound scenario in the vocabulary `scoreScenario` reads. */
export function toBinding(bound: BoundScenario): ScenarioBinding {
  const { scenario } = bound;
  return {
    id: scenario.id,
    group: scenario.group,
    split: scenario.split,
    positive: scenario.positive,
    replay: bound.replay,
    warmupMin: scenario.warmup_min,
    windows: bound.windows,
    excluded: bound.excluded.map((window) => ({
      id: `${window.reason}@${window.from.toISOString()}`,
      from: window.from,
      to: window.to,
      reason: window.reason,
    })),
    benignFaultIds: bound.benignFaultIds,
    expect: {
      tickets: scenario.expect.tickets,
      fault: scenario.expect.fault,
      ...(scenario.expect.within_min === undefined
        ? {}
        : { withinMin: scenario.expect.within_min }),
      maxFalseTickets: scenario.expect.max_false_tickets,
      passLevel: scenario.expect.pass_level,
    },
  };
}

/**
 * The default native reference: every evaluable warning, shutdown warning and shutdown
 * of the registry the replay evaluates, W116 aside. A scenario's own `native_alarm_codes` wins.
 */
export function defaultNativeAlarmCodes(registry: AlarmRegistry | undefined): string[] {
  if (registry === undefined) return [];
  return registry.alarms
    .filter((alarm) => NATIVE_ALARM_TYPES.has(alarm.type) && !NATIVE_ALARM_EXCLUDED.has(alarm.code))
    .map((alarm) => alarm.code);
}

/**
 * The backend whose gate is the run's: Von when it ran live or from cassettes, else the rules
 * baseline, else whatever ran first.
 */
export function headlineBackend(
  backends: readonly Pick<BackendRecord, "name" | "mode">[],
): BackendName | undefined {
  const von = backends.find((backend) => backend.name === "von");
  if (von !== undefined && (von.mode === "live" || von.mode === "cassette")) return "von";
  if (backends.some((backend) => backend.name === "rules")) return "rules";
  return backends[0]?.name;
}

/**
 * Reads the core-10 gate for a complete or a partial run.
 *
 * A complete run passes exactly when `coreGate` says so. A partial one is `attainable` while the
 * scenarios it scored leave room for the thresholds — every unscored one counted as a pass it
 * could still be — and `unattainable` once they do not.
 */
export function judgeGate(counts: GateCounts): GateVerdict & { readonly verdict: JudgedGateKind } {
  const missing = new Set(counts.missing);
  const complete = missing.size === 0;
  const scoredFailed = counts.failed.filter((id) => !missing.has(id));
  const missingPositives = CORE_10_POSITIVE_SCENARIO_IDS.filter((id) => missing.has(id)).length;

  const attainable =
    counts.passed + missing.size >= MIN_SCENARIOS &&
    counts.positivesPassed + missingPositives >= MIN_POSITIVES;
  let verdict: JudgedGateKind;
  if (complete) verdict = counts.pass ? "pass" : "fail";
  else verdict = attainable ? "attainable" : "unattainable";

  return {
    counts,
    complete,
    verdict,
    pass: verdict === "pass" || verdict === "attainable",
    scoredFailed,
    scored: counts.total - missing.size,
    positivesScored: counts.positivesTotal - missingPositives,
  };
}

/**
 * The gate of a backend that answered nothing: every decision failed, so no core-10 scenario was
 * scored at all. Every one of them is missing, none passed and none failed, and the verdict is
 * `not_scored`, which `--fail-on-gate` does not take for a pass.
 */
export function notScoredGate(counts: GateCounts): GateVerdict {
  return {
    counts: {
      ...counts,
      passed: 0,
      positivesPassed: 0,
      failed: [],
      missing: [...counts.scenarios],
      pass: false,
    },
    complete: false,
    verdict: "not_scored",
    pass: false,
    scoredFailed: [],
    scored: 0,
    positivesScored: 0,
  };
}

/**
 * The run's gate: `judgeGate` over the headline backend's counts, or `notScoredGate` when every
 * decision of that backend failed.
 */
export function judgeRunGate(
  counts: GateCounts,
  backends: readonly Pick<BackendRecord, "name" | "stats">[],
): GateVerdict {
  const headline = backends.find((backend) => backend.name === counts.backend);
  if (headline !== undefined && allDecisionsFailed(headline.stats)) return notScoredGate(counts);
  return judgeGate(counts);
}

/** 0 when the run completed (and, under `--fail-on-gate`, the gate held), 2 otherwise. */
export function exitCodeFor(result: Pick<RunResult, "gate">, failOnGate: boolean): number {
  if (!failOnGate) return EXIT_OK;
  return result.gate?.pass === true ? EXIT_OK : EXIT_GATE_FAILED;
}

/**
 * The exit code of a whole run: `exitCodeFor`'s, then 2 when `--exit-eval` found a covered
 * condition broken. An `incomplete` exit eval changes nothing by itself.
 */
export function runExitCode(
  result: Pick<RunResult, "gate" | "exitEval">,
  failOnGate: boolean,
): number {
  const gate = exitCodeFor(result, failOnGate);
  if (gate !== EXIT_OK) return gate;
  return result.exitEval?.verdict === "fail" ? EXIT_GATE_FAILED : EXIT_OK;
}

// --- The E3 check -----------------------------------------------------------------

/** What the E3 check reads beside the run's own results. */
export interface E3Context {
  /** Every scenario file; the core-10 negatives are read from their split and `positive`. */
  readonly scenarios: readonly Scenario[];
  /** The failures the MetroPT-3 check must find: those the failure table marks `in_headline`. */
  readonly headlineFailureIds: ReadonlySet<string>;
}

/** The failures the MetroPT-3 check counts, by the failure table's own `in_headline` flag. */
export function headlineFailureIds(
  table: Pick<GtFailureTable, "failures"> = loadFailureTable(),
): ReadonlySet<string> {
  return new Set(
    table.failures.filter((failure) => failure.in_headline).map((failure) => failure.id),
  );
}

/**
 * The normal-operation negatives E3 asks to raise no suspect event: the core-10 scenarios
 * that are neither positive nor an abstain case — group `negative` — and then the dev negative
 * the exit eval names.
 */
export function e3Negatives(scenarios: readonly Scenario[]): string[] {
  const core = scenarios
    .filter(
      (scenario) =>
        scenario.split === "test" && !scenario.positive && scenario.group === "negative",
    )
    .map((scenario) => scenario.id);
  return [...core, ...E3_DEV_NEGATIVES];
}

/**
 * The core-10 cases E3 asks zero non-benign tickets of, the ticket rule they keep at detection
 * level: the test split's scenarios that are not positives and not normal-operation negatives —
 * the abstain cases — but the depot day, which has a stricter rule of its own.
 */
export function e3AbstainCases(scenarios: readonly Scenario[]): string[] {
  return scenarios
    .filter(
      (scenario) =>
        scenario.split === "test" && !scenario.positive && scenario.group !== "negative",
    )
    .map((scenario) => scenario.id)
    .filter((id) => id !== E3_DEPOT_SCENARIO);
}

/** Whether a run replayed a scenario over its own range, over part of it, or not at all. */
export function replayCoverage(result: ScenarioResult | undefined): ReplayCoverage {
  if (result === undefined) return "none";
  const { scenario, replay } = result.bound;
  const whole =
    replay.from.getTime() === parseIsoMs(scenario.replay.from).getTime() &&
    replay.to.getTime() === parseIsoMs(scenario.replay.to).getTime();
  return whole ? "whole" : "partial";
}

/** Every ticket the replay opened, the warmup's included, in opening order. */
function everyTicket(result: ScenarioResult): TicketRecord[] {
  return [...result.summary.tickets].sort(
    (left, right) =>
      left.openedSimTs.getTime() - right.openedSimTs.getTime() ||
      left.ticketId.localeCompare(right.ticketId),
  );
}

/**
 * The tickets that name a cause the scenario's ground truth does not call benign, whatever their
 * verdict: E3 asks the abstain cases to *produce* no such ticket, so one opened in the warmup or in
 * an excluded window counts, as it does in the smoke E2E's reading of the same words.
 */
function nonBenignTickets(result: ScenarioResult): TicketRecord[] {
  const benign = result.binding.benignFaultIds;
  return everyTicket(result).filter((ticket) => !benign.has(ticket.faultAtOpen));
}

/**
 * Every suspect event the replay raised, the warmup's and the excluded windows' included, in
 * time order: E3 asks a normal-operation negative to *raise* none, as it asks the abstain
 * cases to open no non-benign ticket, wherever it fell.
 */
function everySuspect(result: ScenarioResult): SuspectRecord[] {
  return [...(result.summary.suspectEvents ?? [])].sort(
    (left, right) =>
      left.simTs.getTime() - right.simTs.getTime() || left.eventId.localeCompare(right.eventId),
  );
}

/** What breaks one scenario of a condition: tickets, or suspect events. */
interface Breaking {
  readonly tickets?: (result: ScenarioResult) => TicketRecord[];
  readonly suspects?: (result: ScenarioResult) => SuspectRecord[];
}

/** One scenario of a condition: broken by anything `breaking` returns, else covered or not. */
function scenarioCheck(
  scenarioId: string,
  result: ScenarioResult | undefined,
  breaking: Breaking,
): E3ScenarioCheck {
  const replay = replayCoverage(result);
  const tickets =
    result === undefined || breaking.tickets === undefined ? [] : breaking.tickets(result);
  const suspects =
    result === undefined || breaking.suspects === undefined ? [] : breaking.suspects(result);
  let status: ExitEvalStatus = "not_covered";
  if (tickets.length > 0 || suspects.length > 0) status = "fail";
  else if (replay === "whole") status = "pass";
  return { scenarioId, status, replay, tickets, suspects };
}

/** One per-scenario condition over several scenarios. */
function scenariosCheck(checks: readonly E3ScenarioCheck[]): E3NegativesCheck {
  return { status: combined(checks.map((check) => check.status)), scenarios: checks };
}

/** Several statuses read as one: any failure fails, any gap leaves the whole uncovered. */
function combined(statuses: readonly ExitEvalStatus[]): ExitEvalStatus {
  if (statuses.includes("fail")) return "fail";
  return statuses.includes("not_covered") ? "not_covered" : "pass";
}

/**
 * The core-10 counts, read the way `--fail-on-gate` reads a partial run: a gate still attainable on
 * what was replayed is not covered, one already out of reach has failed.
 */
function countsCheck(whole: readonly ScenarioResult[]): E3CountsCheck {
  const gate = judgeGate(
    coreGate(
      whole.map((result) => result.metrics),
      "rules",
      "detection",
    ),
  );
  let status: ExitEvalStatus = "fail";
  if (gate.verdict === "pass") status = "pass";
  else if (gate.verdict === "attainable") status = "not_covered";
  return { status, gate };
}

/** The headline failures a MetroPT-3 check saw neither detected nor missed. */
function notReplayedOf(
  check: Pick<Metropt3Check, "detected" | "missed">,
  headline: ReadonlySet<string>,
): string[] {
  const seen = new Set([...check.detected, ...check.missed]);
  return [...headline].filter((id) => !seen.has(id)).sort();
}

/**
 * The MetroPT-3 check at detection level over the core-10 scenarios replayed whole — the
 * fixture slices of F1–F4 that E3 names: each failure needs a suspect event in its credited span
 * within its scenario's budget. A headline window of a dev scenario (`metropt3_full`,
 * `f4_precursor_jul14`) is not what E3 measures and is left out.
 */
function metropt3Condition(
  whole: readonly ScenarioResult[],
  headline: ReadonlySet<string>,
): E3Metropt3Check {
  const check = metropt3DetectionCheck(
    whole
      .filter((result) => result.bound.scenario.split === "test")
      .flatMap((result) => result.metrics.detection.windows),
  );
  const notReplayed = notReplayedOf(check, headline);
  let status: ExitEvalStatus = "not_covered";
  if (check.missed.length > 0) status = "fail";
  else if (check.pass && notReplayed.length === 0) status = "pass";
  return { status, check, notReplayed };
}

/**
 * The rules backend's diagnosis figures on the core-10 scenarios replayed whole — tickets naming
 * an accepted fault, at review diagnosis and at diagnosis, and the ticket-level MetroPT-3 check at
 * review-or-ticket level that E3 read before it moved to detection level. Reported, never part
 * of the verdict.
 */
function diagnosisBaseline(whole: readonly ScenarioResult[]): E3DiagnosisBaseline {
  const metrics = whole.map((result) => result.metrics);
  const core = whole
    .filter((result) => result.bound.scenario.split === "test")
    .map((result) => result.metrics);
  const match = runMatch(core, "review");
  return {
    reviewDiagnosis: coreGate(metrics, "rules", "review_diagnosis"),
    diagnosis: coreGate(metrics, "rules", "diagnosis"),
    metropt3Check: metropt3Check(match.windows, match, "review"),
  };
}

/**
 * Every condition of E3 as this run shows it, at detection level (docs/evaluation.md).
 *
 * @param results every scenario and backend pair of the run; only the rules pairs are read.
 * @returns each condition `pass`, `fail` or `not_covered` with its evidence, the verdict — `fail`
 * when a covered condition broke, `pass` only when all five were covered and held, and
 * `incomplete` otherwise, with what each uncovered condition would have needed — and the rules
 * backend's diagnosis baseline, which never changes the verdict.
 */
export function evaluateE3(results: readonly ScenarioResult[], context: E3Context): ExitEvalResult {
  const rules = new Map(
    results
      .filter((result) => result.run.backend === "rules")
      .map((result) => [result.bound.scenario.id, result]),
  );
  const whole = [...rules.values()].filter((result) => replayCoverage(result) === "whole");

  const core10Counts = countsCheck(whole);
  const metropt3 = metropt3Condition(whole, context.headlineFailureIds);
  const negativesNoSuspect = scenariosCheck(
    e3Negatives(context.scenarios).map((id) =>
      scenarioCheck(id, rules.get(id), { suspects: everySuspect }),
    ),
  );
  const abstainNonBenign = scenariosCheck(
    e3AbstainCases(context.scenarios).map((id) =>
      scenarioCheck(id, rules.get(id), { tickets: nonBenignTickets }),
    ),
  );
  const depotNoTicket = scenarioCheck(E3_DEPOT_SCENARIO, rules.get(E3_DEPOT_SCENARIO), {
    tickets: everyTicket,
  });
  const uncovered = (check: E3NegativesCheck) =>
    check.scenarios.filter((entry) => entry.status === "not_covered").map((c) => c.scenarioId);

  const read: readonly { id: E3ConditionId; status: ExitEvalStatus; missing: string[] }[] = [
    {
      id: "core10_counts",
      status: core10Counts.status,
      missing: [...core10Counts.gate.counts.missing],
    },
    { id: "metropt3_check", status: metropt3.status, missing: [...metropt3.notReplayed] },
    {
      id: "negatives_no_suspect",
      status: negativesNoSuspect.status,
      missing: uncovered(negativesNoSuspect),
    },
    {
      id: "abstain_non_benign",
      status: abstainNonBenign.status,
      missing: uncovered(abstainNonBenign),
    },
    { id: "depot_no_ticket", status: depotNoTicket.status, missing: [E3_DEPOT_SCENARIO] },
  ];
  const failed = read.filter((entry) => entry.status === "fail").map((entry) => entry.id);
  const notCovered: ExitEvalGap[] = read
    .filter((entry) => entry.status === "not_covered")
    .map((entry) => ({ condition: entry.id, missing: entry.missing }));

  let verdict: ExitEvalResult["verdict"] = "pass";
  if (failed.length > 0) verdict = "fail";
  else if (notCovered.length > 0) verdict = "incomplete";

  return {
    name: "e3",
    backend: "rules",
    verdict,
    failed,
    notCovered,
    conditions: {
      core10Counts,
      metropt3Check: metropt3,
      negativesNoSuspect,
      abstainNonBenign,
      depotNoTicket,
    },
    baseline: diagnosisBaseline(whole),
  };
}

/**
 * The design-target readings of a run: one per pair whose scenario carries a target, read
 * from the pair's scored tickets and its decisions inside the scenario's unlabelled episodes.
 * Beside the run's figures, never inside them: nothing that scores or gates reads the result.
 */
export function designTargets(results: readonly ScenarioResult[]): DesignReading[] {
  return results.flatMap((result) => {
    const target = result.bound.scenario.design_target;
    if (target === undefined) return [];
    return [
      designReading({
        scenarioId: result.bound.scenario.id,
        backend: result.run.backend,
        target,
        excluded: result.binding.excluded,
        tickets: result.metrics.tickets,
        decisions: result.summary.decisions,
        benignFaultIds: result.binding.benignFaultIds,
      }),
    ];
  });
}

/**
 * Fails when a scenario's rows are not on this machine: its slice is not cut, or the full CSV
 * `METROPT_CSV` names is absent.
 *
 * @throws MissingSliceError or MissingCsvError, both naming the command that fixes them.
 */
export function requireRowsOf(bound: BoundScenario, csvPath: string): void {
  if (bound.source.kind === "slice") {
    requireSlice(bound.source.name);
    return;
  }
  if (!existsSync(csvPath)) throw new MissingCsvError(csvPath);
}

/**
 * Creates the run's directory, suffixing the id when a run of the same second already owns it.
 *
 * @returns the id actually used and the absolute directory.
 */
export function allocateRunDir(outDir: string, runId: string): { id: string; dir: string } {
  mkdirSync(outDir, { recursive: true });
  for (let attempt = 1; attempt <= MAX_RUN_DIR_ATTEMPTS; attempt += 1) {
    const id = attempt === 1 ? runId : `${runId}-${attempt}`;
    const dir = join(outDir, id);
    try {
      mkdirSync(dir);
      return { id, dir };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`${outDir} already holds ${MAX_RUN_DIR_ATTEMPTS} runs named ${runId}`);
}

/**
 * A backend's state as it is recorded: a copy of its counters, not the live view. A mock column
 * is not informative, and neither is a backend whose every decision failed.
 */
export function backendRecord(handle: BackendHandle, thresholds?: GateThresholds): BackendRecord {
  const stats = { ...handle.stats };
  return {
    name: handle.name,
    model: handle.model,
    mode: handle.mode,
    informative: handle.mode !== "mock" && !allDecisionsFailed(stats),
    stats,
    ...(thresholds === undefined ? {} : { thresholds: { ...thresholds } }),
  };
}

/**
 * Says on the log, once the loop is over, which backend had failed decisions and why: the
 * reports say it too, but a failure that reaches only a file is easy to miss.
 */
function warnOnFailures(
  backends: readonly BackendRecord[],
  results: readonly ScenarioResult[],
  log: Logger,
): void {
  for (const backend of backends) {
    if (backend.stats.failures === 0) continue;
    const reasons = failureReasonsOf(
      results.filter((result) => result.run.backend === backend.name),
    );
    log.warn(
      allDecisionsFailed(backend.stats)
        ? "every decision of a backend failed: its column is not informative and its gate is not scored"
        : "decisions of a backend failed: they are missing from its figures",
      {
        backend: backend.name,
        mode: backend.mode,
        failed: backend.stats.failures,
        calls: backend.stats.calls,
        reasons: reasons.map((entry) => `${entry.reason} (${entry.count})`).join("; "),
      },
    );
  }
}

/** `--record` writes live answers only; say so when no backend of the run is live. */
function warnWhenNothingRecords(cfg: EvalConfig, handles: readonly BackendHandle[], log: Logger) {
  if (!cfg.record || handles.some((handle) => handle.mode === "live")) return;
  log.warn("--record has nothing to record: no backend of this run is live", {
    modes: handles.map((handle) => `${handle.name}:${handle.mode}`),
  });
}

/** What one pair needs beside the scenario and the backend. */
interface PairContext {
  readonly cfg: EvalConfig;
  readonly catalog: EvalCatalog;
  readonly nativeDefault: readonly string[];
  readonly wall: FakeWallClock;
  readonly runDir: string;
  readonly log: Logger;
  readonly runScenario: NonNullable<RunDeps["runScenario"]>;
}

/** Replays, records, scores and logs one scenario against one backend. */
async function runPair(
  bound: BoundScenario,
  handle: BackendHandle,
  context: PairContext,
): Promise<ScenarioResult> {
  const { cfg, catalog } = context;
  const { scenario } = bound;
  // The whole recording streams for a minute or more, so it reports each calendar month as it
  // closes; a slice is over in a second and needs no progress.
  const months =
    bound.source.kind === "csv"
      ? createMonthTracker(bound.replay, {
          log: context.log,
          fields: { scenario: scenario.id, backend: handle.name },
        })
      : undefined;
  const run = await context.runScenario(bound, handle, cfg, catalog, {
    wall: context.wall,
    ...(months === undefined ? {} : { onBatch: months.onBatch }),
  });
  months?.finish();
  const summary = summarise(run.events, benignCauses(catalog.entries, bound.benignFaultIds));
  const binding = toBinding(bound);
  const metrics = scoreScenario(
    binding,
    summary.tickets,
    summary.decisions,
    run.alarms,
    cfg.prices,
    {
      backend: handle.name,
      nativeAlarmCodes: scenario.native_alarm_codes ?? context.nativeDefault,
      reviewMin: gateFor(cfg, handle.name).reviewMin,
      suspects: summary.suspectEvents ?? [],
    },
  );

  const name = eventLogName(scenario.id, handle.name);
  writeEventLog(join(context.runDir, SCENARIO_LOG_DIR, name), run.events);

  context.log.info("scenario", {
    scenario: scenario.id,
    backend: handle.name,
    samples: run.stats.samples,
    samples_per_s: run.stats.samplesPerS === null ? null : Math.round(run.stats.samplesPerS),
    wall_ms: Math.round(run.stats.wallMs),
    decisions: run.stats.decisions,
    failed: summary.failedDecisions,
    usage: `${metrics.cost.input_tokens} in, ${metrics.cost.output_tokens} out`,
    cost_usd: metrics.cost.usd,
    detection: metrics.pass.detection,
    review_diagnosis: metrics.pass.reviewDiagnosis,
    diagnosis: metrics.pass.diagnosis,
  });

  return {
    bound,
    binding,
    run,
    summary,
    metrics,
    scored: scenario.group !== "diagnostic",
    eventLog: `${SCENARIO_LOG_DIR}/${name}`,
  };
}

/**
 * Runs every selected scenario against every backend of the configuration.
 *
 * @returns the scored results, the run summary and the gate; the event logs are written as the
 * loop goes, under `<outDir>/<run id>/scenarios/`.
 * @throws ConfigError for a selection, a flag or a backend this checkout cannot run;
 * ScenarioError, MissingSliceError, MissingCsvError or CatalogError when a scenario, its rows or
 * the catalog cannot be used; and whatever a pipeline push rejects with.
 */
export async function runEvaluation(cfg: EvalConfig, deps: RunDeps = {}): Promise<RunResult> {
  if (cfg.jobs !== 1) {
    throw new ConfigError(
      "--jobs",
      `${cfg.jobs} workers asked for, but the loop replays one scenario at a time`,
    );
  }
  const log = deps.log ?? createLogger();
  const now = deps.now ?? (() => new Date());
  const requireRows = deps.requireRows ?? requireRowsOf;
  const startedAt = now();

  const all = loadAll(deps.scenariosDir);
  const headlineFailures = headlineFailureIds();
  const selection = selectRun(cfg, all, headlineFailures);
  const bound = selection.scenarios.map((scenario) =>
    bindScenario(scenario, { profile: selection.bindProfile }),
  );
  for (const entry of bound) requireRows(entry, cfg.csvPath);

  const catalog = await (deps.loadCatalog ?? loadCatalogIn)(cfg.catalog, cfg.secrets);
  const alarmRegistry = alarmsEnabled() ? defaultAlarmRegistry() : undefined;
  const wall = deps.wall ?? createFakeWallClock();
  const handles = await (deps.selectBackends ?? selectBackendsIn)(cfg, { wall, log });

  try {
    warnWhenNothingRecords(cfg, handles, log);
    const { id, dir } = allocateRunDir(cfg.outDir, makeRunId(cfg.profile, startedAt));
    mkdirSync(join(dir, SCENARIO_LOG_DIR));
    log.info("run", { id, profile: cfg.profile, scenarios: bound.length, out: dir });

    const context: PairContext = {
      cfg,
      catalog,
      nativeDefault: defaultNativeAlarmCodes(alarmRegistry),
      wall,
      runDir: dir,
      log,
      runScenario: deps.runScenario ?? runScenarioIn,
    };
    const results: ScenarioResult[] = [];
    for (const entry of bound) {
      for (const handle of handles) results.push(await runPair(entry, handle, context));
    }

    const backends = handles.map((handle) => backendRecord(handle, gateFor(cfg, handle.name)));
    warnOnFailures(backends, results, log);
    const scored = results.filter((result) => result.scored).map((result) => result.metrics);
    const headline = headlineBackend(backends);
    const summary =
      scored.length === 0
        ? null
        : summariseRun(scored, headline === undefined ? {} : { headlineBackend: headline });
    const fullRecording = fullRecordingSummary(results);
    const design = designTargets(results);

    return {
      runId: id,
      runDir: dir,
      profile: cfg.profile,
      startedAt,
      finishedAt: now(),
      catalog,
      alarmRegistry,
      backends,
      results,
      summary,
      gate: summary === null ? null : judgeRunGate(summary.gate, backends),
      ...(selection.tuning === undefined ? {} : { tuning: selection.tuning }),
      ...(fullRecording.length === 0 ? {} : { fullRecording }),
      ...(design.length === 0 ? {} : { designTargets: design }),
      ...(cfg.exitEval === undefined
        ? {}
        : {
            exitEval: evaluateE3(results, {
              scenarios: all,
              headlineFailureIds: headlineFailures,
            }),
          }),
    };
  } finally {
    await closeBackends(handles);
  }
}

/** What writing a run's reports reaches for, beside the loop's own seams. */
export interface ExecuteDeps extends RunDeps {
  /** Where the summary table goes; stdout by default. */
  readonly stdout?: { write(chunk: string): unknown };
  /** The commit, the runtime and the ground-truth digests; read from the checkout by default. */
  readonly provenance?: () => Provenance;
}

/** A path inside the repository as the repository names it; any other path as it is. */
function shown(path: string): string {
  const inside = relative(REPO_ROOT, path);
  return inside.startsWith("..") || isAbsolute(inside) ? path : inside;
}

/**
 * One `fdp-eval run`: the loop, then `run.json` (validated before it is written), its copy
 * `latest.json`, `report.md` and the summary table on stdout.
 *
 * @returns the exit code: 0, or 2 when `--fail-on-gate` was given and the gate failed or
 * `--exit-eval` found a covered condition broken.
 * @throws whatever `runEvaluation` throws, and ReportSchemaError when the built report does not
 * match its schema, before any report file is written.
 */
export async function executeRun(cfg: EvalConfig, deps: ExecuteDeps = {}): Promise<number> {
  const result = await runEvaluation(cfg, deps);
  const report = buildRunReport({
    result,
    cfg,
    provenance: (deps.provenance ?? collectProvenance)(),
  });
  const { runJson } = writeRunJson(report, result.runDir, cfg.outDir);
  const reportMd = writeMarkdownReport(report, result.runDir);
  (deps.stdout ?? process.stdout).write(
    renderConsoleSummary(report, { runJson: shown(runJson), reportMd: shown(reportMd) }),
  );
  return runExitCode(result, cfg.failOnGate);
}
