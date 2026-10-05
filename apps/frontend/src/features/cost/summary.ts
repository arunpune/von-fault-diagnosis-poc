// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The words and rows of the cost summary, kept free of React so they are tested as plain
// functions: the backend names as the tab writes them, the price sentence with its as-of date,
// the per-backend rows in a fixed order, and when the rules backend's "no cost" sentence applies.

import type { ApiCost, BackendTotals } from "@/api/types";
import { fmtUsd, humanize } from "@/lib/format";

/** How each decision backend reads on screen; an unknown one reads as its humanised name. */
const BACKEND_LABELS: Readonly<Record<string, string>> = {
  von: "Von",
  llm: "Language model",
  rules: "Rules",
};

/** The order the per-backend rows are listed in; a backend this build does not know comes last. */
const BACKEND_ORDER: readonly string[] = ["von", "llm", "rules"];

export const RULES_NOTICE = "Rules backend: no model calls, no cost.";

export function backendLabel(backend: string): string {
  return BACKEND_LABELS[backend] ?? humanize(backend);
}

export interface BackendRow extends BackendTotals {
  backend: string;
}

function backendRank(backend: string): number {
  const rank = BACKEND_ORDER.indexOf(backend);
  return rank === -1 ? BACKEND_ORDER.length : rank;
}

/** `by_backend` as rows: Von, the language model, rules, then any other backend by name. */
export function backendRows(byBackend: ApiCost["by_backend"]): BackendRow[] {
  return Object.entries(byBackend)
    .map(([backend, totals]) => ({ ...totals, backend }))
    .sort(
      (a, b) =>
        backendRank(a.backend) - backendRank(b.backend) || a.backend.localeCompare(b.backend),
    );
}

function perMtok(usd: number): string {
  return `${fmtUsd(usd)} per MTok`;
}

/** The language model's prices, or null while neither is configured. */
function llmPrices(prices: ApiCost["prices"]): string | null {
  const parts: string[] = [];
  if (prices.llm_input_per_mtok !== null) {
    parts.push(`${perMtok(prices.llm_input_per_mtok)} input`);
  }
  if (prices.llm_output_per_mtok !== null) {
    parts.push(`${perMtok(prices.llm_output_per_mtok)} output`);
  }
  return parts.length === 0 ? null : `language model ${parts.join(", ")}`;
}

/**
 * The prices the totals were computed with and the day they were checked: "$0.042 per MTok
 * input, output free · prices as of 2026-09-19". When the language model has prices, the Von
 * price is named and the language model's follow it.
 */
export function priceSentence(prices: ApiCost["prices"]): string {
  const von = `${perMtok(prices.von_input_per_mtok)} input, output free`;
  const llm = llmPrices(prices);
  const rates = llm === null ? von : `Von ${von}; ${llm}`;
  return `${rates} · prices as of ${prices.as_of}`;
}

/**
 * True when the rules backend is the active one and no model has billed a call: nothing has cost
 * anything, and the tab says why. The rules backend's own decisions are ledger rows at zero cost,
 * so they do not end it; with no calls at all it holds trivially.
 */
export function showsRulesNotice(activeBackend: string | null, cost: ApiCost): boolean {
  if (activeBackend !== "rules") {
    return false;
  }
  if (cost.totals.calls === 0) {
    return true;
  }
  return Object.entries(cost.by_backend).every(
    ([backend, totals]) => backend === "rules" || totals.calls === 0,
  );
}
