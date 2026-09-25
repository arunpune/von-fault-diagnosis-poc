// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Stack mode's scoring: the rows a running stack left in Postgres, turned into
// the records the in-process run scores, and scored by the same metrics
// (docs/evaluation.md). Everything here is a pure function of the rows and
// the ground truth, so a unit test drives it without a database and the
// integration test can compare it with `scoreScenario` on hand-made records.
//
// **What was replayed** is read from the one-minute telemetry aggregates, not
// assumed: each island of consecutive minutes is a replayed segment, the holes
// between islands are the jumps and the gaps (a missing minute means more than
// 60 s without a sample), and the replayed range runs from the first minute to
// one minute past the last. The markers the overlay stored (`gt.markers`) say
// why the holes are there; they are resolved to their preset and failure and
// reported, and a jump to a failure preset shows up as that failure's window
// because the minutes after the jump overlap it.
//
// **The windows** are every headline failure window of the failure table the
// replayed segments overlap — reached by a jump or by playing through it —
// built by the binder's own `failureScoringWindow` and clipped to the segments
// exactly as `bindScenario` clips a failure to a scenario's range, so a
// failure's true-positive span opens where it opens in process (the credited
// span), and every injection window of `gt.v_injection_windows`, accepted
// `[fault_id]`, benign as `@fdp/ground-truth` declares the injection. The
// excluded windows are the binder's own over the replayed range, and the
// covered time is the replayed range minus the holes, the gaps and them.
//
// **The records** follow the in-process recorder: a ticket's fault at
// open is what the decision that opened it named (the ticket row itself only
// holds the latest fault), it is a ticket-level ticket when its status is
// `open` or a decision gated `ticket` drove it, and it left the live state at
// its resolution, else at its first technician verdict. Only answered
// decisions become `DecisionRecord`s; failed calls are counted apart.
//
// Each backend the database holds decisions or tickets of is one scored pair of
// one scenario, `stack_replay`, so the report reads like an in-process run.
// Detection level reads the unit's suspect events (`app.suspect_events`), the
// same for every backend's pair.

import {
  getInjection,
  getPreset,
  loadFailureTable,
  loadInjections,
  precursorFrom,
  scoringWindows,
} from "@fdp/ground-truth";
import type { GtPresetDef } from "@fdp/ground-truth";

import type { EvalCatalog, GateThresholds } from "../config.ts";
import { BACKEND_NAMES } from "../config.ts";
import type { BackendName } from "../config.ts";
import { NONE_OF_THESE, scoreScenario } from "../metrics/index.ts";
import type {
  AlarmActivation,
  DecisionRecord,
  Interval,
  Prices,
  ScoringWindow,
  SuspectRecord,
  TicketRecord,
} from "../metrics/index.ts";
import type { ScenarioRun } from "../runner/host.ts";
import { benignCauses } from "../runner/recorder.ts";
import type { ScenarioSummary } from "../runner/recorder.ts";
import { toBinding } from "../runner/run.ts";
import type { ScenarioResult } from "../runner/types.ts";
import { bindScenario, failureScoringWindow } from "../scenario/index.ts";
import type { BoundScenario, GroundTruthApi, Scenario } from "../scenario/index.ts";
import type {
  AlarmRow,
  DecisionRow,
  EpisodeRow,
  InjectionWindowRow,
  LedgerRow,
  MarkerRow,
  MinuteIsland,
  StackRows,
  TicketRow,
} from "./db.ts";

/** The one scenario a stack run is scored as. */
export const STACK_SCENARIO_ID = "stack_replay";

/** The profile and the run-id suffix of a stack run. */
export const STACK_PROFILE = "stack";

const MINUTE_MS = 60_000;

/** The statuses a ticket is still live in. */
const LIVE_STATUSES: ReadonlySet<TicketRow["status"]> = new Set(["review", "open"]);

/** The stack's database holds nothing this scorer can measure. */
export class StackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StackError";
  }
}

/** The ground truth stack mode reads: the binder's API plus the replay presets. */
export interface StackGroundTruth extends GroundTruthApi {
  getPreset(id: string): GtPresetDef | undefined;
}

