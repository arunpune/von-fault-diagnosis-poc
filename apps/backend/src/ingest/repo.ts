// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The four statements ingest runs as `app_rw`.
 *
 * Every write goes through `unnest`, so a batch of five hundred minutes is one
 * statement with ten parameters rather than five hundred statements or a five
 * thousand parameter list. PostgreSQL's parameter limit is 65,535 and a
 * replayed day of sixteen signals is well past it once the rows are expanded
 * one by one; arrays keep the shape of the statement fixed whatever the batch
 * size.
 *
 * This module holds no pool. It takes a {@link Queryable}, which a pool, a
 * client checked out of one and a test double all satisfy, so the aggregate
 * read path can run inside the same transaction as a test's fixtures.
 */

import { query, queryOne, type Queryable } from "../db/pool.ts";
import type { MinutePoint } from "./downsample.ts";
import type { AggregateRow, AlarmTransition } from "./types.ts";

/** One row of `app.native_alarms`, with the wall time the backend saw it. */
export interface NativeAlarmRow extends AlarmTransition {
  readonly unit_id: string;
  readonly wall_ts: string;
}

/** What a series request needs out of the folded minutes. */
export interface MinuteQuery {
  readonly unitId: string;
  readonly signalIds: readonly string[];
  readonly fromMs: number;
  readonly toMs: number;
}

/** The persistence ingest needs; `index.ts` works without one. */
export interface TelemetryRepo {
  /** Upsert closed minutes; returns how many rows the statement touched. */
  upsertMinutes(rows: readonly AggregateRow[]): Promise<number>;
  /** Append alarm transitions; returns how many rows were written. */
  insertAlarms(rows: readonly NativeAlarmRow[]): Promise<number>;
  /** Delete minutes older than `retentionDays` before `nowSimTs`; returns the count. */
  prune(retentionDays: number, nowSimTs: string): Promise<number>;
  /** The folded minutes of a window, ascending by signal and then by minute. */
  readMinutes(request: MinuteQuery): Promise<MinutePoint[]>;
}

/** Rows of the aggregate read path, as the driver hands them over. */
type MinuteRecord = {
  signal_id: string;
  minute_sim_ts: Date;
  min: number | null;
  max: number | null;
  avg: number | null;
  duty: number | null;
  discontinuity: boolean;
};

/** The single-column result of the retention function. */
type PruneRecord = { removed: string | number | null };

const UPSERT_MINUTES = `
INSERT INTO app.telemetry_agg_1m
       (unit_id, minute_sim_ts, signal_id, n, min, max, avg, last, duty, discontinuity)
SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::text[], $4::integer[],
                     $5::double precision[], $6::double precision[], $7::double precision[],
                     $8::double precision[], $9::double precision[], $10::boolean[])
ON CONFLICT (unit_id, minute_sim_ts, signal_id) DO UPDATE
   SET n = excluded.n, min = excluded.min, max = excluded.max, avg = excluded.avg,
       last = excluded.last, duty = excluded.duty, discontinuity = excluded.discontinuity`;

const INSERT_ALARMS = `
INSERT INTO app.native_alarms (unit_id, code, state, sim_ts, wall_ts, seq)
SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[],
                     $6::bigint[])`;

const PRUNE = "SELECT app.prune_telemetry_agg($1::integer, $2::timestamptz) AS removed";

const READ_MINUTES = `
SELECT signal_id, minute_sim_ts, min, max, avg, duty, discontinuity
  FROM app.telemetry_agg_1m
 WHERE unit_id = $1 AND signal_id = ANY($2::text[])
   AND minute_sim_ts >= $3::timestamptz AND minute_sim_ts <= $4::timestamptz
 ORDER BY signal_id, minute_sim_ts`;

/** The ingest repository over one queryable holding the `app_rw` credential. */
export function createTelemetryRepo(db: Queryable): TelemetryRepo {
  return {
    async upsertMinutes(rows: readonly AggregateRow[]): Promise<number> {
      if (rows.length === 0) return 0;
      const result = await db.query(UPSERT_MINUTES, [
        rows.map((row) => row.unit_id),
        rows.map((row) => row.minute_sim_ts),
        rows.map((row) => row.signal_id),
        rows.map((row) => row.n),
        rows.map((row) => row.min),
        rows.map((row) => row.max),
        rows.map((row) => row.avg),
        rows.map((row) => row.last),
        rows.map((row) => row.duty),
        rows.map((row) => row.discontinuity),
      ]);
      return result.rowCount ?? 0;
    },

    async insertAlarms(rows: readonly NativeAlarmRow[]): Promise<number> {
      if (rows.length === 0) return 0;
      const result = await db.query(INSERT_ALARMS, [
        rows.map((row) => row.unit_id),
        rows.map((row) => row.code),
        rows.map((row) => row.state),
        rows.map((row) => row.sim_ts),
        rows.map((row) => row.wall_ts),
        rows.map((row) => row.seq),
      ]);
      return result.rowCount ?? 0;
    },

    async prune(retentionDays: number, nowSimTs: string): Promise<number> {
      const row = await queryOne<PruneRecord>(db, PRUNE, [retentionDays, nowSimTs]);
      return Number(row?.removed ?? 0);
    },

    async readMinutes(request: MinuteQuery): Promise<MinutePoint[]> {
      if (request.signalIds.length === 0) return [];
      const rows = await query<MinuteRecord>(db, READ_MINUTES, [
        request.unitId,
        [...request.signalIds],
        isoOf(request.fromMs),
        isoOf(request.toMs),
      ]);
      return rows.map((row) => ({
        signal_id: row.signal_id,
        minuteMs: row.minute_sim_ts.getTime(),
        min: row.min ?? 0,
        max: row.max ?? 0,
        avg: row.avg ?? 0,
        duty: row.duty,
        discontinuity: row.discontinuity,
      }));
    },
  };
}

/** Epoch milliseconds as the contracts' one timestamp format. */
function isoOf(ms: number): string {
  return new Date(Math.round(ms)).toISOString();
}
