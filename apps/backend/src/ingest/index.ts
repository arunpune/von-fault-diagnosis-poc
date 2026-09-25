// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ingest: the one door telemetry comes in through.
 *
 * A batch is validated, decoded once, and handed to three consumers that know
 * nothing of each other — the ring for the live window, the aggregator for the
 * folded minutes, the alarm tracker for the controller's own messages. What
 * comes back is a count of what was taken and what was refused, so the caller
 * can log one line per batch instead of one per sample.
 *
 * Three rules live here:
 *
 *   * **Validation is not the transport's job alone.** The diagnosis MQTT
 *     client already checks the payload, but a host that builds a batch in
 *     code (`tools/eval`, a test) goes through the same `assertValid`, so a
 *     malformed batch cannot reach the ring by a side door.
 *   * **Samples are processed in `seq` order,** and a batch whose first `seq`
 *     is one already accepted is a re-delivery and is dropped whole. The one
 *     exception is a batch that opens with the discontinuity flag: the
 *     simulator restarts its counter at 1 on every start, and that flag is how
 *     a restart is told from a repeat.
 *   * **Two clocks, never mixed.** `sim_ts` drives the ring, the minutes and
 *     the alarm rows; wall time drives only the batching and retention timers,
 *     and it arrives through the injected {@link WallClock}.
 *
 * Writing is asynchronous and `push` is not, so this module never writes on
 * its own: {@link Ingest.flushDue} and {@link Ingest.pruneDue} state the
 * batching and retention policy and the runtime's timers act on it.
 */

import {
  SIGNALS,
  assertValid,
  parseIsoMs,
  toIsoMs,
  type ApiTelemetrySeries,
  type Sample,
  type Signal,
  type TelemetrySamples,
} from "@fdp/contracts";

import type { WallClock } from "../clock.ts";
import { AGGREGATE_FLUSH_ROWS, createAggregator, type Aggregator } from "./aggregates.ts";
import { seriesFromMinutes, seriesFromRing } from "./downsample.ts";
import { createAlarmTracker } from "./native-alarms.ts";
import type { NativeAlarmRow, TelemetryRepo } from "./repo.ts";
import { RingBuffer, alarmBitsOf } from "./ring.ts";
import {
  signalKind,
  toContractSample,
  type AlarmTransition,
  type DecodedSample,
  type IngestResult,
  type SeriesQuery,
} from "./types.ts";

export { RING_CAPACITY, RingBuffer } from "./ring.ts";
export { createAggregator, MINUTE_MS } from "./aggregates.ts";
export { createAlarmTracker } from "./native-alarms.ts";
export { createTelemetryRepo } from "./repo.ts";
export { seriesFromMinutes, seriesFromRing } from "./downsample.ts";
export type { MinutePoint, SeriesOptions } from "./downsample.ts";
export type { MinuteQuery, NativeAlarmRow, TelemetryRepo } from "./repo.ts";
export type { RingRange, RingSample, RingSegment } from "./ring.ts";
export type {
  AggregateRow,
  AlarmTransition,
  DecodedSample,
  IngestResult,
  SeriesQuery,
  SignalKind,
} from "./types.ts";

/** Wall milliseconds between two retention runs. */
export const RETENTION_INTERVAL_MS = 600_000;

export interface IngestOptions {
  /** The unit every row and every series answer is written for. */
  readonly unitId: string;
  /** Wall time, for the batching and retention policies. */
  readonly wall: WallClock;
  /** The signal registry; the contracts one by default. */
  readonly signals?: readonly Signal[];
  /** Where folded minutes and alarm rows go; without one they are dropped. */
  readonly repo?: TelemetryRepo;
  /** Ring capacity, a power of two; {@link RING_CAPACITY} by default. */
  readonly ringCapacity?: number;
  /** Days of data time the aggregates keep (`TELEMETRY_RETENTION_SIM_DAYS`). */
  readonly retentionSimDays?: number;
  /** Called once per accepted sample, in order; the runtime's detection and WS hook. */
  readonly onSample?: (sample: DecodedSample) => void;
  /** Called once per alarm transition, in order; the runtime's WS and alert hook. */
  readonly onAlarm?: (transition: AlarmTransition) => void;
}

