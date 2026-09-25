// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The persistence of the diagnosis records.
 *
 * {@link createPersistence} builds the five repositories of this module over
 * the backend's `app_rw` pool (`db/app.ts`). The credential is the isolation:
 * `app_rw` has no privilege on schema `gt`, so nothing written or read here can
 * touch ground truth, whatever a statement says. Every write runs inside
 * `withTx` on a connection of that pool; every statement is a constant with
 * `$n` parameters.
 *
 * The runtime builds this once at start-up; the REST routes and the sinks type
 * against `./types.ts`, so a test hands them fakes instead.
 */

import type { Pool } from "../db/pool.ts";
import { createAlertsRepo } from "./alerts.ts";
import { createDecisionsRepo } from "./decisions.ts";
import { createEventsRepo } from "./events.ts";
import { createHeartbeatsRepo } from "./heartbeats.ts";
import { createNativeAlarmsRepo } from "./native-alarms.ts";
import type { Persistence } from "./types.ts";

export { createAlertsRepo, DEFAULT_ALERT_LIMIT, MAX_ALERT_LIMIT } from "./alerts.ts";
export {
  DEFAULT_PAGE_LIMIT,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  MAX_PAGE_LIMIT,
} from "./cursor.ts";
export { candidateRows, createDecisionsRepo, type CandidateSources } from "./decisions.ts";
export { createEventsRepo } from "./events.ts";
export { createHeartbeatsRepo } from "./heartbeats.ts";
export {
  createNativeAlarmsRepo,
  DEFAULT_NATIVE_ALARM_LIMIT,
  MAX_NATIVE_ALARM_LIMIT,
} from "./native-alarms.ts";
export type * from "./types.ts";

/** What every repository of one process is scoped to. */
export interface PersistenceOptions {
  /** The unit whose rows the lists read (`UNIT_ID`). */
  readonly unitId: string;
}

/** The five repositories of this module over one `app_rw` pool. */
export function createPersistence(pool: Pool, options: PersistenceOptions): Persistence {
  return {
    events: createEventsRepo(pool, options.unitId),
    decisions: createDecisionsRepo(pool, options.unitId),
    alerts: createAlertsRepo(pool, options.unitId),
    nativeAlarms: createNativeAlarmsRepo(pool, options.unitId),
    heartbeats: createHeartbeatsRepo(pool),
  };
}
