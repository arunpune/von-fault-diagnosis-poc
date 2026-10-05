// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The pre-registered choice of Von's thresholds, proved on synthetic decision sets only (the
// procedure is tools/eval/records/von-thresholds-preregistration.md, as amended on 2026-09-24):
// hand-written Von decisions on the ten tuning scenario ids, re-gated and scored by the same code
// a real sweep runs. Each clause of the selection rule has a decision set whose outcome is worked
// out by hand in its comment. No test here replays a scenario, reads a cassette or calls anything;
// no figure here is Von's.
//
// The amendment makes the choice a triple (N, review, ticket): N = GATE_PERSIST_SIM_MIN in
// {0, 1}, each N read from its own recording of the tuning list. A synthetic sweep is therefore
// two recordings, one per N, each a list of resample runs; most tests give both N the same
// decisions, so a triple at N = 0 and its twin at N = 1 are level on everything but N.
//
// The synthetic tuning list: every scenario replays one day and holds `NEGATIVE_DAYS` negative
// machine-days. Eight are counted — the ten less `unlabelled_leak_may19` and
// `august_oil_level_aug10`, reported apart — so one false ticket is 0.125 a day, above the 0.10
// limit, and five false reviews 0.625, above 0.50. The six positives — f4b and the five
// injections — bind one window from 02:00 to 12:00 accepting `FAULT`, pass at detection level
// within 600 minutes and allow no false ticket. `WRONG` is a non-benign fault no window accepts.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { parseChoiceRecord } from "../choice.ts";
import { ConfigError } from "../config.ts";
import { gate, sweep } from "../metrics/index.ts";
import type { ScenarioMetrics, ThresholdPair } from "../metrics/index.ts";
import { REPORT_SCHEMA_ID } from "../report/types.ts";
import type { ReportDecision, ReportScenario, ReportSuspect, RunReport } from "../report/types.ts";
import { TUNING_REPORTED_ONLY, TUNING_SCENARIOS } from "../tuning.ts";
import {
  INCUMBENT,
  INCUMBENT_TRIPLE,
  LIMITS,
  PERSIST_AXIS,
  PREREGISTERED_JSON_NAME,
  PREREGISTERED_MD_NAME,
  READINGS,
  applySelectionRule,
  checkRun,
  executePreregistered,
  gridFigures,
  median,
  preregisteredGrid,
  preregisteredSweep,
  readResampleRun,
  resampleConfig,
  resampleDirectory,
  scenarioFigures,
} from "./preregistered.ts";
import type { RecordingRuns, ResampleFigures, Triple, TripleFigures } from "./preregistered.ts";
import { SweepUsageError, rescoreScenario, sweepRunOf } from "./regate.ts";
import { run as sweepCommand } from "./sweep.ts";

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-preregistered-"));
  directories.push(directory);
  return directory;
}

// --- A synthetic tuning list -------------------------------------------------------------------

const DAY_START = Date.parse("2020-07-05T00:00:00.000Z");
const FAULT = "downstream_air_leak";
const WRONG = "oil_level_low";
const NEGATIVE_DAYS = 1;

/** The counted scenarios: the tuning list less the two reported apart. */
const COUNTED = TUNING_SCENARIOS.filter((id) => !TUNING_REPORTED_ONLY.includes(id));

/** The positives of the synthetic list: f4b and the five injections, the dev twin included. */
const POSITIVES = TUNING_SCENARIOS.filter(
  (id) => id === "f4b_recurrence_jul17" || id.startsWith("inject_"),
);

function at(hours: number): string {
  return new Date(DAY_START + hours * 3_600_000).toISOString();
}

/** One Von decision of a synthetic scenario. */
interface Decided {
  readonly episode: string;
  readonly hour: number;
  readonly choice: string;
  readonly confidence: number;
  /** Sim minutes its evidence had held; 5 (persisted) unless a test says otherwise. */
  readonly persisted?: number;
}

/** A correct decision inside a positive's window. */
function correct(confidence: number, episode = "e1"): Decided {
  return { episode, hour: 3, choice: FAULT, confidence };
}

/** A decision naming a fault no window accepts, in negative time. */
function wrong(confidence: number, episode = "w1", hour = 14): Decided {
  return { episode, hour, choice: WRONG, confidence };
}

type Plan = Readonly<Record<string, readonly Decided[]>>;

const COUNTS = {
  tp: 0,
  fp: 0,
  fn: 0,
  misdiagnosed: 0,
  recovered: 0,
  duplicates: 0,
  ignored: 0,
  benign: 0,
};

function scenarioOf(
  id: string,
  decisions: readonly Decided[],
  negativeDays: number,
): ReportScenario {
  const positive = POSITIVES.includes(id);
  const stored: ReportDecision[] = decisions.map((entry, index) => {
    const verdict = gate(entry.choice, entry.confidence, INCUMBENT[0], INCUMBENT[1]);
    return {
      decision_id: `${id}-d${index}`,
      episode_id: `${id}-${entry.episode}`,
      sim_ts: at(entry.hour),
      choice: entry.choice,
      confidence: entry.confidence,
      gate: verdict.outcome,
      abstained: verdict.abstained,
      benign_choice: false,
      usage: { input_tokens: 0, output_tokens: 0 },
      backend: "von",
      state_digest: null,
      persisted_sim_min: entry.persisted ?? 5,
    };
  });
  return {
    id,
    title: id,
    group: positive ? "injected" : "negative",
    split: "dev",
    positive,
    backend: "von",
    model: "von-1.13.0",
    mode: "cassette",
    seed: 0,
    scored: true,
    expect: {
      tickets: positive ? "at_least_one" : "none",
      fault: positive ? "accepted" : "benign_or_none",
      within_min: positive ? 600 : null,
      max_false_tickets: 0,
      pass_level: "detection",
    },
    replay: {
      from: at(0),
      to: at(24),
      samples: 1440,
      batches: 58,
      discontinuities: 0,
      covered_machine_days: 1,
      negative_machine_days: negativeDays,
    },
    warmup_min: 0,
    events_file: `scenarios/${id}.von.jsonl`,
    windows: positive
      ? [
          {
            id: `${id}-window`,
            from: at(2),
            to: at(12),
            lead_from: at(2),
            accepted: [FAULT],
            benign: false,
            onset: at(2),
            onset_known: true,
            native_lps_first: null,
            headline: false,
          },
        ]
      : [],
    excluded: [],
    benign_fault_ids: [],
    tickets: [],
    decisions: stored,
    decisions_summary: {
      count: stored.length,
      failed: 0,
      abstained: 0,
      by_choice: {},
      by_gate: { ticket: 0, review: 0, log: 0 },
    },
    suspects: 0,
    episodes: { opened: 0, merged: 0, closed: 0, aborted: 0 },
    alarms: { raised: 0, first_by_code: [] },
    // Filled below with what the run's own scorer gives at 0.60 / 0.85, as a replay's run.json
    // carries it; only the counts the sweep's self-check reads are real.
    metrics: {
      match: { ticket: COUNTS, review: COUNTS },
      rates: { tickets: 0 },
    } as unknown as ReportScenario["metrics"],
    pass: { detection: false, diagnosis: false, reasons: [] },
  };
}