const DEFAULT_GT: StackGroundTruth = {
  loadFailureTable,
  loadInjections,
  getInjection,
  scoringWindows,
  precursorFrom,
  getPreset,
};

/** What the stack replayed, read from its telemetry minutes. */
export interface StackCoverage {
  /** From the first replayed minute to one minute past the last. */
  readonly replay: Interval;
  /** The islands of consecutive minutes, in sim-time order. */
  readonly segments: readonly Interval[];
  /** The holes between the segments: jumps, resets and gaps longer than 60 s. */
  readonly holes: readonly Interval[];
  readonly minutes: number;
  readonly samples: number;
}

/** One marker of the overlay, with the preset and failure it names. */
export interface ResolvedMarker {
  readonly kind: MarkerRow["kind"];
  readonly presetId: string | null;
  readonly failureId: string | null;
  readonly simTsFrom: Date;
  readonly simTsTo: Date;
  readonly wallTs: Date;
}

/** Where a scoring window of the stack came from. */
export interface StackWindow {
  readonly window: ScoringWindow;
  readonly kind: "failure" | "injection";
  /** True for a failure window a jump marker's preset named. */
  readonly reachedByJump: boolean;
}

/** One backend of the stack, scored. */
export interface StackBackendScore {
  readonly backend: BackendName;
  readonly model: string;
  /** Every decision row of the backend, answered or failed. */
  readonly decisionRows: number;
  readonly failures: number;
  readonly result: ScenarioResult;
}

/** Everything a stack run scored, before any report is written. */
export interface StackScore {
  readonly unitId: string;
  readonly coverage: StackCoverage;
  readonly markers: readonly ResolvedMarker[];
  readonly windows: readonly StackWindow[];
  readonly bound: BoundScenario;
  readonly backends: readonly StackBackendScore[];
  readonly ledger: readonly LedgerRow[];
}

/** What scoring needs beside the rows. */
export interface ScoreStackOptions {
  /** The catalog the stack's retrieval ranked; its benign flags judge a choice benign. */
  readonly catalog: Pick<EvalCatalog, "entries">;
  readonly prices: Prices;
  readonly thresholds: GateThresholds;
  /** The default native reference, from the registry the simulator evaluates. */
  readonly nativeAlarmCodes: readonly string[];
  readonly gt?: StackGroundTruth;
}

function laterOf(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}

function earlierOf(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

/**
 * The replayed segments, the holes between them and the replayed range.
 *
 * @throws StackError when there is no telemetry minute: nothing was replayed, so nothing can be
 * scored.
 */
export function stackCoverage(islands: readonly MinuteIsland[]): StackCoverage {
  const segments = islands.map((island) => ({
    from: island.first_minute,
    to: new Date(island.last_minute.getTime() + MINUTE_MS),
  }));
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first === undefined || last === undefined) {
    throw new StackError(
      "the database holds no telemetry minute in the range: the stack replayed nothing to score",
    );
  }
  const holes: Interval[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const before = segments[index - 1] as Interval;
    const after = segments[index] as Interval;
    if (after.from.getTime() > before.to.getTime()) holes.push({ from: before.to, to: after.from });
  }
  return {
    replay: { from: first.from, to: last.to },
    segments,
    holes,
    minutes: islands.reduce((total, island) => total + island.minutes, 0),
    samples: islands.reduce((total, island) => total + island.samples, 0),
  };
}

/** `[from, to)` cut to the replayed segments: from the first overlap's start to the last's end. */
export function clipToSegments(
  from: Date,
  to: Date,
  segments: readonly Interval[],
): Interval | undefined {
  let start: Date | undefined;
  let end: Date | undefined;
  for (const segment of segments) {
    const overlapFrom = laterOf(from, segment.from);
    const overlapTo = earlierOf(to, segment.to);
    if (overlapFrom.getTime() < overlapTo.getTime()) {
      start ??= overlapFrom;
      end = overlapTo;
    }
  }
  return start === undefined || end === undefined ? undefined : { from: start, to: end };
}

