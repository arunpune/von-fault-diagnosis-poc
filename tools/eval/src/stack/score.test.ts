// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Stack mode's scoring on hand-made rows.
//
// The rows are what `readStack` would return after the CI smoke: six hours of
// 1 February, a jump to the F3 preset at 06:00 on 5 June and eight hours
// after it, an oil-cooler injection on 1 February, and tickets and decisions
// written by hand. The ground truth is the committed one. What the database
// really returns — types, grants, the view — is the integration test's
// (`test/integration/stack-score.test.ts`).

import { describe, expect, it } from "vitest";

import { DEFAULTS } from "../config.ts";
import { TEST_PRICES } from "../metrics/fixtures.ts";
import { scoreScenario } from "../metrics/index.ts";
import type { MatchResult } from "../metrics/index.ts";
import { toBinding } from "../runner/run.ts";
import { bindScenario, loadAll } from "../scenario/index.ts";
import type {
  DecisionRow,
  EpisodeRow,
  InjectionWindowRow,
  LedgerRow,
  MarkerRow,
  MinuteIsland,
  StackRows,
  TicketRow,
} from "./db.ts";
import {
  STACK_SCENARIO_ID,
  StackError,
  clipToSegments,
  decisionRecord,
  failureWindows,
  injectionWindows,
  resolveMarkers,
  scoreStack,
  stackCoverage,
  stackPersistence,
  stackPrices,
  stackThresholds,
  ticketRecord,
} from "./score.ts";

function utc(text: string): Date {
  return new Date(text);
}

function island(from: string, to: string, samplesPerMinute = 6): MinuteIsland {
  const first = utc(from);
  const last = utc(to);
  const minutes = (last.getTime() - first.getTime()) / 60_000 + 1;
  return { first_minute: first, last_minute: last, minutes, samples: minutes * samplesPerMinute };
}

/** 1 February 00:00–06:00 and 5 June 06:00–14:00, the two segments of the CI smoke. */
const ISLANDS: readonly MinuteIsland[] = [
  island("2020-02-01T00:00:00.000Z", "2020-02-01T05:59:00.000Z"),
  island("2020-06-05T06:00:00.000Z", "2020-06-05T13:59:00.000Z"),
];

const JUMP_TO_F3: MarkerRow = {
  kind: "jump",
  preset_id: "f3_air_leak_jun05",
  sim_ts_from: utc("2020-02-01T06:00:00.000Z"),
  sim_ts_to: utc("2020-06-05T06:00:00.000Z"),
  wall_ts: utc("2026-09-23T10:00:00.000Z"),
};

const OIL_COOLER: InjectionWindowRow = {
  instance_id: "inj-a1-000001",
  injection_id: "oil_cooler_fouling",
  fault_id: "oil_cooler_fouled",
  start_sim_ts: utc("2020-02-01T02:00:00.000Z"),
  end_sim_ts: utc("2020-02-01T05:00:00.000Z"),
  reason: "cleared",
};

function decision(fields: Partial<DecisionRow> & { decision_id: string }): DecisionRow {
  return {
    episode_id: "e-1",
    event_id: `ev-${fields.decision_id}`,
    sim_ts: utc("2020-02-01T03:00:00.000Z"),
    backend: "rules",
    model: "rules-v1",
    status: "ok",
    choice: "oil_cooler_fouled",
    confidence: 0.9,
    gate_outcome: "ticket",
    abstained: false,
    input_tokens: 0,
    output_tokens: 0,
    state_digest: "d".repeat(64),
    ticket_min: 0.85,
    review_min: 0.6,
    ...fields,
  };
}

function ticket(fields: Partial<TicketRow> & { ticket_id: string }): TicketRow {
  return {
    episode_id: "e-1",
    status: "open",
    fault_id: "oil_cooler_fouled",
    backend: "rules",
    model: "rules-v1",
    opened_sim_ts: utc("2020-02-01T03:00:00.000Z"),
    updated_sim_ts: utc("2020-02-01T03:00:00.000Z"),
    resolved_sim_ts: null,
    latest_decision_id: "d-1",
    symptom_key: "oil_temperature_rising",
    symptom_keys: ["oil_temperature_rising"],
    closed_sim_ts: null,
    ...fields,
  };
}

