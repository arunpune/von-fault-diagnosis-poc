// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The gate, the ticket rebuild and the sweep's self-test.
//
// The self-test is the assertion this file exists for: the row at the run's
// own thresholds must reproduce the run's own metrics exactly. A re-gating
// that cannot reproduce the run it came from says nothing about the grid
// points further out.

import { describe, expect, it } from "vitest";

import { couldOpen, gate, sweep, type SweepRun } from "./sweep.ts";
import { matchTickets } from "./match.ts";
import { precisionRecall } from "./precision.ts";
import { at, decision, window } from "./fixtures.ts";
import { NONE_OF_THESE } from "./types.ts";

const WINDOW = window({
  id: "W",
  from: at(0),
  to: at(360),
  accepted: ["oil_cooler_fouling"],
});

interface GateCase {
  readonly name: string;
  readonly choice: string;
  readonly confidence: number;
  readonly outcome: "ticket" | "review" | "log";
  readonly abstained: boolean;
}

const GATE_CASES: readonly GateCase[] = [
  {
    name: "a named fault at the ticket floor opens a ticket",
    choice: "oil_cooler_fouling",
    confidence: 0.85,
    outcome: "ticket",
    abstained: false,
  },
  {
    name: "a named fault just below it goes to review",
    choice: "oil_cooler_fouling",
    confidence: 0.8499,
    outcome: "review",
    abstained: false,
  },
  {
    name: "a named fault at the review floor goes to review",
    choice: "oil_cooler_fouling",
    confidence: 0.6,
    outcome: "review",
    abstained: false,
  },
  {
    name: "a named fault below the review floor is logged",
    choice: "oil_cooler_fouling",
    confidence: 0.59,
    outcome: "log",
    abstained: false,
  },
  {
    name: "a confident none_of_these is an explicit abstention",
    choice: NONE_OF_THESE,
    confidence: 0.9,
    outcome: "log",
    abstained: true,
  },
  {
    name: "an unconfident none_of_these is just a log line",
    choice: NONE_OF_THESE,
    confidence: 0.3,
    outcome: "log",
    abstained: false,
  },
];

describe("gate", () => {
  it.each(GATE_CASES)("$name", (testCase) => {
    expect(gate(testCase.choice, testCase.confidence, 0.85, 0.6)).toEqual({
      outcome: testCase.outcome,
      abstained: testCase.abstained,
    });
  });
});

/** Two episodes: one that needs a promotion to reach ticket level, one that never does. */
function run(overrides: Partial<SweepRun> = {}): SweepRun {
  return {
    split: "dev",
    thresholds: { ticketMin: 0.85, reviewMin: 0.6 },
    windows: [WINDOW],
    excluded: [],
    benignFaultIds: new Set(),
    coveredMachineDays: 1,
    negativeMachineDays: 0.5,
    episodes: [
      {
        episodeId: "e1",
        decisions: [
          decision({
            decisionId: "d2",
            episodeId: "e1",
            simTs: at(60),
            choice: "oil_cooler_fouling",
            confidence: 0.9,
          }),
          decision({
            decisionId: "d1",
            episodeId: "e1",
            simTs: at(30),
            choice: "oil_cooler_fouling",
            confidence: 0.7,
          }),
        ],
      },
      {
        episodeId: "e2",
        decisions: [
          decision({
            decisionId: "d3",
            episodeId: "e2",
            simTs: at(120),
            choice: NONE_OF_THESE,
            confidence: 0.7,
          }),
        ],
      },
    ],
    ...overrides,
  };
}

