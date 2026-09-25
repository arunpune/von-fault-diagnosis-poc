// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/episodes` (contracts `api-episodes`): one page
 * of episodes, newest first.
 *
 * | parameter | meaning |
 * | --- | --- |
 * | `status` | `open`, `closed` or `aborted`; every episode when absent |
 * | `before` | the `next_cursor` of the previous page |
 * | `limit` | episodes per page; default 50, at most 200 |
 */

import { assertValid, type ApiEpisodes } from "@fdp/contracts";
import type { FastifyPluginAsync } from "fastify";

import type { EpisodeStatus } from "../episodes/index.ts";
import type { EpisodesReader } from "./deps.ts";
import { enumParam, positiveIntParam, textParam, type Query } from "./query.ts";

/** The statuses `?status=` accepts: the contract's episode statuses. */
export const EPISODE_STATUSES: readonly EpisodeStatus[] = ["open", "closed", "aborted"];

export function episodesRoutes(episodes: EpisodesReader): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get<{ Querystring: Query }>("/episodes", async (request): Promise<ApiEpisodes> => {
      const query = request.query;
      const page = await episodes.list({
        status: enumParam(query, "status", EPISODE_STATUSES),
        before: textParam(query, "before"),
        limit: positiveIntParam(query, "limit"),
      });
      return assertValid("api-episodes", page);
    });
  };
}