/** Every marker with the preset it names and the failure that preset replays. */
export function resolveMarkers(
  rows: readonly MarkerRow[],
  gt: Pick<StackGroundTruth, "getPreset"> = DEFAULT_GT,
): ResolvedMarker[] {
  return rows.map((row) => ({
    kind: row.kind,
    presetId: row.preset_id,
    failureId: row.preset_id === null ? null : (gt.getPreset(row.preset_id)?.failure_id ?? null),
    simTsFrom: row.sim_ts_from,
    simTsTo: row.sim_ts_to,
    wallTs: row.wall_ts,
  }));
}

/**
 * Every headline failure window the replayed segments overlap, clipped to them.
 *
 * The window is the binder's own (`failureScoringWindow`), so it opens where `bindScenario`
 * opens a failure — at the precursor when the failure has one, at a known data onset when that
 * is earlier (the credited span) — and the lead time's native alarm is searched from that
 * same `spanFrom`, whether or not the replay reached back that far: `leadFrom`, `onset` and
 * `onsetKnown` survive the clipping, so the metrics compute it exactly as in process.
 */
export function failureWindows(
  coverage: StackCoverage,
  gt: StackGroundTruth = DEFAULT_GT,
): ScoringWindow[] {
  const table = gt.loadFailureTable();
  return gt.scoringWindows().flatMap((scoring) => {
    const failure = table.failures.find((candidate) => candidate.id === scoring.failure_id);
    if (failure === undefined) return [];
    const window = failureScoringWindow(failure, scoring, gt.precursorFrom(scoring.failure_id));
    const span = clipToSegments(window.from, window.to, coverage.segments);
    if (span === undefined) return [];
    return [{ ...window, from: span.from, to: span.to }];
  });
}

/**
 * Every injection window the overlay recorded, clipped to the replayed segments.
 *
 * A window with no stop and no planned end runs to the end of the replay. Its id names the
 * injection and its start, so two instances of one injection stay two windows.
 */
export function injectionWindows(
  rows: readonly InjectionWindowRow[],
  coverage: StackCoverage,
  gt: Pick<StackGroundTruth, "getInjection"> = DEFAULT_GT,
): ScoringWindow[] {
  return rows.flatMap((row) => {
    const span = clipToSegments(
      row.start_sim_ts,
      row.end_sim_ts ?? coverage.replay.to,
      coverage.segments,
    );
    if (span === undefined) return [];
    return [
      {
        id: `${row.injection_id}@${row.start_sim_ts.toISOString()}`,
        from: span.from,
        to: span.to,
        leadFrom: row.start_sim_ts,
        accepted: [row.fault_id],
        benign: gt.getInjection(row.injection_id)?.benign ?? false,
        onset: row.start_sim_ts,
        onsetKnown: true,
        headline: false,
      },
    ];
  });
}

/** The scenario a stack run is scored as: its replayed range, positive when a window is. */
export function stackScenario(coverage: StackCoverage, positive: boolean): Scenario {
  return {
    schema: "urn:fdp:eval:scenario:v1",
    id: STACK_SCENARIO_ID,
    title: "The Compose stack's replay, scored from its database",
    group: positive ? "recording_positive" : "negative",
    profiles: ["dev"],
    split: "dev",
    positive,
    source: { kind: "csv" },
    replay: {
      from: coverage.replay.from.toISOString(),
      to: coverage.replay.to.toISOString(),
    },
    ground_truth: { kind: "negative" },
    expect: positive
      ? {
          tickets: "at_least_one",
          fault: "accepted",
          max_false_tickets: 0,
          pass_level: "detection",
        }
      : { tickets: "none", fault: "benign_or_none", max_false_tickets: 0, pass_level: "detection" },
    warmup_min: 0,
    seed: 0,
    notes:
      "Built by fdp-eval score-stack from the stack's telemetry minutes, gt.markers and gt.v_injection_windows.",
  };
}

