// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The seven scoring outcomes, case by case.
//
// Everything is in minutes from `EPOCH` so a case reads as a timeline rather
// than as a wall of ISO strings, and every case names the tickets it expects
// in each bucket by id, so a regression says which ticket moved where.

import { describe, expect, it } from "vitest";

import { matchTickets, mergeMatches, spanFrom, type MatchResult } from "./match.ts";
import { at, excluded, ticket, window } from "./fixtures.ts";
import type { ExcludedWindow, Level, ScoringWindow, TicketRecord } from "./types.ts";

/** The window every boundary case is scored against: `[60, 120)` with a lead-in from 30. */
const WINDOW = window({
  id: "W",
  from: at(60),
  to: at(120),
  leadFrom: at(30),
  accepted: ["air_leak_downstream", "air_leak_dryer_purge"],
});

interface Case {
  readonly name: string;
  readonly windows?: readonly ScoringWindow[];
  readonly excluded?: readonly ExcludedWindow[];
  readonly tickets: readonly TicketRecord[];
  readonly benign?: readonly string[];
  readonly level?: Level;
  readonly expect: {
    readonly tp?: readonly string[];
    readonly fp?: readonly string[];
    readonly misdiagnosed?: readonly string[];
    readonly recovered?: readonly string[];
    readonly duplicates?: readonly string[];
    readonly ignored?: readonly string[];
    readonly benign?: readonly string[];
    readonly fn?: readonly string[];
  };
}

const CASES: readonly Case[] = [
  {
    name: "a correct ticket at the lead-in boundary is a true positive (inclusive)",
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(30) })],
    expect: { tp: ["t1"] },
  },
  {
    name: "a correct ticket one millisecond before the lead-in is a false positive",
    tickets: [ticket({ ticketId: "t1", openedSimTs: new Date(at(30).getTime() - 1) })],
    expect: { fp: ["t1"], fn: ["W"] },
  },
  {
    name: "a correct ticket at the window end is outside it (exclusive)",
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(120) })],
    expect: { fp: ["t1"], fn: ["W"] },
  },
  {
    name: "a correct ticket one millisecond before the end is still inside",
    tickets: [ticket({ ticketId: "t1", openedSimTs: new Date(at(120).getTime() - 1) })],
    expect: { tp: ["t1"] },
  },
  {
    name: "an alternative accepted fault counts as a true positive",
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(70), faultAtOpen: "air_leak_dryer_purge" })],
    expect: { tp: ["t1"] },
  },
  {
    name: "a wrong ticket followed by a right one is a misdiagnosis, then a recovery",
    tickets: [
      ticket({ ticketId: "t1", openedSimTs: at(70), faultAtOpen: "oil_cooler_fouling" }),
      ticket({ ticketId: "t2", openedSimTs: at(90) }),
    ],
    expect: {
      tp: ["t2"],
      fp: ["t1"],
      misdiagnosed: ["t1"],
      recovered: ["t2"],
    },
  },
  {
    name: "a wrong ticket alone leaves the window missed",
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(70), faultAtOpen: "oil_cooler_fouling" })],
    expect: { fp: ["t1"], misdiagnosed: ["t1"], fn: ["W"] },
  },
  {
    name: "a second correct ticket in the window is a duplicate, never a false positive",
    tickets: [
      ticket({ ticketId: "t1", openedSimTs: at(70) }),
      ticket({ ticketId: "t2", openedSimTs: at(90), faultAtOpen: "air_leak_dryer_purge" }),
    ],
    expect: { tp: ["t1"], duplicates: ["t2"] },
  },
  {
    name: "a ticket opened in an excluded window is ignored",
    excluded: [excluded({ id: "repair", from: at(200), to: at(260) })],
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(210), faultAtOpen: "motor_overload" })],
    expect: { ignored: ["t1"], fn: ["W"] },
  },
  {
    name: "a failure window wins over an excluded one that reaches into it",
    excluded: [excluded({ id: "frozen", from: at(90), to: at(200) })],
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(100) })],
    expect: { tp: ["t1"] },
  },
  {
    name: "a benign fault is never a false positive, inside or outside a window",
    benign: ["high_ambient_temperature"],
    tickets: [
      ticket({ ticketId: "t1", openedSimTs: at(70), faultAtOpen: "high_ambient_temperature" }),
      ticket({ ticketId: "t2", openedSimTs: at(300), faultAtOpen: "high_ambient_temperature" }),
    ],
    expect: { benign: ["t1", "t2"], fn: ["W"] },
  },
  {
    name: "a benign window is neither detected nor missed",
    windows: [window({ id: "B", from: at(60), to: at(120), benign: true, accepted: ["depot"] })],
    benign: ["depot"],
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(70), faultAtOpen: "depot" })],
    expect: { benign: ["t1"] },
  },
  {
    name: "a review-only ticket participates at review level",
    level: "review",
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(70), maxLevel: "review" })],
    expect: { tp: ["t1"] },
  },
  {
    name: "a review-only ticket does not exist at ticket level",
    level: "ticket",
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(70), maxLevel: "review" })],
    expect: { fn: ["W"] },
  },
  {
    name: "at ticket level a later promoted ticket takes the review item's place",
    level: "ticket",
    tickets: [
      ticket({ ticketId: "t1", openedSimTs: at(70), maxLevel: "review" }),
      ticket({ ticketId: "t2", openedSimTs: at(90), maxLevel: "ticket" }),
    ],
    expect: { tp: ["t2"] },
  },
  {
    name: "overlapping windows give the correct answer its own window",
    windows: [
      window({
        id: "precursor",
        from: at(0),
        to: at(120),
        leadFrom: at(0),
        accepted: ["heavy_air_demand"],
      }),
      WINDOW,
    ],
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(70) })],
    expect: { tp: ["t1"], fn: ["precursor"] },
  },
  {
    name: "tickets are classified in opening order, whatever order they arrive in",
    tickets: [
      ticket({ ticketId: "t2", openedSimTs: at(90) }),
      ticket({ ticketId: "t1", openedSimTs: at(70), faultAtOpen: "oil_cooler_fouling" }),
    ],
    expect: { tp: ["t2"], fp: ["t1"], misdiagnosed: ["t1"], recovered: ["t2"] },
  },
];

