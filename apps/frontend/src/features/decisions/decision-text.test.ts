// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { Decision } from "@/api/types";
import {
  backendLabel,
  chosenCandidate,
  chosenTitle,
  failureWords,
  gateWord,
  isAbstention,
  isFailedDecision,
  priceLine,
} from "@/features/decisions/decision-text";
import { fixtures } from "@/test/msw/fixtures";

function answered(): Decision {
  return structuredClone(fixtures.decision);
}

function failed(): Decision {
  return structuredClone(fixtures.decisionFailed);
}

function withGate(decision: Decision, outcome: Decision["gate"]["outcome"]): Decision {
  return { ...decision, gate: { ...decision.gate, outcome, abstained: false } };
}

describe("gateWord", () => {
  it("names each gate outcome", () => {
    expect(gateWord(withGate(answered(), "ticket"))).toBe("Ticket");
    expect(gateWord(withGate(answered(), "review"))).toBe("Review");
    expect(gateWord(withGate(answered(), "log"))).toBe("Logged");
  });

  it("says Abstained when the gate reports an abstention", () => {
    const decision = answered();
    decision.gate = { ...decision.gate, outcome: "log", abstained: true };

    expect(isAbstention(decision)).toBe(true);
    expect(gateWord(decision)).toBe("Abstained");
  });

  it("never calls a failed call an abstention", () => {
    const decision = failed();
    decision.gate = { ...decision.gate, review_min_confidence: 0 };

    expect(isAbstention(decision)).toBe(false);
    expect(gateWord(decision)).toBe("Logged");
  });

  it("reads an outcome a newer contract adds as its own words", () => {
    const decision = answered();
    decision.gate = { ...decision.gate, outcome: "escalate_now" as Decision["gate"]["outcome"] };

    expect(gateWord(decision)).toBe("Escalate now");
  });
});

describe("chosenTitle", () => {
  it("is the chosen candidate's cause name", () => {
    expect(chosenCandidate(answered())?.fault_id).toBe("dryer_purge_leak");
    expect(chosenTitle(answered())).toBe("Dryer purge valve not seating");
  });

  it('is "No matching fault" for none of these', () => {
    expect(chosenTitle(failed())).toBe("No matching fault");
  });

  it("humanises a choice outside the candidate list", () => {
    const decision = answered();
    decision.choice = "oil_cooler_fouled";

    expect(chosenCandidate(decision)).toBeUndefined();
    expect(chosenTitle(decision)).toBe("Oil cooler fouled");
  });
});

describe("failureWords", () => {
  it("is the error kind in words for a failed call and null for an answered one", () => {
    expect(isFailedDecision(failed())).toBe(true);
    expect(failureWords(failed())).toBe("timeout");
    expect(isFailedDecision(answered())).toBe(false);
    expect(failureWords(answered())).toBeNull();
  });

  it('says "unknown" for a failed status that carries no error', () => {
    const decision = failed();
    decision.error = null;

    expect(failureWords(decision)).toBe("unknown");
  });
});

describe("priceLine", () => {
  it("gives the input price, a free output and the day the prices were read", () => {
    expect(priceLine(answered().cost)).toBe(
      "$0.042 per MTok input, output free, prices as of 2026-09-19",
    );
  });

  it("gives the output price when output is billed", () => {
    const cost = { ...answered().cost, price_input_per_mtok: 3, price_output_per_mtok: 15 };

    expect(priceLine(cost)).toBe(
      "$3.00 per MTok input, $15.00 per MTok output, prices as of 2026-09-19",
    );
  });
});

describe("backendLabel", () => {
  it("names the backend and its model as the status bar does", () => {
    expect(backendLabel("jev", "jev-1.13.0")).toBe("Jev · jev-1.13.0");
    expect(backendLabel("llm", "claude-model")).toBe("Claude · claude-model");
    expect(backendLabel("rules", "rules-v1")).toBe("Rules");
  });

  it("humanises a backend a newer contract adds and drops an empty model", () => {
    expect(backendLabel("ensemble_v2", "")).toBe("Ensemble v2");
  });
});
