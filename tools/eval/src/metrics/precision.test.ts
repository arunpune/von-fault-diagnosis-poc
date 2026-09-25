// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Per-fault precision and recall, the aggregates, and the zero-division rule
// that keeps "no tickets" and "precision 0" apart.

import { describe, expect, it } from "vitest";

import { matchTickets } from "./match.ts";
import { precisionRecall } from "./precision.ts";
import { at, ticket, window } from "./fixtures.ts";

const LEAK = window({ id: "W1", from: at(60), to: at(120), accepted: ["air_leak_downstream"] });
const COOLER = window({ id: "W2", from: at(300), to: at(360), accepted: ["oil_cooler_fouling"] });

describe("precisionRecall", () => {
  it("attributes a true positive to the fault the ticket named", () => {
    const match = matchTickets(
      [LEAK],
      [],
      [ticket({ ticketId: "t1", openedSimTs: at(70) })],
      new Set(),
      "ticket",
    );
    const scores = precisionRecall(match, "ticket");

    expect(scores.perFault["air_leak_downstream"]).toEqual({
      tp: 1,
      fp: 0,
      fn: 0,
      windows: 1,
      precision: 1,
      recall: 1,
    });
    expect(scores.micro).toMatchObject({ tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 });
  });

  it("charges a misdiagnosis to its own fault and leaves the window missed", () => {
    const match = matchTickets(
      [LEAK],
      [],
      [ticket({ ticketId: "t1", openedSimTs: at(70), faultAtOpen: "oil_cooler_fouling" })],
      new Set(),
      "ticket",
    );
    const scores = precisionRecall(match, "ticket");

    expect(scores.perFault["oil_cooler_fouling"]).toMatchObject({ tp: 0, fp: 1, precision: 0 });
    expect(scores.perFault["air_leak_downstream"]).toMatchObject({ fn: 1, recall: 0 });
    expect(scores.micro).toMatchObject({ tp: 0, fp: 1, fn: 1, precision: 0, recall: 0 });
  });

  it("reports precision as null when the fault has no tickets at all", () => {
    const match = matchTickets([LEAK], [], [], new Set(), "ticket");
    const scores = precisionRecall(match, "ticket");

    expect(scores.perFault["air_leak_downstream"]).toMatchObject({
      precision: null,
      recall: 0,
    });
    expect(scores.micro.precision).toBeNull();
  });

  it("reports recall as null when no window accepts the fault", () => {
    const match = matchTickets(
      [],
      [],
      [ticket({ ticketId: "t1", openedSimTs: at(70), faultAtOpen: "motor_overload" })],
      new Set(),
      "ticket",
    );
    const scores = precisionRecall(match, "ticket");

    expect(scores.perFault["motor_overload"]).toMatchObject({ precision: 0, recall: null });
    expect(scores.micro.recall).toBeNull();
  });

  it("counts a window with two accepted faults once in the micro recall", () => {
    const both = window({
      id: "W3",
      from: at(60),
      to: at(120),
      accepted: ["air_leak_downstream", "air_leak_dryer_purge"],
    });
    const match = matchTickets([both], [], [], new Set(), "ticket");
    const scores = precisionRecall(match, "ticket");

    expect(scores.perFault["air_leak_downstream"]?.fn).toBe(1);
    expect(scores.perFault["air_leak_dryer_purge"]?.fn).toBe(1);
    expect(scores.micro.fn).toBe(1);
    expect(scores.micro.windows).toBe(1);
  });

  it("averages the macro figures only over the faults that have one", () => {
    const match = matchTickets(
      [LEAK, COOLER],
      [],
      [
        ticket({ ticketId: "t1", openedSimTs: at(70) }),
        ticket({ ticketId: "t2", openedSimTs: at(500), faultAtOpen: "motor_overload" }),
      ],
      new Set(),
      "ticket",
    );
    const scores = precisionRecall(match, "ticket");

    // air_leak_downstream 1.0, motor_overload 0.0, oil_cooler_fouling undefined.
    expect(scores.macro.precision).toBeCloseTo(0.5, 12);
    expect(scores.macro.precisionFaults).toBe(2);
    // air_leak_downstream 1.0, oil_cooler_fouling 0.0, motor_overload undefined.
    expect(scores.macro.recall).toBeCloseTo(0.5, 12);
    expect(scores.macro.recallFaults).toBe(2);
  });

  it("differs between the two levels when a ticket never left the review queue", () => {
    const tickets = [ticket({ ticketId: "t1", openedSimTs: at(70), maxLevel: "review" })];
    const review = precisionRecall(
      matchTickets([LEAK], [], tickets, new Set(), "review"),
      "review",
    );
    const ticketLevel = precisionRecall(
      matchTickets([LEAK], [], tickets, new Set(), "ticket"),
      "ticket",
    );

    expect(review.micro.recall).toBe(1);
    expect(ticketLevel.micro.recall).toBe(0);
  });

  it("refuses a level that contradicts the match", () => {
    const match = matchTickets([LEAK], [], [], new Set(), "ticket");
    expect(() => precisionRecall(match, "review")).toThrow(TypeError);
  });
});
