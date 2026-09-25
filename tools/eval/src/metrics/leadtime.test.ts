// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Lead time and detection latency: the sign, the `>=` qualifier and the two
// native references.

import { describe, expect, it } from "vitest";

import { matchTickets } from "./match.ts";
import { firstAlarmByWindow, leadTimes } from "./leadtime.ts";
import { at, ticket, window } from "./fixtures.ts";

const LEAK = window({
  id: "W1",
  from: at(60),
  to: at(180),
  leadFrom: at(30),
  accepted: ["air_leak_downstream"],
  onset: at(60),
});

function detected(openedAt: number, at_: typeof LEAK = LEAK) {
  return matchTickets(
    [at_],
    [],
    [ticket({ ticketId: "t1", openedSimTs: at(openedAt) })],
    new Set(),
    "review",
  );
}

describe("leadTimes", () => {
  it("is positive when the ticket opened before the native alarm", () => {
    const rows = leadTimes(detected(70), new Map([["W1", { code: "W102", simTs: at(100) }]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      windowId: "W1",
      fault: "air_leak_downstream",
      nativeCode: "W102",
      leadMinutes: 30,
      latencyMinutes: 10,
      qualifier: "",
    });
  });

  it("is negative when the controller was there first", () => {
    const rows = leadTimes(detected(110), new Map([["W1", { code: "W102", simTs: at(100) }]]));
    expect(rows[0]?.leadMinutes).toBe(-10);
  });

  it("carries no lead time when no native alarm fired in the window", () => {
    const rows = leadTimes(detected(70), new Map([["W1", null]]));
    expect(rows[0]?.leadMinutes).toBeUndefined();
    expect(rows[0]?.nativeCode).toBeUndefined();
    expect(rows[0]?.latencyMinutes).toBe(10);
  });

  it("qualifies the latency with >= when the onset is a lower bound", () => {
    const unknownOnset = window({ ...LEAK, onsetKnown: false });
    const rows = leadTimes(detected(70, unknownOnset), new Map());
    expect(rows[0]?.qualifier).toBe(">=");
  });

  it("measures the latency from the window start when there is no onset", () => {
    const noOnset = window({
      id: "W1",
      from: at(60),
      to: at(180),
      leadFrom: at(30),
      accepted: ["air_leak_downstream"],
    });
    const rows = leadTimes(detected(90, noOnset), new Map());
    expect(rows[0]?.latencyMinutes).toBe(30);
  });

  it("is negative in the precursor, where the ticket precedes the onset", () => {
    const rows = leadTimes(detected(40), new Map());
    expect(rows[0]?.latencyMinutes).toBe(-20);
  });

  it("reports the LPS reference beside the CTRL-7 one", () => {
    const withLps = window({ ...LEAK, nativeLpsFirst: at(150) });
    const rows = leadTimes(
      detected(70, withLps),
      new Map([["W1", { code: "W102", simTs: at(100) }]]),
    );
    expect(rows[0]?.leadMinutes).toBe(30);
    expect(rows[0]?.lpsLeadMinutes).toBe(80);
  });

  it("lets a stack-mode override replace the window's own LPS reference", () => {
    const withLps = window({ ...LEAK, nativeLpsFirst: at(150) });
    const rows = leadTimes(detected(70, withLps), new Map(), new Map([["W1", at(120)]]));
    expect(rows[0]?.lpsLeadMinutes).toBe(50);
  });

  it("reports nothing for a window nobody detected", () => {
    const missed = matchTickets([LEAK], [], [], new Set(), "review");
    expect(leadTimes(missed, new Map())).toEqual([]);
  });
});

describe("firstAlarmByWindow", () => {
  const alarms = [
    { code: "W101", simTs: at(20) },
    { code: "W103", simTs: at(110) },
    { code: "W102", simTs: at(100) },
    { code: "W102", simTs: at(200) },
  ];

  it("takes the earliest activation inside [spanFrom, to)", () => {
    const byWindow = firstAlarmByWindow([LEAK], alarms, ["W102", "W103"]);
    expect(byWindow.get("W1")).toEqual({ code: "W102", simTs: at(100) });
  });

  it("ignores activations before the lead-in and at or after the end", () => {
    const byWindow = firstAlarmByWindow([LEAK], alarms, ["W101"]);
    expect(byWindow.get("W1")).toBeNull();
  });

  it("takes every code when the scenario names none", () => {
    const byWindow = firstAlarmByWindow([LEAK], alarms);
    expect(byWindow.get("W1")).toEqual({ code: "W102", simTs: at(100) });
  });
});

/**
 * The native search opens where the true-positive span opens (the credited span): `[spanFrom, to)`,
 * not `[leadFrom, to)`. `ONSET_FIRST` is F3's and F2's shape — no precursor, the data turning
 * before the labelled start: start and `leadFrom` at 60, onset at 50, so the bound window runs
 * `[50, 180)` — and an activation in `[onset, start)` is now the reference, and a ticket credited
 * in that stretch is measured against it.
 */
describe("the native search over the credited span", () => {
  const ONSET_FIRST = window({
    id: "F",
    from: at(50),
    to: at(180),
    leadFrom: at(60),
    accepted: ["air_leak_downstream"],
    onset: at(50),
    nativeLpsFirst: at(150),
  });
  const RAISES = [
    { code: "W103", simTs: at(40) },
    { code: "W103", simTs: at(52) },
    { code: "W102", simTs: at(58) },
    { code: "W102", simTs: at(100) },
  ];

  it.each([
    [
      "an activation between a known onset and the start is the reference (F2, F3)",
      ONSET_FIRST,
      { code: "W103", simTs: at(52) },
    ],
    [
      "an onset that is only a lower bound opens nothing (F1)",
      window({ ...ONSET_FIRST, onsetKnown: false }),
      { code: "W102", simTs: at(100) },
    ],
    [
      "an earlier precursor keeps the search at the precursor (F4)",
      window({ ...ONSET_FIRST, leadFrom: at(30) }),
      { code: "W103", simTs: at(40) },
    ],
    [
      "an onset after the start never delays the search (F4b)",
      window({ ...ONSET_FIRST, from: at(55), leadFrom: at(55), onset: at(90) }),
      { code: "W102", simTs: at(58) },
    ],
  ] as const)("%s", (_name, entry, expected) => {
    expect(firstAlarmByWindow([entry], RAISES).get(entry.id)).toEqual(expected);
  });

  it("still ignores an activation before the onset", () => {
    const byWindow = firstAlarmByWindow([ONSET_FIRST], [{ code: "W103", simTs: at(49) }]);
    expect(byWindow.get("F")).toBeNull();
  });

  it("measures a ticket credited before the start against the activation in the stretch", () => {
    const match = matchTickets(
      [ONSET_FIRST],
      [],
      [ticket({ ticketId: "t1", openedSimTs: at(55) })],
      new Set(),
      "review",
    );
    const [row] = leadTimes(match, firstAlarmByWindow([ONSET_FIRST], RAISES, ["W102", "W103"]));
    expect(row).toMatchObject({
      nativeCode: "W103",
      nativeFirst: at(52),
      leadMinutes: -3,
      // Latency still runs from the onset and the LPS reference is the window's own.
      latencyMinutes: 5,
      lpsFirst: at(150),
      lpsLeadMinutes: 95,
    });
  });
});
