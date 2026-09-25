// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The REST surface, under the `/api` prefix.
 *
 * This plugin is the one place routes are registered, so the prefix, the error
 * shape and the ordering live together:
 *
 * - `GET /api/health`, always, because the healthcheck asks it before
 *   anything else is connected;
 * - the dashboard routes, one plugin per resource, once the
 *   runtime hands over their {@link ApiDeps};
 * - the two overlay plugins, when this process runs the overlay; they stay
 *   apart — read and command — so a read route can never move the replay.
 *
 * Every error answers the contracts `api-error` shape so the user interface has
 * one body to parse, whatever failed; `errors.ts` maps what a route throws to
 * the status and the code. `@fastify/cors` is registered only when the
 * composition root asks for it, which it does outside production: in the
 * Compose stack nginx serves the page and the API from one origin, and the
 * Vite development server proxies `/api` the same way.
 */

import cors from "@fastify/cors";
import type { FastifyPluginAsync } from "fastify";

import { overlayReadRoutes, type OverlayReadPorts } from "../overlay/routes-read.ts";
import { overlaySimRoutes, type SimRoutePorts } from "../overlay/routes-sim.ts";
import { alarmsRoutes } from "./alarms.ts";
import { alertsRoutes } from "./alerts.ts";
import { catalogRoutes } from "./catalog.ts";
import { costRoutes } from "./cost.ts";
import { decisionsRoutes } from "./decisions.ts";
import type { ApiDeps } from "./deps.ts";
import { episodesRoutes } from "./episodes.ts";
import { apiError, toHttpError } from "./errors.ts";
import { eventsRoutes } from "./events.ts";
import { healthRoutes, type HealthPorts } from "./health.ts";
import { seriesRoutes } from "./series.ts";
import { signalsRoutes } from "./signals.ts";
import { statusRoutes } from "./status.ts";
import { telemetryRoutes } from "./telemetry.ts";
import { ticketsRoutes } from "./tickets.ts";

export { apiError } from "./errors.ts";
export type { ApiDeps } from "./deps.ts";

/** The prefix nginx and the Vite development server proxy. */
export const API_PREFIX = "/api";

export interface ApiPorts {
  readonly health: HealthPorts;
  /** When the process started, for `uptime_s`. */
  readonly startedAt: Date;
  /** The dashboard routes; absent until the runtime has built what they read. */
  readonly dashboard?: ApiDeps;
  /**
   * The overlay's two plugins, registered only when this process runs the
   * overlay. They stay apart — read and command — so a read route can never
   * move the replay.
   */
  readonly overlay?: {
    readonly read?: OverlayReadPorts;
    readonly sim?: SimRoutePorts;
  };
  /** Answer cross-origin requests; `true` only outside production (`NODE_ENV`). */
  readonly crossOrigin?: boolean;
}

/** Every REST route but health and the overlay, one plugin per resource. */
export function dashboardRoutes(deps: ApiDeps): FastifyPluginAsync {
  return async (fastify) => {
    await fastify.register(statusRoutes(deps));
    await fastify.register(signalsRoutes(deps.repos.catalog));
    await fastify.register(seriesRoutes(deps.ingest));
    await fastify.register(telemetryRoutes(deps));
    await fastify.register(alarmsRoutes(deps.repos.nativeAlarms));
    await fastify.register(eventsRoutes(deps.repos.events));
    await fastify.register(decisionsRoutes(deps.repos.decisions));
    await fastify.register(episodesRoutes(deps.repos.episodes));
    await fastify.register(ticketsRoutes(deps));
    await fastify.register(costRoutes(deps.repos.cost));
    await fastify.register(alertsRoutes(deps.repos.alerts));
    await fastify.register(catalogRoutes(deps.repos.catalog));
  };
}

export function apiRoutes(ports: ApiPorts): FastifyPluginAsync {
  return async (fastify) => {
    if (ports.crossOrigin === true) await fastify.register(cors, { origin: true });

    fastify.setNotFoundHandler(async (request, reply) =>
      reply.code(404).send(apiError("not_found", `no route for ${request.method} ${request.url}`)),
    );

    fastify.setErrorHandler(async (error: unknown, request, reply) => {
      const { status, body } = toHttpError(error);
      if (status >= 500) request.log.error({ err: error }, "request failed");
      return reply.code(status).send(body);
    });

    await fastify.register(healthRoutes(ports.health, ports.startedAt));
    if (ports.dashboard !== undefined) {
      await fastify.register(dashboardRoutes(ports.dashboard));
    }
    if (ports.overlay?.read !== undefined) {
      await fastify.register(overlayReadRoutes(ports.overlay.read));
    }
    if (ports.overlay?.sim !== undefined) {
      await fastify.register(overlaySimRoutes(ports.overlay.sim));
    }
  };
}