/** Whether a decision's choice names a cause the catalog or the ground truth calls benign. */
function isBenignChoice(
  row: DecisionRow,
  benign: ReadonlySet<string>,
  chosenBenign: ReadonlyMap<string, boolean>,
): boolean {
  if (row.choice === NONE_OF_THESE) return false;
  return chosenBenign.get(row.decision_id) === true || benign.has(row.choice);
}

/** An answered decision row as the metrics read it. */
export function decisionRecord(
  row: DecisionRow,
  benign: ReadonlySet<string>,
  chosenBenign: ReadonlyMap<string, boolean> = new Map(),
): DecisionRecord {
  return {
    decisionId: row.decision_id,
    episodeId: row.episode_id,
    simTs: row.sim_ts,
    choice: row.choice,
    confidence: row.confidence,
    gate: row.gate_outcome,
    abstained: row.abstained,
    usage: { input_tokens: row.input_tokens, output_tokens: row.output_tokens },
    backend: row.backend,
    benignChoice: isBenignChoice(row, benign, chosenBenign),
  };
}

/** When a ticket left the live state, or `undefined` while it is still `review` or `open`. */
function leftLiveAt(row: TicketRow): Date | undefined {
  if (LIVE_STATUSES.has(row.status)) return undefined;
  return row.resolved_sim_ts ?? row.closed_sim_ts ?? row.updated_sim_ts;
}

/**
 * One ticket row as the metrics read it.
 *
 * @param drivers the answered decisions of the ticket's episode and of every episode merged into
 * it, in sim-time order: the decisions that could open, update or promote the ticket.
 */
export function ticketRecord(row: TicketRow, drivers: readonly DecisionRow[]): TicketRecord {
  const opened = row.opened_sim_ts.getTime();
  const closed = leftLiveAt(row);
  const gating = drivers.filter(
    (decision) =>
      decision.status === "ok" &&
      decision.gate_outcome !== "log" &&
      decision.choice !== NONE_OF_THESE,
  );
  const opener =
    gating.find((decision) => decision.sim_ts.getTime() === opened) ??
    gating.find((decision) => decision.sim_ts.getTime() >= opened);
  const promoted = gating.some(
    (decision) =>
      decision.gate_outcome === "ticket" &&
      decision.sim_ts.getTime() >= opened &&
      (closed === undefined || decision.sim_ts.getTime() <= closed.getTime()),
  );
  return {
    ticketId: row.ticket_id,
    episodeId: row.episode_id,
    openedSimTs: row.opened_sim_ts,
    faultAtOpen: opener?.choice ?? row.fault_id,
    faultLatest: row.fault_id,
    maxLevel: row.status === "open" || promoted ? "ticket" : "review",
    ...(closed === undefined ? {} : { closedSimTs: closed }),
  };
}

/** Every raise, and the first raise of each code in the order the codes first appeared. */
function alarmActivations(rows: readonly AlarmRow[]): {
  readonly all: AlarmActivation[];
  readonly first: AlarmActivation[];
} {
  const all = rows.map((row) => ({ code: row.code, simTs: row.sim_ts }));
  const seen = new Set<string>();
  const first = all.filter((alarm) => {
    if (seen.has(alarm.code)) return false;
    seen.add(alarm.code);
    return true;
  });
  return { all, first };
}

/** The backends the database holds decisions or tickets of, in the order the report lists them. */
function backendsIn(rows: StackRows): BackendName[] {
  const named = new Set([
    ...rows.decisions.map((row) => row.backend),
    ...rows.tickets.map((row) => row.backend),
  ]);
  const unknown = [...named].filter((name) => !(BACKEND_NAMES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new StackError(
      `the database names backends this harness does not know: ${unknown.join(", ")}`,
    );
  }
  const backends = BACKEND_NAMES.filter((name) => named.has(name));
  if (backends.length === 0) {
    throw new StackError(
      "the database holds no decision and no ticket in the range: nothing was diagnosed to score",
    );
  }
  return backends;
}

/** The episodes merged into each episode, so a ticket finds every decision that drove it. */
function mergedInto(episodes: readonly EpisodeRow[]): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const episode of episodes) {
    if (episode.merged_into === null) continue;
    const list = merged.get(episode.merged_into) ?? [];
    list.push(episode.episode_id);
    merged.set(episode.merged_into, list);
  }
  return merged;
}