/** A synthetic scenario's suspect events, one per hour given, as a newer run.json keeps them. */
function suspectEventsOf(id: string, hours: readonly number[]): ReportSuspect[] {
  return hours.map((hour, index) => ({
    event_id: `${id}-s${index}`,
    sim_ts: at(hour),
    symptom_key: "fast_decay",
  }));
}

/** What the run's own scorer gives a scenario at `pair`, every pass flag included. */
function scoredAt(
  scenario: ReportScenario,
  report: RunReport,
  pair: ThresholdPair,
): ScenarioMetrics {
  const [row] = sweep(sweepRunOf(scenario, report), [pair]);
  if (row === undefined) throw new Error("sweep() gave no row");
  return rescoreScenario(scenario, row, pair, report);
}

interface RunOptions {
  readonly negativeDays?: number;
  readonly misses?: number;
  /** Cassette hits the run reports; 10 unless a test says otherwise. */
  readonly hits?: number;
  readonly suspects?: Readonly<Record<string, readonly number[]>>;
  /** The run's GATE_PERSIST_SIM_MIN; 1 unless a test says otherwise. */
  readonly persist?: number;
}

/**
 * A resample's run.json over the ten tuning ids, stored figures consistent with its decisions.
 *
 * Without `suspects` it has the shape of a run written before suspect events were recorded: no
 * suspect events, and the ticket rule stored in `pass.detection`. With `suspects` (hours of
 * suspect events per scenario; an empty map is allowed) it has the shape a `--tuning` run writes
 * now: every scenario keeps its suspect events, `pass.detection` is the scorer's detection level
 * on them, and the ticket rule is `pass.review_diagnosis`.
 */
function runOf(
  plan: Plan,
  resample: number,
  answersMax: number,
  options: RunOptions = {},
): RunReport {
  const { suspects } = options;
  const persist = options.persist ?? 1;
  const draft: RunReport = {
    schema: REPORT_SCHEMA_ID,
    run: {
      id: `20260924-12${String(persist)}00${resample}-tuning`,
      mode: "in_process",
      profile: "tuning",
      scenario_filter: [],
      started_wall_ts: "2026-09-24T12:00:00.000Z",
      finished_wall_ts: "2026-09-24T12:00:10.000Z",
      git_sha: null,
      node: "v24.18.0",
      backend_version: "1.0.0",
      ground_truth: {
        package_version: "1.0.0",
        failures_sha256: "a".repeat(64),
        injections_sha256: null,
      },
      catalog: {
        source: "reference",
        name: "reference",
        sha256: "c".repeat(64),
        entries: 39,
        faults: 39,
      },
      alarm_registry: { source: "off", sha256: null },
      thresholds: {
        ticket_min: 0.85,
        review_min: 0.6,
        decision_interval_sim_min: 30,
        episode_clear_sim_min: 120,
        persist_sim_min: persist,
      },
      rules_disabled: [],
      prices: {
        von_input_per_mtok: 0.042,
        llm_input_per_mtok: 5,
        llm_output_per_mtok: 25,
        as_of: "2026-09-19",
      },
      seed: null,
    },
    backends: [
      {
        name: "von",
        model: "von-1.13.0",
        mode: "cassette",
        informative: true,
        calls: 10,
        failures: 0,
        cassette_hits: options.hits ?? 10,
        cassette_misses: options.misses ?? 0,
        cassette_miss_digests: [],
        cassette_reused: 0,
        cassette_resample: resample,
        cassette_answers_max: answersMax,
        thresholds: { ticket_min: 0.85, review_min: 0.6 },
        rate_limit: null,
      },
    ],
    scenarios: TUNING_SCENARIOS.map((id) => {
      const scenario = scenarioOf(id, plan[id] ?? [], options.negativeDays ?? NEGATIVE_DAYS);
      if (suspects === undefined) return scenario;
      const events = suspectEventsOf(id, suspects[id] ?? []);
      return { ...scenario, suspect_events: events, suspects: events.length };
    }),
    summary: null,
    gate: null,
  };
  return {
    ...draft,
    scenarios: draft.scenarios.map((scenario) => {
      const own = scenarioFigures(scenario, draft, INCUMBENT);
      const scored = suspects === undefined ? undefined : scoredAt(scenario, draft, INCUMBENT);
      return {
        ...scenario,
        metrics: {
          ...scenario.metrics,
          match: {
            ticket: { ...COUNTS, fp: own.falseTickets },
            review: { ...COUNTS, fp: own.falseReviews },
          },
          rates: { ...scenario.metrics.rates, tickets: own.tickets },
        },
        pass:
          scored === undefined
            ? { detection: own.passed ?? true, diagnosis: own.passed ?? true, reasons: [] }
            : {
                detection: scored.pass.detection,
                review_diagnosis: scored.pass.reviewDiagnosis,
                diagnosis: scored.pass.diagnosis,
                reasons: scored.pass.reasons,
              },
      };
    }),
  };
}

/** One recording at `persist`: a run per resample of `plans`, each saying it holds that many. */
function recordingOf(
  persist: number,
  plans: readonly Plan[],
  options: RunOptions = {},
): RecordingRuns {
  return {
    persistSimMin: persist,
    runs: plans.map((plan, resample) =>
      runOf(plan, resample, plans.length, { ...options, persist }),
    ),
  };
}

/** The two recordings, N = 0 from `zero` and N = 1 from `one`. */
function recordingsOf(
  zero: readonly Plan[],
  one: readonly Plan[],
  options: RunOptions = {},
): RecordingRuns[] {
  return [recordingOf(0, zero, options), recordingOf(1, one, options)];
}

/** Both N recorded with the same decisions: a triple and its twin differ only by N. */
function sameAtBoth(plans: readonly Plan[], options: RunOptions = {}): RecordingRuns[] {
  return recordingsOf(plans, plans, options);
}

/** The six positives, each with one correct decision at the confidence given, in order. */
function positives(confidences: readonly number[]): Plan {
  return Object.fromEntries(
    POSITIVES.map((id, index) => [id, [correct(confidences[index] ?? 0.9)]]),
  );
}

function triple(persistSimMin: number, ticketMin: number, reviewMin: number): Triple {
  return { persistSimMin, pair: [ticketMin, reviewMin] };
}

