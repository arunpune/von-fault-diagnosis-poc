// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Abstention accuracy and the explicit rate.

import { describe, expect, it } from "vitest";

import { abstention, mergeAbstention, type AbstainCase } from "./abstain.ts";
import { at, decision, ticket } from "./fixtures.ts";
import { NONE_OF_THESE } from "./types.ts";

const BENIGN = new Set(["high_ambient_temperature"]);

function abstainCase(overrides: Partial<AbstainCase> & { id: string }): AbstainCase {
  return {
    tickets: overrides.tickets ?? [],
    decisions: overrides.decisions ?? [],
    benignFaultIds: overrides.benignFaultIds ?? BENIGN,
    reviewMin: overrides.reviewMin ?? 0.6,
    id: overrides.id,
  };
}

describe("abstention", () => {
  it("counts an explicit none_of_these above the review floor as correct", () => {
    const result = abstention([
      abstainCase({
        id: "depot",
        decisions: [
          decision({
            decisionId: "d1",
            choice: NONE_OF_THESE,
            confidence: 0.72,
            gate: "log",
            abstained: true,
          }),
        ],
      }),
    ]);

    expect(result).toMatchObject({ correct: 1, total: 1, accuracy: 1, explicitRate: 1 });
  });

  it("accepts a benign candidate in the review queue", () => {
    const result = abstention([
      abstainCase({
        id: "high_ambient",
        tickets: [
          ticket({
            ticketId: "t1",
            faultAtOpen: "high_ambient_temperature",
            maxLevel: "review",
          }),
        ],
        decisions: [
          decision({
            decisionId: "d1",
            choice: "high_ambient_temperature",
            confidence: 0.66,
            gate: "review",
            benignChoice: true,
          }),
        ],
      }),
    ]);

    expect(result.correct).toBe(1);
    expect(result.explicitRate).toBe(0);
  });

  it("forgives a wrong candidate the gate sent to the log", () => {
    const result = abstention([
      abstainCase({
        id: "quiet",
        decisions: [
          decision({
            decisionId: "d1",
            choice: "air_leak_downstream",
            confidence: 0.55,
            gate: "log",
          }),
        ],
      }),
    ]);
    expect(result.correct).toBe(1);
  });

  it("fails a case whose ticket names a non-benign fault", () => {
    const result = abstention([
      abstainCase({
        id: "wrong_ticket",
        tickets: [ticket({ ticketId: "t1", faultAtOpen: "air_leak_downstream" })],
      }),
    ]);

    expect(result.correct).toBe(0);
    expect(result.accuracy).toBe(0);
    expect(result.cases[0]?.reasons[0]).toContain("air_leak_downstream");
  });

  it("fails a case whose decision named a fault at review or above", () => {
    const result = abstention([
      abstainCase({
        id: "confident_wrong",
        decisions: [
          decision({
            decisionId: "d1",
            choice: "air_leak_downstream",
            confidence: 0.9,
            gate: "ticket",
          }),
        ],
      }),
    ]);
    expect(result.correct).toBe(0);
  });

  it("fails an unconfident none_of_these below the review floor", () => {
    const result = abstention([
      abstainCase({
        id: "unsure",
        decisions: [
          decision({
            decisionId: "d1",
            choice: NONE_OF_THESE,
            confidence: 0.4,
            gate: "review",
          }),
        ],
      }),
    ]);
    expect(result.correct).toBe(0);
  });

  it("reports the explicit rate over every decision in the cases", () => {
    const result = abstention([
      abstainCase({
        id: "mixed",
        decisions: [
          decision({
            decisionId: "d1",
            choice: NONE_OF_THESE,
            confidence: 0.7,
            gate: "log",
            abstained: true,
          }),
          decision({
            decisionId: "d2",
            choice: "high_ambient_temperature",
            confidence: 0.66,
            gate: "review",
            benignChoice: true,
          }),
          decision({
            decisionId: "d3",
            choice: NONE_OF_THESE,
            confidence: 0.8,
            gate: "log",
            abstained: true,
          }),
        ],
      }),
    ]);

    expect(result.explicit).toBe(2);
    expect(result.decisions).toBe(3);
    expect(result.explicitRate).toBeCloseTo(2 / 3, 12);
  });

  it("reports null rather than zero when there are no cases", () => {
    const result = abstention([]);
    expect(result).toMatchObject({ correct: 0, total: 0, accuracy: null, explicitRate: null });
  });
});

describe("mergeAbstention", () => {
  it("pools the counts of several scenarios", () => {
    const correct = abstention([
      abstainCase({
        id: "a",
        decisions: [
          decision({
            decisionId: "d1",
            simTs: at(0),
            choice: NONE_OF_THESE,
            confidence: 0.7,
            gate: "log",
            abstained: true,
          }),
        ],
      }),
    ]);
    const wrong = abstention([
      abstainCase({
        id: "b",
        tickets: [ticket({ ticketId: "t1", faultAtOpen: "motor_overload" })],
        decisions: [decision({ decisionId: "d2", gate: "ticket" })],
      }),
    ]);

    const merged = mergeAbstention([correct, wrong]);
    expect(merged).toMatchObject({ correct: 1, total: 2, decisions: 2, explicit: 1 });
    expect(merged.accuracy).toBe(0.5);
    expect(merged.cases.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});
