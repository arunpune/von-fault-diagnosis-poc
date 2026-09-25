// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Covered machine-days and the two ticket rates.
//
// The arithmetic this file exists for is the union: overlapping gaps, frozen
// blocks and excluded windows are subtracted once, never summed.

import { describe, expect, it } from "vitest";

import { coveredMachineDays, negativeMachineDays, ticketRates } from "./rate.ts";
import { at, excluded, ticket } from "./fixtures.ts";

/** One day, in the minutes `at()` counts. */
const DAY = 1440;
const RANGE = { from: at(0), to: at(DAY) };

function hours(count: number): number {
  return count / 24;
}

describe("coveredMachineDays", () => {
  it("is the whole range when nothing is subtracted", () => {
    expect(coveredMachineDays(RANGE)).toBe(1);
  });

  it("subtracts a gap once", () => {
    const covered = coveredMachineDays(RANGE, [{ from: at(60), to: at(120) }]);
    expect(covered).toBeCloseTo(1 - hours(1), 12);
  });

  it("subtracts overlapping gaps and frozen blocks only once", () => {
    const covered = coveredMachineDays(
      RANGE,
      [
        { from: at(60), to: at(180) },
        { from: at(120), to: at(240) },
      ],
      [{ from: at(150), to: at(200) }],
    );
    // The union is [60, 240): three hours, not the five the three spans sum to.
    expect(covered).toBeCloseTo(1 - hours(3), 12);
  });

  it("merges two touching gaps into one hole", () => {
    const covered = coveredMachineDays(RANGE, [
      { from: at(60), to: at(120) },
      { from: at(120), to: at(180) },
    ]);
    expect(covered).toBeCloseTo(1 - hours(2), 12);
  });

  it("clips a gap that reaches past the range", () => {
    const covered = coveredMachineDays(RANGE, [{ from: at(DAY - 60), to: at(DAY + 600) }]);
    expect(covered).toBeCloseTo(1 - hours(1), 12);
  });

  it("ignores a gap entirely outside the range", () => {
    expect(coveredMachineDays(RANGE, [{ from: at(DAY + 60), to: at(DAY + 120) }])).toBe(1);
  });

  it("subtracts excluded windows too", () => {
    const covered = coveredMachineDays(
      RANGE,
      [],
      [],
      [excluded({ id: "repair", from: at(600), to: at(720) })],
    );
    expect(covered).toBeCloseTo(1 - hours(2), 12);
  });

  it("never goes below zero", () => {
    expect(coveredMachineDays(RANGE, [{ from: at(-600), to: at(DAY + 600) }])).toBe(0);
  });

  it("rejects an interval that ends before it starts", () => {
    expect(() => coveredMachineDays({ from: at(DAY), to: at(0) })).toThrow(RangeError);
  });
});

describe("negativeMachineDays", () => {
  it("subtracts the positive windows as well as the gaps", () => {
    const negative = negativeMachineDays(
      RANGE,
      [{ from: at(600), to: at(720) }],
      [{ from: at(60), to: at(120) }],
    );
    expect(negative).toBeCloseTo(1 - hours(3), 12);
  });
});

describe("ticketRates", () => {
  const tickets = [ticket({ ticketId: "t1" }), ticket({ ticketId: "t2" })];

  it("divides each count by its own denominator", () => {
    const rates = ticketRates(tickets, [tickets[0]!], 2, 0.5);
    expect(rates.ticketsPerMachineDay).toBe(1);
    expect(rates.falseTicketsPerMachineDay).toBe(2);
  });

  it("reports null rather than zero when there is no covered time", () => {
    const rates = ticketRates(tickets, [], 0, 0);
    expect(rates.ticketsPerMachineDay).toBeNull();
    expect(rates.falseTicketsPerMachineDay).toBeNull();
  });

  it("keeps the counts and the denominators in the result", () => {
    const rates = ticketRates(tickets, [tickets[0]!], 2, 0.5);
    expect(rates).toMatchObject({
      tickets: 2,
      falseTickets: 1,
      coveredMachineDays: 2,
      negativeMachineDays: 0.5,
    });
  });
});
