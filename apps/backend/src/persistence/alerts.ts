// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `app.system_alerts`, written and read as `app_rw`.
 *
 * An alert is one row for its whole life: the raise inserts it and the clear
 * updates it in place, so the table answers "what is up right now" with one
 * filter. The heartbeat hands over `alert-system` messages, and the list hands
 * them back — each alert as its latest message — so `GET /api/alerts/system`
 * and the WebSocket frames carry the same document.
 *
 * A message and a row map onto each other through `toSystemAlertRow`, the
 * heartbeat's own mapping: the raise instant is `since_wall_ts` on both
 * messages, and the clear message's `wall_ts` is the row's `cleared_wall_ts`.
 */

import type { AlertSystem } from "@fdp/contracts";

import { query, withTx, type Pool } from "../db/pool.ts";
import { ALERT_SYSTEM_SCHEMA, toSystemAlertRow } from "../heartbeat/index.ts";
import { clampLimit, type LimitBounds } from "./cursor.ts";
import { iso, isoOrNull, jsonb } from "./sql.ts";
import type { AlertListQuery, AlertsRepo } from "./types.ts";

/** Alerts {@link AlertsRepo.list} returns when the caller does not say. */
export const DEFAULT_ALERT_LIMIT = 100;

/** The most alerts one list returns. */
export const MAX_ALERT_LIMIT = 1_000;

const ALERT_BOUNDS: LimitBounds = { fallback: DEFAULT_ALERT_LIMIT, max: MAX_ALERT_LIMIT };

// A clear only moves the row forward: the raise instant and the unit never
// change once the alert exists.
const UPSERT = `
INSERT INTO app.system_alerts
       (alert_id, unit_id, kind, state, raised_wall_ts, cleared_wall_ts, details)
VALUES ($1::uuid, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::jsonb)
ON CONFLICT (alert_id) DO UPDATE
   SET state = excluded.state,
       cleared_wall_ts = excluded.cleared_wall_ts,
       details = excluded.details`;

const LIST = `
SELECT alert_id, unit_id, kind, state, raised_wall_ts, cleared_wall_ts, details
  FROM app.system_alerts
 WHERE unit_id = $1
   AND ($2::text IS NULL OR state = $2::text)
 ORDER BY raised_wall_ts DESC, id DESC
 LIMIT $3::integer`;

type AlertRecord = {
  alert_id: string;
  unit_id: string;
  kind: AlertSystem["kind"];
  state: AlertSystem["state"];
  raised_wall_ts: Date;
  cleared_wall_ts: Date | null;
  details: AlertSystem["details"];
};

/** The state filter of one list request. */
function stateFilter(active: boolean | undefined): AlertSystem["state"] | null {
  if (active === undefined) return null;
  return active ? "raised" : "cleared";
}

/**
 * The latest `alert-system` message of one row.
 *
 * The row type states the kind and the state as the contract's enums: the
 * table's `CHECK` constraints admit exactly those values.
 */
function toMessage(row: AlertRecord): AlertSystem {
  const raised = iso(row.raised_wall_ts);
  return {
    schema: ALERT_SYSTEM_SCHEMA,
    unit_id: row.unit_id,
    wall_ts: isoOrNull(row.cleared_wall_ts) ?? raised,
    alert_id: row.alert_id,
    kind: row.kind,
    state: row.state,
    since_wall_ts: raised,
    details: row.details,
  };
}

/** The system-alert statements of one unit over one `app_rw` pool. */
export function createAlertsRepo(pool: Pool, unitId: string): AlertsRepo {
  return {
    async upsert(alert) {
      const row = toSystemAlertRow(alert);
      await withTx(pool, (client) =>
        client.query(UPSERT, [
          row.alert_id,
          row.unit_id,
          row.kind,
          row.state,
          row.raised_wall_ts,
          row.cleared_wall_ts,
          jsonb(row.details),
        ]),
      );
    },

    async list(request: AlertListQuery = {}) {
      const rows = await query<AlertRecord>(pool, LIST, [
        unitId,
        stateFilter(request.active),
        clampLimit(request.limit, ALERT_BOUNDS),
      ]);
      return rows.map(toMessage);
    },
  };
}