export interface Ingest {
  /**
   * Validate and take one batch.
   *
   * The parameter is `unknown` because this is a boundary: a payload off the
   * broker, a fixture read from disk and a batch built in a test all arrive
   * here unproven, and `assertValid` is what makes them a `TelemetrySamples`.
   *
   * @throws SchemaValidationError when the payload is not a valid batch.
   */
  push(message: unknown): IngestResult;
  /** The live sample window; never cleared on a discontinuity. */
  readonly ring: RingBuffer;
  /** The newest accepted sample, in the contracts' shape. */
  latest(): Sample | undefined;
  /**
   * The downsampled history of a window.
   *
   * A window the ring still covers is answered from memory (`source: "ring"`);
   * an older one from `app.telemetry_agg_1m` (`source: "agg_1m"`), which needs
   * the repository and therefore a round trip. That is why this is the one
   * asynchronous read of the interface.
   */
  series(query: SeriesQuery): Promise<ApiTelemetrySeries>;
  /**
   * Write the closed minutes and the alarm rows that are waiting.
   *
   * With `final`, the minute still being folded is closed first; that is the
   * shutdown path and the end of a replay. Without a repository this is a
   * no-op.
   */
  flush(options?: { readonly final?: boolean }): Promise<void>;
  /** True when the batching policy — five wall seconds or five hundred rows — says to write. */
  flushDue(): boolean;
  /** Delete aggregates older than the retention window; returns the row count. */
  prune(): Promise<number>;
  /** True when ten wall minutes have passed since the last retention run. */
  pruneDue(): boolean;
  /** The controller alarm codes active after the last sample (detection's `activeAlarms`). */
  activeAlarms(): string[];
}

