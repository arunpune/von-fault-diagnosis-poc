// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The live picture of the plant as the backend sees it.
 *
 * The simulator and the gateway publish their status retained on the unit's
 * status subtree. The runtime keeps the latest of each, tells the telemetry
 * watchdog whether the replay is playing (a paused replay is not a silent
 * one), and forwards both to the browser as `status.sim` and
 * `status.gateway` frames as they arrive.
 *
 * Two readers assemble the rest: {@link runtimeStatus} is `GET /api/status`
 * without the gate thresholds (the route adds them), and {@link wsSnapshot}
 * is the `snapshot` frame the hub sends a socket right after `hello`. Both read
 * everything at the moment they are asked, so neither is ever older than the
 * request that asked.
 */

import type {
  ActiveFaultInjections,
  AlertSystem,
  GroundTruthCatalog,
  HealthSim,
  SnapshotPayload,
  StatusBackend,
  StatusGateway,
  StatusSim,
} from "@fdp/contracts";

import type { RuntimeStatus } from "../api/deps.ts";
import { toEpisodeMessage } from "../episodes/index.ts";
import type { Heartbeat } from "../heartbeat/index.ts";
import type { DecisionsRepo } from "../persistence/types.ts";
import type { Pipeline } from "../pipeline/types.ts";
import type { Hub } from "../ws/hub.ts";

/** The `snapshot` frame's cap on recent decisions (`ws-server-message`). */
export const SNAPSHOT_DECISIONS = 50;

/** The latest retained status of the simulator and the gateway. */
export interface StatusTracker {
  /** A `status-sim` arrived: keep it, tell the watchdog, forward it. */
  onSim(message: StatusSim): void;
  /** A `status-gateway` arrived: keep it, forward it. */
  onGateway(message: StatusGateway): void;
  sim(): StatusSim | null;
  gateway(): StatusGateway | null;
  /** The three replay values `GET /api/health` repeats; `null` before the first status. */
  healthSim(): HealthSim | null;
}

export interface StatusTrackerPorts {
  readonly watchdog: Pick<Heartbeat, "noteSimState">;
  readonly hub: Pick<Hub, "broadcast">;
}

export function createStatusTracker(ports: StatusTrackerPorts): StatusTracker {
  let sim: StatusSim | null = null;
  let gateway: StatusGateway | null = null;

  return {
    onSim(message) {
      sim = message;
      ports.watchdog.noteSimState(message.state);
      ports.hub.broadcast("status.sim", message);
    },

    onGateway(message) {
      gateway = message;
      ports.hub.broadcast("status.gateway", message);
    },

    sim: () => sim,
    gateway: () => gateway,
    healthSim: () =>
      sim === null ? null : { state: sim.state, speed: sim.speed, sim_ts: sim.sim_ts },
  };
}

/**
 * What the overlay module knows right now: the retained catalog and the
 * running injections. The composition root adapts the overlay recorder to it,
 * so nothing here imports the overlay.
 */
export interface OverlayView {
  catalog(): GroundTruthCatalog | null;
  active(): ActiveFaultInjections | null;
}

/** Everything the two readers assemble. */
export interface RuntimeViewSources {
  readonly tracker: Pick<StatusTracker, "sim" | "gateway">;
  /** The backend's own `status-backend` as it would be published now. */
  readonly backend: () => StatusBackend;
  /** The system alerts raised right now. */
  readonly alerts: () => readonly AlertSystem[];
  readonly overlay: OverlayView;
  readonly pipeline: Pick<Pipeline, "snapshot" | "ingest">;
  readonly decisions: Pick<DecisionsRepo, "list">;
}

/** The body of `GET /api/status`, less the gate the route adds. */
export function runtimeStatus(sources: RuntimeViewSources): RuntimeStatus {
  return {
    sim: sources.tracker.sim(),
    gateway: sources.tracker.gateway(),
    backend: sources.backend(),
    alerts_active: [...sources.alerts()],
    injections_active: [...(sources.overlay.active()?.active ?? [])],
  };
}

/** Newest first by the opening instant, ties broken by id (the order of the REST lists). */
function newestFirst<T>(key: (item: T) => readonly [string, string]) {
  return (left: T, right: T): number => {
    const [leftTs, leftId] = key(left);
    const [rightTs, rightId] = key(right);
    if (leftTs !== rightTs) return leftTs < rightTs ? 1 : -1;
    if (leftId === rightId) return 0;
    return leftId < rightId ? 1 : -1;
  };
}

/** The `snapshot` frame: the statuses, the newest sample, the open work and the overlay. */
export async function wsSnapshot(sources: RuntimeViewSources): Promise<SnapshotPayload> {
  const view = sources.pipeline.snapshot();
  const recent = await sources.decisions.list({ limit: SNAPSHOT_DECISIONS });
  return {
    status: {
      sim: sources.tracker.sim(),
      gateway: sources.tracker.gateway(),
      backend: sources.backend(),
    },
    latest_sample: sources.pipeline.ingest.latest() ?? null,
    episodes: view.episodes
      .filter((episode) => episode.status === "open")
      .map(toEpisodeMessage)
      .sort(newestFirst((episode) => [episode.opened_sim_ts, episode.episode_id])),
    tickets: view.tickets
      .filter((ticket) => ticket.status === "review" || ticket.status === "open")
      .sort(newestFirst((ticket) => [ticket.opened_sim_ts, ticket.ticket_id])),
    decisions: recent.items,
    system_alerts: [...sources.alerts()],
    overlay: { catalog: sources.overlay.catalog(), active: sources.overlay.active() },
  };
}
