// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The four rows of the gate, and the boundaries between them.
 *
 * The thresholds are inclusive on the way up — a confidence exactly at the
 * ticket threshold opens a ticket — because that is how the evaluation harness
 * sweeps them, and an exclusive comparison would make a swept threshold behave
 * differently from the value printed beside it in the report.
 */

import { describe, expect, it } from "vitest";

import { NONE_OF_THESE } from "../decision/types.ts";
import { failedGate, gate } from "./index.ts";
import type { GateConfig } from "./index.ts";

const CONFIG: GateConfig = { ticketMin: 0.85, reviewMin: 0.6 };

describe("gate", () => {
  it.each([
    { choice: "dryer_purge_leak", confidence: 1, outcome: "ticket", abstained: false },
    { choice: "dryer_purge_leak", confidence: 0.85, outcome: "ticket", abstained: false },
    { choice: "dryer_purge_leak", confidence: 0.8499, outcome: "review", abstained: false },
    { choice: "dryer_purge_leak", confidence: 0.6, outcome: "review", abstained: false },
    { choice: "dryer_purge_leak", confidence: 0.5999, outcome: "log", abstained: false },
    { choice: "dryer_purge_leak", confidence: 0, outcome: "log", abstained: false },
    { choice: NONE_OF_THESE, confidence: 1, outcome: "log", abstained: true },
    { choice: NONE_OF_THESE, confidence: 0.6, outcome: "log", abstained: true },
    { choice: NONE_OF_THESE, confidence: 0.5999, outcome: "log", abstained: false },
  ])("$choice at $confidence is $outcome", ({ choice, confidence, outcome, abstained }) => {
    const result = gate({ choice, confidence }, CONFIG);
    expect(result.outcome).toBe(outcome);
    expect(result.abstained).toBe(abstained);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("names the chosen cause in the reason it gives", () => {
    expect(gate({ choice: "oil_cooler_fouled", confidence: 0.9 }, CONFIG).reason).toContain(
      "oil_cooler_fouled",
    );
  });

  it("quotes the thresholds it decided against", () => {
    const reason = gate({ choice: "oil_cooler_fouled", confidence: 0.7 }, CONFIG).reason;
    expect(reason).toContain("0.60");
    expect(reason).toContain("0.85");
  });

  it("follows the thresholds it is given rather than the defaults", () => {
    const strict: GateConfig = { ticketMin: 0.95, reviewMin: 0.9 };
    expect(gate({ choice: "oil_cooler_fouled", confidence: 0.9 }, strict).outcome).toBe("review");
    expect(gate({ choice: "oil_cooler_fouled", confidence: 0.95 }, strict).outcome).toBe("ticket");
  });

  it("never opens a ticket on an abstention, however sure the backend is", () => {
    expect(gate({ choice: NONE_OF_THESE, confidence: 1 }, CONFIG).outcome).toBe("log");
  });
});

describe("failedGate", () => {
  it("logs and says the backend never answered", () => {
    const result = failedGate();
    expect(result).toMatchObject({ outcome: "log", abstained: false });
    expect(result.reason).toContain("no answer");
  });
});