/** A triple as `{ persistSimMin, pair }` for `toEqual`. */
function asTriple(value: Triple | undefined): Triple | undefined {
  return value === undefined ? undefined : { persistSimMin: value.persistSimMin, pair: value.pair };
}

// --- The grid, the axis and the median ---------------------------------------------------------

describe("the pre-registered grid", () => {
  it("is review 0.50…0.80 by ticket 0.70…0.95 in steps of 0.05, review below ticket: 36 pairs", () => {
    const grid = preregisteredGrid();
    expect(grid).toHaveLength(36);
    expect(grid).toContainEqual(INCUMBENT);
    expect(grid).toContainEqual([0.7, 0.65]);
    expect(grid).not.toContainEqual([0.7, 0.7]);
    expect(grid).not.toContainEqual([0.75, 0.8]);
    expect(grid.every(([ticketMin, reviewMin]) => reviewMin < ticketMin)).toBe(true);
    expect(new Set(grid.map(([ticketMin]) => ticketMin))).toEqual(
      new Set([0.7, 0.75, 0.8, 0.85, 0.9, 0.95]),
    );
    expect(new Set(grid.map(([, reviewMin]) => reviewMin))).toEqual(
      new Set([0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]),
    );
  });

  it("is swept at N = 0 and N = 1, and (N = 1, 0.60 / 0.85) is the triple to beat", () => {
    expect(PERSIST_AXIS).toEqual([0, 1]);
    expect(asTriple(INCUMBENT_TRIPLE)).toEqual(triple(1, 0.85, 0.6));
  });

  it("keeps the pre-registered limits", () => {
    expect(LIMITS).toEqual({ falseTicketsPerDay: 0.1, falseReviewsPerDay: 0.5 });
    expect(INCUMBENT).toEqual([0.85, 0.6]);
  });
});

describe("median", () => {
  it("is the middle value, or the mean of the two middle ones", () => {
    expect(median([3])).toBe(3);
    expect(median([5, 1, 4])).toBe(4);
    expect(median([6, 4, 4, 5])).toBe(4.5);
    expect(() => median([])).toThrow(RangeError);
  });
});

// --- The figures ------------------------------------------------------------------------------

describe("the figures of one resample", () => {
  it("pools false tickets, false reviews and positives over the counted scenarios", () => {
    const report = runOf(
      {
        ...positives([0.9, 0.9, 0.7, 0.7, 0.57, 0.57]),
        summer_normal_jul05: [wrong(0.9)],
        frozen_logger_jun22: [wrong(0.62)],
      },
      0,
      1,
    );
    const figures = gridFigures(1, [report], [INCUMBENT])[0];
    expect(figures).toMatchObject({ persistSimMin: 1, pair: INCUMBENT });
    // The 0.90 wrong decision is a false ticket (and a false review); the 0.62 one a false review.
    expect(figures?.resamples[0]).toMatchObject({
      falseTickets: 1,
      falseReviews: 2,
      negativeMachineDays: 8,
      positivesPassed: 4,
      positivesTotal: 6,
    });
    expect(figures?.resamples[0]?.falseTicketsPerDay).toBeCloseTo(1 / 8, 12);
    expect(figures?.resamples[0]?.falseReviewsPerDay).toBeCloseTo(2 / 8, 12);
  });

  it("reports unlabelled_leak_may19 and august_oil_level_aug10 apart and counts neither", () => {
    // August binds no labelled window and expects a ticket of any fault; since the amendment of
    // 2026-09-24 its time is not negative time, so its oil-level ticket is not a false one.
    expect(TUNING_REPORTED_ONLY).toEqual(["unlabelled_leak_may19", "august_oil_level_aug10"]);
    expect(COUNTED).toHaveLength(8);
    const report = runOf(
      {
        unlabelled_leak_may19: [wrong(0.95), wrong(0.95, "w2", 16)],
        august_oil_level_aug10: [wrong(0.9), wrong(0.7, "w2", 18)],
      },
      0,
      1,
    );
    const figures = gridFigures(1, [report], [INCUMBENT])[0]?.resamples[0];
    expect(figures).toMatchObject({ falseTickets: 0, falseReviews: 0, negativeMachineDays: 8 });
    expect(figures?.scenarios.map((entry) => entry.scenario)).toEqual(COUNTED);
    expect(figures?.reportedOnly).toEqual([
      expect.objectContaining({ scenario: "unlabelled_leak_may19", tickets: 2 }),
      expect.objectContaining({
        scenario: "august_oil_level_aug10",
        tickets: 2,
        named: ["oil_level_low (ticket)", "oil_level_low (review)"],
      }),
    ]);
  });

  it("fails a positive that also opens a false review, as its own pass rule does", () => {
    const [id] = POSITIVES;
    const report = runOf(
      { ...positives([0.9]), [id as string]: [correct(0.9), wrong(0.62)] },
      0,
      1,
    );
    const scenario = report.scenarios.find((entry) => entry.id === id) as ReportScenario;
    expect(scenarioFigures(scenario, report, INCUMBENT).passed).toBe(false);
    expect(scenarioFigures(scenario, report, [0.85, 0.65]).passed).toBe(true);
  });

  it("never opens a ticket at another pair on a decision whose evidence had not persisted", () => {
    // At 0.60 / 0.85 the persisted 0.70 review opened the ticket, so the exempt 0.90 blip only
    // updated it; at 0.75 / 0.85 the blip may not open one, and nothing is opened at all.
    const [id] = POSITIVES;
    const report = runOf(
      {
        [id as string]: [
          correct(0.7),
          { episode: "e1", hour: 4, choice: WRONG, confidence: 0.9, persisted: 0 },
        ],
      },
      0,
      1,
    );
    const scenario = report.scenarios.find((entry) => entry.id === id) as ReportScenario;
    expect(scenarioFigures(scenario, report, [0.85, 0.75])).toMatchObject({
      tickets: 0,
      falseTickets: 0,
      falseReviews: 0,
    });
  });
});

// --- The selection rule, on synthetic decision sets --------------------------------------------

