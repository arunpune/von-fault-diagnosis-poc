// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The cost arithmetic and the ledger row.
 *
 * The figures are worked by hand: 1,234 Jev input tokens at 0.042 per million
 * cost exactly 0.0000518280 dollars, a language-model call of 1,000 input and
 * 200 output tokens at 5 and 25 costs exactly one cent, and the rules twin
 * costs nothing. "Exactly" is the point: the assertions compare ledger units
 * and the ten-decimal string the column would print, not floats within a
 * tolerance. `test/integration/cost.test.ts` then holds the same numbers
 * against the database's generated column.
 */

import { assertValid } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { candidatesFor, FIXTURE_LABELS } from "../../test/fixtures/catalog/index.ts";
import {
  FIXTURE_UNIT_ID,
  SIGNATURE_A_CANDIDATE_IDS,
  SIGNATURE_A_EVENT,
} from "../../test/fixtures/catalog/events.ts";
import { fixedClock } from "../clock.ts";
import { loadEnv } from "../config/env.ts";
import { createLlmBackend } from "../decision/llm/index.ts";
import type { LlmProvider } from "../decision/llm/provider.ts";
import { toDecisionMessage } from "../decision/message.ts";
import type { DecisionMessageContext } from "../decision/message.ts";
import { DecisionError, NONE_OF_THESE } from "../decision/types.ts";
import type { DecisionInput } from "../decision/types.ts";
import {
  computeCost,
  COST_DECIMALS,
  costBlock,
  costUnits,
  pricesFor,
  record,
  summaryPrices,
} from "./index.ts";
import type { Prices } from "./index.ts";

const AS_OF = "2026-09-19";

const JEV: Prices = { price_input_per_mtok: 0.042, price_output_per_mtok: 0, prices_as_of: AS_OF };
const LLM: Prices = { price_input_per_mtok: 5, price_output_per_mtok: 25, prices_as_of: AS_OF };
const RULES: Prices = { price_input_per_mtok: 0, price_output_per_mtok: 0, prices_as_of: AS_OF };

/** The cost as `numeric(16,10)` prints it. */
function ledgerText(units: bigint): string {
  return (Number(units) / 10 ** COST_DECIMALS).toFixed(COST_DECIMALS);
}

describe("computeCost", () => {
  it("prices 1,234 Jev input tokens at 0.042 per million as 0.0000518280 exactly", () => {
    const usage = { input_tokens: 1_234, output_tokens: 0 };
    expect(costUnits(usage, JEV)).toBe(518_280n);
    expect(ledgerText(costUnits(usage, JEV))).toBe("0.0000518280");
    expect(computeCost(usage, JEV)).toBe(0.000051828);
  });

  it("prices a language-model call on both token counts: (1000 x 5 + 200 x 25) / 1e6", () => {
    const usage = { input_tokens: 1_000, output_tokens: 200 };
    expect(costUnits(usage, LLM)).toBe(100_000_000n);
    expect(computeCost(usage, LLM)).toBe(0.01);
  });

  it("prices the rules twin at zero whatever it reports", () => {
    expect(computeCost({ input_tokens: 0, output_tokens: 0 }, RULES)).toBe(0);
    expect(computeCost({ input_tokens: 5_000, output_tokens: 700 }, RULES)).toBe(0);
  });

  it("does not drift the way tokens x price / 1e6 in floating point does", () => {
    const usage = { input_tokens: 3, output_tokens: 0 };
    const prices: Prices = { ...JEV, price_input_per_mtok: 0.1 };
    expect((3 * 0.1) / 1e6).not.toBe(0.0000003);
    expect(computeCost(usage, prices)).toBe(0.0000003);
  });

  it("rounds the eleventh decimal half away from zero, as numeric(16,10) does", () => {
    const one = { input_tokens: 1, output_tokens: 0 };
    // 1 token at 0.000050 per million is 5e-11 dollars: half a ledger unit.
    expect(costUnits(one, { ...JEV, price_input_per_mtok: 0.00005 })).toBe(1n);
    expect(costUnits(one, { ...JEV, price_input_per_mtok: 0.000049 })).toBe(0n);
    expect(costUnits(one, { ...JEV, price_input_per_mtok: 0.000149 })).toBe(1n);
    expect(costUnits(one, { ...JEV, price_input_per_mtok: 0.00015 })).toBe(2n);
  });

  it("keeps a price to the six decimals numeric(12,6) stores", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    expect(computeCost(usage, { ...JEV, price_input_per_mtok: 0.0420004 })).toBe(0.042);
  });
});