const EPISODES: readonly EpisodeRow[] = [
  { episode_id: "e-1", status: "closed", merged_into: null },
  { episode_id: "e-2", status: "open", merged_into: null },
];

function rows(fields: Partial<StackRows> = {}): StackRows {
  return {
    unitId: "cau-7",
    tickets: [],
    decisions: [],
    chosen: [],
    episodes: EPISODES,
    alarms: [],
    ledger: [],
    injections: [OIL_COOLER],
    markers: [JUMP_TO_F3],
    islands: ISLANDS,
    ...fields,
  };
}

describe("stackCoverage", () => {
  it("reads the replayed segments, the hole between them and the replayed range", () => {
    const coverage = stackCoverage(ISLANDS);
    expect(coverage.segments.map((s) => [s.from.toISOString(), s.to.toISOString()])).toEqual([
      ["2020-02-01T00:00:00.000Z", "2020-02-01T06:00:00.000Z"],
      ["2020-06-05T06:00:00.000Z", "2020-06-05T14:00:00.000Z"],
    ]);
    expect(coverage.holes).toEqual([
      { from: utc("2020-02-01T06:00:00.000Z"), to: utc("2020-06-05T06:00:00.000Z") },
    ]);
    expect(coverage.replay).toEqual({
      from: utc("2020-02-01T00:00:00.000Z"),
      to: utc("2020-06-05T14:00:00.000Z"),
    });
    expect(coverage.minutes).toBe(360 + 480);
    expect(coverage.samples).toBe((360 + 480) * 6);
  });

  it("refuses a database that replayed nothing", () => {
    expect(() => stackCoverage([])).toThrow(StackError);
  });
});

describe("clipToSegments", () => {
  const { segments } = stackCoverage(ISLANDS);

  it("keeps the part of a span the segments replayed", () => {
    expect(
      clipToSegments(utc("2020-06-05T10:00:00.000Z"), utc("2020-06-07T14:30:00.000Z"), segments),
    ).toEqual({ from: utc("2020-06-05T10:00:00.000Z"), to: utc("2020-06-05T14:00:00.000Z") });
  });

  it("spans every segment a long window crosses, and nothing when it crosses none", () => {
    expect(
      clipToSegments(utc("2020-01-31T00:00:00.000Z"), utc("2020-07-01T00:00:00.000Z"), segments),
    ).toEqual({ from: utc("2020-02-01T00:00:00.000Z"), to: utc("2020-06-05T14:00:00.000Z") });
    expect(
      clipToSegments(utc("2020-04-18T00:00:00.000Z"), utc("2020-04-19T02:00:00.000Z"), segments),
    ).toBeUndefined();
  });
});

describe("the windows of a stack", () => {
  const coverage = stackCoverage(ISLANDS);

  it("finds the F3 window after the jump, clipped to what was replayed", () => {
    const windows = failureWindows(coverage);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      id: "F3",
      // The data onset, not the labelled 10:00 start (the credited span), exactly as the binder.
      from: utc("2020-06-05T09:48:30.000Z"),
      to: utc("2020-06-05T14:00:00.000Z"),
      leadFrom: utc("2020-06-05T10:00:00.000Z"),
      accepted: ["dryer_purge_leak", "downstream_air_leak"],
      benign: false,
      onset: utc("2020-06-05T09:48:30.000Z"),
      onsetKnown: true,
      headline: true,
    });
  });

  it("scores an injection window against its fault, benign as the injection catalog says", () => {
    const [cooler, ambient] = injectionWindows(
      [
        OIL_COOLER,
        {
          ...OIL_COOLER,
          instance_id: "inj-a1-000002",
          injection_id: "high_ambient_temperature",
          fault_id: "high_ambient_temperature",
          start_sim_ts: utc("2020-06-05T12:00:00.000Z"),
          end_sim_ts: null,
        },
      ],
      coverage,
    );
    expect(cooler).toEqual({
      id: "oil_cooler_fouling@2020-02-01T02:00:00.000Z",
      from: utc("2020-02-01T02:00:00.000Z"),
      to: utc("2020-02-01T05:00:00.000Z"),
      leadFrom: utc("2020-02-01T02:00:00.000Z"),
      accepted: ["oil_cooler_fouled"],
      benign: false,
      onset: utc("2020-02-01T02:00:00.000Z"),
      onsetKnown: true,
      headline: false,
    });
    // No stop and no planned end: the window runs to the end of the replay.
    expect(ambient).toMatchObject({ benign: true, to: utc("2020-06-05T14:00:00.000Z") });
  });

  it("resolves a jump marker to its preset's failure", () => {
    const [jump, reset] = resolveMarkers([
      JUMP_TO_F3,
      { ...JUMP_TO_F3, kind: "reset", preset_id: "baseline_feb" },
    ]);
    expect(jump).toMatchObject({ kind: "jump", presetId: "f3_air_leak_jun05", failureId: "F3" });
    expect(reset).toMatchObject({ kind: "reset", presetId: "baseline_feb", failureId: null });
  });
});

