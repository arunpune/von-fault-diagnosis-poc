// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The cost ledger of the Cost tab, as pure functions.
// `GET /api/cost` returns the newest fifty billed decisions; the decisions cache grows while the
// page is open (the `decision` frames land there), so the ledger is the union of both by
// `decision_id` and keeps growing past fifty. A decision contributes the same numbers the
// backend bills it with — its `cost` and `usage` blocks — and a failed call contributes nothing,
// because the backend writes no ledger row for it.

import type { Decision, LedgerRow } from "@/api/types";
import { parseIso } from "@/lib/time";

/** A decision as the ledger row the backend writes for it; null for a failed call. */
export function ledgerRowOf(decision: Decision): LedgerRow | null {
  if (decision.status !== "ok") {
    return null;
  }
  return {
    decision_id: decision.decision_id,
    backend: decision.backend,
    model: decision.model,
    input_tokens: decision.usage.input_tokens,
    output_tokens: decision.usage.output_tokens,
    cost_usd: decision.cost.usd,
    wall_ts: decision.wall_ts,
    sim_ts: decision.sim_ts,
  };
}

/** Epoch ms of a row's wall time; a row without a readable time sorts as the oldest. */
function wallMs(row: LedgerRow): number {
  const ms = parseIso(row.wall_ts);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * The union of the backend's newest ledger rows and the decisions cache, one row per
 * `decision_id`, newest first by wall time (ties by id, so the order is stable). Where both hold
 * a decision, the backend's row wins: it is the billed record.
 */
export function mergeLedger(
  recent: readonly LedgerRow[],
  decisions: readonly Decision[],
): LedgerRow[] {
  const byId = new Map<string, LedgerRow>();
  for (const decision of decisions) {
    const row = ledgerRowOf(decision);
    if (row !== null) {
      byId.set(row.decision_id, row);
    }
  }
  for (const row of recent) {
    byId.set(row.decision_id, row);
  }
  return Array.from(byId.values(), (row) => ({ row, ms: wallMs(row) }))
    .sort((a, b) => b.ms - a.ms || a.row.decision_id.localeCompare(b.row.decision_id))
    .map(({ row }) => row);
}

/** What the rows cost together, in US dollars. */
export function ledgerUsd(ledger: readonly LedgerRow[]): number {
  let usd = 0;
  for (const row of ledger) {
    usd += row.cost_usd;
  }
  return usd;
}

/**
 * What the decisions before the oldest row cost: the running total less the rows at hand, never
 * below zero. The ledger holds the newest decisions only, so the cumulative line starts here and
 * ends at the running total instead of starting from nothing.
 */
export function costBefore(totalUsd: number, ledger: readonly LedgerRow[]): number {
  return Math.max(0, totalUsd - ledgerUsd(ledger));
}

/** One step of the cumulative cost: the running total right after the decision at `t`. */
export interface CumulativePoint {
  /** Wall time, epoch ms. */
  t: number;
  usd: number;
}

/**
 * The running total over wall time, oldest first, for a step chart: a first point at the oldest
 * decision's time holding `startUsd`, then one point per decision with the total after it. Rows
 * without a readable wall time are left out. `ledger` is newest first, as `mergeLedger` returns it.
 */
export function cumulativeCost(ledger: readonly LedgerRow[], startUsd = 0): CumulativePoint[] {
  const points: CumulativePoint[] = [];
  let usd = startUsd;
  for (const row of ledger.toReversed()) {
    const t = parseIso(row.wall_ts);
    if (Number.isNaN(t)) {
      continue;
    }
    if (points.length === 0) {
      points.push({ t, usd });
    }
    usd += row.cost_usd;
    points.push({ t, usd });
  }
  return points;
}