describe("the selection rule on synthetic decision sets", () => {
  it("clause 4, change: a qualifying triple that passes more positives on every resample replaces the incumbent", () => {
    // Both N recorded alike: positives at 0.90, 0.90, 0.70, 0.70, 0.57, 0.57 and no false alarm.
    // Every triple qualifies (72); review ≤ 0.55 passes all six, 0.60 / 0.85 four. Among the
    // six-passers the ties prefer N = 1, then the closest pair: (1, 0.55 / 0.85). Six is two
    // more than four, on the only resample: it replaces the incumbent.
    const { selection, withheld } = preregisteredSweep(
      sameAtBoth([positives([0.9, 0.9, 0.7, 0.7, 0.57, 0.57])]),
    );
    expect(withheld).toEqual([]);
    expect(selection?.outcome).toBe("change");
    expect(asTriple(selection?.chosen)).toEqual(triple(1, 0.85, 0.55));
    expect(selection?.qualifying).toHaveLength(72);
    expect(selection?.reason).toContain("passes 6 positives on the median resample against 4");
  });

  it("clause 1: the constraint holds on every resample, not on most of them", () => {
    // As above, but on resample 1 summer_normal_jul05 carries five wrong decisions at 0.56:
    // five false reviews over 8 days (0.625 a day) at every review ≤ 0.55. Those triples pass six
    // on both resamples and break the constraint on resample 1 only, so they do not qualify;
    // the best qualifying triple is then the incumbent itself, and it stays.
    const blips = [0, 1, 2, 3, 4].map((index) => wrong(0.56, `w${index}`, 14 + index));
    const base = positives([0.9, 0.9, 0.7, 0.7, 0.57, 0.57]);
    const { selection } = preregisteredSweep(
      sameAtBoth([base, { ...base, summer_normal_jul05: blips }]),
    );
    const lower = selection?.verdicts.find(
      (verdict) =>
        verdict.persistSimMin === 1 && verdict.pair[0] === 0.85 && verdict.pair[1] === 0.55,
    );
    expect(lower?.meetsConstraint).toBe(false);
    expect(lower?.breaches).toEqual([
      expect.stringMatching(/^resample 1: 0\.625 false reviews per negative machine-day/),
    ]);
    expect(selection?.outcome).toBe("keep");
    expect(asTriple(selection?.best)).toEqual(asTriple(INCUMBENT_TRIPLE));
  });

  it("clause 2: the objective reads the median resample, not the best one", () => {
    // The two 0.57 positives answer 0.57 on resample 0 and 0.40 on resamples 1 and 2: review
    // ≤ 0.55 passes 6, 4, 4 (median 4), level with the incumbent's 4, 4, 4. The ties then keep
    // the incumbent (N = 1, distance 0), so it stays.
    const high = positives([0.9, 0.9, 0.7, 0.7, 0.57, 0.57]);
    const low = positives([0.9, 0.9, 0.7, 0.7, 0.4, 0.4]);
    const { selection, triples } = preregisteredSweep(sameAtBoth([high, low, low]));
    const lower = triples.find(
      (entry) => entry.persistSimMin === 1 && entry.pair[0] === 0.85 && entry.pair[1] === 0.55,
    );
    expect(lower?.resamples.map((entry) => entry.positivesPassed)).toEqual([6, 4, 4]);
    expect(selection?.outcome).toBe("keep");
    expect(asTriple(selection?.best)).toEqual(asTriple(INCUMBENT_TRIPLE));
  });

  it("clause 3: fewer false reviews beat N and the distance", () => {
    // Every positive at 0.90 (every triple passes six) and one wrong decision at 0.62 on the
    // summer day: a false review at every review ≤ 0.60, the incumbent included. With the
    // positives level, fewer false reviews rank (1, 0.65 / 0.85) above the incumbent — but it
    // passes no more positives, so clause 4 keeps the incumbent.
    const { selection } = preregisteredSweep(
      sameAtBoth([{ ...positives([]), summer_normal_jul05: [wrong(0.62)] }]),
    );
    expect(asTriple(selection?.best)).toEqual(triple(1, 0.85, 0.65));
    expect(selection?.outcome).toBe("keep");
    expect(selection?.reason).toContain("not at least one more");
  });

  it("clause 3: then fewer false tickets beat N and the distance", () => {
    // Two negative machine-days a scenario (16 counted), so one false ticket is 0.0625 a day and
    // within the limit. One wrong decision at 0.87: a false review at every triple and a false
    // ticket at every ticket ≤ 0.85. Positives and false reviews are level, so the fewer false
    // tickets of ticket ≥ 0.90 win; N = 1, then the closest: (1, 0.60 / 0.90).
    const { selection } = preregisteredSweep(
      sameAtBoth([{ ...positives([]), summer_normal_jul05: [wrong(0.87)] }], { negativeDays: 2 }),
    );
    expect(selection?.incumbentMeetsConstraint).toBe(true);
    expect(asTriple(selection?.best)).toEqual(triple(1, 0.9, 0.6));
    expect(selection?.outcome).toBe("keep");
  });

  it("clause 3: then N = 1, before the distance to 0.60 / 0.85", () => {
    // N = 0's recording passes six positives at every pair; N = 1's passes six only at review
    // ≤ 0.55 (two positives at 0.57) and four at the incumbent pair. No false alarm anywhere.
    // Among the six-passers the N clause comes first: (1, 0.55 / 0.85), distance 0.05, ranks
    // above (0, 0.60 / 0.85), distance 0. It passes two more than the incumbent, on its own
    // recording's only resample, so it replaces it.
    const { selection } = preregisteredSweep(
      recordingsOf([positives([])], [positives([0.9, 0.9, 0.9, 0.9, 0.57, 0.57])]),
    );
    expect(asTriple(selection?.best)).toEqual(triple(1, 0.85, 0.55));
    expect(selection?.outcome).toBe("change");
    expect(asTriple(selection?.chosen)).toEqual(triple(1, 0.85, 0.55));
    const zero = selection?.verdicts.find(
      (verdict) =>
        verdict.persistSimMin === 0 && verdict.pair[0] === 0.85 && verdict.pair[1] === 0.6,
    );
    expect(zero).toMatchObject({ meetsConstraint: true, medianPositives: 6, distance: 0 });
  });

  it("the incumbent is (N = 1, 0.60 / 0.85): its twin at N = 0 does not replace it when level", () => {
    // Both N recorded alike, four positives at 0.60 / 0.85: (0, 0.60 / 0.85) is level with the
    // incumbent on everything but N, and the N clause keeps the incumbent first.
    const { selection } = preregisteredSweep(
      sameAtBoth([positives([0.9, 0.9, 0.9, 0.9, 0.4, 0.4])]),
    );
    expect(asTriple(selection?.best)).toEqual(asTriple(INCUMBENT_TRIPLE));
    expect(selection?.outcome).toBe("keep");
    expect(asTriple(selection?.chosen)).toEqual(asTriple(INCUMBENT_TRIPLE));
  });

  it("clause 4: a triple at N = 0 replaces the incumbent when it passes clearly more, the pipeline's N with it", () => {
    // N = 0 passes six at every pair; N = 1 five at every pair (one positive at 0.40). The best
    // six-passer is (0, 0.60 / 0.85) (no N = 1 triple passes six, so the distance decides). One
    // more than the incumbent's five on the median, and its fewest (6) is not below the
    // incumbent's most (5): it replaces the incumbent, and N moves to 0.
    const { selection } = preregisteredSweep(
      recordingsOf([positives([])], [positives([0.9, 0.9, 0.9, 0.9, 0.9, 0.4])]),
    );
    expect(selection?.outcome).toBe("change");
    expect(asTriple(selection?.chosen)).toEqual(triple(0, 0.85, 0.6));
    expect(selection?.reason).toContain("N = 0, 0.60 / 0.85");
  });

  it("clause 4 across N: never fewer under any pairing of the two recordings' resamples", () => {
    // N = 0's three resamples pass 6, 6, 5 at every pair; N = 1's pass 5, 6, 5 (one positive at
    // 0.40 on resamples 0 and 2). The best is (0, 0.60 / 0.85), median 6 against the incumbent's
    // 5: one more. Paired by index it would never pass fewer (6 ≥ 5, 6 ≥ 6, 5 ≥ 5), but the two
    // recordings' resamples pair with nothing: its fewest, 5, is below the incumbent's most, 6,
    // so under some pairing it passes fewer, and the incumbent stays.
    const six = positives([]);
    const five = positives([0.9, 0.9, 0.9, 0.9, 0.9, 0.4]);
    const { selection } = preregisteredSweep(recordingsOf([six, six, five], [five, six, five]));
    expect(asTriple(selection?.best)).toEqual(triple(0, 0.85, 0.6));
    expect(selection?.outcome).toBe("keep");
    expect(selection?.reason).toContain("fewest");
    expect(selection?.reason).toContain("recordings");
  });

  it("clause 4: never fewer on any resample of the incumbent's own recording", () => {
    // Resamples 0 and 1: positives 0.90, 0.90, 0.70, 0.70, 0.57, 0.57 (review 0.55: 6, 0.60: 4).
    // Resample 2: the last two answer 0.62 (both pass everywhere) and the first positive also
    // opens a wrong 0.57 review in negative time, which fails it at review ≤ 0.55 only: 5
    // against 6. (1, 0.55 / 0.85) is best (median 6 against 4) but passes fewer on resample 2.
    const first = POSITIVES[0] as string;
    const base = positives([0.9, 0.9, 0.7, 0.7, 0.57, 0.57]);
    const third = {
      ...positives([0.9, 0.9, 0.7, 0.7, 0.62, 0.62]),
      [first]: [correct(0.9), wrong(0.57)],
    };
    const { selection } = preregisteredSweep(sameAtBoth([base, base, third]));
    expect(asTriple(selection?.best)).toEqual(triple(1, 0.85, 0.55));
    expect(selection?.outcome).toBe("keep");
    expect(selection?.reason).toContain("resample 2: 5 against 6");
  });

  it("clause 4: when the incumbent breaks the constraint, the best qualifying triple wins without a margin", () => {
    // One wrong decision at 0.86 on the summer day: a false ticket (0.125 a day) at every ticket
    // ≤ 0.85, so the incumbent breaks the constraint. Every triple passes six positives; among
    // the qualifying ones (ticket ≥ 0.90), N = 1 and then the closest: (1, 0.60 / 0.90), which
    // wins with no more positives than the incumbent.
    const { selection } = preregisteredSweep(
      sameAtBoth([{ ...positives([]), summer_normal_jul05: [wrong(0.86)] }]),
    );
    expect(selection?.incumbentMeetsConstraint).toBe(false);
    expect(selection?.outcome).toBe("change");
    expect(asTriple(selection?.chosen)).toEqual(triple(1, 0.9, 0.6));
    expect(selection?.reason).toContain("breaks the constraint");
  });

  it("clause 4: when no triple qualifies, the thresholds and N stay and the finding is recorded", () => {
    // A wrong decision at 0.96 is a false ticket at every ticket threshold of the grid, at both N.
    const { selection } = preregisteredSweep(
      sameAtBoth([{ ...positives([]), frozen_logger_jun22: [wrong(0.96)] }]),
    );
    expect(selection?.qualifying).toEqual([]);
    expect(selection?.outcome).toBe("keep");
    expect(asTriple(selection?.chosen)).toEqual(asTriple(INCUMBENT_TRIPLE));
    expect(selection?.reason).toContain("no triple qualifies");
  });

  it("does not count a correct oil-level ticket on 10 August against the constraint", () => {
    // Before the amendment this ticket was a false one (0.111 a day at every ticket ≤ 0.90) and
    // moved Von to ticket 0.95; reported apart, it leaves the incumbent meeting the constraint.
    const { selection, triples } = preregisteredSweep(
      sameAtBoth([{ ...positives([]), august_oil_level_aug10: [wrong(0.92)] }]),
    );
    expect(selection?.incumbentMeetsConstraint).toBe(true);
    expect(selection?.outcome).toBe("keep");
    const incumbent = triples.find(
      (entry) => entry.persistSimMin === 1 && entry.pair[0] === 0.85 && entry.pair[1] === 0.6,
    );
    expect(incumbent?.resamples[0]?.falseTickets).toBe(0);
    expect(incumbent?.resamples[0]?.reportedOnly).toContainEqual(
      expect.objectContaining({ scenario: "august_oil_level_aug10", tickets: 1 }),
    );
  });
});