/** The ingest facade. */
export function createIngest(options: IngestOptions): Ingest {
  const signals = options.signals ?? SIGNALS;
  const digitalTags = new Set(
    signals.filter((signal) => signalKind(signal) === "digital").map((signal) => signal.tag),
  );
  const ring = new RingBuffer({ signals, capacity: options.ringCapacity });
  const aggregator: Aggregator = createAggregator({
    unitId: options.unitId,
    signals,
    wall: options.wall,
  });
  const alarms = createAlarmTracker();
  const alarmQueue: NativeAlarmRow[] = [];
  const carried: Record<string, number> = {};

  let lastSeq: number | undefined;
  let lastDecoded: DecodedSample | undefined;
  let lastPruneMs = options.wall.now().getTime();

  function decode(sample: TelemetrySamples["samples"][number]): DecodedSample {
    const values: Record<string, number> = {};
    for (const signal of signals) {
      const raw = sample.values[signal.tag];
      const value =
        raw === undefined ? carried[signal.tag] : typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
      if (value === undefined) continue;
      values[signal.tag] = digitalTags.has(signal.tag) ? (value === 0 ? 0 : 1) : value;
      carried[signal.tag] = values[signal.tag] ?? 0;
    }
    return {
      seq: sample.seq,
      simTsMs: parseIsoMs(sample.sim_ts).getTime(),
      simTs: sample.sim_ts,
      discontinuity: sample.flags.discontinuity,
      missing: sample.flags.missing,
      values,
      alarms: sample.alarms,
      alarmBits: alarmBitsOf(sample.alarms),
    };
  }

  /** Without a repository the folded rows have nowhere to go; keep memory bounded. */
  function dropUnwritable(): void {
    if (options.repo === undefined && aggregator.pending() >= AGGREGATE_FLUSH_ROWS) {
      aggregator.take();
    }
    if (options.repo === undefined && alarmQueue.length >= AGGREGATE_FLUSH_ROWS) {
      alarmQueue.splice(0, alarmQueue.length);
    }
  }

  return {
    ring,

    push(message: unknown): IngestResult {
      const batch = assertValid("telemetry-samples", message);
      const [first] = batch.samples;
      if (!first.flags.discontinuity && lastSeq !== undefined && first.seq <= lastSeq) {
        return {
          accepted: 0,
          rejected: batch.samples.length,
          discontinuity: false,
          alarms: [],
        };
      }

      const transitions: AlarmTransition[] = [];
      let accepted = 0;
      let rejected = 0;
      let discontinuity = false;

      for (const sample of batch.samples) {
        if (!sample.flags.discontinuity && lastSeq !== undefined && sample.seq <= lastSeq) {
          rejected += 1;
          continue;
        }
        const decoded = decode(sample);
        lastSeq = decoded.seq;
        lastDecoded = decoded;
        accepted += 1;
        if (decoded.discontinuity) discontinuity = true;

        ring.push(decoded);
        aggregator.push(decoded);
        for (const transition of alarms.push(decoded)) {
          transitions.push(transition);
          alarmQueue.push({
            ...transition,
            unit_id: options.unitId,
            wall_ts: toIsoMs(options.wall.now()),
          });
          options.onAlarm?.(transition);
        }
        options.onSample?.(decoded);
      }

      dropUnwritable();
      return { accepted, rejected, discontinuity, alarms: transitions };
    },

    latest(): Sample | undefined {
      return lastDecoded === undefined ? undefined : toContractSample(lastDecoded, signals);
    },

    async series(query: SeriesQuery): Promise<ApiTelemetrySeries> {
      const earliest = earliestSimTsMs(ring);
      const covered = earliest !== undefined && query.fromMs >= earliest;
      if (covered || options.repo === undefined) {
        return seriesFromRing(ring, query, { unitId: options.unitId, signals });
      }
      const rows = await options.repo.readMinutes({
        unitId: options.unitId,
        signalIds: query.signalIds,
        fromMs: query.fromMs,
        toMs: query.toMs,
      });
      return seriesFromMinutes(rows, query, { unitId: options.unitId, signals });
    },

    async flush(flushOptions: { readonly final?: boolean } = {}): Promise<void> {
      if (flushOptions.final === true) aggregator.closeOpen();
      const rows = aggregator.take();
      const pendingAlarms = alarmQueue.splice(0, alarmQueue.length);
      const repo = options.repo;
      if (repo === undefined) return;
      if (rows.length > 0) await repo.upsertMinutes(rows);
      if (pendingAlarms.length > 0) await repo.insertAlarms(pendingAlarms);
    },

    flushDue(): boolean {
      return aggregator.due() || alarmQueue.length >= AGGREGATE_FLUSH_ROWS;
    },

    async prune(): Promise<number> {
      lastPruneMs = options.wall.now().getTime();
      const repo = options.repo;
      const latestSimTs = aggregator.latestSimTs();
      if (repo === undefined || latestSimTs === undefined) return 0;
      return repo.prune(options.retentionSimDays ?? DEFAULT_RETENTION_SIM_DAYS, latestSimTs);
    },

    pruneDue(): boolean {
      return options.wall.now().getTime() - lastPruneMs >= RETENTION_INTERVAL_MS;
    },

    activeAlarms: () => alarms.active(),
  };
}

/** The default of `TELEMETRY_RETENTION_SIM_DAYS`, for a host that passes none. */
const DEFAULT_RETENTION_SIM_DAYS = 365;

/**
 * The earliest data time the ring holds.
 *
 * Not simply the oldest position: a backwards jump makes a later segment start
 * before an earlier one, and a window is covered by the ring only when every
 * segment that could answer it is still there.
 */
function earliestSimTsMs(ring: RingBuffer): number | undefined {
  let earliest: number | undefined;
  for (const segment of ring.segments()) {
    if (earliest === undefined || segment.fromMs < earliest) earliest = segment.fromMs;
  }
  return earliest;
}
