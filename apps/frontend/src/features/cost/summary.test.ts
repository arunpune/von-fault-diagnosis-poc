// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ApiCost } from "@/api/types";
import {
  backendLabel,
  backendRows,
  priceSentence,
  showsRulesNotice,
} from "@/features/cost/summary";
import { fixtures } from "@/test/msw/fixtures";

const JEV_ONLY: ApiCost["prices"] = {
  jev_input_per_mtok: 0.042,
  llm_input_per_mtok: null,
  llm_output_per_mtok: null,
  as_of: "2026-09-19",
};

function totals(calls: number, usd = 0) {
  return { usd, calls, input_tokens: 0, output_tokens: 0 };
}

function costWith(calls: number, byBackend: ApiCost["by_backend"]): ApiCost {
  return { ...structuredClone(fixtures.cost), totals: totals(calls), by_backend: byBackend };
}

describe("priceSentence", () => {
  it("states the Jev input price, free output and the as-of date", () => {
    expect(priceSentence(JEV_ONLY)).toBe(
      "$0.042 per MTok input, output free · prices as of 2026-09-19",
    );
  });

  it("names the Jev price and adds the language model's prices when configured", () => {
    expect(priceSentence(fixtures.cost.prices)).toBe(
      "Jev $0.042 per MTok input, output free; " +
        "language model $3.00 per MTok input, $15.00 per MTok output · prices as of 2026-09-19",
    );
  });

  it("adds the one language-model price that is configured", () => {
    expect(priceSentence({ ...JEV_ONLY, llm_input_per_mtok: 0.8 })).toBe(
      "Jev $0.042 per MTok input, output free; language model $0.80 per MTok input" +
        " · prices as of 2026-09-19",
    );
  });
});

describe("backendRows", () => {
  it("lists Jev, the language model and rules in that order, then others by name", () => {
    const row = { ...totals(1), model: "m" };
    const rows = backendRows({ rules: row, zeta: row, llm: row, alpha: row, jev: row });

    expect(rows.map((entry) => entry.backend)).toEqual(["jev", "llm", "rules", "alpha", "zeta"]);
  });

  it("keeps each backend's totals and model", () => {
    expect(backendRows(fixtures.cost.by_backend)).toEqual([
      { backend: "jev", ...fixtures.cost.by_backend.jev },
      { backend: "llm", ...fixtures.cost.by_backend.llm },
    ]);
  });
});

describe("backendLabel", () => {
  it("names the three decision backends and humanises any other", () => {
    expect(["jev", "llm", "rules", "edge_model"].map(backendLabel)).toEqual([
      "Jev",
      "Language model",
      "Rules",
      "Edge model",
    ]);
  });
});

describe("showsRulesNotice", () => {
  const rulesRow = { ...totals(3), model: "rules-v1" };
  const jevRow = { ...totals(2, 0.00015), model: "jev-1.13.0" };

  it("applies under the rules backend before any call was billed", () => {
    expect(showsRulesNotice("rules", costWith(0, {}))).toBe(true);
  });

  it("still applies once the rules backend's own zero-cost decisions are in the ledger", () => {
    expect(showsRulesNotice("rules", costWith(3, { rules: rulesRow }))).toBe(true);
  });

  it("does not apply once a model has billed a call", () => {
    expect(showsRulesNotice("rules", costWith(5, { rules: rulesRow, jev: jevRow }))).toBe(false);
  });

  it("does not apply under a model backend or while the backend is unknown", () => {
    expect(showsRulesNotice("jev", costWith(0, {}))).toBe(false);
    expect(showsRulesNotice(null, costWith(0, {}))).toBe(false);
  });
});
