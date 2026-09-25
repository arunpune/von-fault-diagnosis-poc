// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The statements the cost ledger runs as `app_rw`.
 *
 * The ledger is the only place a dollar figure is stored, and `cost_usd` is a
 * generated column, so nothing here ever writes one: the insert sends tokens
 * and the prices they were billed at, and the database derives the rest. A
 * reader that wants the money asks for the column back.
 *
 * Every sum is taken in SQL, over `numeric`, so a total is as exact as the rows
 * it adds up; JavaScript only ever sees the finished figure. Money and token
 * sums come out of the driver as strings, because `numeric` and `bigint` do
 * not fit a JavaScript number in general, and every one of them is converted
 * in one place, {@link toNumber}, so a forgotten conversion cannot leave a
 * string where the contract promises a number — `api-cost` is validated
 * against its schema in the integration test, which is what makes that a
 * mechanical guarantee rather than a convention.
 *
 * Like `ingest/repo.ts`, this module holds no pool: it takes a
 * {@link Queryable}, so a test can hand it a transaction and roll the whole
 * fixture back.
 */

import type { ApiCost, BackendTotals, DecisionBackend, LedgerRow } from "@fdp/contracts";

import { query, queryOne, type Queryable } from "../db/pool.ts";
import type { CostLedgerRow } from "./index.ts";

/** How many rows `api-cost.recent` carries at most. */
export const MAX_RECENT_ROWS = 50;

/** How many rows `GET /api/cost/ledger` returns when it is not asked. */
export const DEFAULT_LEDGER_LIMIT = 100;

/** The most rows one `GET /api/cost/ledger` returns, whatever it asks for. */
export const MAX_LEDGER_LIMIT = 1_000;

/** One item of `GET /api/cost/ledger`: a ledger row plus the prices it was billed at. */
export interface CostLedgerEntry extends LedgerRow {
  readonly price_input_per_mtok: number;
  readonly price_output_per_mtok: number;
  /** The day the prices were read, `YYYY-MM-DD`. */
  readonly prices_as_of: string;
}

/** The body of `GET /api/cost/ledger`. */
export interface CostLedger {
  readonly items: CostLedgerEntry[];
}

/** What the REST routes, the WS `cost.update` frame and the sinks use. */
export interface CostRepo {
  /**
   * Write the row of one billed decision and return the `cost_usd` the
   * database generated for it, or `null` when that decision was billed
   * already (`decision_id` is unique, so a replayed message bills once).
   */
  insert(row: CostLedgerRow): Promise<number | null>;
  /** The whole `api-cost` body. */
  summary(): Promise<ApiCost>;
  /** The newest ledger rows, newest first, for `GET /api/cost/ledger`. */
  ledger(limit?: number): Promise<CostLedger>;
  /** What the run has cost so far: `total_usd` of the `cost.update` frame. */
  totalUsd(): Promise<number>;
  /** Money, calls and tokens so far; `calls` is the frame's other running figure. */
  totals(): Promise<ApiCost["totals"]>;
}

/** `numeric` and `bigint` arrive as strings; `null` means no rows at all. */
function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

/** A `timestamptz` as the contracts' one timestamp format. */
function toIso(value: Date): string {
  return value.toISOString();
}

const INSERT = `
INSERT INTO app.cost_ledger
       (decision_id, backend, model, input_tokens, output_tokens,
        price_input_per_mtok, price_output_per_mtok, prices_as_of, wall_ts, sim_ts)
VALUES ($1::uuid, $2, $3, $4::integer, $5::integer,
        $6::numeric, $7::numeric, $8::date, $9::timestamptz, $10::timestamptz)
ON CONFLICT (decision_id) DO NOTHING
RETURNING cost_usd`;

const TOTALS = `
SELECT coalesce(sum(cost_usd), 0) AS usd,
       count(*) AS calls,
       coalesce(sum(input_tokens), 0) AS input_tokens,
       coalesce(sum(output_tokens), 0) AS output_tokens
  FROM app.cost_ledger`;

// The view groups by backend and model; `api-cost.by_backend` is keyed by
// backend alone and names one model, so the models of one backend are added
// together here and the one that answered most of its calls names the entry
// (a run that changed LLM_MODEL halfway keeps the split in `recent` and in the
// ledger).
const BY_BACKEND = `
SELECT backend,
       (array_agg(model ORDER BY calls DESC, model))[1] AS model,
       sum(calls) AS calls,
       coalesce(sum(input_tokens), 0) AS input_tokens,
       coalesce(sum(output_tokens), 0) AS output_tokens,
       coalesce(sum(cost_usd), 0) AS usd
  FROM app.v_cost_totals
 GROUP BY backend
 ORDER BY backend`;

