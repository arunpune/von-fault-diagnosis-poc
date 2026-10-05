// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `run.json`: the run, turned into the document of `schemas/report.schema.json`
// and validated before a byte of it is written.
//
// The builder is a pure function of the run's records, its configuration and
// its provenance. It converts instants to ISO strings and the metrics
// library's camel case to the snake case every file of this package uses, and
// it picks fields rather than spreading objects, for the same reason the event
// log does: a record that grows a field does not grow the report with it
// until the schema says so. Nothing it reads carries a key, and the only
// trace of a decision's state is its `state_digest`.
//
// `latest.json` beside the run directories is a copy of the newest `run.json`,
// so a tool that wants "the last run" (the sweep, a CI artifact step) never
// has to list directories.

import _Ajv2020 from "ajv/dist/2020.js";
import type { AnySchemaObject, ErrorObject, ValidateFunction } from "ajv";
import _addFormats from "ajv-formats";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { allDecisionsFailed } from "../backends/types.ts";
import type { EvalConfig } from "../config.ts";
import type {
  AbstentionResult,
  CostSummary,
  DecisionRecord,
  DesignLevelReading,
  DesignReading,
  DetectionResult,
  ExcludedWindow,
  FaultScore,
  GateCounts,
  LeadTime,
  MatchResult,
  Metropt3Check,
  PrecisionRecall,
  RunSummary,
  ScoringWindow,
  SuspectRecord,
  TicketRates,
  TicketRecord,
} from "../metrics/index.ts";
import type { TimedOutput } from "../runner/host.ts";
import type {
  BackendRecord,
  E3ScenarioCheck,
  ExitEvalResult,
  FullRecordingResult,
  GateVerdict,
  RunResult,
  ScenarioResult,
} from "../runner/types.ts";
import type { TuningReport } from "../tuning.ts";
import type { Provenance } from "./provenance.ts";
import { REPORT_SCHEMA_ID } from "./types.ts";
import type {
  ReportAbstention,
  ReportBackend,
  ReportBackendSummary,
  ReportBaselineCounts,
  ReportCost,
  ReportDecision,
  ReportDesignLevel,
  ReportDesignReading,
  ReportDetection,
  ReportE3Metropt3,
  ReportE3Scenario,
  ReportExcluded,
  ReportExitEval,
  ReportFailureReason,
  ReportFaultScore,
  ReportFullRecording,
  ReportGate,
  ReportGateCounts,
  ReportLeadTime,
  ReportMatchCounts,
  ReportMetropt3Check,
  ReportPrecisionRecall,
  ReportRates,
  ReportRunInfo,
  ReportScenario,
  ReportSummary,
  ReportSuspect,
  ReportTicket,
  ReportTuning,
  ReportWindow,
  RunReport,
  TicketVerdict,
} from "./types.ts";

// ajv and ajv-formats ship CommonJS with a default export, which Node's ESM interop hands
// back as the module object itself. The casts restore the declared class and plugin types.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

/** Absolute path of the report schema. */
export const REPORT_SCHEMA_PATH: string = fileURLToPath(
  new URL("../../schemas/report.schema.json", import.meta.url),
);

/** The report inside a run's directory. */
export const RUN_JSON_NAME = "run.json";

/** The copy of the newest report beside the run directories. */
export const LATEST_JSON_NAME = "latest.json";

/** The configuration a report restates. */
export type ReportConfig = Pick<
  EvalConfig,
  | "scenarios"
  | "gate"
  | "decisionIntervalSimMin"
  | "episodeClearSimMin"
  | "persistSimMin"
  | "rulesDisabled"
  | "prices"
  | "seed"
  | "failOnGate"
>;

/** Everything a report is built from. */
export interface ReportInput {
  readonly result: RunResult;
  readonly cfg: ReportConfig;
  readonly provenance: Provenance;
}

/** A built report the schema refused: a defect of the builder, never of the run. */
export class ReportSchemaError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`run.json does not match ${REPORT_SCHEMA_ID}: ${issues.join("; ")}`);
    this.name = "ReportSchemaError";
    this.issues = issues;
  }
}

