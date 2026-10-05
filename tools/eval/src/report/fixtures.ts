// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// A hand-made run for the report tests: every ticket outcome, both backends,
// a mock column, a decision whose backend output carries a state and raw
// bodies that must never reach a file, and a diagnostic scenario; a second,
// rules-only one that carries the `--tuning` and `--exit-eval e3` blocks (a
// suspect event in the baseline day's warmup breaks the negatives); and a
// third, the tuning list's design case `unlabelled_leak_may19` with its design
// target.
//
// The scenarios are the committed ones, bound against the committed ground
// truth, so the windows and the benign causes are the real ones; only the
// tickets and decisions are written by hand, in minutes after midnight of
// 3 February 2020, the day the injected scenarios replay. It sits in `src/`
// beside the code it serves, as `metrics/fixtures.ts` does, and nothing but a
// test imports it.

import type { Decision } from "@fdp/contracts";
import type { DecisionOutput } from "@fdp/backend/pipeline";

import type { BackendMode } from "../backends/types.ts";
import type { BackendName, EvalCatalog } from "../config.ts";
import { loadConfig } from "../config.ts";
import { at, decision, suspect, ticket } from "../metrics/fixtures.ts";
import { scoreScenario, summarise as summariseRun } from "../metrics/index.ts";
import type {
  DecisionRecord,
  ScenarioBinding,
  SuspectRecord,
  TicketRecord,
} from "../metrics/index.ts";
import { defaultAlarmRegistry } from "../replay/index.ts";
import type { TimedOutput } from "../runner/host.ts";
import {
  designTargets,
  evaluateE3,
  headlineFailureIds,
  judgeGate,
  toBinding,
} from "../runner/run.ts";
import type { BackendRecord, RunResult, ScenarioResult } from "../runner/types.ts";
import { bindScenario, loadAll } from "../scenario/index.ts";
import type { BoundScenario, Profile } from "../scenario/index.ts";
import { selectTuning, sharedSlices } from "../tuning.ts";
import type { ReportConfig } from "./json.ts";
import type { Provenance } from "./provenance.ts";

/** The key the contracts mock accepts; no report may ever contain it. */
export const SAMPLE_KEY = "eval-mock";

/** A marker planted in a backend output's `state`; no report may ever contain it. */
export const SAMPLE_STATE_MARKER = "state-seen-by-the-backend";

/** A marker planted in a backend output's raw bodies, with a bearer header beside it. */
export const SAMPLE_RAW_MARKER = `Bearer ${SAMPLE_KEY}`;

/** The digest the sample decision's state has. */
export const SAMPLE_DIGEST = "b".repeat(64);

export const SAMPLE_RUN_ID = "20260922-120000-core";

export const SAMPLE_PROVENANCE: Provenance = {
  git_sha: "0123456789abcdef0123456789abcdef01234567",
  node: "v24.18.0",
  backend_version: "1.0.0",
  ground_truth: {
    package_version: "1.0.0",
    failures_sha256: "c".repeat(64),
    injections_sha256: "d".repeat(64),
  },
};

export const SAMPLE_CATALOG: EvalCatalog = {
  source: "reference",
  name: "reference",
  sha256: "e".repeat(64),
  entries: [],
  conditions: [],
};

/** The configuration the sample run restates, with `--fail-on-gate` on. */
export function sampleConfig(): ReportConfig {
  return loadConfig(["--profile", "core", "--fail-on-gate"], { EVAL_VON_MODE: "mock" });
}

function bound(id: string, profile: Profile): BoundScenario {
  const scenario = loadAll().find((entry) => entry.id === id);
  if (scenario === undefined) throw new Error(`no committed scenario ${id}`);
  return bindScenario(scenario, { profile });
}

/** The oil-cooler scenario's binding, with one excluded hour added so a ticket can be ignored. */
function oilCoolerBinding(scenario: BoundScenario): ScenarioBinding {
  const binding = toBinding(scenario);
  return {
    ...binding,
    excluded: [
      ...binding.excluded,
      { id: "repair@2020-02-03T20:00:00.000Z", from: at(1200), to: at(1260), reason: "repair" },
    ],
  };
}