describe("ticketRecord", () => {
  it("takes the fault the opening decision named, not the one the row holds now", () => {
    const record = ticketRecord(
      ticket({
        ticket_id: "t-1",
        status: "review",
        fault_id: "oil_level_low",
        opened_sim_ts: utc("2020-02-01T03:00:00.000Z"),
      }),
      [
        decision({ decision_id: "d-1", gate_outcome: "review", confidence: 0.7 }),
        decision({
          decision_id: "d-2",
          sim_ts: utc("2020-02-01T03:30:00.000Z"),
          choice: "oil_level_low",
          gate_outcome: "log",
          confidence: 0.4,
        }),
      ],
    );
    expect(record).toEqual({
      ticketId: "t-1",
      episodeId: "e-1",
      openedSimTs: utc("2020-02-01T03:00:00.000Z"),
      faultAtOpen: "oil_cooler_fouled",
      faultLatest: "oil_level_low",
      maxLevel: "review",
    });
  });

  it("is a ticket-level ticket once a decision gated ticket drove it, even after it resolved", () => {
    const record = ticketRecord(
      ticket({
        ticket_id: "t-2",
        status: "resolved",
        resolved_sim_ts: utc("2020-02-01T05:30:00.000Z"),
      }),
      [
        decision({ decision_id: "d-1", gate_outcome: "review", confidence: 0.7 }),
        decision({ decision_id: "d-2", sim_ts: utc("2020-02-01T04:00:00.000Z") }),
      ],
    );
    expect(record).toMatchObject({
      maxLevel: "ticket",
      closedSimTs: utc("2020-02-01T05:30:00.000Z"),
    });
  });

  it("leaves the live state at the first verdict when nothing resolved it first", () => {
    const record = ticketRecord(
      ticket({
        ticket_id: "t-3",
        status: "closed",
        closed_sim_ts: utc("2020-02-01T04:10:00.000Z"),
      }),
      [decision({ decision_id: "d-1" })],
    );
    expect(record.closedSimTs).toEqual(utc("2020-02-01T04:10:00.000Z"));
    expect(record.maxLevel).toBe("ticket");
  });
});

describe("decisionRecord", () => {
  it("calls a choice benign from the candidate's flag or the ground truth, never none_of_these", () => {
    const benign = new Set(["high_ambient_temperature"]);
    const flagged = new Map([["d-1", true]]);
    expect(decisionRecord(decision({ decision_id: "d-1" }), benign, flagged).benignChoice).toBe(
      true,
    );
    expect(
      decisionRecord(decision({ decision_id: "d-2", choice: "high_ambient_temperature" }), benign)
        .benignChoice,
    ).toBe(true);
    expect(
      decisionRecord(decision({ decision_id: "d-3", choice: "none_of_these" }), benign, flagged)
        .benignChoice,
    ).toBe(false);
  });
});