function compile(): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const document = JSON.parse(readFileSync(REPORT_SCHEMA_PATH, "utf8")) as AnySchemaObject;
  return ajv.compile(document);
}

const validator: ValidateFunction = compile();

function issues(errors: readonly ErrorObject[] | null | undefined): string[] {
  if (errors === null || errors === undefined) return ["/ is invalid"];
  return errors.map(
    (error) =>
      `${error.instancePath === "" ? "/" : error.instancePath} ${error.message ?? "is invalid"}`,
  );
}

/**
 * Checks a report document against `urn:fdp:eval:report:v1`.
 *
 * @throws ReportSchemaError listing every issue.
 */
export function validateReport(document: unknown): RunReport {
  if (validator(document)) return document as RunReport;
  throw new ReportSchemaError(issues(validator.errors));
}

// --- Conversions ---------------------------------------------------------------

function iso(value: Date): string {
  return value.toISOString();
}

function optionalIso(value: Date | undefined): string | null {
  return value === undefined ? null : value.toISOString();
}

function windowJson(window: ScoringWindow): ReportWindow {
  return {
    id: window.id,
    from: iso(window.from),
    to: iso(window.to),
    lead_from: iso(window.leadFrom),
    accepted: [...window.accepted],
    benign: window.benign,
    onset: optionalIso(window.onset),
    onset_known: window.onsetKnown,
    native_lps_first: optionalIso(window.nativeLpsFirst),
    headline: window.headline,
  };
}

function excludedJson(window: ExcludedWindow): ReportExcluded {
  return { id: window.id, from: iso(window.from), to: iso(window.to), reason: window.reason };
}

interface Classified {
  readonly verdict: TicketVerdict;
  readonly windowId: string | null;
}

/**
 * The outcome of every scored ticket, from the review-level classification, where every ticket
 * participates. A recovered ticket is also in `tp` and a misdiagnosed one also in `fp`, so the
 * more specific lists are read first.
 */
function classify(match: MatchResult): Map<string, Classified> {
  const found = new Map<string, Classified>();
  const put = (ticket: TicketRecord, verdict: TicketVerdict, windowId: string | null) => {
    if (!found.has(ticket.ticketId)) found.set(ticket.ticketId, { verdict, windowId });
  };
  for (const { ticket, window } of match.recovered) put(ticket, "recovered", window.id);
  for (const { ticket, window } of match.tp) put(ticket, "tp", window.id);
  for (const { ticket, window } of match.duplicates) put(ticket, "duplicate", window.id);
  for (const { ticket, window } of match.misdiagnosed) put(ticket, "misdiagnosed", window.id);
  for (const ticket of match.fp) put(ticket, "fp", null);
  for (const ticket of match.ignored) put(ticket, "ignored", null);
  for (const ticket of match.benign) put(ticket, "benign", null);
  return found;
}

function ticketJson(ticket: TicketRecord, classified: Classified): ReportTicket {
  return {
    ticket_id: ticket.ticketId,
    episode_id: ticket.episodeId,
    opened_sim_ts: iso(ticket.openedSimTs),
    fault_at_open: ticket.faultAtOpen,
    fault_latest: ticket.faultLatest,
    max_level: ticket.maxLevel,
    closed_sim_ts: optionalIso(ticket.closedSimTs),
    open_at_end: ticket.closedSimTs === undefined,
    verdict: classified.verdict,
    window_id: classified.windowId,
  };
}

/**
 * Every ticket of the pair in opening order: the scored ones with their verdict, the ones the
 * warmup swallowed as `warmup`.
 *
 * @throws Error when a scored ticket has no review-level outcome, which would mean the match
 * and the ticket list disagree.
 */
function ticketsJson(result: ScenarioResult): ReportTicket[] {
  const { metrics } = result;
  const classified = classify(metrics.match.review);
  const scored = metrics.tickets.map((ticket) => {
    const outcome = classified.get(ticket.ticketId);
    if (outcome === undefined) {
      throw new Error(
        `${metrics.scenarioId}: ticket ${ticket.ticketId} has no review-level outcome`,
      );
    }
    return ticketJson(ticket, outcome);
  });
  const warmup = metrics.warmupTickets.map((ticket) =>
    ticketJson(ticket, { verdict: "warmup", windowId: null }),
  );
  return [...warmup, ...scored].sort(
    (left, right) =>
      left.opened_sim_ts.localeCompare(right.opened_sim_ts) ||
      left.ticket_id.localeCompare(right.ticket_id),
  );
}

