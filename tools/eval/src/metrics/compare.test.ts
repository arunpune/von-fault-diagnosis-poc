// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The rules-versus-Von table and the per-backend aggregation behind it.

import { describe, expect, it } from "vitest";

import { aggregateScenarios, compare } from "./compare.ts";
import { scoreScenario } from "./summary.ts";
import { TEST_PRICES, at, decision, suspect, ticket, window } from "./fixtures.ts";
import type { ScenarioBinding, ScenarioMetrics } from "./types.ts";

const WINDOW = window({
  id: "W",
  from: at(120),
  to: at(480),
  accepted: ["air_leak_downstream"],
  onset: at(120),
  headline: true,
});

function binding(id: string): ScenarioBinding {
  return {
    id,
    group: "recording_positive",
    split: "test",
    replay: { from: at(0), to: at(1440) },
    warmupMin: 60,
    windows: [WINDOW],
    excluded: [],
    benignFaultIds: new Set(),
    expect: {
      tickets: "at_least_one",
      fault: "accepted",
      withinMin: 120,
      maxFalseTickets: 0,
      passLevel: "diagnosis",
    },
  };
}

function scenario(
  id: string,
  backend: string,
  found: boolean,
  raised: boolean = found,
): ScenarioMetrics {
  return scoreScenario(
    binding(id),
    found ? [ticket({ ticketId: `t-${id}-${backend}`, openedSimTs: at(150) })] : [],
    [
      decision({
        decisionId: `d-${id}-${backend}`,
        simTs: at(150),
        backend,
        usage: { input_tokens: backend === "rules" ? 0 : 1234, output_tokens: 0 },
      }),
    ],
    [{ code: "W102", simTs: at(200) }],
    TEST_PRICES,
    {
      backend,
      suspects: raised ? [suspect({ eventId: `s-${id}-${backend}`, simTs: at(140) })] : [],
    },
  );
}

describe("aggregateScenarios", () => {
  it("pools one backend's scenarios into one column", () => {
    const aggregate = aggregateScenarios([scenario("a", "von", true), scenario("b", "von", false)]);

    expect(aggregate.backend).toBe("von");
    expect(aggregate.scenarios).toBe(2);
    expect(aggregate.match.ticket.tp).toHaveLength(1);
    expect(aggregate.match.ticket.fn).toHaveLength(1);
    expect(aggregate.precisionRecall.ticket.micro.recall).toBeCloseTo(0.5, 12);
    expect(aggregate.cost.calls).toBe(2);
    expect(aggregate.cost.usd).toBeCloseTo(0.000103656, 12);
    expect(aggregate.detectionPassed).toBe(1);
    expect(aggregate.reviewDiagnosisPassed).toBe(1);
  });

  it("counts detection on suspect events and review diagnosis on tickets, apart", () => {
    const aggregate = aggregateScenarios([
      scenario("a", "rules", false, true),
      scenario("b", "rules", true, false),
    ]);
    expect(aggregate.detectionPassed).toBe(1);
    expect(aggregate.reviewDiagnosisPassed).toBe(1);
    expect(aggregate.diagnosisPassed).toBe(1);
  });

  it("checks the headline failures over the pooled windows", () => {
    const aggregate = aggregateScenarios([scenario("a", "von", true)]);
    expect(aggregate.metropt3Check.review.pass).toBe(true);
    expect(aggregate.metropt3Check.ticket.pass).toBe(true);
  });

  it("refuses to mix two backends into one column", () => {
    expect(() =>
      aggregateScenarios([scenario("a", "von", true), scenario("b", "rules", true)]),
    ).toThrow(TypeError);
  });

  it("refuses an empty list", () => {
    expect(() => aggregateScenarios([])).toThrow(TypeError);
  });
});

describe("compare", () => {
  const rules = [scenario("a", "rules", true), scenario("b", "rules", false)];
  const von = [scenario("a", "von", true), scenario("b", "von", true)];

  it("puts Von minus rules in the delta", () => {
    const rows = compare(rules, von);
    const recall = rows.find((row) => row.metric === "recall (ticket, micro)");

    expect(recall?.rules).toBeCloseTo(0.5, 12);
    expect(recall?.von).toBe(1);
    expect(recall?.delta).toBeCloseTo(0.5, 12);
  });

  it("marks the metrics a smaller number is better on", () => {
    const rows = compare(rules, von);
    expect(rows.find((row) => row.metric === "cost (USD)")?.lowerIsBetter).toBe(true);
    expect(rows.find((row) => row.metric === "recall (ticket, micro)")?.lowerIsBetter).toBe(false);
  });

  it("leaves out the llm column when no llm ran", () => {
    const [row] = compare(rules, von);
    expect(row).not.toHaveProperty("llm");
  });

  it("adds the llm column when it did", () => {
    const [row] = compare(rules, von, [scenario("a", "llm", true)]);
    expect(row).toHaveProperty("llm");
  });

  it("reports a missing backend as null rather than zero", () => {
    const rows = compare(rules, []);
    const recall = rows.find((row) => row.metric === "recall (ticket, micro)");

    expect(recall?.von).toBeNull();
    expect(recall?.delta).toBeNull();
  });

  it("keeps the row order stable so two reports diff cleanly", () => {
    expect(compare(rules, von).map((row) => row.metric)).toEqual(
      compare(von, rules).map((row) => row.metric),
    );
  });
});
