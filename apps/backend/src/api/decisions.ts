// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/decisions` and `GET /api/decisions/:id` (contracts `api-decisions`
 * and `decision`).
 *
 * The list is one page of decision messages, newest first:
 *
 * | parameter | meaning |
 * | --- | --- |
 * | `before` | the `next_cursor` of the previous page; the newest decisions when absent |
 * | `limit` | decisions per page; the repository's default (50) and cap (200) apply |
 * | `episode_id` | only the decisions taken inside this episode (the ticket history) |
 *
 * The single decision is the same message plus `state`: what the decision
 * backend was shown, which the decision sheet renders and the broker never
 * carries. Failed decisions are messages like any other (`status: failed`),
 * so both routes list them.
 */

import { assertValid, type ApiDecisions } from "@fdp/contracts";
import type { FastifyPluginAsync } from "fastify";

import type { StoredDecision } from "../persistence/types.ts";
import type { ApiRepos } from "./deps.ts";
import { NotFoundError } from "./errors.ts";
import { positiveIntParam, textParam, type Query } from "./query.ts";

export function decisionsRoutes(decisions: ApiRepos["decisions"]): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get<{ Querystring: Query }>("/decisions", async (request): Promise<ApiDecisions> => {
      const query = request.query;
      const page = await decisions.list({
        before: textParam(query, "before"),
        limit: positiveIntParam(query, "limit"),
        episode_id: textParam(query, "episode_id"),
      });
      return assertValid("api-decisions", page);
    });

    fastify.get<{ Params: { id: string } }>(
      "/decisions/:id",
      async (request): Promise<StoredDecision> => {
        const decision = await decisions.get(request.params.id, { withState: true });
        if (decision === undefined) {
          throw new NotFoundError(`no decision with id ${request.params.id}`);
        }
        assertValid("decision", decision);
        return decision;
      },
    );
  };
}