/** One ticket per scoring outcome, plus one the warmup swallows. */
const TICKETS: readonly TicketRecord[] = [
  ticket({ ticketId: "t-warmup", openedSimTs: at(30), faultAtOpen: "oil_cooler_fouled" }),
  ticket({
    ticketId: "t-wrong",
    openedSimTs: at(150),
    faultAtOpen: "dryer_purge_leak",
    faultLatest: "oil_cooler_fouled",
    closedSimTs: at(400),
  }),
  ticket({ ticketId: "t-right", openedSimTs: at(180), faultAtOpen: "oil_cooler_fouled" }),
  ticket({
    ticketId: "t-again",
    openedSimTs: at(240),
    faultAtOpen: "oil_cooler_fouled",
    maxLevel: "review",
  }),
  ticket({ ticketId: "t-benign", openedSimTs: at(300), faultAtOpen: "high_ambient_temperature" }),
  ticket({ ticketId: "t-excluded", openedSimTs: at(1230), faultAtOpen: "airend_bearing_wear" }),
  ticket({ ticketId: "t-false", openedSimTs: at(1320), faultAtOpen: "airend_bearing_wear" }),
];

function decisions(backend: BackendName, inputTokens: number): DecisionRecord[] {
  return [
    decision({
      decisionId: "00000000-0000-4000-8000-000000000001",
      simTs: at(150),
      choice: "dryer_purge_leak",
      backend,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    }),
    decision({
      decisionId: "00000000-0000-4000-8000-000000000002",
      simTs: at(180),
      choice: "oil_cooler_fouled",
      confidence: 0.92,
      backend,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    }),
    decision({
      decisionId: "00000000-0000-4000-8000-000000000003",
      simTs: at(600),
      choice: "none_of_these",
      confidence: 0.7,
      gate: "log",
      abstained: true,
      backend,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    }),
  ];
}

/** The decision message and backend output of the sample's second decision. */
function decisionEvent(backend: "rules" | "von"): TimedOutput {
  const message: Decision = {
    schema: "urn:fdp:schema:decision:v1",
    unit_id: "cau-7",
    wall_ts: "2026-01-01T00:00:00.000Z",
    decision_id: "00000000-0000-4000-8000-000000000002",
    episode_id: "00000000-0000-4000-8000-000000000012",
    event_id: "00000000-0000-4000-8000-000000000022",
    sim_ts: at(180).toISOString(),
    backend,
    model: backend === "rules" ? "rules-v1" : "von-1.13.0",
    status: "ok",
    choice: "oil_cooler_fouled",
    probabilities: { oil_cooler_fouled: 0.92, none_of_these: 0.08 },
    confidence: 0.92,
    support: {},
    candidates: [],
    severity: { level: "medium", score: 1, probabilities: { "1": 1 }, confidence: 1 },
    gate: {
      outcome: "ticket",
      abstained: false,
      reason: "sample",
      ticket_min_confidence: 0.85,
      review_min_confidence: 0.6,
    },
    usage: { input_tokens: 1480, output_tokens: 0 },
    cost: { usd: 0, price_input_per_mtok: 0, price_output_per_mtok: 0, prices_as_of: "2026-09-19" },
    latency_ms: 0,
    state_digest: SAMPLE_DIGEST,
    error: null,
  };
  const output: DecisionOutput = {
    backend,
    model: message.model,
    choice: message.choice,
    probabilities: message.probabilities,
    confidence: message.confidence,
    support: {},
    severity: { level: "medium", score: 1, probabilities: { "1": 1 }, confidence: 1 },
    usage: message.usage,
    latency_ms: 0,
    state: { note: SAMPLE_STATE_MARKER },
    state_digest: SAMPLE_DIGEST,
    raw: {
      request: { headers: { authorization: SAMPLE_RAW_MARKER } },
      response: { body: SAMPLE_RAW_MARKER },
    },
  };
  return { type: "decision", decision: message, output, gate: null, batchSimTs: message.sim_ts };
}

