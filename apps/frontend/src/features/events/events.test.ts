// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { Decision } from "@/api/types";
import { latestDecisionByEvent } from "@/features/events/events";
import { fixtures } from "@/test/msw/fixtures";

/** The fixture item at `index`; the fixtures are fixed, so a missing one is a broken fixture. */
function fixtureAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`the fixture list has no item ${index}`);
  }
  return item;
}

// decisions.json: a failed call and an answered decision on two different events, newest first.
const FAILED = fixtureAt(fixtures.decisions.items, 0);
const ANSWERED = fixtureAt(fixtures.decisions.items, 1);

function redecided(decisionId: string, wallTs: string): Decision {
  return { ...structuredClone(ANSWERED), decision_id: decisionId, wall_ts: wallTs };
}

function decisionIds(latest: Map<string, Decision>): Record<string, string> {
  return Object.fromEntries(
    [...latest].map(([eventId, decision]) => [eventId, decision.decision_id]),
  );
}

describe("latestDecisionByEvent", () => {
  it("maps each event to the decision made on it, failed calls included", () => {
    const latest = latestDecisionByEvent(fixtures.decisions.items);

    expect(latest.size).toBe(3);
    expect(latest.get(FAILED.event_id)).toBe(FAILED);
    expect(latest.get(ANSWERED.event_id)).toBe(ANSWERED);
  });

  it("keeps the latest of several decisions on one event by wall time, in any order", () => {
    const later = redecided("later", "2026-06-05T10:00:00.000Z");

    expect(decisionIds(latestDecisionByEvent([ANSWERED, later]))).toEqual({
      [ANSWERED.event_id]: "later",
    });
    expect(decisionIds(latestDecisionByEvent([later, ANSWERED]))).toEqual({
      [ANSWERED.event_id]: "later",
    });
  });

  it("keeps the decision listed first on a tie or an unreadable time", () => {
    const twin = redecided("twin", ANSWERED.wall_ts);
    const unreadable = redecided("unreadable", "not a time");

    expect(latestDecisionByEvent([ANSWERED, twin]).get(ANSWERED.event_id)).toBe(ANSWERED);
    expect(latestDecisionByEvent([unreadable, ANSWERED]).get(ANSWERED.event_id)).toBe(ANSWERED);
  });

  it("is empty without decisions", () => {
    expect(latestDecisionByEvent([]).size).toBe(0);
  });
});
