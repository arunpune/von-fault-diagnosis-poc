// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/telemetry/series`, alias `GET /api/series` (contracts
 * `api-telemetry-series`).
 *
 * The downsampled history the recorder seeds its charts from. The query names
 * the window and the tags:
 *
 * | parameter | meaning |
 * | --- | --- |
 * | `from`, `to` | the window in data time, both `iso_ts`, both required, `from ≤ to` |
 * | `signals` | comma-separated tag ids, in the order the answer keeps; every registry tag when absent |
 * | `tags` | the same list under the name the user interface uses; `signals` wins when both are given |
 * | `points` | the point budget per tag, at most 2000 (the contract's cap, also the default); ingest keeps at least one bucket, two points |
 *
 * The decimation itself — min and max per bucket for an analog tag, the
 * transitions of a digital one, the ring or the one-minute aggregates — is
 * ingest's (`ingest/downsample.ts`); this route only reads the query and
 * checks the answer against the contract.
 */

import { assertValid, SIGNALS, type ApiTelemetrySeries } from "@fdp/contracts";
import type { FastifyPluginAsync } from "fastify";

import { MAX_SERIES_POINTS } from "../ingest/types.ts";
import type { ApiDeps } from "./deps.ts";
import { BadRequestError } from "./errors.ts";
import { identifierListParam, instantParam, positiveIntParam, type Query } from "./query.ts";

/** The canonical path and its alias; both answer the same body. */
export const SERIES_PATHS = ["/telemetry/series", "/series"] as const;

/** The registry's tags, in register order: the answer when a request names none. */
const ALL_TAGS: readonly string[] = SIGNALS.map((signal) => signal.tag);

function requiredInstant(query: Query, name: string): number {
  const value = instantParam(query, name);
  if (value === undefined) throw new BadRequestError(`${name} is required`, name);
  return value;
}

export function seriesRoutes(ingest: ApiDeps["ingest"]): FastifyPluginAsync {
  return async (fastify) => {
    for (const path of SERIES_PATHS) {
      fastify.get<{ Querystring: Query }>(path, async (request): Promise<ApiTelemetrySeries> => {
        const query = request.query;
        const fromMs = requiredInstant(query, "from");
        const toMs = requiredInstant(query, "to");
        if (fromMs > toMs) throw new BadRequestError("from is after to", "from");
        const signalIds =
          identifierListParam(query, "signals") ?? identifierListParam(query, "tags") ?? ALL_TAGS;
        const points = positiveIntParam(query, "points", MAX_SERIES_POINTS);

        const series = await ingest.series({ signalIds, fromMs, toMs, points });
        return assertValid("api-telemetry-series", series);
      });
    }
  };
}