// --- The selection rule, on hand-set figures ---------------------------------------------------

/** Figures for one triple: the same pooled figures on every resample but the positives. */
function figuresFor(
  at: Triple,
  positivesByResample: readonly number[],
  rates: { readonly tickets?: number; readonly reviews?: number } = {},
): TripleFigures {
  return {
    ...at,
    resamples: positivesByResample.map((passed, resample): ResampleFigures => ({
      resample,
      falseTickets: 0,
      falseReviews: 0,
      negativeMachineDays: 8,
      falseTicketsPerDay: rates.tickets ?? 0,
      falseReviewsPerDay: rates.reviews ?? 0,
      positivesPassed: passed,
      positivesTotal: 6,
      scenarios: [],
      reportedOnly: [],
    })),
  };
}

describe("the selection rule on hand-set figures", () => {
  it("settles a tie clause 3 leaves by the higher ticket, then the higher review, and says so", () => {
    // The incumbent breaks the constraint; four triples at N = 1, distance 0.05, tie on everything.
    const triples = [
      figuresFor(INCUMBENT_TRIPLE, [4], { tickets: 0.2 }),
      figuresFor(triple(1, 0.8, 0.6), [5]),
      figuresFor(triple(1, 0.9, 0.6), [5]),
      figuresFor(triple(1, 0.85, 0.55), [5]),
      figuresFor(triple(1, 0.85, 0.65), [5]),
      figuresFor(triple(0, 0.85, 0.6), [5]),
    ];
    const selection = applySelectionRule(triples);
    expect(selection.outcome).toBe("change");
    expect(asTriple(selection.chosen)).toEqual(triple(1, 0.9, 0.6));
    expect(selection.residualTie).toHaveLength(4);
    expect(selection.reason).toContain("residual order");
  });

  it("treats a triple with no negative time to divide by as breaking the constraint", () => {
    const undivided = figuresFor(triple(1, 0.9, 0.6), [6]);
    const triples = [
      figuresFor(INCUMBENT_TRIPLE, [4]),
      {
        ...undivided,
        resamples: undivided.resamples.map((entry) => ({ ...entry, falseTicketsPerDay: null })),
      },
    ];
    const selection = applySelectionRule(triples);
    expect(selection.verdicts[1]?.meetsConstraint).toBe(false);
    expect(selection.outcome).toBe("keep");
  });

  it("asks for at least one more positive on the median even when the median is a half", () => {
    // Four resamples: (1, 0.55 / 0.85) passes 5, 5, 4, 4 (median 4.5) against 4, 4, 4, 4: 0.5 more.
    const selection = applySelectionRule([
      figuresFor(INCUMBENT_TRIPLE, [4, 4, 4, 4]),
      figuresFor(triple(1, 0.85, 0.55), [5, 5, 4, 4]),
    ]);
    expect(asTriple(selection.best)).toEqual(triple(1, 0.85, 0.55));
    expect(selection.outcome).toBe("keep");
  });

  it("takes each N's own number of resamples", () => {
    // N = 0 has two resamples (6, 6), N = 1 three (4, 4, 4): a different recording, so a
    // different count, and N = 0's fewest (6) is not below the incumbent's most (4).
    const selection = applySelectionRule([
      figuresFor(INCUMBENT_TRIPLE, [4, 4, 4]),
      figuresFor(triple(0, 0.85, 0.6), [6, 6]),
    ]);
    expect(selection.outcome).toBe("change");
    expect(asTriple(selection.chosen)).toEqual(triple(0, 0.85, 0.6));
  });

  it("refuses triples without the incumbent, or one N's triples with different resamples", () => {
    expect(() => applySelectionRule([figuresFor(triple(1, 0.9, 0.6), [4])])).toThrow(RangeError);
    expect(() =>
      applySelectionRule([
        figuresFor(INCUMBENT_TRIPLE, [4]),
        figuresFor(triple(1, 0.9, 0.6), [4, 4]),
      ]),
    ).toThrow(RangeError);
  });
});

