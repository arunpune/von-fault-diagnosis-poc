// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `app.heartbeats`, written and read as `app_rw`.
 *
 * One row per watched source, overwritten with whatever the watchdog last saw.
 * The heartbeat module emits a row only when its content changed, so this
 * table is written about once a second while telemetry flows, not once per
 * sample.
 *
 * The write is an upsert on `source` although `0005` seeds both rows: a
 * database whose `app` tables were emptied (a test's `TRUNCATE`, an operator
 * clearing a run) is written exactly like a fresh one, instead of an `UPDATE`
 * that silently touches nothing.
 */

import type { HeartbeatState } from "@fdp/contracts";

import { query, withTx, type Pool } from "../db/pool.ts";
import type { HeartbeatRow, HeartbeatSource } from "../heartbeat/index.ts";
import { isoOrNull, jsonb } from "./sql.ts";
import type { HeartbeatsRepo } from "./types.ts";

const UPSERT = `
INSERT INTO app.heartbeats
       (source, status, last_ok_wall_ts, last_seen_wall_ts, consecutive_errors, detail)
VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5::integer, $6::jsonb)
ON CONFLICT (source) DO UPDATE
   SET status = excluded.status,
       last_ok_wall_ts = excluded.last_ok_wall_ts,
       last_seen_wall_ts = excluded.last_seen_wall_ts,
       consecutive_errors = excluded.consecutive_errors,
       detail = excluded.detail`;

const LIST = `
SELECT source, status, last_ok_wall_ts, last_seen_wall_ts, consecutive_errors, detail
  FROM app.heartbeats
 ORDER BY source`;

/** One row as the driver hands it over; the enums are the table's `CHECK` values. */
type HeartbeatRecord = {
  source: HeartbeatSource;
  status: HeartbeatState;
  last_ok_wall_ts: Date | null;
  last_seen_wall_ts: Date | null;
  consecutive_errors: number;
  detail: Record<string, unknown>;
};

function toRow(record: HeartbeatRecord): HeartbeatRow {
  return {
    source: record.source,
    status: record.status,
    last_ok_wall_ts: isoOrNull(record.last_ok_wall_ts),
    last_seen_wall_ts: isoOrNull(record.last_seen_wall_ts),
    consecutive_errors: record.consecutive_errors,
    detail: record.detail,
  };
}

/** The heartbeat statements over one `app_rw` pool. */
export function createHeartbeatsRepo(pool: Pool): HeartbeatsRepo {
  return {
    async update(row) {
      await withTx(pool, (client) =>
        client.query(UPSERT, [
          row.source,
          row.status,
          row.last_ok_wall_ts,
          row.last_seen_wall_ts,
          row.consecutive_errors,
          jsonb(row.detail),
        ]),
      );
    },

    async list() {
      const rows = await query<HeartbeatRecord>(pool, LIST);
      return rows.map(toRow);
    },
  };
}