describe("stackThresholds and stackPrices", () => {
  it("reads the gate the latest decision was gated at, else the environment's", () => {
    expect(
      stackThresholds(
        [
          decision({ decision_id: "d-1", ticket_min: 0.8, review_min: 0.5 }),
          decision({ decision_id: "d-2", ticket_min: 0.9, review_min: 0.7 }),
          decision({ decision_id: "d-3", ticket_min: null, review_min: null }),
        ],
        DEFAULTS.gate,
      ),
    ).toEqual({ thresholds: { ticketMin: 0.9, reviewMin: 0.7 }, source: "decisions" });
    expect(stackThresholds([], DEFAULTS.gate)).toEqual({
      thresholds: DEFAULTS.gate,
      source: "environment",
    });
  });

  it("reads the persistence the latest decision states, else the environment's", () => {
    expect(
      stackPersistence(
        [
          decision({ decision_id: "d-1", persist_min: 5 }),
          decision({ decision_id: "d-2", persist_min: 3 }),
          decision({ decision_id: "d-3", persist_min: null }),
          decision({ decision_id: "d-4" }),
        ],
        DEFAULTS.persistSimMin,
      ),
    ).toBe(3);
    expect(stackPersistence([decision({ decision_id: "d-1" })], DEFAULTS.persistSimMin)).toBe(
      DEFAULTS.persistSimMin,
    );
    expect(stackPersistence([], 0)).toBe(0);
  });

  it("bills at the ledger's prices, falling back per backend", () => {
    const ledger: LedgerRow[] = [
      {
        backend: "jev",
        model: "jev-1.13.0",
        calls: 2,
        input_tokens: 2960,
        output_tokens: 0,
        cost_usd: 0.00012432,
        price_input_per_mtok: 0.042,
        price_output_per_mtok: 0,
        prices_as_of: "2026-09-20",
      },
    ];
    expect(stackPrices(ledger, TEST_PRICES)).toEqual({
      ...TEST_PRICES,
      jevInputPerMtok: 0.042,
      asOf: "2026-09-20",
    });
    expect(stackPrices([], TEST_PRICES)).toEqual(TEST_PRICES);
  });
});