describe("sweep", () => {
  it("rebuilds a ticket from the first gated decision and promotes it later", () => {
    const [row] = sweep(run(), []);
    expect(row?.tickets).toHaveLength(1);
    expect(row?.tickets[0]).toMatchObject({
      episodeId: "e1",
      openedSimTs: at(30),
      faultAtOpen: "oil_cooler_fouling",
      maxLevel: "ticket",
    });
  });

  it("opens nothing for an episode whose decisions all stay at log", () => {
    const [row] = sweep(run(), []);
    expect(row?.tickets.map((entry) => entry.episodeId)).toEqual(["e1"]);
  });

  it("always marks the row approximate, because merging is not simulated", () => {
    expect(sweep(run(), [[0.9, 0.7]]).every((row) => row.approximate)).toBe(true);
  });

  it("reproduces the run's own metrics at the run's own thresholds", () => {
    const stored = run();
    const rows = sweep(stored, [
      [0.95, 0.9],
      [0.7, 0.5],
    ]);
    const own = rows.find(
      (row) =>
        row.ticketMin === stored.thresholds.ticketMin &&
        row.reviewMin === stored.thresholds.reviewMin,
    );
    expect(own).toBeDefined();

    // The run itself opened exactly the tickets the rebuild produces at its thresholds.
    const expected = precisionRecall(
      matchTickets(
        stored.windows,
        stored.excluded,
        own?.tickets ?? [],
        stored.benignFaultIds,
        "ticket",
      ),
      "ticket",
    );
    expect(own?.precisionRecall.ticket).toEqual(expected);
    expect(own?.precisionRecall.ticket.micro).toMatchObject({ tp: 1, fp: 0, fn: 0 });
  });

  it("adds the run's own pair to the grid when the caller left it out", () => {
    const rows = sweep(run(), [[0.95, 0.9]]);
    expect(rows.map((row) => [row.ticketMin, row.reviewMin])).toEqual([
      [0.85, 0.6],
      [0.95, 0.9],
    ]);
  });

  it("scores a pair only once when the caller repeats it", () => {
    const rows = sweep(run(), [
      [0.85, 0.6],
      [0.85, 0.6],
    ]);
    expect(rows).toHaveLength(1);
  });

  it("counts the explicit abstentions at each pair", () => {
    const rows = sweep(run(), [[0.9, 0.75]]);
    expect(rows.find((row) => row.reviewMin === 0.6)?.abstained).toBe(1);
    expect(rows.find((row) => row.reviewMin === 0.75)?.abstained).toBe(0);
  });

  it("refuses a run on the test split", () => {
    expect(() => sweep(run({ split: "test" }), [])).toThrow(/test split/);
  });

  it("reports a test-split run when the caller opts in", () => {
    expect(sweep(run({ split: "test" }), [], { allowTestSplit: true })).toHaveLength(1);
  });

  it("refuses a held-out run whatever the caller passes", () => {
    expect(() => sweep(run({ split: "heldout" }), [])).toThrow(/held-out run/);
    expect(() => sweep(run({ split: "heldout" }), [], { allowTestSplit: true })).toThrow(
      /never re-gated/,
    );
  });

  it("rejects a review floor above the ticket floor", () => {
    expect(() => sweep(run(), [[0.6, 0.9]])).toThrow(RangeError);
  });

  it("rejects a threshold outside [0, 1]", () => {
    expect(() => sweep(run(), [[1.2, 0.9]])).toThrow(RangeError);
  });
});

describe("the persistence before the ticket", () => {
  /**
   * One episode as a run at 0.60 / 0.85 took it with GATE_PERSIST_SIM_MIN = 1: a persisted
   * review at 0.70 opened its ticket, so a later blip (evidence 0 min old) was decided anyway,
   * because an episode that owns a ticket is exempt; then persisted evidence came back.
   */
  function exemptRun(persistSimMin: number | undefined): SweepRun {
    return run({
      ...(persistSimMin === undefined ? {} : { persistSimMin }),
      episodes: [
        {
          episodeId: "e1",
          decisions: [
            decision({
              decisionId: "d1",
              episodeId: "e1",
              simTs: at(30),
              choice: "oil_cooler_fouling",
              confidence: 0.7,
              persistedSimMin: 1,
            }),
            decision({
              decisionId: "d2",
              episodeId: "e1",
              simTs: at(60),
              choice: "oil_cooler_fouling",
              confidence: 0.9,
              persistedSimMin: 0,
            }),
            decision({
              decisionId: "d3",
              episodeId: "e1",
              simTs: at(90),
              choice: "oil_cooler_fouling",
              confidence: 0.8,
              persistedSimMin: 12,
            }),
          ],
        },
      ],
    });
  }

  it("says which decisions a ticketless episode could have taken", () => {
    const blip = decision({ decisionId: "b", persistedSimMin: 0.5 });
    expect(couldOpen(blip, 1)).toBe(false);
    expect(couldOpen(decision({ decisionId: "p", persistedSimMin: 1 }), 1)).toBe(true);
    // Without the rule, or without the figure (a run recorded before it), every decision could.
    expect(couldOpen(blip, 0)).toBe(true);
    expect(couldOpen(decision({ decisionId: "u" }), 1)).toBe(true);
  });

  it("reproduces the run at its own pair: the exempt blip only updates the open ticket", () => {
    const [own] = sweep(exemptRun(1), []);
    expect(own?.tickets[0]).toMatchObject({ openedSimTs: at(30), maxLevel: "ticket" });
  });

  it("never opens a ticket on the exempt blip at a stricter pair; the next persisted decision does", () => {
    // At review 0.75 the 0.70 review no longer opens anything, so the episode would have owned
    // no ticket at 60 min and its 0-minute evidence would not have been decided at all.
    const rows = sweep(exemptRun(1), [[0.85, 0.75]]);
    const strict = rows.find((row) => row.reviewMin === 0.75);
    expect(strict?.tickets).toHaveLength(1);
    expect(strict?.tickets[0]).toMatchObject({
      openedSimTs: at(90),
      faultAtOpen: "oil_cooler_fouling",
      maxLevel: "review",
    });
  });

  it("re-gates a run recorded without the figure, or at GATE_PERSIST_SIM_MIN 0, as before", () => {
    for (const persistSimMin of [undefined, 0]) {
      const strict = sweep(exemptRun(persistSimMin), [[0.85, 0.75]]).find(
        (row) => row.reviewMin === 0.75,
      );
      expect(strict?.tickets[0]).toMatchObject({ openedSimTs: at(60), maxLevel: "ticket" });
    }
  });
});
