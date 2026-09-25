// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { Decision, LedgerRow } from "@/api/types";
import {
  costBefore,
  cumulativeCost,
  ledgerRowOf,
  ledgerUsd,
  mergeLedger,
} from "@/features/cost/ledger";
import { fixtures } from "@/test/msw/fixtures";

/** The fixture item at `index`; the fixtures are fixed, so a missing one is a broken fixture. */
function fixtureAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`the fixture list has no item ${index}`);
  }
  return item;
}

// decisions.json: a failed call, an answered Jev decision and a rules decision, newest first.
const FAILED = fixtureAt(fixtures.decisions.items, 0);
const ANSWERED = fixtureAt(fixtures.decisions.items, 1);
const RULES = fixtureAt(fixtures.decisions.items, 2);
// cost.json: the Jev ledger row of ANSWERED and a language-model row.
const JEV_ROW = fixtureAt(fixtures.cost.recent, 0);
const LLM_ROW = fixtureAt(fixtures.cost.recent, 1);

function row(decisionId: string, wallTs: string, costUsd: number): LedgerRow {
  return {
    decision_id: decisionId,
    backend: "jev",
    model: "jev-1.13.0",
    input_tokens: 2_000,
    output_tokens: 0,
    cost_usd: costUsd,
    wall_ts: wallTs,
    sim_ts: "2020-06-05T09:00:00.000Z",
  };
}

function decision(decisionId: string, wallTs: string, costUsd: number): Decision {
  return {
    ...structuredClone(ANSWERED),
    decision_id: decisionId,
    wall_ts: wallTs,
    usage: { input_tokens: 3_000, output_tokens: 0 },
    cost: { ...ANSWERED.cost, usd: costUsd },
  };
}

function ids(ledger: readonly LedgerRow[]): string[] {
  return ledger.map((entry) => entry.decision_id);
}

describe("ledgerRowOf", () => {
  it("bills a decision with its own cost, usage, backend, model and times", () => {
    expect(ledgerRowOf(ANSWERED)).toEqual({
      decision_id: ANSWERED.decision_id,
      backend: "jev",
      model: "jev-1.13.0",
      input_tokens: 1_834,
      output_tokens: 0,
      cost_usd: 0.000077028,
      wall_ts: ANSWERED.wall_ts,
      sim_ts: ANSWERED.sim_ts,
    });
  });

  it("bills a rules decision at zero and a failed call not at all", () => {
    expect(ledgerRowOf(RULES)).toMatchObject({ backend: "rules", cost_usd: 0 });
    expect(ledgerRowOf(FAILED)).toBeNull();
  });
});

describe("mergeLedger", () => {
  it("unions the recent rows and the decisions by decision id, newest first", () => {
    const ledger = mergeLedger(fixtures.cost.recent, fixtures.decisions.items);

    // The answered decision is also the Jev ledger row; the failed call has no row.
    expect(ids(ledger)).toEqual([JEV_ROW.decision_id, LLM_ROW.decision_id, RULES.decision_id]);
  });

  it("keeps the backend's row where a decision is also in the recent rows", () => {
    const billed = { ...JEV_ROW, cost_usd: 0.00008 };
    const ledger = mergeLedger([billed], [ANSWERED]);

    expect(ledger).toEqual([billed]);
  });

  it("orders by wall time whatever order the sources come in, ties by id", () => {
    const ledger = mergeLedger(
      [row("b", "2026-06-05T10:00:00.000Z", 1), row("c", "2026-06-05T12:00:00.000Z", 1)],
      [decision("a", "2026-06-05T10:00:00.000Z", 1), decision("d", "2026-06-05T11:00:00.000Z", 1)],
    );

    expect(ids(ledger)).toEqual(["c", "d", "a", "b"]);
  });

  it("grows past the fifty rows the backend returns", () => {
    const recent = Array.from({ length: 50 }, (_, index) =>
      row(`r${index}`, `2026-06-05T09:${String(index).padStart(2, "0")}:00.000Z`, 0.0001),
    );
    const pushed = decision("pushed", "2026-06-05T10:30:00.000Z", 0.0002);

    const ledger = mergeLedger(recent, [pushed]);

    expect(ledger).toHaveLength(51);
    expect(ledger[0]?.decision_id).toBe("pushed");
    expect(ledger[50]?.decision_id).toBe("r0");
  });

  it("puts a row without a readable wall time last", () => {
    const ledger = mergeLedger(
      [row("late", "not a time", 1), row("early", "2026-06-05T09:00:00.000Z", 1)],
      [],
    );

    expect(ids(ledger)).toEqual(["early", "late"]);
  });

  it("is empty when nothing was billed", () => {
    expect(mergeLedger([], [FAILED])).toEqual([]);
  });
});

describe("cumulativeCost", () => {
  const ledger = [
    row("c", "2026-06-05T12:00:00.000Z", 0.25),
    row("b", "2026-06-05T11:00:00.000Z", 0.5),
    row("a", "2026-06-05T10:00:00.000Z", 1),
  ];

  it("steps up at each decision, oldest first, from zero", () => {
    expect(cumulativeCost(ledger)).toEqual([
      { t: Date.parse("2026-06-05T10:00:00.000Z"), usd: 0 },
      { t: Date.parse("2026-06-05T10:00:00.000Z"), usd: 1 },
      { t: Date.parse("2026-06-05T11:00:00.000Z"), usd: 1.5 },
      { t: Date.parse("2026-06-05T12:00:00.000Z"), usd: 1.75 },
    ]);
  });

  it("starts from what the older decisions cost and ends at the running total", () => {
    const total = 2.75;
    const points = cumulativeCost(ledger, costBefore(total, ledger));

    expect(points[0]?.usd).toBe(1);
    expect(points.at(-1)?.usd).toBe(total);
  });

  it("leaves out a row without a readable wall time", () => {
    const points = cumulativeCost([row("x", "not a time", 5), ...ledger]);

    expect(points.map((point) => point.usd)).toEqual([0, 1, 1.5, 1.75]);
  });

  it("is empty for an empty ledger", () => {
    expect(cumulativeCost([], 3)).toEqual([]);
  });
});

describe("costBefore", () => {
  it("is the running total less the rows at hand, never below zero", () => {
    const rows = [row("a", "2026-06-05T10:00:00.000Z", 0.25)];

    expect(ledgerUsd(rows)).toBe(0.25);
    expect(costBefore(1, rows)).toBe(0.75);
    // A pushed decision can reach the ledger before its cost update reaches the totals.
    expect(costBefore(0.1, rows)).toBe(0);
  });
});
