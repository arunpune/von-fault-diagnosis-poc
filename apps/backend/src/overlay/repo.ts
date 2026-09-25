// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The overlay repository: every statement that touches the `gt` schema
 * (docs/architecture.md#ground-truth-isolation).
 *
 * This module is the only importer of `db/gt.ts`, which is the only pool that
 * holds the privileged credential; `.dependency-cruiser.cjs` refuses the import
 * anywhere else and `test/arch/imports.test.ts` proves the rule bites. A row
 * therefore reaches `gt.injections`, `gt.markers` or `gt.catalog_snapshot`
 * through one of the three `record*` functions below or not at all.
 *
 * The columns are those of migration 0002: an injection is keyed by
 * `(unit_id, instance_id, event)` and carries the `gt-injection` message's own
 * field names, so a start and its stop are two rows and a redelivery of either
 * one is a conflict the database absorbs.
 *
 * Reads are for the overlay's own GET routes and return `iso_ts` strings, not
 * `Date` objects: the routes answer the contracts' time format and the
 * conversion belongs beside the driver that produced the value.
 */

import {
  toIsoMs,
  type FaultInjectionEvent,
  type GroundTruthCatalog,
  type ReplayMarker,
} from "@fdp/contracts";

import { createGtPool, type OverlayDbConfig } from "../db/gt.ts";
import { query, type Pool, type PoolLogger, type Queryable } from "../db/pool.ts";
import { digestOf } from "../ids.ts";

export type { OverlayDbConfig };

/**
 * The overlay pool, opened here so that `db/gt.ts` keeps one importer.
 *
 * The composition root reaches it through `overlay/index.ts`; nothing else in
 * the package may name the privileged credential. `logger` hears of a
 * connection the server ended while the pool held it idle.
 */
export function openOverlayPool(config: OverlayDbConfig, logger: PoolLogger): Pool {
  return createGtPool(config, logger);
}

/** A half-open window on the simulated clock; an absent bound is unbounded. */
export interface SimRange {
  readonly from?: string | null;
  readonly to?: string | null;
}

/** One row of `gt.v_injection_windows`, with the timestamps as `iso_ts`. */
export type InjectionWindow = {
  unit_id: string;
  instance_id: string;
  injection_id: string;
  fault_id: string;
  start_sim_ts: string;
  /** Null only for a start whose message carried no end, which the schema forbids. */
  end_sim_ts: string | null;
  /** Why the instance ended; null while no stop has arrived. */
  reason: string | null;
  params: Record<string, unknown>;
};

/** One row of `gt.markers`, with the timestamps as `iso_ts`. */
export type Marker = {
  unit_id: string;
  kind: "jump" | "reset" | "loop";
  preset_id: string | null;
  sim_ts_from: string;
  sim_ts_to: string;
  wall_ts: string;
};

/** What the recorder writes through and the read routes query. */
export interface OverlayRepo {
  /** Store one catalog; false when an identical one is already recorded. */
  recordCatalog(message: GroundTruthCatalog): Promise<boolean>;
  /** Store one injection event; false when this `(instance_id, event)` is already recorded. */
  recordInjection(message: FaultInjectionEvent): Promise<boolean>;
  /** Store one replay marker. Markers have no natural key, so every message is a row. */
  recordMarker(message: ReplayMarker): Promise<void>;
  /** The injection windows overlapping `range`, oldest start first. */
  injectionWindows(unitId: string, range?: SimRange): Promise<InjectionWindow[]>;
  /** The markers inside `range`, oldest first. */
  markers(unitId: string, range?: SimRange): Promise<Marker[]>;
}

/**
 * The digest a catalog is deduplicated on.
 *
 * `source_sha256` covers the ground-truth data files the simulator is serving,
 * so two publications of the same menu collapse into
 * one row even when their envelopes differ; a catalog without one falls back to
 * the digest of the message, which is what the column name promises and what a
 * redelivered retained message hashes to.
 */
export function catalogDigest(message: GroundTruthCatalog): string {
  return message.source_sha256 ?? digestOf(message);
}

const INSERT_CATALOG = `
  INSERT INTO gt.catalog_snapshot (unit_id, received_wall_ts, payload_sha256, payload)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (payload_sha256) DO NOTHING
  RETURNING id`;

const INSERT_INJECTION = `
  INSERT INTO gt.injections (
    unit_id, instance_id, injection_id, fault_id, event,
    sim_ts, wall_ts, params, ends_sim_ts, reason)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  ON CONFLICT (unit_id, instance_id, event) DO NOTHING
  RETURNING id`;

const INSERT_MARKER = `
  INSERT INTO gt.markers (unit_id, kind, preset_id, sim_ts_from, sim_ts_to, wall_ts)
  VALUES ($1, $2, $3, $4, $5, $6)`;

// The bounds are cast once and compared as NULL-or-match, so one prepared
// statement serves an open, half-open or closed window without string building.
const SELECT_WINDOWS = `
  SELECT unit_id, instance_id, injection_id, fault_id, start_sim_ts, end_sim_ts, reason, params
    FROM gt.v_injection_windows
   WHERE unit_id = $1
     AND ($2::timestamptz IS NULL OR end_sim_ts IS NULL OR end_sim_ts >= $2::timestamptz)
     AND ($3::timestamptz IS NULL OR start_sim_ts <= $3::timestamptz)
   ORDER BY start_sim_ts, instance_id`;

const SELECT_MARKERS = `
  SELECT unit_id, kind, preset_id, sim_ts_from, sim_ts_to, wall_ts
    FROM gt.markers
   WHERE unit_id = $1
     AND ($2::timestamptz IS NULL OR sim_ts_to >= $2::timestamptz)
     AND ($3::timestamptz IS NULL OR sim_ts_from <= $3::timestamptz)
   ORDER BY sim_ts_from, id`;

type WindowRow = {
  unit_id: string;
  instance_id: string;
  injection_id: string;
  fault_id: string;
  start_sim_ts: Date;
  end_sim_ts: Date | null;
  reason: string | null;
  params: Record<string, unknown> | null;
};

type MarkerRow = {
  unit_id: string;
  kind: string;
  preset_id: string | null;
  sim_ts_from: Date;
  sim_ts_to: Date;
  wall_ts: Date;
};

/** The repository over any queryable: the overlay pool in the process, a client in a test. */
export function createOverlayRepo(db: Queryable): OverlayRepo {
  return {
    async recordCatalog(message) {
      const rows = await query<{ id: string }>(db, INSERT_CATALOG, [
        message.unit_id,
        message.wall_ts,
        catalogDigest(message),
        message,
      ]);
      return rows.length > 0;
    },

    async recordInjection(message) {
      const rows = await query<{ id: string }>(db, INSERT_INJECTION, [
        message.unit_id,
        message.instance_id,
        message.injection_id,
        message.fault_id,
        message.event,
        message.sim_ts,
        message.wall_ts,
        message.params,
        message.ends_sim_ts,
        message.reason ?? null,
      ]);
      return rows.length > 0;
    },

    async recordMarker(message) {
      await query(db, INSERT_MARKER, [
        message.unit_id,
        message.kind,
        message.preset_id ?? null,
        message.sim_ts_from,
        message.sim_ts_to,
        message.wall_ts,
      ]);
    },

    async injectionWindows(unitId, range = {}) {
      const rows = await query<WindowRow>(db, SELECT_WINDOWS, [
        unitId,
        range.from ?? null,
        range.to ?? null,
      ]);
      return rows.map((row) => ({
        unit_id: row.unit_id,
        instance_id: row.instance_id,
        injection_id: row.injection_id,
        fault_id: row.fault_id,
        start_sim_ts: toIsoMs(row.start_sim_ts),
        end_sim_ts: row.end_sim_ts === null ? null : toIsoMs(row.end_sim_ts),
        reason: row.reason,
        params: row.params ?? {},
      }));
    },

    async markers(unitId, range = {}) {
      const rows = await query<MarkerRow>(db, SELECT_MARKERS, [
        unitId,
        range.from ?? null,
        range.to ?? null,
      ]);
      return rows.map((row) => ({
        unit_id: row.unit_id,
        kind: asMarkerKind(row.kind),
        preset_id: row.preset_id,
        sim_ts_from: toIsoMs(row.sim_ts_from),
        sim_ts_to: toIsoMs(row.sim_ts_to),
        wall_ts: toIsoMs(row.wall_ts),
      }));
    },
  };
}

/** The column carries a CHECK constraint, so anything else is a corrupt row. */
function asMarkerKind(value: string): Marker["kind"] {
  if (value === "jump" || value === "reset" || value === "loop") return value;
  throw new Error(`gt.markers holds an unknown kind: ${value}`);
}