function ids(result: MatchResult): Record<string, string[]> {
  return {
    tp: result.tp.map(({ ticket: entry }) => entry.ticketId),
    fp: result.fp.map((entry) => entry.ticketId),
    misdiagnosed: result.misdiagnosed.map(({ ticket: entry }) => entry.ticketId),
    recovered: result.recovered.map(({ ticket: entry }) => entry.ticketId),
    duplicates: result.duplicates.map(({ ticket: entry }) => entry.ticketId),
    ignored: result.ignored.map((entry) => entry.ticketId),
    benign: result.benign.map((entry) => entry.ticketId),
    fn: result.fn.map((entry) => entry.id),
  };
}

describe("matchTickets", () => {
  it.each(CASES)("$name", (testCase) => {
    const result = matchTickets(
      testCase.windows ?? [WINDOW],
      testCase.excluded ?? [],
      testCase.tickets,
      new Set(testCase.benign ?? []),
      testCase.level ?? "review",
    );

    expect(ids(result)).toEqual({
      tp: [...(testCase.expect.tp ?? [])],
      fp: [...(testCase.expect.fp ?? [])],
      misdiagnosed: [...(testCase.expect.misdiagnosed ?? [])],
      recovered: [...(testCase.expect.recovered ?? [])],
      duplicates: [...(testCase.expect.duplicates ?? [])],
      ignored: [...(testCase.expect.ignored ?? [])],
      benign: [...(testCase.expect.benign ?? [])],
      fn: [...(testCase.expect.fn ?? [])],
    });
  });

  it("defaults to review level, the wider of the two", () => {
    const result = matchTickets(
      [WINDOW],
      [],
      [ticket({ ticketId: "t1", openedSimTs: at(70), maxLevel: "review" })],
      new Set(),
    );
    expect(result.level).toBe("review");
    expect(result.tp).toHaveLength(1);
  });

  it("rejects a window whose bounds name no instant", () => {
    expect(() =>
      matchTickets(
        [window({ id: "broken", from: new Date("not a date") })],
        [],
        [ticket({ ticketId: "t1" })],
        new Set(),
      ),
    ).toThrow(RangeError);
  });
});

/**
 * The credited span: a window whose onset is known opens at `min(leadFrom, onset)`.
 * `ONSET_FIRST` is F3's and F2's shape — no precursor, the data turning before the labelled
 * start: `[60, 120)`, onset at 50.
 */
const ONSET_FIRST = window({
  id: "F",
  from: at(60),
  to: at(120),
  onset: at(50),
  onsetKnown: true,
  accepted: ["dryer_purge_leak", "downstream_air_leak"],
});

