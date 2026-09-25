// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `app.native_alarms`, read as `app_rw`.
 *
 * The controller's own alarm transitions, as ingest recorded them while it
 * diffed consecutive samples (`TelemetryRepo.insertAlarms`). The reads are
 * windows of data time: the chart overlay asks for the transitions inside the
 * range it draws, and the lead-time comparison of the evaluation asks for the
 * first raise of one code after an onset. Both ends are inclusive, the same
 * convention as ingest's aggregate read path.
 */

import { query, type Pool } from "../db/pool.ts";
import { clampLimit, type LimitBounds } from "./cursor.ts";
import { iso } from "./sql.ts";
import type { NativeAlarm, NativeAlarmRange, NativeAlarmsRepo } from "./types.ts";

/** Transitions {@link NativeAlarmsRepo.list} returns when the caller does not say. */
export const DEFAULT_NATIVE_ALARM_LIMIT = 1_000;

/** The most transitions one list returns. */
export const MAX_NATIVE_ALARM_LIMIT = 10_000;

const NATIVE_ALARM_BOUNDS: LimitBounds = {
  fallback: DEFAULT_NATIVE_ALARM_LIMIT,
  max: MAX_NATIVE_ALARM_LIMIT,
};

const LIST = `
SELECT code, state, sim_ts, wall_ts, seq::text AS seq
  FROM app.native_alarms
 WHERE unit_id = $1
   AND sim_ts >= $2::timestamptz AND sim_ts <= $3::timestamptz
   AND ($4::text IS NULL OR code = $4::text)
 ORDER BY sim_ts, id
 LIMIT $5::integer`;

/** One row as the driver hands it over; `bigint` travels as text. */
type NativeAlarmRecord = {
  code: string;
  state: NativeAlarm["state"];
  sim_ts: Date;
  wall_ts: Date;
  seq: string | null;
};

function toNativeAlarm(row: NativeAlarmRecord): NativeAlarm {
  return {
    code: row.code,
    state: row.state,
    sim_ts: iso(row.sim_ts),
    wall_ts: iso(row.wall_ts),
    // A sample `seq` is a uint32 register value, well inside a double.
    seq: row.seq === null ? null : Number(row.seq),
  };
}

/** The native-alarm reads of one unit over one `app_rw` pool. */
export function createNativeAlarmsRepo(pool: Pool, unitId: string): NativeAlarmsRepo {
  return {
    async list(range: NativeAlarmRange) {
      const rows = await query<NativeAlarmRecord>(pool, LIST, [
        unitId,
        range.from,
        range.to,
        range.code ?? null,
        clampLimit(range.limit, NATIVE_ALARM_BOUNDS),
      ]);
      return rows.map(toNativeAlarm);
    },
  };
}