/** The digest of the state each decision saw, from the decision messages of the event log. */
function stateDigests(events: readonly TimedOutput[]): Map<string, string> {
  const digests = new Map<string, string>();
  for (const event of events) {
    if (event.type === "decision") {
      digests.set(event.decision.decision_id, event.decision.state_digest);
    }
  }
  return digests;
}

function decisionJson(decision: DecisionRecord, digests: Map<string, string>): ReportDecision {
  return {
    decision_id: decision.decisionId,
    episode_id: decision.episodeId,
    sim_ts: iso(decision.simTs),
    choice: decision.choice,
    confidence: decision.confidence,
    gate: decision.gate,
    abstained: decision.abstained,
    benign_choice: decision.benignChoice,
    usage: {
      input_tokens: decision.usage.input_tokens,
      output_tokens: decision.usage.output_tokens,
    },
    backend: decision.backend,
    state_digest: digests.get(decision.decisionId) ?? null,
    ...(decision.persistedSimMin === undefined
      ? {}
      : { persisted_sim_min: decision.persistedSimMin }),
  };
}

function decisionsSummaryJson(result: ScenarioResult): ReportScenario["decisions_summary"] {
  const { decisions, failedDecisions } = result.summary;
  const byChoice: Record<string, number> = {};
  const byGate = { ticket: 0, review: 0, log: 0 };
  for (const decision of decisions) {
    byChoice[decision.choice] = (byChoice[decision.choice] ?? 0) + 1;
    byGate[decision.gate] += 1;
  }
  return {
    count: decisions.length,
    failed: failedDecisions,
    abstained: decisions.filter((decision) => decision.abstained).length,
    by_choice: byChoice,
    by_gate: byGate,
  };
}

function faultScoreJson(score: FaultScore): ReportFaultScore {
  return {
    tp: score.tp,
    fp: score.fp,
    fn: score.fn,
    windows: score.windows,
    precision: score.precision,
    recall: score.recall,
  };
}

function precisionRecallJson(result: PrecisionRecall): ReportPrecisionRecall {
  return {
    level: result.level,
    per_fault: Object.fromEntries(
      Object.entries(result.perFault).map(([fault, score]) => [fault, faultScoreJson(score)]),
    ),
    micro: faultScoreJson(result.micro),
    macro: {
      precision: result.macro.precision,
      recall: result.macro.recall,
      precision_faults: result.macro.precisionFaults,
      recall_faults: result.macro.recallFaults,
    },
  };
}

function matchCountsJson(match: MatchResult): ReportMatchCounts {
  return {
    tp: match.tp.length,
    fp: match.fp.length,
    fn: match.fn.length,
    misdiagnosed: match.misdiagnosed.length,
    recovered: match.recovered.length,
    duplicates: match.duplicates.length,
    ignored: match.ignored.length,
    benign: match.benign.length,
  };
}

function leadTimeJson(lead: LeadTime): ReportLeadTime {
  return {
    window_id: lead.windowId,
    fault: lead.fault,
    first_correct_ticket: iso(lead.firstCorrectTicket),
    native_code: lead.nativeCode ?? null,
    native_first: optionalIso(lead.nativeFirst),
    lead_minutes: lead.leadMinutes ?? null,
    lps_first: optionalIso(lead.lpsFirst),
    lps_lead_minutes: lead.lpsLeadMinutes ?? null,
    latency_minutes: lead.latencyMinutes,
    qualifier: lead.qualifier,
  };
}

function ratesJson(rates: TicketRates): ReportRates {
  return {
    tickets: rates.tickets,
    false_tickets: rates.falseTickets,
    covered_machine_days: rates.coveredMachineDays,
    negative_machine_days: rates.negativeMachineDays,
    tickets_per_machine_day: rates.ticketsPerMachineDay,
    false_tickets_per_machine_day: rates.falseTicketsPerMachineDay,
  };
}