function result(
  scenario: BoundScenario,
  binding: ScenarioBinding,
  backend: BackendRecord,
  tickets: readonly TicketRecord[],
  suspects: readonly SuspectRecord[] = [],
  decided: readonly DecisionRecord[] = tickets.length === 0
    ? []
    : decisions(backend.name, backend.name === "von" ? 1480 : 0),
): ScenarioResult {
  const events =
    tickets.length === 0 ? [] : [decisionEvent(backend.name === "von" ? "von" : "rules")];
  const metrics = scoreScenario(
    binding,
    tickets,
    decided,
    [{ code: "W104", simTs: at(420) }],
    sampleConfig().prices,
    { backend: backend.name, nativeAlarmCodes: ["W104"], reviewMin: 0.6, suspects },
  );
  return {
    bound: scenario,
    binding,
    run: {
      scenarioId: scenario.scenario.id,
      backend: backend.name,
      model: backend.model,
      mode: backend.mode,
      seed: scenario.scenario.seed,
      events,
      alarms: [{ code: "W104", simTs: at(420) }],
      firstAlarms: [{ code: "W104", simTs: at(420) }],
      alarmTransitions: [],
      stats: {
        samples: 8716,
        batches: 349,
        discontinuities: 1,
        wallMs: 250,
        samplesPerS: 34864,
        decisions: decided.length,
        failures: 0,
      },
    },
    summary: {
      tickets,
      decisions: decided,
      failedDecisions: 0,
      suspects: suspects.length,
      suspectEvents: suspects,
      episodes: { opened: tickets.length, merged: 0, closed: 1, aborted: 0 },
      openAtEnd: tickets.filter((entry) => entry.closedSimTs === undefined).map((t) => t.ticketId),
    },
    metrics,
    scored: scenario.scenario.group !== "diagnostic",
    eventLog: `scenarios/${scenario.scenario.id}.${backend.name}.jsonl`,
  };
}

function backendRecord(name: BackendName, mode: BackendMode): BackendRecord {
  return {
    name,
    model: name === "rules" ? "rules-v1" : "von-1.13.0",
    mode,
    informative: mode !== "mock",
    stats: { calls: 3, failures: 0, cassetteMisses: 0 },
  };
}

/**
 * A run of the oil-cooler scenario and the August diagnostic one against rules and a mock Von.
 *
 * @param runDir where the run's files would be written; the result only names it.
 */
export function sampleRunResult(runDir: string): RunResult {
  const backends = [backendRecord("rules", "-"), backendRecord("von", "mock")];
  const oilCooler = bound("inject_oil_cooler_fouling", "core");
  const oilBinding = oilCoolerBinding(oilCooler);
  const august = bound("august_oil_level_aug10", "dev");
  const augustBinding = toBinding(august);

  const results = backends.flatMap((backend) => [
    result(oilCooler, oilBinding, backend, TICKETS),
    result(august, augustBinding, backend, []),
  ]);
  const summary = summariseRun(
    results.filter((entry) => entry.scored).map((entry) => entry.metrics),
    { headlineBackend: "rules" },
  );
  return {
    runId: SAMPLE_RUN_ID,
    runDir,
    profile: "core",
    startedAt: new Date("2026-09-22T12:00:00.000Z"),
    finishedAt: new Date("2026-09-22T12:01:30.000Z"),
    catalog: SAMPLE_CATALOG,
    alarmRegistry: defaultAlarmRegistry(),
    backends,
    results,
    summary,
    gate: judgeGate(summary.gate),
  };
}

export const SAMPLE_E3_RUN_ID = "20260922-120000-tuning";

/** The baseline day's two tickets: a non-benign one in the warmup, then a benign one. */
const BASELINE_TICKETS: readonly TicketRecord[] = [
  ticket({ ticketId: "t-early", openedSimTs: at(20), faultAtOpen: "airend_bearing_wear" }),
  ticket({ ticketId: "t-demand", openedSimTs: at(600), faultAtOpen: "high_air_demand" }),
];

/** The depot day's one ticket, naming a benign cause. */
const DEPOT_TICKETS: readonly TicketRecord[] = [
  ticket({
    ticketId: "t-depot",
    openedSimTs: new Date("2020-07-31T03:00:00.000Z"),
    faultAtOpen: "high_air_demand",
  }),
];

/** The baseline day's one suspect event, raised inside the warmup. */
export const BASELINE_SUSPECTS: readonly SuspectRecord[] = [
  suspect({ eventId: "s-early", simTs: at(20), symptomKey: "frequent_cycling" }),
];

/**
 * A rules-only run with the `--tuning` report and the E3 check: the baseline day, the depot day
 * and a quiet `frozen_logger_jun22`. The suspect event in the baseline day's warmup breaks the
 * negatives, which read every suspect event, and the benign ticket on the depot day breaks
 * the depot rule; the core-10 counts, the MetroPT-3 check and the abstain cases are not covered, so
 * the check fails and names the three gaps.
 *
 * @param runDir where the run's files would be written; the result only names it.
 */