describe("scoreStack", () => {
  const options = {
    catalog: { entries: [] },
    prices: TEST_PRICES,
    thresholds: DEFAULTS.gate,
    nativeAlarmCodes: ["W102", "W103"],
  };

  it("scores one pair per backend of the one stack scenario", () => {
    const score = scoreStack(
      rows({
        decisions: [
          decision({ decision_id: "d-1" }),
          decision({
            decision_id: "d-2",
            episode_id: "e-2",
            sim_ts: utc("2020-06-05T07:00:00.000Z"),
            choice: "airend_bearing_wear",
            gate_outcome: "review",
            confidence: 0.65,
          }),
          decision({
            decision_id: "d-3",
            status: "failed",
            choice: "none_of_these",
            gate_outcome: "log",
          }),
        ],
        tickets: [
          ticket({ ticket_id: "t-1" }),
          ticket({
            ticket_id: "t-2",
            episode_id: "e-2",
            status: "review",
            fault_id: "airend_bearing_wear",
            opened_sim_ts: utc("2020-06-05T07:00:00.000Z"),
          }),
        ],
        alarms: [{ code: "W102", sim_ts: utc("2020-02-01T04:00:00.000Z") }],
      }),
      options,
    );

    expect(
      score.windows.map((entry) => [entry.kind, entry.window.id, entry.reachedByJump]),
    ).toEqual([
      ["failure", "F3", true],
      ["injection", "oil_cooler_fouling@2020-02-01T02:00:00.000Z", false],
    ]);
    expect(score.backends).toHaveLength(1);
    const [rules] = score.backends;
    expect(rules?.backend).toBe("rules");
    expect(rules?.decisionRows).toBe(3);
    expect(rules?.failures).toBe(1);

    const result = rules?.result;
    expect(result?.bound.scenario.id).toBe(STACK_SCENARIO_ID);
    expect(result?.bound.scenario.positive).toBe(true);
    expect(result?.binding.gaps).toEqual(score.coverage.holes);
    expect(result?.summary.tickets.map((t) => [t.ticketId, t.faultAtOpen, t.maxLevel])).toEqual([
      ["t-1", "oil_cooler_fouled", "ticket"],
      ["t-2", "airend_bearing_wear", "review"],
    ]);
    expect(result?.summary.decisions.map((d) => d.decisionId)).toEqual(["d-1", "d-2"]);
    expect(result?.summary.openAtEnd).toEqual(["t-1", "t-2"]);

    const metrics = result?.metrics;
    expect(metrics?.match.ticket.tp.map((m) => m.window.id)).toEqual([
      "oil_cooler_fouling@2020-02-01T02:00:00.000Z",
    ]);
    expect(metrics?.match.review.fp.map((t) => t.ticketId)).toEqual(["t-2"]);
    expect(metrics?.leadTimes[0]).toMatchObject({ nativeCode: "W102", leadMinutes: 60 });
    // 14 replayed hours, of which the injection's 3 and F3's 4 h 11.5 min (from its 09:48:30
    // onset, the credited span) are positive.
    expect(metrics?.rates.coveredMachineDays).toBeCloseTo(14 / 24, 12);
    expect(metrics?.rates.negativeMachineDays).toBeCloseTo((14 * 60 - 180 - 251.5) / 1440, 12);
  });

  it("scores every backend's pair at detection level on the unit's suspect events", () => {
    const score = scoreStack(
      rows({
        suspects: [
          {
            event_id: "ev-oil",
            sim_ts: utc("2020-02-01T02:40:00.000Z"),
            symptom_key: "oil_temperature_high",
          },
          {
            event_id: "ev-purge",
            sim_ts: utc("2020-06-05T09:55:00.000Z"),
            symptom_key: "continuous_load",
          },
        ],
        decisions: [
          decision({ decision_id: "d-1" }),
          decision({ decision_id: "d-j", backend: "jev", model: "jev-1.13.0" }),
        ],
      }),
      options,
    );
    expect(score.backends.map((entry) => entry.backend)).toEqual(["rules", "jev"]);
    for (const entry of score.backends) {
      const { metrics, summary } = entry.result;
      expect(summary.suspectEvents?.map((event) => event.eventId)).toEqual(["ev-oil", "ev-purge"]);
      expect(metrics.detection.windows.map((window) => [window.windowId, window.detected])).toEqual(
        [
          ["F3", true],
          ["oil_cooler_fouling@2020-02-01T02:00:00.000Z", true],
        ],
      );
      expect(metrics.pass.detection).toBe(true);
    }
  });

  it("refuses a database that diagnosed nothing, and a backend it does not know", () => {
    expect(() => scoreStack(rows(), options)).toThrow(/nothing was diagnosed/);
    expect(() =>
      scoreStack(
        rows({ decisions: [decision({ decision_id: "d-1", backend: "oracle" })] }),
        options,
      ),
    ).toThrow(/does not know: oracle/);
  });
});

/**
 * The credited span in both scorers: a correct ticket at F3's data onset + 2 min is a true
 * positive and one at onset − 1 min a false positive, whether it comes from an in-process replay
 * of `f3_air_leak_jun05` or from the rows of a stack that jumped to the F3 preset. The stack is
 * the CI smoke's shape above, whose 5 June segment starts at 06:00, before the onset.
 */