function abstentionJson(result: AbstentionResult): ReportAbstention {
  return {
    correct: result.correct,
    total: result.total,
    accuracy: result.accuracy,
    decisions: result.decisions,
    explicit: result.explicit,
    explicit_rate: result.explicitRate,
    cases: result.cases.map((entry) => ({
      id: entry.id,
      correct: entry.correct,
      reasons: [...entry.reasons],
    })),
  };
}

function costJson(cost: CostSummary): ReportCost {
  return {
    backend: cost.backend,
    usd: cost.usd,
    input_tokens: cost.input_tokens,
    output_tokens: cost.output_tokens,
    calls: cost.calls,
    per_decision: cost.perDecision,
    per_ticket: cost.perTicket,
    prices: {
      input_per_mtok: cost.prices.inputPerMtok,
      output_per_mtok: cost.prices.outputPerMtok,
      as_of: cost.prices.asOf,
    },
  };
}

function metropt3Json(check: Metropt3Check): ReportMetropt3Check {
  return {
    level: check.level,
    detected: [...check.detected],
    missed: [...check.missed],
    pass: check.pass,
    in_sample: true,
  };
}

function suspectJson(suspect: SuspectRecord): ReportSuspect {
  return {
    event_id: suspect.eventId,
    sim_ts: iso(suspect.simTs),
    symptom_key: suspect.symptomKey,
  };
}

function detectionJson(detection: DetectionResult): ReportDetection {
  return {
    suspects: detection.suspects,
    warmup_suspects: detection.warmupSuspects,
    outside_windows: detection.outsideWindows,
    windows: detection.windows.map((window) => ({
      window_id: window.windowId,
      headline: window.headline,
      first_suspect: window.first === undefined ? null : suspectJson(window.first),
      deadline: optionalIso(window.deadline),
      detected: window.detected,
    })),
  };
}

/**
 * A backend's gate level as `run.json` writes it: a backend is gated at detection or diagnosis;
 * review diagnosis is only ever a baseline count, which `exit_eval.baseline` writes.
 *
 * @throws Error on a gate at review diagnosis, which no summary builds.
 */
function gateLevel(gate: GateCounts): ReportGateCounts["level"] {
  if (gate.level === "review_diagnosis") {
    throw new Error(`${gate.backend}: a backend's gate is never at review diagnosis`);
  }
  return gate.level;
}

function gateCountsJson(gate: GateCounts): ReportGateCounts {
  return {
    backend: gate.backend,
    level: gateLevel(gate),
    scenarios: [...gate.scenarios],
    passed: gate.passed,
    total: gate.total,
    positives_passed: gate.positivesPassed,
    positives_total: gate.positivesTotal,
    failed: [...gate.failed],
    missing: [...gate.missing],
    pass: gate.pass,
  };
}

