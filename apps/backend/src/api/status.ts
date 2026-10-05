// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/status` (contracts `api-status`).
 *
 * Everything the status bar and its lamps need in one call, which the user
 * interface makes on every WebSocket open: the retained simulator and gateway
 * statuses, the backend's own status, the raised system alerts, the running
 * injections, the two gate thresholds of the running decision backend (Von's
 * own pair or the global one) and the persistence a symptom's evidence needs
 * before it can open a review or a ticket. The runtime reports the live part;
 * the gate's parameters come from the environment, because they are what the
 * gate runs with and never change while the process lives. There is no feature flag for review:
 * review is a ticket status.
 */

import { assertValid, type ApiStatus } from "@fdp/contracts";
import type { FastifyPluginAsync } from "fastify";

import { gateThresholds } from "../config/env.ts";
import type { ApiDeps } from "./deps.ts";

export function statusRoutes(deps: Pick<ApiDeps, "env" | "runtime">): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/status", async (): Promise<ApiStatus> => {
      const live = await deps.runtime.status();
      const thresholds = gateThresholds(deps.env.gate, deps.env.decisionBackend);
      return assertValid("api-status", {
        ...live,
        gate: {
          ticket_min_confidence: thresholds.ticketMinConfidence,
          review_min_confidence: thresholds.reviewMinConfidence,
          persist_sim_min: deps.env.gate.persistSimMin,
        },
      });
    });
  };
}
