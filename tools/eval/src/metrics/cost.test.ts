// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Cost arithmetic, and the proof that it agrees with the database.
//
// `app.cost_ledger.cost_usd` is a generated column,
// `(input_tokens * price_input_per_mtok + output_tokens * price_output_per_mtok) / 1000000.0`.
// The library groups the same quantity differently — one division per side —
// so the two are compared here on the reference cases rather than assumed
// equal. The tolerance is 1e-12, four orders of magnitude tighter than the
// tenth decimal `numeric(16,10)` keeps.

import { describe, expect, it } from "vitest";

import { cost, mergeCost, pricesFor } from "./cost.ts";
import { TEST_PRICES, decision, ticket } from "./fixtures.ts";

/** The database's own grouping, for the agreement check. */
function generatedColumn(
  inputTokens: number,
  outputTokens: number,
  priceIn: number,
  priceOut: number,
): number {
  return (inputTokens * priceIn + outputTokens * priceOut) / 1_000_000.0;
}

describe("pricesFor", () => {
  it("bills Jev on input tokens only", () => {
    expect(pricesFor(TEST_PRICES, "jev")).toEqual({
      inputPerMtok: 0.042,
      outputPerMtok: 0,
      asOf: "2026-09-19",
    });
  });

  it("bills the LLM on both sides", () => {
    expect(pricesFor(TEST_PRICES, "llm")).toMatchObject({
      inputPerMtok: 5,
      outputPerMtok: 25,
    });
  });

  it("makes the rules baseline free", () => {
    expect(pricesFor(TEST_PRICES, "rules")).toMatchObject({
      inputPerMtok: 0,
      outputPerMtok: 0,
    });
  });
});

describe("cost", () => {
  it("matches the generated column on the Jev reference case", () => {
    const result = cost(
      [decision({ decisionId: "d1", usage: { input_tokens: 1234, output_tokens: 0 } })],
      TEST_PRICES,
      "jev",
    );

    expect(result.usd).toBeCloseTo(0.000051828, 12);
    expect(result.usd).toBeCloseTo(generatedColumn(1234, 0, 0.042, 0), 12);
  });

  it("matches the generated column on the LLM reference case", () => {
    const result = cost(
      [decision({ decisionId: "d1", usage: { input_tokens: 1000, output_tokens: 200 } })],
      TEST_PRICES,
      "llm",
    );

    expect(result.usd).toBeCloseTo(0.01, 12);
    expect(result.usd).toBeCloseTo(generatedColumn(1000, 200, 5, 25), 12);
  });

  it("costs the rules baseline at zero", () => {
    const result = cost(
      [decision({ decisionId: "d1", usage: { input_tokens: 9999, output_tokens: 9999 } })],
      TEST_PRICES,
      "rules",
    );
    expect(result.usd).toBe(0);
    expect(result.perDecision).toBe(0);
  });

  it("sums the decisions and keeps one row each", () => {
    const result = cost(
      [
        decision({ decisionId: "d1", usage: { input_tokens: 1234, output_tokens: 0 } }),
        decision({ decisionId: "d2", usage: { input_tokens: 1234, output_tokens: 0 } }),
      ],
      TEST_PRICES,
      "jev",
      [ticket({ ticketId: "t1" })],
    );

    expect(result.calls).toBe(2);
    expect(result.input_tokens).toBe(2468);
    expect(result.usd).toBeCloseTo(0.000103656, 12);
    expect(result.perDecision).toBeCloseTo(0.000051828, 12);
    expect(result.perTicket).toBeCloseTo(0.000103656, 12);
    expect(result.decisions.map((row) => row.decisionId)).toEqual(["d1", "d2"]);
  });

  it("reports null rather than zero when nothing was spent on nothing", () => {
    const result = cost([], TEST_PRICES, "jev");
    expect(result.usd).toBe(0);
    expect(result.perDecision).toBeNull();
    expect(result.perTicket).toBeNull();
  });

  it("reports a null cost per ticket when no ticket was opened", () => {
    const result = cost(
      [decision({ decisionId: "d1", usage: { input_tokens: 1234, output_tokens: 0 } })],
      TEST_PRICES,
      "jev",
      [],
    );
    expect(result.perTicket).toBeNull();
  });
});

describe("mergeCost", () => {
  it("pools scenario costs into one backend total", () => {
    const prices = pricesFor(TEST_PRICES, "jev");
    const first = cost(
      [decision({ decisionId: "d1", usage: { input_tokens: 1234, output_tokens: 0 } })],
      TEST_PRICES,
      "jev",
    );
    const second = cost(
      [decision({ decisionId: "d2", usage: { input_tokens: 1234, output_tokens: 0 } })],
      TEST_PRICES,
      "jev",
    );

    const merged = mergeCost([first, second], "jev", prices, 2);
    expect(merged.calls).toBe(2);
    expect(merged.usd).toBeCloseTo(0.000103656, 12);
    expect(merged.perTicket).toBeCloseTo(0.000051828, 12);
  });

  it("refuses to pool two backends into one column", () => {
    const rules = cost([], TEST_PRICES, "rules");
    expect(() => mergeCost([rules], "jev", pricesFor(TEST_PRICES, "jev"), 0)).toThrow(TypeError);
  });
});
