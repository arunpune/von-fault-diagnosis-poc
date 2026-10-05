// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The live plan: the arithmetic of one row on hand-made decisions,
// and one real plan over the F3 slice when it is cut. The plan replays with
// the contracts' mock only; nothing here reaches an API.

import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.ts";
import { cost } from "../metrics/cost.ts";
import type { DecisionRecord } from "../metrics/types.ts";
import { datasetRequired, sliceIsCut } from "../slices.ts";
import { LLM_OUTPUT_TOKENS_PER_CALL, planLiveRun, planRow } from "./plan.ts";

const cfg = loadConfig([], {}, { cwd: "/tmp" });

function decision(id: string, inputTokens: number): DecisionRecord {
  return {
    decisionId: id,
    episodeId: "episode-1",
    simTs: new Date("2020-06-05T09:51:00.000Z"),
    choice: "dryer_purge_leak",
    confidence: 0.9,
    gate: "ticket",
    abstained: false,
    usage: { input_tokens: inputTokens, output_tokens: 0 },
    backend: "von",
    benignChoice: false,
  };
}

const DECISIONS = [decision("d1", 1234), decision("d2", 1500)];

describe("planRow", () => {
  it("bills Von the mock's input tokens at the dated input price, output free", () => {
    const row = planRow("von", "von-1.13.0", DECISIONS, cfg.prices);
    expect(row).toEqual({
      backend: "von",
      model: "von-1.13.0",
      calls: 2,
      inputTokens: 2734,
      outputTokens: 0,
      usd: cost(DECISIONS, cfg.prices, "von").usd,
      pricesAsOf: "2026-09-19",
    });
    expect(row.usd).toBeCloseTo((2734 * 0.042) / 1e6, 12);
  });

  it("bills the LLM the same input and a fixed answer per call, at its own prices", () => {
    const row = planRow("llm", "claude-opus-5", DECISIONS, cfg.prices);
    expect(row.calls).toBe(2);
    expect(row.inputTokens).toBe(2734);
    expect(row.outputTokens).toBe(2 * LLM_OUTPUT_TOKENS_PER_CALL);
    expect(row.usd).toBeCloseTo((2734 * 5) / 1e6 + (600 * 25) / 1e6, 12);
  });

  it("plans nothing for a run that decides nothing", () => {
    expect(planRow("von", "von-1.13.0", [], cfg.prices)).toMatchObject({ calls: 0, usd: 0 });
  });
});

describe("planLiveRun", () => {
  const cut = sliceIsCut("f3-jun05");

  it("has the F3 slice, or its absence is allowed", () => {
    expect(cut || !datasetRequired(), "the f3-jun05 slice is not cut; run make fixtures").toBe(
      true,
    );
  });

  it.skipIf(!cut)("counts the decisions of a mock replay of the run's scenarios", async () => {
    const argv = ["--profile", "smoke", "--scenario", "f3_air_leak_jun05"];
    const plan = await planLiveRun(loadConfig(argv, {}, { cwd: "/tmp" }), ["von", "llm"]);
    expect(plan.scenarios).toBe(1);
    const [von, llm] = plan.rows;
    expect(von?.backend).toBe("von");
    expect(von?.calls).toBeGreaterThan(0);
    expect(von?.inputTokens).toBeGreaterThan(von?.calls ?? 0);
    expect(llm?.calls).toBe(von?.calls);
    expect(llm?.outputTokens).toBe((llm?.calls ?? 0) * LLM_OUTPUT_TOKENS_PER_CALL);
  });
});