describe("the true-positive span in stack mode and in process", () => {
  const ONSET = utc("2020-06-05T09:48:30.000Z");
  const options = {
    catalog: { entries: [] },
    prices: TEST_PRICES,
    thresholds: DEFAULTS.gate,
    nativeAlarmCodes: ["W102", "W103"],
  };

  function f3Scenario() {
    const scenario = loadAll().find((candidate) => candidate.id === "f3_air_leak_jun05");
    if (scenario === undefined) throw new Error("no committed f3_air_leak_jun05");
    return scenario;
  }

  function outcome(match: MatchResult): Record<string, string[]> {
    return {
      tp: match.tp.map((entry) => entry.ticket.ticketId),
      fp: match.fp.map((entry) => entry.ticketId),
      fn: match.fn.map((entry) => entry.id),
    };
  }

  /** The F3 scenario scored in process, with one correct ticket. */
  function inProcess(opened: Date): MatchResult {
    const metrics = scoreScenario(
      toBinding(bindScenario(f3Scenario(), { profile: "core" })),
      [
        {
          ticketId: "t-1",
          episodeId: "e-2",
          openedSimTs: opened,
          faultAtOpen: "dryer_purge_leak",
          faultLatest: "dryer_purge_leak",
          maxLevel: "ticket",
        },
      ],
      [],
      [],
      TEST_PRICES,
      { backend: "rules" },
    );
    return metrics.match.review;
  }

  /** The same ticket as a stack leaves it, scored from the rows; only the F3 window is kept. */
  function stack(opened: Date): MatchResult {
    const score = scoreStack(
      rows({
        injections: [],
        decisions: [
          decision({
            decision_id: "d-1",
            episode_id: "e-2",
            sim_ts: opened,
            choice: "dryer_purge_leak",
          }),
        ],
        tickets: [
          ticket({
            ticket_id: "t-1",
            episode_id: "e-2",
            fault_id: "dryer_purge_leak",
            opened_sim_ts: opened,
            updated_sim_ts: opened,
          }),
        ],
      }),
      options,
    );
    const match = score.backends[0]?.result.metrics.match.review;
    if (match === undefined) throw new Error("the stack scored no backend");
    return match;
  }

  it.each([
    ["onset + 2 min", 2, { tp: ["t-1"], fp: [], fn: [] }],
    ["onset − 1 min", -1, { tp: [], fp: ["t-1"], fn: ["F3"] }],
  ] as const)("a correct ticket at %s scores the same in both", (_label, minutes, expected) => {
    const opened = new Date(ONSET.getTime() + minutes * 60_000);
    expect(outcome(inProcess(opened))).toEqual(expected);
    expect(outcome(stack(opened))).toEqual(expected);
  });

  it("binds the same F3 span in both", () => {
    const [bound] = bindScenario(f3Scenario(), { profile: "core" }).windows;
    const [fromStack] = failureWindows(stackCoverage(ISLANDS));
    expect(bound?.from).toEqual(ONSET);
    expect(fromStack?.from).toEqual(ONSET);
    expect(fromStack?.leadFrom).toEqual(bound?.leadFrom);
    expect(fromStack?.onset).toEqual(bound?.onset);
  });
});

/**
 * The lead-time reference in both scorers: the native alarm is searched in `[spanFrom, to)`,
 * the credited span, not in `[leadFrom, to)`. The same correct ticket and the same raises — the
 * CTRL-7 port's over the F3 and F2 replays — give the same lead-time row from an in-process
 * score of the scenario and from a `scoreStack` of the rows a stack that replayed the day
 * leaves: F3's `W103` at 09:51:19 and F2's `W102` at 23:25:00, with the `W103` raised at
 * 23:16:35 ahead of it under the scenario's own codes.
 */