const BY_DAY = `
SELECT to_char((wall_ts AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day_wall,
       sum(cost_usd) AS usd
  FROM app.cost_ledger
 GROUP BY 1
 ORDER BY 1`;

// `sim_ts` is nullable in the schema, and the contract's ledger row is not: a
// row this backend wrote always carries one, and anything else reports the
// wall time it was billed at rather than dropping out of the list.
const ROWS = `
SELECT decision_id, backend, model, input_tokens, output_tokens, cost_usd,
       wall_ts, coalesce(sim_ts, wall_ts) AS sim_ts,
       price_input_per_mtok, price_output_per_mtok,
       to_char(prices_as_of, 'YYYY-MM-DD') AS prices_as_of
  FROM app.cost_ledger
 ORDER BY id DESC
 LIMIT $1::integer`;

type TotalsRecord = {
  usd: string;
  calls: string;
  input_tokens: string;
  output_tokens: string;
};

type BackendRecord = {
  backend: DecisionBackend;
  model: string;
  calls: string;
  input_tokens: string;
  output_tokens: string;
  usd: string;
};

type DayRecord = { day_wall: string; usd: string };

type RowRecord = {
  decision_id: string;
  backend: DecisionBackend;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
  wall_ts: Date;
  sim_ts: Date;
  price_input_per_mtok: string;
  price_output_per_mtok: string;
  prices_as_of: string;
};

/** One `api-cost.recent` entry out of a ledger row. */
function toLedgerRow(row: RowRecord): LedgerRow {
  return {
    decision_id: row.decision_id,
    backend: row.backend,
    model: row.model,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cost_usd: toNumber(row.cost_usd),
    wall_ts: toIso(row.wall_ts),
    sim_ts: toIso(row.sim_ts),
  };
}

/** A `limit` query value as a row count the statement accepts. */
function ledgerLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LEDGER_LIMIT;
  return Math.min(MAX_LEDGER_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * The cost repository over one queryable holding the `app_rw` credential.
 *
 * `prices` is the `prices` block of `api-cost` (`summaryPrices(env)`): it is
 * configuration, not ledger data, so it is handed in once rather than read
 * from the rows.
 */
export function createCostRepo(db: Queryable, prices: ApiCost["prices"]): CostRepo {
  async function totals(): Promise<ApiCost["totals"]> {
    const row = await queryOne<TotalsRecord>(db, TOTALS);
    return {
      usd: toNumber(row?.usd),
      calls: toNumber(row?.calls),
      input_tokens: toNumber(row?.input_tokens),
      output_tokens: toNumber(row?.output_tokens),
    };
  }

  return {
    async insert(row: CostLedgerRow): Promise<number | null> {
      const inserted = await queryOne<{ cost_usd: string }>(db, INSERT, [
        row.decision_id,
        row.backend,
        row.model,
        row.input_tokens,
        row.output_tokens,
        row.price_input_per_mtok,
        row.price_output_per_mtok,
        row.prices_as_of,
        row.wall_ts,
        row.sim_ts,
      ]);
      return inserted === undefined ? null : toNumber(inserted.cost_usd);
    },

    async summary(): Promise<ApiCost> {
      const [running, backends, days, recent] = await Promise.all([
        totals(),
        query<BackendRecord>(db, BY_BACKEND),
        query<DayRecord>(db, BY_DAY),
        query<RowRecord>(db, ROWS, [MAX_RECENT_ROWS]),
      ]);

      const byBackend: Record<string, BackendTotals> = {};
      for (const backend of backends) {
        byBackend[backend.backend] = {
          model: backend.model,
          usd: toNumber(backend.usd),
          calls: toNumber(backend.calls),
          input_tokens: toNumber(backend.input_tokens),
          output_tokens: toNumber(backend.output_tokens),
        };
      }

      return {
        totals: running,
        by_backend: byBackend,
        by_day: days.map((day) => ({ day_wall: day.day_wall, usd: toNumber(day.usd) })),
        prices,
        recent: recent.map(toLedgerRow),
      };
    },

    async ledger(limit: number = DEFAULT_LEDGER_LIMIT): Promise<CostLedger> {
      const rows = await query<RowRecord>(db, ROWS, [ledgerLimit(limit)]);
      return {
        items: rows.map((row) => ({
          ...toLedgerRow(row),
          price_input_per_mtok: toNumber(row.price_input_per_mtok),
          price_output_per_mtok: toNumber(row.price_output_per_mtok),
          prices_as_of: row.prices_as_of,
        })),
      };
    },

    async totalUsd(): Promise<number> {
      return (await totals()).usd;
    },

    totals,
  };
}
