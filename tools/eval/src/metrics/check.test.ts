// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The MetroPT-3 check: 4/4 passes, 3/4 does not, and the result always says
// it is in-sample — on tickets, and at detection level on the suspect events.

import { describe, expect, it } from "vitest";

import { metropt3Check, metropt3DetectionCheck } from "./check.ts";
import { matchTickets } from "./match.ts";
import { at, ticket, window } from "./fixtures.ts";
import type { Level, WindowDetection } from "./types.ts";

/** The four headline failures, each one hour wide and an hour apart. */
const HEADLINE = ["F1", "F2", "F3", "F4"].map((id, index) =>
  window({
    id,
    from: at(index * 120),
    to: at(index * 120 + 60),
    accepted: ["air_leak_downstream"],
    headline: true,
  }),
);

/** A secondary positive, which the check must not count. */
const SECONDARY = window({
  id: "F4b",
  from: at(600),
  to: at(660),
  accepted: ["air_leak_downstream"],
  headline: false,
});

/**
 * A classification in which exactly `ids` were ticketed.
 *
 * `maxLevel` is how far each ticket got (a review item never leaves the queue), `matchLevel`
 * is the level the check is asked at; the two differ in the strictness case.
 */
function detect(ids: readonly string[], maxLevel: Level = "ticket", matchLevel: Level = "review") {
  const tickets = ids.map((id) => {
    const found = [...HEADLINE, SECONDARY].find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`no window ${id}`);
    return ticket({
      ticketId: `t-${id}`,
      openedSimTs: new Date(found.from.getTime() + 60_000),
      maxLevel,
    });
  });
  return matchTickets([...HEADLINE, SECONDARY], [], tickets, new Set(), matchLevel);
}

describe("metropt3Check", () => {
  it("passes when all four headline failures are found", () => {
    const result = metropt3Check(HEADLINE, detect(["F1", "F2", "F3", "F4"]), "review");
    expect(result).toMatchObject({
      pass: true,
      detected: ["F1", "F2", "F3", "F4"],
      missed: [],
      in_sample: true,
    });
  });

  it("fails at 3 of 4", () => {
    const result = metropt3Check(HEADLINE, detect(["F1", "F2", "F3"]), "review");
    expect(result.pass).toBe(false);
    expect(result.detected).toEqual(["F1", "F2", "F3"]);
    expect(result.missed).toEqual(["F4"]);
  });

  it("never counts a secondary positive", () => {
    const result = metropt3Check(
      [...HEADLINE, SECONDARY],
      detect(["F1", "F2", "F3", "F4", "F4b"]),
      "review",
    );
    expect(result.detected).toEqual(["F1", "F2", "F3", "F4"]);
  });

  it("does not pass over no windows at all", () => {
    const result = metropt3Check([], matchTickets([], [], [], new Set(), "review"), "review");
    expect(result.pass).toBe(false);
  });

  it("is stricter at ticket level than at review level", () => {
    const all = ["F1", "F2", "F3", "F4"];
    expect(metropt3Check(HEADLINE, detect(all, "review", "review"), "review").pass).toBe(true);
    expect(metropt3Check(HEADLINE, detect(all, "review", "ticket"), "ticket").pass).toBe(false);
  });

  it("refuses a level that contradicts the match", () => {
    expect(() => metropt3Check(HEADLINE, detect(["F1"]), "ticket")).toThrow(TypeError);
  });

  it("always carries in_sample: true, whatever the result", () => {
    expect(metropt3Check(HEADLINE, detect([]), "review").in_sample).toBe(true);
  });
});

describe("metropt3DetectionCheck", () => {
  /** A detection of `id`, detected or not. */
  function seen(id: string, detected: boolean, headline = true): WindowDetection {
    return { windowId: id, headline, detected };
  }

  it("passes when a suspect event detected all four headline failures in time", () => {
    const result = metropt3DetectionCheck(["F1", "F2", "F3", "F4"].map((id) => seen(id, true)));
    expect(result).toEqual({
      level: "detection",
      detected: ["F1", "F2", "F3", "F4"],
      missed: [],
      pass: true,
      in_sample: true,
    });
  });

  it("fails at 3 of 4 and names the miss, whether its event came late or never", () => {
    const result = metropt3DetectionCheck([
      seen("F1", true),
      seen("F2", true),
      seen("F3", true),
      seen("F4", false),
    ]);
    expect(result).toMatchObject({ pass: false, detected: ["F1", "F2", "F3"], missed: ["F4"] });
  });

  it("never counts a secondary positive or an injected window", () => {
    const result = metropt3DetectionCheck([
      ...["F1", "F2", "F3", "F4"].map((id) => seen(id, true)),
      seen("F4b", true, false),
      seen("oil_cooler_fouling", false, false),
    ]);
    expect(result).toMatchObject({ pass: true, detected: ["F1", "F2", "F3", "F4"], missed: [] });
  });

  it("counts a failure detected in any scenario that binds it", () => {
    const result = metropt3DetectionCheck([seen("F4", false), seen("F4", true)]);
    expect(result).toMatchObject({ detected: ["F4"], missed: [], pass: true });
  });

  it("does not pass over no headline window", () => {
    expect(metropt3DetectionCheck([]).pass).toBe(false);
    expect(metropt3DetectionCheck([seen("F4b", true, false)]).pass).toBe(false);
  });
});