export function sampleExitEvalRunResult(runDir: string): RunResult {
  const rules = backendRecord("rules", "-");
  const baseline = bound("baseline_feb03_normal", "core");
  const depot = bound("depot_lps_jul31", "core");
  const frozen = bound("frozen_logger_jun22", "dev");
  const results = [
    result(baseline, toBinding(baseline), rules, BASELINE_TICKETS, BASELINE_SUSPECTS),
    result(depot, toBinding(depot), rules, DEPOT_TICKETS),
    result(frozen, toBinding(frozen), rules, []),
  ];
  const summary = summariseRun(
    results.map((entry) => entry.metrics),
    { headlineBackend: "rules" },
  );
  const scenarios = loadAll();
  const headline = headlineFailureIds();
  const tuning = selectTuning(scenarios, headline);
  return {
    runId: SAMPLE_E3_RUN_ID,
    runDir,
    profile: "tuning",
    startedAt: new Date("2026-09-22T12:00:00.000Z"),
    finishedAt: new Date("2026-09-22T12:01:30.000Z"),
    catalog: SAMPLE_CATALOG,
    alarmRegistry: defaultAlarmRegistry(),
    backends: [rules],
    results,
    summary,
    gate: judgeGate(summary.gate),
    tuning: {
      scenarios: tuning.map((scenario) => scenario.id),
      sharedSlices: sharedSlices(tuning, scenarios),
    },
    exitEval: evaluateE3(results, { scenarios, headlineFailureIds: headline }),
  };
}

export const SAMPLE_DESIGN_RUN_ID = "20260924-120000-tuning";

/** An instant of 19–20 May 2020, the unlabelled episode's night (22:22:17 → 20 May 23:02:33). */
function may(iso: string): Date {
  return new Date(`2020-05-${iso}.000Z`);
}

/**
 * The design case's tickets: a benign one after the warmup and before the episode, then,
 * inside it, a review item naming a cause off the target and a ticket naming one on it.
 */
export const DESIGN_TICKETS: readonly TicketRecord[] = [
  ticket({ ticketId: "t-before", openedSimTs: may("19T21:30:00"), faultAtOpen: "high_air_demand" }),
  ticket({
    ticketId: "t-silencer",
    openedSimTs: may("19T23:00:00"),
    faultAtOpen: "purge_silencer_damaged",
    maxLevel: "review",
  }),
  ticket({ ticketId: "t-purge", openedSimTs: may("20T02:00:00"), faultAtOpen: "dryer_purge_leak" }),
];

/** The design case's decisions: the two that opened the items, and an abstention after them. */
export const DESIGN_DECISIONS: readonly DecisionRecord[] = [
  decision({
    decisionId: "00000000-0000-4000-8000-000000000101",
    simTs: may("19T23:00:00"),
    choice: "purge_silencer_damaged",
    confidence: 0.7,
    gate: "review",
  }),
  decision({
    decisionId: "00000000-0000-4000-8000-000000000102",
    simTs: may("20T02:00:00"),
    choice: "dryer_purge_leak",
    confidence: 0.9,
    gate: "ticket",
  }),
  decision({
    decisionId: "00000000-0000-4000-8000-000000000103",
    simTs: may("20T03:00:00"),
    choice: "none_of_these",
    confidence: 0.7,
    gate: "log",
    abstained: true,
  }),
];

/**
 * A rules-only tuning run of the summer negative and the design case `unlabelled_leak_may19`:
 * the design case is diagnostic, so it is reported and never scored, and its design target
 * is read beside the run.
 *
 * @param runDir where the run's files would be written; the result only names it.
 */
export function sampleDesignRunResult(runDir: string): RunResult {
  const rules = backendRecord("rules", "-");
  const summer = bound("summer_normal_jul05", "dev");
  const may19 = bound("unlabelled_leak_may19", "dev");
  const results = [
    result(summer, toBinding(summer), rules, []),
    result(may19, toBinding(may19), rules, DESIGN_TICKETS, [], DESIGN_DECISIONS),
  ];
  const summary = summariseRun(
    results.filter((entry) => entry.scored).map((entry) => entry.metrics),
    { headlineBackend: "rules" },
  );
  return {
    runId: SAMPLE_DESIGN_RUN_ID,
    runDir,
    profile: "tuning",
    startedAt: new Date("2026-09-24T12:00:00.000Z"),
    finishedAt: new Date("2026-09-24T12:01:30.000Z"),
    catalog: SAMPLE_CATALOG,
    alarmRegistry: defaultAlarmRegistry(),
    backends: [rules],
    results,
    summary,
    gate: judgeGate(summary.gate),
    designTargets: designTargets(results),
  };
}