describe("the lead-time reference in stack mode and in process", () => {
  function raise(code: string, at: string) {
    return { code, simTs: utc(at) };
  }

  const F3_RAISES = [
    raise("W103", "2020-06-05T09:51:19.000Z"),
    raise("W102", "2020-06-05T09:58:35.000Z"),
  ];
  const F2_RAISES = [
    raise("W103", "2020-05-29T21:35:58.000Z"),
    raise("W103", "2020-05-29T22:51:18.000Z"),
    raise("W103", "2020-05-29T23:16:35.000Z"),
    raise("W102", "2020-05-29T23:25:00.000Z"),
  ];

  /** 5 June as the CI smoke replays it, and the F2 scenario's own range. */
  const F3_DAY = ISLANDS;
  const F2_NIGHT = [island("2020-05-29T18:00:00.000Z", "2020-05-30T11:59:00.000Z")];

  interface Case {
    readonly scenarioId: string;
    readonly islands: readonly MinuteIsland[];
    readonly raises: readonly { readonly code: string; readonly simTs: Date }[];
    readonly opened: Date;
    readonly codes?: readonly string[];
  }

  function scenarioOf(id: string) {
    const scenario = loadAll().find((candidate) => candidate.id === id);
    if (scenario === undefined) throw new Error(`no committed ${id}`);
    return scenario;
  }

  /** The case's scenario scored in process, with one correct ticket. */
  function inProcess(entry: Case) {
    const scenario = scenarioOf(entry.scenarioId);
    const metrics = scoreScenario(
      toBinding(bindScenario(scenario, { profile: "core" })),
      [
        {
          ticketId: "t-1",
          episodeId: "e-2",
          openedSimTs: entry.opened,
          faultAtOpen: "dryer_purge_leak",
          faultLatest: "dryer_purge_leak",
          maxLevel: "ticket",
        },
      ],
      [],
      entry.raises,
      TEST_PRICES,
      { backend: "rules", nativeAlarmCodes: entry.codes ?? scenario.native_alarm_codes ?? [] },
    );
    return metrics.leadTimes;
  }

  /** The same ticket and raises as a stack leaves them, scored from the rows. */
  function stack(entry: Case) {
    const score = scoreStack(
      rows({
        islands: entry.islands,
        markers: [],
        injections: [],
        alarms: entry.raises.map((alarm) => ({ code: alarm.code, sim_ts: alarm.simTs })),
        decisions: [
          decision({
            decision_id: "d-1",
            episode_id: "e-2",
            sim_ts: entry.opened,
            choice: "dryer_purge_leak",
          }),
        ],
        tickets: [
          ticket({
            ticket_id: "t-1",
            episode_id: "e-2",
            fault_id: "dryer_purge_leak",
            opened_sim_ts: entry.opened,
            updated_sim_ts: entry.opened,
          }),
        ],
      }),
      {
        catalog: { entries: [] },
        prices: TEST_PRICES,
        thresholds: DEFAULTS.gate,
        nativeAlarmCodes: entry.codes ?? scenarioOf(entry.scenarioId).native_alarm_codes ?? [],
      },
    );
    const metrics = score.backends[0]?.result.metrics;
    if (metrics === undefined) throw new Error("the stack scored no backend");
    return metrics.leadTimes;
  }

  it.each([
    [
      "F3, a ticket after W103",
      {
        scenarioId: "f3_air_leak_jun05",
        islands: F3_DAY,
        raises: F3_RAISES,
        opened: utc("2020-06-05T09:53:00.000Z"),
      },
      { windowId: "F3", nativeCode: "W103", nativeFirst: "2020-06-05T09:51:19.000Z" },
    ],
    [
      "F3, a ticket after the start",
      {
        scenarioId: "f3_air_leak_jun05",
        islands: F3_DAY,
        raises: F3_RAISES,
        opened: utc("2020-06-05T10:05:00.000Z"),
      },
      { windowId: "F3", nativeCode: "W103", nativeFirst: "2020-06-05T09:51:19.000Z" },
    ],
    [
      "F2, W102 only",
      {
        scenarioId: "f2_air_leak_may30",
        islands: F2_NIGHT,
        raises: F2_RAISES,
        opened: utc("2020-05-29T23:20:00.000Z"),
        codes: ["W102"],
      },
      { windowId: "F2", nativeCode: "W102", nativeFirst: "2020-05-29T23:25:00.000Z" },
    ],
    [
      "F2, the scenario's codes",
      {
        scenarioId: "f2_air_leak_may30",
        islands: F2_NIGHT,
        raises: F2_RAISES,
        opened: utc("2020-05-29T23:20:00.000Z"),
      },
      { windowId: "F2", nativeCode: "W103", nativeFirst: "2020-05-29T23:16:35.000Z" },
    ],
  ] as const)("%s: the same reference in both", (_label, entry, expected) => {
    const local = inProcess(entry);
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({ ...expected, nativeFirst: utc(expected.nativeFirst) });
    expect(stack(entry)).toEqual(local);
  });
});
