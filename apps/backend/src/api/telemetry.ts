// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/telemetry/latest` and `GET /api/features`: the two
 * debugging views of what the backend is looking at right now.
 *
 * Neither has a contract; both are for a person with `curl`, not for the user
 * interface, which reads the live frames instead.
 *
 * - `/telemetry/latest` answers the newest sample ingest accepted, in the
 *   `telemetry-samples` sample shape, beside the machine state detection
 *   derived from it (`{ mode, since_sim_ts, dryer_tower }`, the `machine_state`
 *   block a suspect event carries). Both are `null` before the first sample.
 * - `/features` answers detection's current feature frame —
 *   windows, cycle statistics and the bucketed signals the rules evaluate —
 *   or `null` before the first frame. A feature that is not known yet is
 *   absent from the JSON rather than `null`.
 */

import type { Sample, SuspectEvent } from "@fdp/contracts";
import type { FastifyPluginAsync } from "fastify";

import type { FeatureFrame } from "../detection/index.ts";
import type { ApiDeps } from "./deps.ts";

/** The body of `GET /api/telemetry/latest`. */
export interface LatestTelemetry {
  readonly sample: Sample | null;
  readonly machine_state: SuspectEvent["machine_state"] | null;
}

/** The body of `GET /api/features`. */
export interface CurrentFeatures {
  readonly frame: FeatureFrame | null;
}

export function telemetryRoutes(deps: Pick<ApiDeps, "ingest" | "detector">): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/telemetry/latest", async (): Promise<LatestTelemetry> => {
      const frame = deps.detector.frame();
      return {
        sample: deps.ingest.latest() ?? null,
        machine_state:
          frame === undefined
            ? null
            : {
                mode: frame.mode,
                since_sim_ts: frame.mode_since_sim_ts,
                dryer_tower: frame.dryer_tower,
              },
      };
    });

    fastify.get("/features", async (): Promise<CurrentFeatures> => ({
      frame: deps.detector.frame() ?? null,
    }));
  };
}
