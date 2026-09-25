// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/health` (contracts `api-health`).
 *
 * The route answers the four connections of the running backend — the two
 * database roles and the two broker credentials — the two watchdogs and
 * the replay position, and it carries no credential and no connection string.
 *
 * A link is **wired** when the composition root gave this route a probe for it.
 * A link without a probe (the overlay pool of a process that does not run the
 * overlay, or a connection a test left out) reports `down` — the honest answer,
 * since nothing is holding that connection open — while the HTTP status follows
 * the links this process actually runs. Once every link is wired the two
 * coincide, which is the rule the schema states: a connection down means 503.
 */

import {
  assertValid,
  type ApiHealth,
  type DecisionBackend,
  type HeartbeatState,
  type LinkState,
} from "@fdp/contracts";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { WallClock } from "../clock.ts";

/** The four connections the health body reports. */
export type LinkName = "db.app" | "db.gt" | "mqtt.diag" | "mqtt.ops";

export const LINK_NAMES: readonly LinkName[] = ["db.app", "db.gt", "mqtt.diag", "mqtt.ops"];

export type { HeartbeatState, LinkState };

/** Answers whether one connection is usable right now. Never throws to the caller. */
export type LinkProbe = () => boolean | Promise<boolean>;

/** What `app.ts` gives the route; every field but `clock` and `version` is optional. */
export interface HealthPorts {
  readonly clock: WallClock;
  readonly version: string;
  readonly backend: { readonly name: DecisionBackend; readonly model: string };
  /** One probe per wired link; a missing entry is a link this process does not run yet. */
  readonly links: Partial<Record<LinkName, LinkProbe>>;
  readonly heartbeats?: () => ApiHealth["heartbeats"];
  readonly sim?: () => ApiHealth["sim"];
  readonly counters?: () => Record<string, number>;
}

const UNKNOWN_HEARTBEATS: ApiHealth["heartbeats"] = {
  telemetry: "unknown",
  decision_api: "unknown",
};

/** Run one probe; anything it throws or rejects with counts as `down`. */
async function stateOf(probe: LinkProbe | undefined): Promise<LinkState> {
  if (probe === undefined) return "down";
  try {
    return (await probe()) ? "ok" : "down";
  } catch {
    return "down";
  }
}

/** Build the body of `GET /api/health` and the status code that goes with it. */
export async function healthReport(
  ports: HealthPorts,
  startedAt: Date,
): Promise<{ status: number; body: ApiHealth }> {
  const states = new Map<LinkName, LinkState>();
  await Promise.all(
    LINK_NAMES.map(async (name) => {
      states.set(name, await stateOf(ports.links[name]));
    }),
  );

  const wired = LINK_NAMES.filter((name) => ports.links[name] !== undefined);
  const wiredDown = wired.some((name) => states.get(name) === "down");
  const anyDown = LINK_NAMES.some((name) => states.get(name) === "down");

  const now = ports.clock.now();
  const body: ApiHealth = {
    status: anyDown ? "degraded" : "ok",
    wall_ts: now.toISOString(),
    version: ports.version,
    backend: { name: ports.backend.name, model: ports.backend.model },
    mqtt: { diag: states.get("mqtt.diag") ?? "down", ops: states.get("mqtt.ops") ?? "down" },
    db: { app: states.get("db.app") ?? "down", gt: states.get("db.gt") ?? "down" },
    heartbeats: ports.heartbeats?.() ?? UNKNOWN_HEARTBEATS,
    sim: ports.sim?.() ?? null,
    counters: {
      ...(ports.counters?.() ?? {}),
      links_unwired: LINK_NAMES.length - wired.length,
    },
    uptime_s: Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000)),
  };

  assertValid("api-health", body);
  return { status: wiredDown ? 503 : 200, body };
}

/** The Fastify plugin `api/index.ts` registers. */
export function healthRoutes(ports: HealthPorts, startedAt: Date): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.get("/health", async (_request, reply) => {
      const report = await healthReport(ports, startedAt);
      return reply.code(report.status).send(report.body);
    });
  };
}
