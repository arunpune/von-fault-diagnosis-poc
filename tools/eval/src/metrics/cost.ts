// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What a run cost.
//
//   usd = input_tokens × price_in / 1e6 + output_tokens × price_out / 1e6
//
// The database stores the same quantity as a generated column,
// `(input_tokens * price_input_per_mtok + output_tokens * price_output_per_mtok) / 1000000.0`
// in `numeric(16,10)`. The two groupings differ only in the last bits of a
// double, far below the column's tenth decimal, so the report and the ledger
// agree to 1e-12 — which `cost.test.ts` asserts on the two reference cases
// rather than trusting.
//
// Prices are per backend and dated. Jev bills input tokens only; the LLM
// comparison bills both; the rules backend is free and gets zero prices rather
// than an exception, so the same arithmetic runs for all three and a rules
// column of 0.00 is a measured number, not a special case.

import type { BackendPrices, CostSummary, DecisionRecord, Prices, TicketRecord } from "./types.ts";

export type { BackendPrices, CostSummary } from "./types.ts";

/** Tokens per million, the unit every published price is quoted in. */
const PER_MTOK = 1_000_000;

/** What one decision cost. */
export interface DecisionCost {
  readonly decisionId: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly usd: number;
}

/** The cost summary plus the per-decision rows the ledger keeps. */
export interface CostResult extends CostSummary {
  readonly decisions: readonly DecisionCost[];
}

/**
 * The prices one backend is billed at (`pricesFor`).
 *
 * Any backend that is not `jev` or `llm` is free: the rules baseline costs nothing, and a
 * future deterministic backend should not need a new branch to be costed correctly.
 */
export function pricesFor(prices: Prices, backend: string): BackendPrices {
  if (backend === "jev") {
    return { inputPerMtok: prices.jevInputPerMtok, outputPerMtok: 0, asOf: prices.asOf };
  }
  if (backend === "llm") {
    return {
      inputPerMtok: prices.llmInputPerMtok,
      outputPerMtok: prices.llmOutputPerMtok,
      asOf: prices.asOf,
    };
  }
  return { inputPerMtok: 0, outputPerMtok: 0, asOf: prices.asOf };
}

/** The cost formula for one decision's usage. */
function usd(input: number, output: number, prices: BackendPrices): number {
  return (input * prices.inputPerMtok) / PER_MTOK + (output * prices.outputPerMtok) / PER_MTOK;
}

/**
 * What a backend's decisions cost, in total, per decision and per ticket.
 *
 * @param decisions the ok decisions of the scenario or run; failed calls carry no tokens and
 * get no ledger row, so they are simply absent.
 * @param prices the run's dated prices.
 * @param backend the backend the decisions came from; it selects the prices.
 * @param tickets the tickets those decisions produced, for the per-ticket figure.
 * @returns the totals; `perDecision` and `perTicket` are `null` when there were none, because
 * a cost per ticket of 0.00 and "no tickets were opened" are different findings.
 */
export function cost(
  decisions: readonly DecisionRecord[],
  prices: Prices,
  backend: string,
  tickets: readonly TicketRecord[] = [],
): CostResult {
  const billed = pricesFor(prices, backend);
  const rows = decisions.map((decision) => ({
    decisionId: decision.decisionId,
    input_tokens: decision.usage.input_tokens,
    output_tokens: decision.usage.output_tokens,
    usd: usd(decision.usage.input_tokens, decision.usage.output_tokens, billed),
  }));

  const total = rows.reduce((sum, row) => sum + row.usd, 0);
  const input = rows.reduce((sum, row) => sum + row.input_tokens, 0);
  const output = rows.reduce((sum, row) => sum + row.output_tokens, 0);

  return {
    backend,
    usd: total,
    input_tokens: input,
    output_tokens: output,
    calls: rows.length,
    perDecision: rows.length === 0 ? null : total / rows.length,
    perTicket: tickets.length === 0 ? null : total / tickets.length,
    prices: billed,
    decisions: rows,
  };
}

/**
 * Several cost summaries of one backend pooled into one.
 *
 * @throws TypeError when the summaries name different backends or different prices, which
 * would produce a total nobody can reproduce from the report's price block.
 */
export function mergeCost(
  summaries: readonly CostSummary[],
  backend: string,
  prices: BackendPrices,
  tickets: number,
): CostSummary {
  for (const summary of summaries) {
    if (summary.backend !== backend) {
      throw new TypeError(`cannot pool the cost of ${summary.backend} into ${backend}`);
    }
  }
  const total = summaries.reduce((sum, summary) => sum + summary.usd, 0);
  const calls = summaries.reduce((sum, summary) => sum + summary.calls, 0);

  return {
    backend,
    usd: total,
    input_tokens: summaries.reduce((sum, summary) => sum + summary.input_tokens, 0),
    output_tokens: summaries.reduce((sum, summary) => sum + summary.output_tokens, 0),
    calls,
    perDecision: calls === 0 ? null : total / calls,
    perTicket: tickets === 0 ? null : total / tickets,
    prices,
  };
}
