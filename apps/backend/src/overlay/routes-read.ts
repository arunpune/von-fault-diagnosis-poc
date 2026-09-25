// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/overlay/*`: the read-only overlay endpoint.
 *
 * The user interface draws the recorded truth over the charts so a viewer can
 * see what the diagnosis side was never told. That is the one direction ground
 * truth is allowed to travel, and this file is deliberately the whole of it:
 * four GET routes, no writer, no command. Dependency-cruiser refuses an import
 * of the recorder or of the control passthrough from here, so a later change
 * cannot quietly turn the read endpoint into a write endpoint.
 *
 * The two retained messages are served from the recorder's memory through the
 * injected getters — the plugin never imports the recorder itself — and the two
 * ranged lists come from the repository's read functions. The marker list is
 * checked against its contract before it is sent: these bodies have no `api-*`
 * schema of their own and the `gt-*` message is what the
 * interface parses, so a row that cannot be read back as one is a bug here, not
 * a body to hand out.
 */

import {
  assertValid,
  ISO_MS_PATTERN,
  type ActiveFaultInjections,
  type GroundTruthCatalog,
  type ReplayMarker,
} from "@fdp/contracts";
import type { FastifyPluginAsync, FastifyReply } from "fastify";

import { overlayError } from "./errors.ts";
import type { InjectionWindow, Marker, OverlayRepo, SimRange } from "./repo.ts";

/** The read side of the repository; these routes need nothing that writes. */
export type OverlayReadRepo = Pick<OverlayRepo, "injectionWindows" | "markers">;

export interface OverlayReadPorts {
  /** The newest `gt-catalog`, or null before the simulator published one. */
  readonly catalog: () => GroundTruthCatalog | null;
  /** The newest `gt-injection-active`, or null before the simulator published one. */
  readonly active: () => ActiveFaultInjections | null;
  readonly repo: OverlayReadRepo;
  /** The unit whose overlay is served. */
  readonly unitId: string;
}

/** The body of `GET /api/overlay/injections`. */
export interface InjectionWindowList {
  readonly items: readonly InjectionWindow[];
}

/** The body of `GET /api/overlay/markers`: whole `gt-marker` messages. */
export interface MarkerList {
  readonly items: readonly ReplayMarker[];
}

/** `?from=&to=`, both optional and both `iso_ts` when present. */
interface RangeQuery {
  from?: string;
  to?: string;
}

/** The query string as a {@link SimRange}, or the name of the bound that is not an instant. */
function rangeOf(query: RangeQuery): SimRange | string {
  for (const name of ["from", "to"] as const) {
    const value = query[name];
    if (value !== undefined && !ISO_MS_PATTERN.test(value)) return name;
  }
  return { from: query.from ?? null, to: query.to ?? null };
}

/** Rebuild the `gt-marker` message a stored row came from. */
function markerMessage(row: Marker): ReplayMarker {
  return assertValid("gt-marker", {
    schema: "urn:fdp:schema:gt-marker:v1",
    unit_id: row.unit_id,
    wall_ts: row.wall_ts,
    kind: row.kind,
    ...(row.preset_id === null ? {} : { preset_id: row.preset_id }),
    sim_ts_from: row.sim_ts_from,
    sim_ts_to: row.sim_ts_to,
  });
}

function badRange(reply: FastifyReply, bound: string): FastifyReply {
  return reply
    .code(400)
    .send(overlayError("bad_request", `${bound} is not an iso_ts instant`, { parameter: bound }));
}

export function overlayReadRoutes(ports: OverlayReadPorts): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/overlay/catalog", async (_request, reply) => {
      const catalog = ports.catalog();
      if (catalog === null) {
        return reply
          .code(404)
          .send(overlayError("not_found", "the simulator has not published a catalog yet"));
      }
      return reply.code(200).send(catalog);
    });

    fastify.get("/overlay/active", async (_request, reply) => {
      const active = ports.active();
      if (active === null) {
        return reply
          .code(404)
          .send(overlayError("not_found", "the simulator has not published an active list yet"));
      }
      return reply.code(200).send(active);
    });

    fastify.get<{ Querystring: RangeQuery }>("/overlay/injections", async (request, reply) => {
      const range = rangeOf(request.query);
      if (typeof range === "string") return badRange(reply, range);
      const body: InjectionWindowList = {
        items: await ports.repo.injectionWindows(ports.unitId, range),
      };
      return reply.code(200).send(body);
    });

    fastify.get<{ Querystring: RangeQuery }>("/overlay/markers", async (request, reply) => {
      const range = rangeOf(request.query);
      if (typeof range === "string") return badRange(reply, range);
      const rows = await ports.repo.markers(ports.unitId, range);
      const body: MarkerList = { items: rows.map(markerMessage) };
      return reply.code(200).send(body);
    });
  };
}