// --- What the pre-registered sweep will not read, and when it will not choose ------------------

describe("the runs the pre-registered sweep reads", () => {
  const base = positives([0.9, 0.9, 0.7, 0.7, 0.57, 0.57]);

  it("withholds the choice when a resample had a cassette miss, naming its N", () => {
    const recordings = [
      recordingOf(0, [base]),
      {
        persistSimMin: 1,
        runs: [runOf(base, 0, 2, { persist: 1 }), runOf(base, 1, 2, { persist: 1, misses: 3 })],
      },
    ];
    const result = preregisteredSweep(recordings);
    expect(result.withheld).toEqual([
      expect.stringContaining(
        "GATE_PERSIST_SIM_MIN = 1, resample 1: 3 request(s) had no cassette at this N and were answered by the mock",
      ),
    ]);
    expect(result.missing).toEqual([]);
  });

  it("refuses to choose when one N was not recorded, and names the missing recording", () => {
    // Nothing recorded at N = 0: every request of its replay missed (the store answers a replay
    // at N only from N's recording), so no hit, and the recording holds no answer to rotate.
    const recordings = [
      recordingOf(0, [base], { hits: 0, misses: 12 }),
      recordingOf(1, [base, base]),
    ];
    const result = preregisteredSweep(recordings);
    expect(result.selection).toBeNull();
    expect(result.missing).toEqual([0]);
    expect(result.withheld[0]).toContain("GATE_PERSIST_SIM_MIN = 0");
    expect(result.withheld[0]).toContain("no recording");
    expect(result.withheld[0]).toContain(
      "GATE_PERSIST_SIM_MIN=0 pnpm --filter @fdp/eval run record -- --tuning --confirm-live",
    );
    // The recorded N is still tabulated; the missing one is not.
    expect(new Set(result.triples.map((entry) => entry.persistSimMin))).toEqual(new Set([1]));
    expect(result.triples).toHaveLength(36);
  });

  it("refuses a sweep that does not hold one recording per N of the axis", () => {
    expect(() => preregisteredSweep([recordingOf(1, [base])])).toThrow(
      /no resample run at GATE_PERSIST_SIM_MIN 0/,
    );
    expect(() => preregisteredSweep([...sameAtBoth([base]), recordingOf(2, [base])])).toThrow(
      /GATE_PERSIST_SIM_MIN 2 is not on the pre-registered axis/,
    );
  });

  it("withholds the choice when the re-gating does not give a resample's run back", () => {
    const report = runOf(base, 0, 1);
    const tampered: RunReport = {
      ...report,
      scenarios: report.scenarios.map((scenario) =>
        scenario.id === "summer_normal_jul05"
          ? {
              ...scenario,
              metrics: {
                ...scenario.metrics,
                match: { ...scenario.metrics.match, ticket: { ...COUNTS, fp: 1 } },
              },
            }
          : scenario,
      ),
    };
    const result = preregisteredSweep([
      recordingOf(0, [base]),
      { persistSimMin: 1, runs: [tampered] },
    ]);
    expect(result.recordings[1]?.runs[0]?.reproduces).toBe(false);
    expect(result.withheld).toEqual([
      expect.stringContaining("summer_normal_jul05: falseTickets 0 re-gated, 1 in the run"),
    ]);
  });

  it("reads a newer run's ticket rule from review_diagnosis, not from its suspect-event detection flag", () => {
    // A newer --tuning run.json stores pass.detection from suspect events and the ticket rule
    // as pass.review_diagnosis. The first positive raised a suspect event at 03:00, inside its
    // window and budget, but its one decision (0.50) stays at log and opens no ticket: it passes
    // detection and fails the ticket rule. The self-check compares the re-gated ticket rule with
    // review_diagnosis; compared with detection, this positive would read "not given back" and
    // every choice would be withheld.
    const [id] = POSITIVES;
    const plan: Plan = { ...base, [id as string]: [correct(0.5)] };
    const suspects = Object.fromEntries(POSITIVES.map((positive) => [positive, [3]]));
    const report = runOf(plan, 0, 1, { suspects });
    const stored = report.scenarios.find((entry) => entry.id === id) as ReportScenario;
    expect(stored.suspect_events).toHaveLength(1);
    expect(stored.pass).toMatchObject({ detection: true, review_diagnosis: false });
    expect(checkRun(report, 0, 1)).toMatchObject({
      reproduces: true,
      differences: [],
      withheld: [],
    });
    const result = preregisteredSweep(recordingsOf([plan], [plan], { suspects }));
    expect(result.withheld).toEqual([]);
    expect(result.recordings[1]?.runs[0]?.reproduces).toBe(true);
  });

  it.each([
    [
      "a profile other than tuning",
      (report: RunReport): RunReport => ({ ...report, run: { ...report.run, profile: "dev" } }),
      /not a --tuning run/,
    ],
    [
      "a test-split scenario",
      (report: RunReport): RunReport => ({
        ...report,
        scenarios: report.scenarios.map((scenario, index) =>
          index === 0 ? { ...scenario, split: "test" } : scenario,
        ),
      }),
      /never chosen on the core-10/,
    ],
    [
      "a list other than the tuning list",
      (report: RunReport): RunReport => ({ ...report, scenarios: report.scenarios.slice(1) }),
      /exactly the tuning list/,
    ],
    [
      "Von not replayed from cassettes",
      (report: RunReport): RunReport => ({
        ...report,
        backends: report.backends.map((backend) => ({ ...backend, mode: "mock" as const })),
      }),
      /from cassettes/,
    ],
    [
      "a gate other than 0.60 / 0.85",
      (report: RunReport): RunReport => ({
        ...report,
        backends: report.backends.map((backend) => ({
          ...backend,
          thresholds: { ticket_min: 0.9, review_min: 0.6 },
        })),
      }),
      /re-gates decisions taken at 0\.60 \/ 0\.85/,
    ],
    [
      "no GATE_PERSIST_SIM_MIN",
      (report: RunReport): RunReport => {
        const thresholds = Object.fromEntries(
          Object.entries(report.run.thresholds).filter(([key]) => key !== "persist_sim_min"),
        ) as RunReport["run"]["thresholds"];
        return { ...report, run: { ...report.run, thresholds } };
      },
      /before the persistence rule/,
    ],
    [
      "a run at another GATE_PERSIST_SIM_MIN than its recording's",
      (report: RunReport): RunReport => ({
        ...report,
        run: { ...report.run, thresholds: { ...report.run.thresholds, persist_sim_min: 0 } },
      }),
      /ran at GATE_PERSIST_SIM_MIN 0, not 1/,
    ],
  ])("refuses %s", (_name, change, message) => {
    const recordings = [
      recordingOf(0, [base]),
      { persistSimMin: 1, runs: [change(runOf(base, 0, 1))] },
    ];
    expect(() => preregisteredSweep(recordings)).toThrow(SweepUsageError);
    expect(() => preregisteredSweep(recordings)).toThrow(message);
  });

  it("refuses runs out of resample order, or fewer than the recording holds", () => {
    const runs = [runOf(base, 0, 2), runOf(base, 1, 2)];
    expect(() =>
      preregisteredSweep([
        recordingOf(0, [base]),
        { persistSimMin: 1, runs: [runs[1] as RunReport, runs[0] as RunReport] },
      ]),
    ).toThrow(/served resample 1, not 0/);
    expect(() =>
      preregisteredSweep([
        recordingOf(0, [base]),
        { persistSimMin: 1, runs: [runs[0] as RunReport] },
      ]),
    ).toThrow(/reads 2 resample run\(s\) at GATE_PERSIST_SIM_MIN 1, not 1/);
  });
});

