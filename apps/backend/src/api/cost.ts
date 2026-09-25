// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/cost` and `GET /api/cost/ledger` (contracts `api-cost`).
 *
 * The summary is the cost panel's whole body — running totals, the split per
 * decision backend, the daily series, the prices and the fifty newest ledger
 * rows — summed in SQL by the cost repository. The ledger is the
 * newest billed decisions with the prices each was billed at,
 * `{ items: [...] }`, `limit` rows (the repository's default 100, at most
 * 1,000). Only answered decisions are billed, so a failed call appears in
 * neither.
 */

import { assertValid, type ApiCost } from "@fdp/contracts";
import type { FastifyPluginAsync } from "fastify";

import { MAX_LEDGER_LIMIT } from "../cost/repo.ts";
import type { CostLedger } from "../persistence/types.ts";
import type { ApiRepos } from "./deps.ts";
import { positiveIntParam, type Query } from "./query.ts";

export function costRoutes(cost: ApiRepos["cost"]): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/cost", async (): Promise<ApiCost> =>
      assertValid("api-cost", await cost.summary()),
    );

    fastify.get<{ Querystring: Query }>("/cost/ledger", async (request): Promise<CostLedger> =>
      cost.ledger(positiveIntParam(request.query, "limit", MAX_LEDGER_LIMIT)),
    );
  };
}
