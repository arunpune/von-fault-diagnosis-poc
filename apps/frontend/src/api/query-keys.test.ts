// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { qk } from "@/api/query-keys";

function startsWith(key: readonly unknown[], prefix: readonly unknown[]): boolean {
  return prefix.every((part, index) => Object.is(key[index], part));
}

describe("query keys", () => {
  it("nest every list under the prefix its reducers invalidate", () => {
    expect(startsWith(qk.decisions(), qk.decisionLists())).toBe(true);
    expect(startsWith(qk.decisions("episode-1"), qk.decisionLists())).toBe(true);
    expect(startsWith(qk.tickets("review"), qk.ticketLists())).toBe(true);
    expect(startsWith(qk.overlayInjections({ from: 1, to: 2 }), qk.overlayInjectionLists())).toBe(
      true,
    );
    expect(startsWith(qk.overlayMarkers({}), qk.overlayMarkerLists())).toBe(true);
  });

  it("keep a list apart from the detail of one of its items", () => {
    expect(startsWith(qk.decision("d-1"), qk.decisionLists())).toBe(false);
    expect(startsWith(qk.ticket("t-1"), qk.ticketLists())).toBe(false);
  });

  it("spell an absent filter or bound as null, so equal requests share one entry", () => {
    expect(qk.decisions()).toEqual(["decisions", null]);
    expect(qk.overlayMarkers({})).toEqual(["overlay", "markers", { from: null, to: null }]);
    expect(qk.series({ from: 1, to: 2 })).toEqual([
      "series",
      { tags: null, from: 1, to: 2, points: null },
    ]);
    expect(qk.series({ tags: ["a", "b"], from: 1, to: 2, points: 600 })).toEqual([
      "series",
      { tags: "a,b", from: 1, to: 2, points: 600 },
    ]);
  });
});