// --- The command -----------------------------------------------------------------------------

describe("the pre-registered sweep as a command", () => {
  const base = positives([0.9, 0.9, 0.7, 0.7, 0.57, 0.57]);

  /** Replays of the two recordings: N = 0 holds two answers of a request, N = 1 three. */
  function replayer(asked: string[], options: { readonly zeroMissing?: boolean } = {}) {
    const held: Readonly<Record<number, number>> = { 0: 2, 1: 3 };
    return (persistSimMin: number, resample: number): Promise<RunReport> => {
      asked.push(`${persistSimMin}/${resample}`);
      const missing = options.zeroMissing === true && persistSimMin === 0;
      return Promise.resolve(
        runOf(base, resample, missing ? 0 : (held[persistSimMin] ?? 1), {
          persist: persistSimMin,
          ...(missing ? { hits: 0, misses: 12 } : {}),
        }),
      );
    };
  }

  it("replays each N's recording, as many resamples as it holds, and writes its report", async () => {
    const out = temporaryDirectory();
    const asked: string[] = [];
    const written: string[] = [];
    const { result, json, md } = await executePreregistered(
      { outDir: out, fromRuns: false, env: {} },
      { replay: replayer(asked), stdout: { write: (chunk: string) => written.push(chunk) } },
    );
    expect(asked).toEqual(["0/0", "0/1", "1/0", "1/1", "1/2"]);
    expect(asTriple(result.selection?.chosen)).toEqual(triple(1, 0.85, 0.55));
    const document = JSON.parse(readFileSync(json, "utf8")) as Record<string, unknown>;
    expect(document).toMatchObject({
      schema: "urn:fdp:eval:preregistered-sweep:v2",
      backend: "von",
      persist_axis: [0, 1],
      incumbent: { persist_sim_min: 1, ticket_min: 0.85, review_min: 0.6 },
      reported_apart: [
        expect.objectContaining({ scenario: "unlabelled_leak_may19" }),
        expect.objectContaining({ scenario: "august_oil_level_aug10" }),
      ],
      selection: {
        status: "chosen",
        chosen: { persist_sim_min: 1, ticket_min: 0.85, review_min: 0.55 },
        missing_recordings: [],
      },
    });
    expect((document["triples"] as unknown[]).length).toBe(72);
    const recordings = document["recordings"] as { runs: unknown[] }[];
    expect(recordings.map((entry) => entry.runs.length)).toEqual([2, 3]);
    const page = readFileSync(md, "utf8");
    expect(page).toContain(
      "Chosen: GATE_PERSIST_SIM_MIN=1, VON_GATE_REVIEW_MIN_CONFIDENCE=0.55, VON_GATE_TICKET_MIN_CONFIDENCE=0.85",
    );
    expect(page).toContain("## Reported apart, never counted");
    expect(page).toContain("`august_oil_level_aug10`");
    expect(page).toContain("after the E3 and E4 results had been seen");
    expect(page).toContain("gitignored `reports/`");
    for (const reading of READINGS) expect(page).toContain(reading);
    expect(json.endsWith(PREREGISTERED_JSON_NAME)).toBe(true);
    expect(md.endsWith(PREREGISTERED_MD_NAME)).toBe(true);
    expect(written.join("")).toContain("VON_GATE_REVIEW_MIN_CONFIDENCE=0.55");
    expect(written.join("")).toContain("GATE_PERSIST_SIM_MIN=1");
  });

  it("says no triple is chosen, and names none, when a resample cannot be read as the model's", async () => {
    const { json, md } = await executePreregistered(
      { outDir: temporaryDirectory(), fromRuns: true, env: {} },
      {
        read: (persistSimMin, resample) =>
          runOf(base, resample, 2, {
            persist: persistSimMin,
            ...(persistSimMin === 1 && resample === 1 ? { misses: 1 } : {}),
          }),
        stdout: { write: () => true },
      },
    );
    expect(JSON.parse(readFileSync(json, "utf8"))).toMatchObject({
      selection: { status: "withheld", chosen: null, reason: null },
    });
    // The rule alone would move Von to (1, 0.55 / 0.85); withheld, the page marks no triple chosen.
    const page = readFileSync(md, "utf8");
    expect(page).toContain("No triple chosen");
    expect(page).not.toMatch(/chosen\)/);
    expect(page).not.toContain("N = 1, 0.55 / 0.85 by scenario");
  });

  it("says which recording is missing when one N was never recorded", async () => {
    const asked: string[] = [];
    const written: string[] = [];
    const { json, md } = await executePreregistered(
      { outDir: temporaryDirectory(), fromRuns: false, env: {} },
      {
        replay: replayer(asked, { zeroMissing: true }),
        stdout: { write: (chunk: string) => written.push(chunk) },
      },
    );
    expect(asked).toEqual(["0/0", "1/0", "1/1", "1/2"]);
    expect(JSON.parse(readFileSync(json, "utf8"))).toMatchObject({
      selection: { status: "withheld", chosen: null, missing_recordings: [0] },
    });
    const page = readFileSync(md, "utf8");
    expect(page).toContain(
      "No triple chosen: the tuning list's recording at GATE_PERSIST_SIM_MIN = 0 is missing.",
    );
    expect(written.join("")).toContain("GATE_PERSIST_SIM_MIN = 0 is missing");
  });

  it("names both recordings as missing when the cassette store holds none", async () => {
    const empty = () =>
      Promise.reject(
        new ConfigError("EVAL_VON_MODE", "cassette mode replays recorded answers and holds none"),
      );
    const refused = await executePreregistered(
      { outDir: temporaryDirectory(), fromRuns: false, env: {} },
      { replay: empty, stdout: { write: () => true } },
    ).catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(ConfigError);
    const message = (refused as ConfigError).message;
    expect(message).toContain("GATE_PERSIST_SIM_MIN = 0 and GATE_PERSIST_SIM_MIN = 1");
    expect(message).toContain("no triple is chosen");
    expect(message).toContain(
      "GATE_PERSIST_SIM_MIN=0 pnpm --filter @fdp/eval run record -- --tuning --confirm-live",
    );
  });

  it("replays the tuning list for Von alone, from cassettes, at 0.60 / 0.85 and the N it is given, whatever the environment says", () => {
    const cfg = resampleConfig(
      {
        EVAL_VON_MODE: "live",
        VON_GATE_TICKET_MIN_CONFIDENCE: "0.95",
        GATE_PERSIST_SIM_MIN: "2",
      },
      "/tmp/sweep",
      0,
      2,
    );
    expect(cfg).toMatchObject({
      profile: "tuning",
      backends: ["von"],
      vonMode: "cassette",
      record: false,
      confirmLive: false,
      resample: 2,
      vonGate: { ticketMin: 0.85, reviewMin: 0.6 },
      persistSimMin: 0,
      // Each N on the recording made at N "and on no other": a cassette that does not say its
      // value is a miss, never served.
      cassetteOwnRecordingOnly: true,
      outDir: resampleDirectory("/tmp/sweep", 0, 2),
    });
    expect(resampleDirectory("/tmp/sweep", 0, 2)).toBe("/tmp/sweep/persist-0/resample-2");
    // Von's default pair is now the choice (0.65 / 0.85); the sweep still replays at the pair
    // the recordings were made at.
    expect(resampleConfig({}, "/tmp/sweep", 1, 0).vonGate).toEqual({
      ticketMin: 0.85,
      reviewMin: 0.6,
    });
  });

  it("names a missing or foreign resample run as a usage error", () => {
    const out = temporaryDirectory();
    expect(() => readResampleRun(out, 1, 0)).toThrow(SweepUsageError);
    mkdirSync(resampleDirectory(out, 1, 0), { recursive: true });
    writeFileSync(join(resampleDirectory(out, 1, 0), "latest.json"), "{}", "utf8");
    expect(() => readResampleRun(out, 1, 0)).toThrow(/is not a run\.json/);
  });

  it("records the choice once, with the triple the held-out run reads, and never a withheld one", async () => {
    const out = temporaryDirectory();
    const choicePath = join(temporaryDirectory(), "von-thresholds-choice.md");
    const quiet = { write: () => true };
    const request = { outDir: out, fromRuns: false, env: {}, recordChoice: true, choicePath };
    const recordedAt = () => new Date("2026-09-26T08:00:00.000Z");
    await executePreregistered(request, {
      replay: replayer([]),
      stdout: quiet,
      now: recordedAt,
      preregistrationCommit: () => "0123456789abcdef0123456789abcdef01234567",
    });
    const text = readFileSync(choicePath, "utf8");
    expect(parseChoiceRecord(text, choicePath)).toEqual({
      persistSimMin: 1,
      reviewMin: 0.55,
      ticketMin: 0.85,
    });
    expect(text).toContain("**change**");
    expect(text).toContain("20260924-121002-tuning");
    expect(text).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(text).not.toMatch(/positives? passed|per negative machine-day/);

    // Once written, the choice is not written again.
    await expect(
      executePreregistered(request, { replay: replayer([]), stdout: quiet, now: recordedAt }),
    ).rejects.toThrow(/already records the choice/);

    // A withheld choice is never recorded.
    const elsewhere = join(temporaryDirectory(), "von-thresholds-choice.md");
    await expect(
      executePreregistered(
        { ...request, outDir: temporaryDirectory(), choicePath: elsewhere },
        { replay: replayer([], { zeroMissing: true }), stdout: quiet, now: recordedAt },
      ),
    ).rejects.toThrow(/no triple is chosen/);
    expect(existsSync(elsewhere)).toBe(false);
  });

  it("refuses the flags that would change the pre-registered runs, grid or data", async () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        errors.push(String(chunk));
        return true;
      });
    try {
      const never = { replay: () => Promise.reject(new Error("never replayed")) };
      for (const extra of [
        ["--grid", "0.6:0.9:0.05x0.5:0.8:0.05"],
        ["--run", "x.json"],
        ["--allow-test-split"],
      ]) {
        expect(await sweepCommand(["--preregistered", ...extra], {}, never)).toBe(1);
      }
      expect(await sweepCommand(["--from-runs"], {})).toBe(1);
      expect(await sweepCommand(["--record-choice"], {})).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("")).toContain("is not allowed with it");
    expect(errors.join("")).toContain("--from-runs belongs to --preregistered");
    expect(errors.join("")).toContain("--record-choice belongs to --preregistered");
  });
});