function scenarioJson(result: ScenarioResult): ReportScenario {
  const { bound, binding, run, summary, metrics } = result;
  const { scenario } = bound;
  const digests = stateDigests(run.events);
  return {
    id: scenario.id,
    title: scenario.title,
    group: scenario.group,
    split: scenario.split,
    positive: scenario.positive,
    backend: run.backend,
    model: run.model,
    mode: run.mode,
    seed: run.seed,
    scored: result.scored,
    expect: {
      tickets: scenario.expect.tickets,
      fault: scenario.expect.fault,
      within_min: scenario.expect.within_min ?? null,
      max_false_tickets: scenario.expect.max_false_tickets,
      pass_level: scenario.expect.pass_level,
    },
    replay: {
      from: iso(bound.replay.from),
      to: iso(bound.replay.to),
      samples: run.stats.samples,
      batches: run.stats.batches,
      discontinuities: run.stats.discontinuities,
      covered_machine_days: metrics.rates.coveredMachineDays,
      negative_machine_days: metrics.rates.negativeMachineDays,
    },
    warmup_min: scenario.warmup_min,
    events_file: result.eventLog,
    windows: binding.windows.map(windowJson),
    excluded: binding.excluded.map(excludedJson),
    benign_fault_ids: [...binding.benignFaultIds].sort(),
    ...(scenario.design_target === undefined
      ? {}
      : {
          design_target: {
            accepted: [...scenario.design_target.accepted],
            provenance: scenario.design_target.provenance,
          },
        }),
    tickets: ticketsJson(result),
    suspect_events: (summary.suspectEvents ?? []).map(suspectJson),
    decisions: summary.decisions.map((decision) => decisionJson(decision, digests)),
    decisions_summary: decisionsSummaryJson(result),
    suspects: summary.suspects,
    episodes: { ...summary.episodes },
    alarms: {
      raised: run.alarms.length,
      first_by_code: run.firstAlarms.map((alarm) => ({
        code: alarm.code,
        sim_ts: iso(alarm.simTs),
      })),
    },
    metrics: {
      match: {
        ticket: matchCountsJson(metrics.match.ticket),
        review: matchCountsJson(metrics.match.review),
      },
      precision_recall: {
        ticket: precisionRecallJson(metrics.precisionRecall.ticket),
        review: precisionRecallJson(metrics.precisionRecall.review),
      },
      lead_times: metrics.leadTimes.map(leadTimeJson),
      rates: ratesJson(metrics.rates),
      abstention: metrics.abstention === null ? null : abstentionJson(metrics.abstention),
      cost: costJson(metrics.cost),
      detection: detectionJson(metrics.detection),
    },
    pass: {
      detection: metrics.pass.detection,
      review_diagnosis: metrics.pass.reviewDiagnosis,
      diagnosis: metrics.pass.diagnosis,
      reasons: [...metrics.pass.reasons],
    },
  };
}

/**
 * Why the failed decisions of some scenario runs failed, as `<kind>: <message>` with a count,
 * most frequent first. The message is the backend's own sentence, never a provider body.
 */