describe("pricesFor", () => {
  const env = loadEnv({
    JEV_PRICE_INPUT_PER_MTOK: "0.042",
    LLM_PRICE_INPUT_PER_MTOK: "5",
    LLM_PRICE_OUTPUT_PER_MTOK: "25",
    PRICES_AS_OF: AS_OF,
  });

  it("bills Jev on input tokens only", () => {
    expect(pricesFor(env, "jev")).toEqual(JEV);
  });

  it("bills the language model on both token counts", () => {
    expect(pricesFor(env, "llm")).toEqual(LLM);
  });

  it("bills the rules twin nothing, on the same date", () => {
    expect(pricesFor(env, "rules")).toEqual(RULES);
  });
});

describe("summaryPrices", () => {
  it("leaves the language-model prices null while no key configures it", () => {
    expect(summaryPrices(loadEnv({}))).toEqual({
      jev_input_per_mtok: 0.042,
      llm_input_per_mtok: null,
      llm_output_per_mtok: null,
      as_of: AS_OF,
    });
  });

  it("shows them once LLM_API_KEY is set", () => {
    const prices = summaryPrices(loadEnv({ LLM_API_KEY: "sk-test-not-a-key" }));
    expect(prices.llm_input_per_mtok).toBe(5);
    expect(prices.llm_output_per_mtok).toBe(25);
  });
});

describe("costBlock", () => {
  it("repeats the prices beside the cost, for the decision message", () => {
    expect(costBlock({ input_tokens: 1_234, output_tokens: 0 }, JEV)).toEqual({
      usd: 0.000051828,
      price_input_per_mtok: 0.042,
      price_output_per_mtok: 0,
      prices_as_of: AS_OF,
    });
  });
});

describe("record", () => {
  const input: DecisionInput = {
    event: SIGNATURE_A_EVENT,
    candidates: candidatesFor(SIGNATURE_A_CANDIDATE_IDS),
    unit_id: FIXTURE_UNIT_ID,
  };

  const context: DecisionMessageContext = {
    unit_id: FIXTURE_UNIT_ID,
    decision_id: "22222222-2222-4222-8222-222222222222",
    episode_id: "33333333-3333-4333-8333-333333333333",
    event_id: SIGNATURE_A_EVENT.event_id,
    sim_ts: SIGNATURE_A_EVENT.sim_ts,
    wall_ts: "2026-09-22T08:00:05.000Z",
    backend: "llm",
    model: "claude-opus-5",
    symptom_key: SIGNATURE_A_EVENT.symptom_key,
    candidates: input.candidates,
    gate: { ticketMin: 0.85, reviewMin: 0.6 },
    prices: (usage) => costBlock(usage, LLM),
  };

  const provider: LlmProvider = {
    name: "fake",
    model: "claude-opus-5",
    complete: () =>
      Promise.resolve({
        parsed: {
          choice: "dryer_purge_leak",
          probabilities: [
            { id: "dryer_purge_leak", probability: 0.9 },
            { id: NONE_OF_THESE, probability: 0.1 },
          ],
          support: [{ id: "dryer_purge_leak", support: 1 }],
          severity_level: "high",
          severity_confidence: 0.8,
          rationale: "Purge pressure far above normal.",
        },
        usage: { input_tokens: 1_000, output_tokens: 200 },
        model: "claude-opus-5",
        stop_reason: "end_turn",
        raw: {},
      }),
  };

  it("bills an answered decision at the prices its own cost block shows", async () => {
    const output = await createLlmBackend(provider, fixedClock(context.wall_ts), {
      labels: FIXTURE_LABELS,
    }).decide(input);
    const message = assertValid("decision", toDecisionMessage(output, context));

    expect(record(message)).toEqual({
      decision_id: context.decision_id,
      backend: "llm",
      model: "claude-opus-5",
      input_tokens: 1_000,
      output_tokens: 200,
      price_input_per_mtok: 5,
      price_output_per_mtok: 25,
      prices_as_of: AS_OF,
      wall_ts: context.wall_ts,
      sim_ts: SIGNATURE_A_EVENT.sim_ts,
    });
    expect(message.cost.usd).toBe(0.01);
  });

  it("bills a failed call nothing", () => {
    const failure = new DecisionError("overloaded", "anthropic returned 529", { status: 529 });
    const message = assertValid("decision", toDecisionMessage(failure, context));

    expect(message.status).toBe("failed");
    expect(record(message)).toBeNull();
  });
});
