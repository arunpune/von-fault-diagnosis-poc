// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/events/suspect`, alias `GET /api/events` (contracts `api-events`):
 * one page of suspect events, newest first.
 *
 * | parameter | meaning |
 * | --- | --- |
 * | `before` | the `next_cursor` of the previous page; the newest events when absent |
 * | `limit` | events per page; the repository's default (50) and cap (200) apply |
 * | `symptom_key` | only the events opened on this symptom |
 *
 * The items are the stored `suspect-event` messages, exactly as detection
 * published them.
 */

import { assertValid, type ApiEvents } from "@fdp/contracts";
import type { FastifyPluginAsync } from "fastify";

import type { ApiRepos } from "./deps.ts";
import { identifierParam, positiveIntParam, textParam, type Query } from "./query.ts";

/** The canonical path and its alias; both answer the same body. */
export const EVENT_PATHS = ["/events/suspect", "/events"] as const;

export function eventsRoutes(events: ApiRepos["events"]): FastifyPluginAsync {
  return async (fastify) => {
    for (const path of EVENT_PATHS) {
      fastify.get<{ Querystring: Query }>(path, async (request): Promise<ApiEvents> => {
        const query = request.query;
        const page = await events.list({
          before: textParam(query, "before"),
          limit: positiveIntParam(query, "limit"),
          symptom_key: identifierParam(query, "symptom_key"),
        });
        return assertValid("api-events", page);
      });
    }
  };
}
