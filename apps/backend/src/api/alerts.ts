// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/alerts/system`: the system alerts of the two
 * watchdogs, each as its latest `alert-system` message, newest raise first.
 *
 * | parameter | meaning |
 * | --- | --- |
 * | `active` | `true`: only the alerts raised right now (the banners after a reconnect); `false`: only cleared ones; both when absent |
 * | `limit` | at most this many alerts; the repository's default (100) and cap (1,000) apply |
 *
 * The body is `{ items: alert-system[] }`, every item checked against the
 * contract before it leaves.
 */

import { assertValid, type AlertSystem } from "@fdp/contracts";
import type { FastifyPluginAsync } from "fastify";

import type { ApiRepos } from "./deps.ts";
import { booleanParam, positiveIntParam, type Query } from "./query.ts";

/** The body of `GET /api/alerts/system`. */
export interface AlertList {
  readonly items: readonly AlertSystem[];
}

export function alertsRoutes(alerts: ApiRepos["alerts"]): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get<{ Querystring: Query }>("/alerts/system", async (request): Promise<AlertList> => {
      const items = await alerts.list({
        active: booleanParam(request.query, "active"),
        limit: positiveIntParam(request.query, "limit"),
      });
      return { items: items.map((alert) => assertValid("alert-system", alert)) };
    });
  };
}