/** How many episodes of the backend's decisions each transition left behind. */
function episodeCounts(
  episodes: readonly EpisodeRow[],
  decisions: readonly DecisionRow[],
): ScenarioSummary["episodes"] {
  const ids = new Set(decisions.map((row) => row.episode_id));
  const own = episodes.filter((episode) => ids.has(episode.episode_id));
  return {
    opened: own.length,
    merged: own.filter((episode) => episode.merged_into !== null).length,
    closed: own.filter((episode) => episode.status === "closed").length,
    aborted: own.filter((episode) => episode.status === "aborted").length,
  };
}

/** The model a backend answered with last. */
function modelOf(backend: BackendName, rows: StackRows): string {
  const decisions = rows.decisions.filter((row) => row.backend === backend);
  const latest = decisions[decisions.length - 1];
  if (latest !== undefined) return latest.model;
  return rows.tickets.find((row) => row.backend === backend)?.model ?? backend;
}

interface PairInput {
  readonly backend: BackendName;
  readonly rows: StackRows;
  readonly bound: BoundScenario;
  readonly coverage: StackCoverage;
  readonly benign: ReadonlySet<string>;
  readonly alarms: { readonly all: AlarmActivation[]; readonly first: AlarmActivation[] };
  readonly options: ScoreStackOptions;
}

function scorePair(input: PairInput): StackBackendScore {
  const { backend, rows, bound, coverage, benign, alarms, options } = input;
  const decisionRows = rows.decisions.filter((row) => row.backend === backend);
  const answered = decisionRows.filter((row) => row.status === "ok");
  const chosenBenign = new Map(rows.chosen.map((row) => [row.decision_id, row.benign]));
  const merged = mergedInto(rows.episodes);

  const tickets = rows.tickets
    .filter((row) => row.backend === backend)
    .map((row) => {
      const episodes = new Set([row.episode_id, ...(merged.get(row.episode_id) ?? [])]);
      return ticketRecord(
        row,
        answered.filter((decision) => episodes.has(decision.episode_id)),
      );
    });
  const decisions = answered.map((row) => decisionRecord(row, benign, chosenBenign));
  const binding = { ...toBinding(bound), gaps: coverage.holes };
  const model = modelOf(backend, rows);
  const failures = decisionRows.length - answered.length;

  const run: ScenarioRun = {
    scenarioId: STACK_SCENARIO_ID,
    backend,
    model,
    mode: "-",
    seed: bound.scenario.seed,
    events: [],
    alarms: alarms.all,
    firstAlarms: alarms.first,
    alarmTransitions: [],
    stats: {
      samples: coverage.samples,
      batches: 0,
      discontinuities: coverage.segments.length,
      wallMs: 0,
      samplesPerS: null,
      decisions: decisionRows.length,
      failures,
    },
  };
  // Detection runs once for the unit, before any backend is asked, so every backend's pair is
  // scored at detection level on the same suspect events.
  const suspectEvents: SuspectRecord[] = (rows.suspects ?? []).map((row) => ({
    eventId: row.event_id,
    simTs: row.sim_ts,
    symptomKey: row.symptom_key,
  }));
  const summary: ScenarioSummary = {
    tickets,
    decisions,
    failedDecisions: failures,
    suspects: new Set(decisionRows.map((row) => row.event_id)).size,
    suspectEvents,
    episodes: episodeCounts(rows.episodes, decisionRows),
    openAtEnd: rows.tickets
      .filter((row) => row.backend === backend && LIVE_STATUSES.has(row.status))
      .map((row) => row.ticket_id),
  };
  const metrics = scoreScenario(binding, tickets, decisions, alarms.all, options.prices, {
    backend,
    nativeAlarmCodes: options.nativeAlarmCodes,
    reviewMin: options.thresholds.reviewMin,
    suspects: suspectEvents,
  });

  return {
    backend,
    model,
    decisionRows: decisionRows.length,
    failures,
    result: {
      bound,
      binding,
      run,
      summary,
      metrics,
      scored: true,
      eventLog: `scenarios/${STACK_SCENARIO_ID}.${backend}.jsonl`,
    },
  };
}