export function failureReasonsOf(
  results: readonly Pick<ScenarioResult, "summary">[],
): ReportFailureReason[] {
  const counts = new Map<string, number>();
  for (const result of results) {
    for (const [reason, count] of Object.entries(result.summary.failureReasons ?? {})) {
      counts.set(reason, (counts.get(reason) ?? 0) + count);
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function backendJson(backend: BackendRecord, results: readonly ScenarioResult[]): ReportBackend {
  const { stats } = backend;
  return {
    name: backend.name,
    model: backend.model,
    mode: backend.mode,
    informative: backend.informative,
    calls: stats.calls,
    failures: stats.failures,
    failure_reasons: failureReasonsOf(
      results.filter((result) => result.run.backend === backend.name),
    ),
    cassette_hits: stats.cassetteHits ?? 0,
    cassette_misses: stats.cassetteMisses,
    cassette_miss_digests: [...(stats.cassetteMissDigests ?? [])],
    cassette_reused: stats.cassetteReused ?? 0,
    ...(stats.cassetteResample === undefined ? {} : { cassette_resample: stats.cassetteResample }),
    ...(stats.cassetteAnswersMax === undefined
      ? {}
      : { cassette_answers_max: stats.cassetteAnswersMax }),
    ...(backend.thresholds === undefined
      ? {}
      : {
          thresholds: {
            ticket_min: backend.thresholds.ticketMin,
            review_min: backend.thresholds.reviewMin,
          },
        }),
    rate_limit:
      stats.rateLimit === undefined
        ? null
        : {
            calls: stats.rateLimit.calls,
            retries: stats.rateLimit.retries,
            waited_ms: stats.rateLimit.waitedMs,
          },
  };
}

function summaryJson(summary: RunSummary): ReportSummary {
  return {
    headline_backend: summary.gate.backend,
    core10: [...summary.core10],
    backends: summary.backends.map((backend): ReportBackendSummary => ({
      backend: backend.backend,
      scenarios: backend.scenarios,
      precision_recall: {
        ticket: precisionRecallJson(backend.precisionRecall.ticket),
        review: precisionRecallJson(backend.precisionRecall.review),
      },
      lead_times: backend.leadTimes.map(leadTimeJson),
      rates: ratesJson(backend.rates),
      abstention: abstentionJson(backend.abstention),
      cost: costJson(backend.cost),
      metropt3_check: metropt3Json(backend.metropt3Check),
      metropt3_detection: metropt3Json(backend.metropt3Detection),
      gate: gateCountsJson(backend.gate),
    })),
    comparison: summary.comparison.map((row) => ({
      metric: row.metric,
      rules: row.rules,
      von: row.von,
      llm: row.llm ?? null,
      delta: row.delta,
      lower_is_better: row.lowerIsBetter,
    })),
    metropt3_check: metropt3Json(summary.metropt3Check),
  };
}

/**
 * `n/10` of one backend's gate at the level its name promises, or `null` when it did not run or
 * every one of its decisions failed, which leaves nothing of it to count.
 */
function core10Count(
  summary: RunSummary,
  backends: readonly BackendRecord[],
  backend: string,
  level: GateCounts["level"],
): string | null {
  const record = backends.find((entry) => entry.name === backend);
  if (record !== undefined && allDecisionsFailed(record.stats)) return null;
  const gate = summary.backends.find((entry) => entry.backend === backend)?.gate;
  if (gate?.level !== level) return null;
  return `${gate.passed}/${gate.total}`;
}

function gateJson(
  verdict: GateVerdict,
  summary: RunSummary,
  enforced: boolean,
  backends: readonly BackendRecord[],
): ReportGate {
  const { counts } = verdict;
  return {
    backend: counts.backend,
    level: gateLevel(counts),
    enforced,
    complete: verdict.complete,
    verdict: verdict.verdict,
    pass: verdict.pass,
    passed: counts.passed,
    scored: verdict.scored,
    total: counts.total,
    positives_passed: counts.positivesPassed,
    positives_scored: verdict.positivesScored,
    positives_total: counts.positivesTotal,
    failed: [...verdict.scoredFailed],
    missing: [...counts.missing],
    core10: {
      rules_detection: core10Count(summary, backends, "rules", "detection"),
      von_diagnosis: core10Count(summary, backends, "von", "diagnosis"),
    },
  };
}

/**
 * One scenario of an E3 condition, its tickets written exactly as the rules pair's own entry in
 * `scenarios[]` writes them, so the verdict the condition shows is the one the report prints.
 *
 * @throws Error when the condition names a ticket the pair does not report, which would mean the
 * check and the report read two different runs.
 */
function e3ScenarioJson(
  check: E3ScenarioCheck,
  results: readonly ScenarioResult[],
): ReportE3Scenario {
  const pair = results.find(
    (result) => result.run.backend === "rules" && result.bound.scenario.id === check.scenarioId,
  );
  const reported = new Map(
    (pair === undefined ? [] : ticketsJson(pair)).map((ticket) => [ticket.ticket_id, ticket]),
  );
  return {
    scenario: check.scenarioId,
    status: check.status,
    replay: check.replay,
    tickets: check.tickets.map((ticket) => {
      const entry = reported.get(ticket.ticketId);
      if (entry === undefined) {
        throw new Error(
          `${check.scenarioId}: E3 names ticket ${ticket.ticketId}, which no pair reports`,
        );
      }
      return entry;
    }),
    suspects: check.suspects.map(suspectJson),
  };
}

function e3Metropt3Json(check: Metropt3Check, notReplayed: readonly string[]): ReportE3Metropt3 {
  if (check.level === "ticket") throw new Error("E3 reads no MetroPT-3 check at ticket level");
  return {
    level: check.level,
    detected: [...check.detected],
    missed: [...check.missed],
    not_replayed: [...notReplayed],
    in_sample: true,
  };
}

function baselineCountsJson(
  counts: GateCounts,
  level: ReportBaselineCounts["level"],
): ReportBaselineCounts {
  return {
    level,
    passed: counts.passed,
    total: counts.total,
    positives_passed: counts.positivesPassed,
    positives_total: counts.positivesTotal,
    failed: counts.failed.filter((id) => !counts.missing.includes(id)),
    not_replayed: [...counts.missing],
  };
}

function exitEvalJson(
  exitEval: ExitEvalResult,
  results: readonly ScenarioResult[],
): ReportExitEval {
  const { core10Counts, metropt3Check, negativesNoSuspect, abstainNonBenign, depotNoTicket } =
    exitEval.conditions;
  const { counts } = core10Counts.gate;
  const { baseline } = exitEval;
  const baselineCheck = e3Metropt3Json(baseline.metropt3Check, [...metropt3Check.notReplayed]);
  return {
    name: exitEval.name,
    backend: exitEval.backend,
    verdict: exitEval.verdict,
    failed: [...exitEval.failed],
    not_covered: exitEval.notCovered.map((gap) => ({
      condition: gap.condition,
      missing: [...gap.missing],
    })),
    conditions: {
      core10_counts: {
        status: core10Counts.status,
        level: "detection",
        gate_verdict: core10Counts.gate.verdict,
        passed: counts.passed,
        total: counts.total,
        positives_passed: counts.positivesPassed,
        positives_total: counts.positivesTotal,
        failed: [...core10Counts.gate.scoredFailed],
        not_replayed: [...counts.missing],
      },
      metropt3_check: {
        status: metropt3Check.status,
        level: "detection",
        detected: [...metropt3Check.check.detected],
        missed: [...metropt3Check.check.missed],
        not_replayed: [...metropt3Check.notReplayed],
        in_sample: true,
      },
      negatives_no_suspect: {
        status: negativesNoSuspect.status,
        scenarios: negativesNoSuspect.scenarios.map((check) => e3ScenarioJson(check, results)),
      },
      abstain_non_benign: {
        status: abstainNonBenign.status,
        scenarios: abstainNonBenign.scenarios.map((check) => e3ScenarioJson(check, results)),
      },
      depot_no_ticket: e3ScenarioJson(depotNoTicket, results),
    },
    baseline: {
      gated: false,
      review_diagnosis: baselineCountsJson(baseline.reviewDiagnosis, "review_diagnosis"),
      diagnosis: baselineCountsJson(baseline.diagnosis, "diagnosis"),
      metropt3_check: { ...baselineCheck, level: "review" },
    },
  };
}

function designLevelJson(reading: DesignLevelReading): ReportDesignLevel {
  return {
    on_target: reading.onTarget,
    off_target: reading.offTarget,
    benign: reading.benign,
    outside: reading.outside,
    first:
      reading.first === undefined
        ? null
        : {
            ticket_id: reading.first.ticketId,
            opened_sim_ts: iso(reading.first.openedSimTs),
            fault_at_open: reading.first.faultAtOpen,
          },
    met: reading.met,
  };
}

/** One design-target reading as `run.json` writes it: apart from every figure, `gated: false`. */
export function designReadingJson(reading: DesignReading): ReportDesignReading {
  return {
    scenario: reading.scenarioId,
    backend: reading.backend,
    gated: false,
    accepted: [...reading.target.accepted],
    provenance: reading.target.provenance,
    episodes: reading.episodes.map((episode) => ({ from: iso(episode.from), to: iso(episode.to) })),
    review: designLevelJson(reading.review),
    ticket: designLevelJson(reading.ticket),
    decisions: {
      total: reading.decisions.total,
      on_target: reading.decisions.onTarget,
      by_choice: { ...reading.decisions.byChoice },
    },
  };
}

function fullRecordingJson(entry: FullRecordingResult): ReportFullRecording {
  return {
    scenario: entry.scenarioId,
    backend: entry.backend,
    replay: { from: iso(entry.replay.from), to: iso(entry.replay.to) },
    metropt3_check: {
      ticket: metropt3Json(entry.metropt3.ticket),
      review: metropt3Json(entry.metropt3.review),
    },
    false_tickets: { ticket: entry.falseTickets.ticket, review: entry.falseTickets.review },
    covered_machine_days: entry.coveredMachineDays,
    negative_machine_days: entry.negativeMachineDays,
    false_tickets_per_machine_day: {
      ticket: entry.falseTicketsPerMachineDay.ticket,
      review: entry.falseTicketsPerMachineDay.review,
    },
    unlabelled_detections: entry.unlabelled.map((detection) => ({
      ticket_id: detection.ticket.ticketId,
      opened_sim_ts: iso(detection.ticket.openedSimTs),
      fault_at_open: detection.ticket.faultAtOpen,
      max_level: detection.ticket.maxLevel,
      episode_from: iso(detection.episodeFrom),
      episode_to: iso(detection.episodeTo),
    })),
  };
}

function tuningJson(tuning: TuningReport): ReportTuning {
  return {
    scenarios: [...tuning.scenarios],
    shared_slices: tuning.sharedSlices.map((entry) => ({
      scenario: entry.scenario,
      slice: entry.slice,
      core10: [...entry.core10],
    })),
  };
}

function runInfo(input: ReportInput): ReportRunInfo {
  const { result, cfg, provenance } = input;
  const registry = result.alarmRegistry;
  return {
    id: result.runId,
    mode: result.mode ?? "in_process",
    profile: result.profile,
    scenario_filter: [...cfg.scenarios],
    started_wall_ts: iso(result.startedAt),
    finished_wall_ts: iso(result.finishedAt),
    git_sha: provenance.git_sha,
    node: provenance.node,
    backend_version: provenance.backend_version,
    ground_truth: { ...provenance.ground_truth },
    catalog: {
      source: result.catalog.source,
      name: result.catalog.name,
      sha256: result.catalog.sha256,
      entries: result.catalog.entries.length,
      faults: new Set(result.catalog.entries.map((entry) => entry.fault_id)).size,
    },
    alarm_registry:
      registry === undefined
        ? { source: "off", sha256: null }
        : { source: registry.source, sha256: registry.sha256 },
    thresholds: {
      ticket_min: cfg.gate.ticketMin,
      review_min: cfg.gate.reviewMin,
      decision_interval_sim_min: cfg.decisionIntervalSimMin,
      episode_clear_sim_min: cfg.episodeClearSimMin,
      persist_sim_min: cfg.persistSimMin,
    },
    rules_disabled: [...cfg.rulesDisabled],
    prices: {
      von_input_per_mtok: cfg.prices.vonInputPerMtok,
      llm_input_per_mtok: cfg.prices.llmInputPerMtok,
      llm_output_per_mtok: cfg.prices.llmOutputPerMtok,
      as_of: cfg.prices.asOf,
    },
    seed: cfg.seed ?? null,
  };
}

/** Builds `run.json` from a finished run; the result still has to pass `validateReport`. */
export function buildRunReport(input: ReportInput): RunReport {
  const { result, cfg } = input;
  const { summary, gate } = result;
  return {
    schema: REPORT_SCHEMA_ID,
    run: runInfo(input),
    backends: result.backends.map((backend) => backendJson(backend, result.results)),
    scenarios: result.results.map(scenarioJson),
    summary: summary === null ? null : summaryJson(summary),
    gate:
      summary === null || gate === null
        ? null
        : gateJson(gate, summary, cfg.failOnGate, result.backends),
    ...(result.tuning === undefined ? {} : { tuning: tuningJson(result.tuning) }),
    ...(result.exitEval === undefined
      ? {}
      : { exit_eval: exitEvalJson(result.exitEval, result.results) }),
    ...(result.fullRecording === undefined
      ? {}
      : { full_recording: result.fullRecording.map(fullRecordingJson) }),
    ...(result.designTargets === undefined
      ? {}
      : { design_targets: result.designTargets.map(designReadingJson) }),
  };
}

/** The report as text: two-space indentation and a final newline. */
export function renderRunJson(report: RunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Validates the report, writes it as `<runDir>/run.json` and copies it to `<outDir>/latest.json`.
 *
 * @returns the two paths written.
 * @throws ReportSchemaError before anything is written when the report does not validate.
 */
export function writeRunJson(
  report: RunReport,
  runDir: string,
  outDir: string,
): { readonly runJson: string; readonly latest: string } {
  validateReport(report);
  const runJson = join(runDir, RUN_JSON_NAME);
  const latest = join(outDir, LATEST_JSON_NAME);
  writeFileSync(runJson, renderRunJson(report), "utf8");
  copyFileSync(runJson, latest);
  return { runJson, latest };
}
