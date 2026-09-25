// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The overlay, assembled.
 *
 * The composition root reaches the module through this file alone: the
 * privileged configuration, the privileged pool and the privileged broker
 * client are all built behind it, so `src/index.ts` never names a credential
 * and dependency-cruiser can keep `overlay/config.ts` inside `overlay/**`.
 *
 * `createOverlay` opens both connections; the caller starts the recorder and
 * the control passthrough, hands the two route port objects to `api/index.ts`
 * and calls `stop` on shutdown.
 */

import type { WallClock } from "../clock.ts";
import type { Logger } from "../log.ts";
import { createOpsClient } from "../mqtt/ops-client.ts";
import type { FdpMqttClient } from "../mqtt/client.ts";
import { loadOverlayConfig, type OverlayConfig } from "./config.ts";
import { createRecorder, type OverlayHub, type OverlayRecorder } from "./recorder.ts";
import { createOverlayRepo, openOverlayPool, type OverlayRepo } from "./repo.ts";
import type { OverlayReadPorts } from "./routes-read.ts";
import type { SimRoutePorts } from "./routes-sim.ts";
import { createSimControl, type SimControl } from "./simctl.ts";

export { loadOverlayConfig, OverlayConfigError, type OverlayConfig } from "./config.ts";
export { createRecorder, type OverlayFrame, type OverlayHub } from "./recorder.ts";
export { createOverlayRepo, type InjectionWindow, type Marker, type OverlayRepo } from "./repo.ts";
export { overlayReadRoutes, type OverlayReadPorts } from "./routes-read.ts";
export { overlaySimRoutes, SIM_ROUTES, type SimRoutePorts } from "./routes-sim.ts";
export { ACK_TIMEOUT_MS, createSimControl, type SimControl } from "./simctl.ts";

export interface OverlayDeps {
  readonly logger: Logger;
  readonly wall: WallClock;
  /** The process environment by default; a test passes its own. */
  readonly config?: OverlayConfig;
  /** The WebSocket hub; the overlay records without one. */
  readonly hub?: OverlayHub;
}

/** Everything the composition root needs from the overlay, and nothing else. */
export interface Overlay {
  readonly config: OverlayConfig;
  readonly ops: FdpMqttClient;
  readonly repo: OverlayRepo;
  readonly recorder: OverlayRecorder;
  readonly control: SimControl;
  /** What `api/index.ts` registers the two plugins with. */
  readonly readPorts: OverlayReadPorts;
  readonly simPorts: SimRoutePorts;
  /** True while the broker connection is usable; `/api/health` reports it as `mqtt.ops`. */
  reachable(): boolean;
  /** One round trip on the overlay's pool; `/api/health` reports it as `db.gt`. */
  databaseReachable(): Promise<boolean>;
  /** Subscribe the overlay topics and the acknowledgement topic. */
  start(): Promise<void>;
  /** Close the broker client and the pool. */
  stop(): Promise<void>;
}

/**
 * Open the overlay's two connections and wire its five parts together.
 *
 * @throws OverlayConfigError when a variable is unusable, and
 * `OpsCredentialError` when the broker credential is missing.
 */
export async function createOverlay(deps: OverlayDeps): Promise<Overlay> {
  const config = deps.config ?? loadOverlayConfig();
  const pool = openOverlayPool(config.db, deps.logger);
  let ops: FdpMqttClient;
  try {
    ops = await createOpsClient(config.mqtt, { logger: deps.logger });
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  const repo = createOverlayRepo(pool);
  const recorder = createRecorder({
    ops,
    repo,
    logger: deps.logger,
    hub: deps.hub,
    unitId: config.unitId,
  });
  const control = createSimControl({
    ops,
    wall: deps.wall,
    logger: deps.logger,
    unitId: config.unitId,
  });

  return {
    config,
    ops,
    repo,
    recorder,
    control,
    readPorts: {
      catalog: () => recorder.catalog(),
      active: () => recorder.active(),
      repo,
      unitId: config.unitId,
    },
    simPorts: { control },
    reachable: () => ops.connected(),

    async databaseReachable() {
      await pool.query("SELECT 1");
      return true;
    },

    async start() {
      await recorder.start();
      await control.start();
    },

    async stop() {
      control.stop();
      await ops.close();
      await pool.end();
    },
  };
}
