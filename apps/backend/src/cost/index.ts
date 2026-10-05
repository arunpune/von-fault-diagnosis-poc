// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a decision cost.
 *
 * Three consumers read the same number: the decision message's `cost` block,
 * the cost panel behind `GET /api/cost`, and the evaluation report. They agree
 * because the arithmetic exists twice and only twice — here, and as the
 * generated column of `app.cost_ledger` — and the integration test asserts the
 * two agree to the last digit the column keeps.
 *
 * ## Why the arithmetic is integer
 *
 * `cost_usd` is `numeric(16,10)`, so a decision costs a whole number of
 * ten-decimal units and nothing finer. Computing it as `tokens * price / 1e6`
 * in binary floating point gives a value that is a few ulps away from that,
 * which is invisible in a panel and fatal in an assertion: the ledger and the
 * message would disagree in the tenth decimal for no reason a reader could
 * explain.
 *
 * So the whole computation is exact. A price is `numeric(12,6)`, so it is an
 * integer number of millionths; multiplied by a token count it is an integer
 * number of millionths of a dollar per million tokens, which is an integer
 * number of `1e-12` dollars. Dividing that by a hundred, rounding half away
 * from zero as PostgreSQL's `numeric` does, gives the ledger's own unit
 * exactly. Only the final conversion to a JavaScript number is inexact, and it
 * happens after the value is already fixed.
 *
 * ## Dated prices
 *
 * Every row carries the prices it was billed at and the day those prices were
 * read (`PRICES_AS_OF`). A re-priced model therefore never rewrites history:
 * yesterday's rows keep yesterday's price, and the cost panel can show both.
 */

import type { ApiCost, Decision } from "@fdp/contracts";

import type { Env } from "../config/env.ts";
import type { DecisionCost } from "../decision/message.ts";
import type { DecisionBackendName, DecisionUsage } from "../decision/types.ts";

/** How many decimals the ledger's `cost_usd` keeps (`numeric(16,10)`). */
export const COST_DECIMALS = 10;

/** One ledger unit as a fraction of a dollar: `1e-10`. */
const COST_UNITS_PER_USD = 10 ** COST_DECIMALS;

/** How many decimals a price keeps (`numeric(12,6)`). */
const PRICE_UNITS_PER_USD = 1_000_000;

/**
 * How many `1e-12` units make one ledger unit.
 *
 * A token count times a price in millionths is a whole number of `1e-12`
 * dollars per million tokens, which is a whole number of `1e-12` dollars once
 * the million is divided out.
 */
const RAW_UNITS_PER_COST_UNIT = 100n;

/** The prices one backend is billed at, as `app.cost_ledger` stores them. */
export interface Prices {
  readonly price_input_per_mtok: number;
  readonly price_output_per_mtok: number;
  /** The day the prices were read, `YYYY-MM-DD`. */
  readonly prices_as_of: string;
}

/** One `app.cost_ledger` row, without the column the database generates. */
export interface CostLedgerRow extends Prices {
  readonly decision_id: string;
  readonly backend: DecisionBackendName;
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly wall_ts: string;
  readonly sim_ts: string;
}

/**
 * The prices `backend` is billed at.
 *
 * Von bills input tokens only — its answers are option ids and numbers, and
 * the price list carries no output price for it — and the rules twin calls
 * nothing at all, so its rows cost zero and still exist, which is what makes
 * "what would this run have cost with a model" answerable from one table.
 */
export function pricesFor(env: Env, backend: DecisionBackendName): Prices {
  const asOf = env.prices.asOf;
  switch (backend) {
    case "von":
      return {
        price_input_per_mtok: env.prices.vonInputPerMtok,
        price_output_per_mtok: 0,
        prices_as_of: asOf,
      };
    case "llm":
      return {
        price_input_per_mtok: env.prices.llmInputPerMtok,
        price_output_per_mtok: env.prices.llmOutputPerMtok,
        prices_as_of: asOf,
      };
    case "rules":
      return { price_input_per_mtok: 0, price_output_per_mtok: 0, prices_as_of: asOf };
  }
}

/**
 * The `prices` block of `api-cost`.
 *
 * The language-model prices are `null` until a key configures that backend,
 * because a figure the run could not have been billed at would read as a claim
 * about what it spent. Von's input price is always shown: the cost panel uses
 * it to price a run that has not called anything yet.
 */
export function summaryPrices(env: Env): ApiCost["prices"] {
  const llmConfigured = env.llmApiKey !== null;
  return {
    von_input_per_mtok: env.prices.vonInputPerMtok,
    llm_input_per_mtok: llmConfigured ? env.prices.llmInputPerMtok : null,
    llm_output_per_mtok: llmConfigured ? env.prices.llmOutputPerMtok : null,
    as_of: env.prices.asOf,
  };
}

/** A price as the whole number of millionths `numeric(12,6)` stores. */
function priceUnits(price: number): bigint {
  return BigInt(Math.round(price * PRICE_UNITS_PER_USD));
}

/** A token count as a whole number; a fractional count would not be one. */
function tokenUnits(tokens: number): bigint {
  return BigInt(Math.max(0, Math.round(tokens)));
}

/**
 * The cost in ledger units (`1e-10` dollars), exactly as the column stores it.
 *
 * Exported because the integration test compares against the database in this
 * unit rather than in dollars: an equality of integers leaves no room for the
 * comparison itself to be the thing that fails.
 */
export function costUnits(usage: DecisionUsage, prices: Prices): bigint {
  const raw =
    tokenUnits(usage.input_tokens) * priceUnits(prices.price_input_per_mtok) +
    tokenUnits(usage.output_tokens) * priceUnits(prices.price_output_per_mtok);
  // PostgreSQL's numeric rounds half away from zero, and `raw` is never
  // negative: tokens and prices both carry a non-negative check.
  return (raw + RAW_UNITS_PER_COST_UNIT / 2n) / RAW_UNITS_PER_COST_UNIT;
}

/** What one call cost, in US dollars, rounded as the ledger rounds it. */
export function computeCost(usage: DecisionUsage, prices: Prices): number {
  return Number(costUnits(usage, prices)) / COST_UNITS_PER_USD;
}

/** The `cost` block of the decision message. */
export function costBlock(usage: DecisionUsage, prices: Prices): DecisionCost {
  return {
    usd: computeCost(usage, prices),
    price_input_per_mtok: prices.price_input_per_mtok,
    price_output_per_mtok: prices.price_output_per_mtok,
    prices_as_of: prices.prices_as_of,
  };
}

/**
 * The ledger row of one decision message, or `null` when it bills nothing.
 *
 * Only an ok decision gets a row. A failed call has no tokens: it is counted in
 * `status-backend` instead, so the cost panel shows what was spent and not how
 * often the provider was down.
 *
 * The prices come from the message's own `cost` block, which `costBlock`
 * filled from the same {@link Prices} when the message was built, so the row
 * and the message cannot be billed at two different prices — and the
 * database's generated `cost_usd` then equals `cost.usd` to the last digit.
 */
export function record(decision: Decision): CostLedgerRow | null {
  if (decision.status !== "ok") return null;
  return {
    decision_id: decision.decision_id,
    backend: decision.backend,
    model: decision.model,
    input_tokens: decision.usage.input_tokens,
    output_tokens: decision.usage.output_tokens,
    price_input_per_mtok: decision.cost.price_input_per_mtok,
    price_output_per_mtok: decision.cost.price_output_per_mtok,
    prices_as_of: decision.cost.prices_as_of,
    wall_ts: decision.wall_ts,
    sim_ts: decision.sim_ts,
  };
}