/**
 * Scores what a stack left in its database.
 *
 * @param rows what `readStack` read.
 * @param options the catalog, the prices and thresholds the stack ran with, the native codes.
 * @throws StackError when nothing was replayed or diagnosed, or a backend is unknown.
 */
export function scoreStack(rows: StackRows, options: ScoreStackOptions): StackScore {
  const gt = options.gt ?? DEFAULT_GT;
  const coverage = stackCoverage(rows.islands);
  const markers = resolveMarkers(rows.markers, gt);
  const jumpedTo = new Set(
    markers.filter((marker) => marker.kind === "jump").map((marker) => marker.failureId),
  );
  const windows: StackWindow[] = [
    ...failureWindows(coverage, gt).map((window) => ({
      window,
      kind: "failure" as const,
      reachedByJump: jumpedTo.has(window.id),
    })),
    ...injectionWindows(rows.injections, coverage, gt).map((window) => ({
      window,
      kind: "injection" as const,
      reachedByJump: false,
    })),
  ];
  const scoring = windows.map((entry) => entry.window);
  const positive = scoring.some((window) => !window.benign);

  const scenario = stackScenario(coverage, positive);
  const bound: BoundScenario = {
    ...bindScenario(scenario, { profile: "dev", deps: { gt } }),
    windows: scoring,
  };
  const benign = benignCauses(options.catalog.entries, bound.benignFaultIds);
  const alarms = alarmActivations(rows.alarms);

  return {
    unitId: rows.unitId,
    coverage,
    markers,
    windows,
    bound,
    backends: backendsIn(rows).map((backend) =>
      scorePair({ backend, rows, bound, coverage, benign, alarms, options }),
    ),
    ledger: rows.ledger,
  };
}

/**
 * The gate thresholds the stack's decisions were gated at, from the latest decision that states
 * them, or `fallback` when none does.
 */
export function stackThresholds(
  decisions: readonly DecisionRow[],
  fallback: GateThresholds,
): { readonly thresholds: GateThresholds; readonly source: "decisions" | "environment" } {
  const stated = [...decisions]
    .reverse()
    .find((row) => row.ticket_min !== null && row.review_min !== null);
  if (stated === undefined || stated.ticket_min === null || stated.review_min === null) {
    return { thresholds: fallback, source: "environment" };
  }
  return {
    thresholds: { ticketMin: stated.ticket_min, reviewMin: stated.review_min },
    source: "decisions",
  };
}

/**
 * The persistence the stack's gate ran with: the latest decision message that states
 * it, else `fallback` — the evaluation's own `GATE_PERSIST_SIM_MIN`, as for the thresholds.
 */
export function stackPersistence(decisions: readonly DecisionRow[], fallback: number): number {
  const stated = [...decisions]
    .reverse()
    .find((row) => row.persist_min !== undefined && row.persist_min !== null);
  return stated?.persist_min ?? fallback;
}

/**
 * The prices the stack billed at, from its cost ledger, over `fallback` for a backend the ledger
 * holds no row of.
 */
export function stackPrices(ledger: readonly LedgerRow[], fallback: Prices): Prices {
  const latest = (backend: string) => ledger.find((row) => row.backend === backend);
  const jev = latest("jev");
  const llm = latest("llm");
  const asOf = ledger
    .map((row) => row.prices_as_of)
    .sort()
    .pop();
  return {
    jevInputPerMtok: jev?.price_input_per_mtok ?? fallback.jevInputPerMtok,
    llmInputPerMtok: llm?.price_input_per_mtok ?? fallback.llmInputPerMtok,
    llmOutputPerMtok: llm?.price_output_per_mtok ?? fallback.llmOutputPerMtok,
    asOf: asOf ?? fallback.asOf,
  };
}