const SPAN_CASES: readonly (Case & { readonly window: ScoringWindow })[] = [
  {
    name: "a correct ticket at onset + 2 min, before the labelled start, is a true positive",
    window: ONSET_FIRST,
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(52), faultAtOpen: "dryer_purge_leak" })],
    expect: { tp: ["t1"] },
  },
  {
    name: "a correct ticket at the onset itself is a true positive (inclusive)",
    window: ONSET_FIRST,
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(50), faultAtOpen: "dryer_purge_leak" })],
    expect: { tp: ["t1"] },
  },
  {
    name: "a correct ticket at onset − 1 min is still a false positive",
    window: ONSET_FIRST,
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(49), faultAtOpen: "dryer_purge_leak" })],
    expect: { fp: ["t1"], fn: ["F"] },
  },
  {
    name: "a wrong ticket between the onset and the start is a misdiagnosis of the window",
    window: ONSET_FIRST,
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(52), faultAtOpen: "motor_overload" })],
    expect: { fp: ["t1"], misdiagnosed: ["t1"], fn: ["F"] },
  },
  {
    name: "an onset that is only a lower bound does not open the span (F1)",
    window: window({ ...ONSET_FIRST, onsetKnown: false }),
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(52), faultAtOpen: "dryer_purge_leak" })],
    expect: { fp: ["t1"], fn: ["F"] },
  },
  {
    name: "a precursor earlier than the onset keeps the span at the precursor (F4)",
    window: window({ ...ONSET_FIRST, leadFrom: at(30) }),
    tickets: [
      ticket({ ticketId: "t0", openedSimTs: at(29), faultAtOpen: "dryer_purge_leak" }),
      ticket({ ticketId: "t1", openedSimTs: at(30), faultAtOpen: "dryer_purge_leak" }),
    ],
    expect: { tp: ["t1"], fp: ["t0"] },
  },
  {
    name: "an onset after the labelled start never moves the span later (F4b)",
    window: window({ ...ONSET_FIRST, onset: at(90) }),
    tickets: [ticket({ ticketId: "t1", openedSimTs: at(60), faultAtOpen: "dryer_purge_leak" })],
    expect: { tp: ["t1"] },
  },
];

describe("the true-positive span", () => {
  it.each([
    ["a known onset before the start opens it (F2, F3)", ONSET_FIRST, at(50)],
    ["an onset that is a lower bound does not (F1)", { ...ONSET_FIRST, onsetKnown: false }, at(60)],
    ["an earlier precursor keeps it (F4)", { ...ONSET_FIRST, leadFrom: at(30) }, at(30)],
    ["a later onset never delays it (F4b)", { ...ONSET_FIRST, onset: at(90) }, at(60)],
    ["an injection's onset is its lead_from", window({ id: "I", onset: at(0) }), at(0)],
    ["no onset leaves lead_from", window({ id: "N", leadFrom: at(10) }), at(10)],
  ] as const)("spanFrom: %s", (_name, entry, expected) => {
    expect(spanFrom(entry)).toEqual(expected);
  });

  it("rejects an onset that names no instant", () => {
    expect(() => spanFrom({ ...ONSET_FIRST, onset: new Date("not a date") })).toThrow(RangeError);
  });

  it.each(SPAN_CASES)("$name", (testCase) => {
    const result = matchTickets([testCase.window], [], testCase.tickets, new Set(), "review");
    expect(ids(result)).toEqual({
      tp: [...(testCase.expect.tp ?? [])],
      fp: [...(testCase.expect.fp ?? [])],
      misdiagnosed: [...(testCase.expect.misdiagnosed ?? [])],
      recovered: [],
      duplicates: [],
      ignored: [],
      benign: [],
      fn: [...(testCase.expect.fn ?? [])],
    });
  });
});

describe("mergeMatches", () => {
  it("pools the buckets of several scenarios", () => {
    const first = matchTickets(
      [WINDOW],
      [],
      [ticket({ ticketId: "t1", openedSimTs: at(70) })],
      new Set(),
      "ticket",
    );
    const second = matchTickets(
      [window({ id: "W2", from: at(300), to: at(360), accepted: ["motor_overload"] })],
      [],
      [ticket({ ticketId: "t2", openedSimTs: at(310), faultAtOpen: "oil_cooler_fouling" })],
      new Set(),
      "ticket",
    );

    const merged = mergeMatches([first, second], "ticket");
    expect(merged.tp).toHaveLength(1);
    expect(merged.fp).toHaveLength(1);
    expect(merged.fn.map((entry) => entry.id)).toEqual(["W2"]);
    expect(merged.windows).toHaveLength(2);
  });

  it("refuses to mix two levels", () => {
    const ticketLevel = matchTickets([WINDOW], [], [], new Set(), "ticket");
    expect(() => mergeMatches([ticketLevel], "review")).toThrow(TypeError);
  });
});
