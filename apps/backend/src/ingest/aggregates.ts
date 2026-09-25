// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Folding samples into one row per unit, minute and signal
 * (`app.telemetry_agg_1m`).
 *
 * Raw samples are never stored. The ring keeps about a week of them for the
 * live chart and the rules; everything older is this: `n`, `min`, `max`,
 * `avg`, `last` and, for a state, the fraction of the minute it read true.
 *
 * One minute is open at a time. Samples arrive in `seq` order and data time
 * does not move backwards inside a segment, so a sample whose minute differs
 * from the open one closes it — no window of late arrivals, no timer. A
 * discontinuity inside a minute does not split the row, because the primary
 * key of the table is the minute: it sets the `discontinuity` flag instead,
 * which is the reader's signal that the minute has no comparable neighbour.
 *
 * Closed rows queue up and leave in batches. {@link Aggregator.due} states the
 * batching policy — five wall seconds or five hundred rows, whichever comes
 * first — and the caller decides when to act on it, because writing is
 * asynchronous and `push` is not.
 */

import { SIGNALS, toIsoMs, type Signal } from "@fdp/contracts";

import type { WallClock } from "../clock.ts";
import { signalKind, type AggregateRow, type DecodedSample } from "./types.ts";

/** One minute of data time, in milliseconds. */
export const MINUTE_MS = 60_000;

/** Wall milliseconds between two batched writes. */
export const AGGREGATE_FLUSH_INTERVAL_MS = 5_000;

/** Closed rows that force a write before the interval is up. */
export const AGGREGATE_FLUSH_ROWS = 500;

export interface AggregatorOptions {
  readonly unitId: string;
  /** The signals to fold; the contracts registry by default. */
  readonly signals?: readonly Signal[];
  /** Wall time, for the five-second half of the batching policy. */
  readonly wall: WallClock;
}

export interface Aggregator {
  /** Fold one sample into the open minute, closing the previous one first. */
  push(sample: DecodedSample): void;
  /** Close the minute still open, if any; a shutdown or the end of a replay. */
  closeOpen(): void;
  /** Closed rows waiting to be written. */
  pending(): number;
  /** True when the batching policy says to write now. */
  due(): boolean;
  /** Take the closed rows; the write interval restarts from this moment. */
  take(): AggregateRow[];
  /** The newest data time folded so far, as an `iso_ts`, or `undefined`. */
  latestSimTs(): string | undefined;
}

/** What one signal has seen so far this minute. */
interface Accumulator {
  n: number;
  min: number;
  max: number;
  sum: number;
  last: number;
  trueCount: number;
}

/** The folding aggregator. */
export function createAggregator(options: AggregatorOptions): Aggregator {
  const signals = options.signals ?? SIGNALS;
  const digital = new Set(
    signals.filter((signal) => signalKind(signal) === "digital").map((signal) => signal.tag),
  );
  const accumulators = new Map<string, Accumulator>(
    signals.map((signal) => [signal.tag, empty()] as const),
  );

  const queue: AggregateRow[] = [];
  let openMinuteMs: number | undefined;
  let openDiscontinuity = false;
  let latestSimTsMs: number | undefined;
  let lastTakeMs = options.wall.now().getTime();

  function closeOpen(): void {
    if (openMinuteMs === undefined) return;
    const minute = toIsoMs(new Date(openMinuteMs));
    for (const [tag, accumulator] of accumulators) {
      if (accumulator.n === 0) continue;
      queue.push({
        unit_id: options.unitId,
        minute_sim_ts: minute,
        signal_id: tag,
        n: accumulator.n,
        min: accumulator.min,
        max: accumulator.max,
        avg: accumulator.sum / accumulator.n,
        last: accumulator.last,
        duty: digital.has(tag) ? accumulator.trueCount / accumulator.n : null,
        discontinuity: openDiscontinuity,
      });
      reset(accumulator);
    }
    openMinuteMs = undefined;
    openDiscontinuity = false;
  }

  return {
    push(sample: DecodedSample): void {
      const minuteMs = Math.floor(sample.simTsMs / MINUTE_MS) * MINUTE_MS;
      if (minuteMs !== openMinuteMs) closeOpen();
      openMinuteMs = minuteMs;
      if (sample.discontinuity) openDiscontinuity = true;
      if (latestSimTsMs === undefined || sample.simTsMs > latestSimTsMs) {
        latestSimTsMs = sample.simTsMs;
      }

      for (const [tag, accumulator] of accumulators) {
        const value = sample.values[tag];
        if (value === undefined || !Number.isFinite(value)) continue;
        if (accumulator.n === 0) {
          accumulator.min = value;
          accumulator.max = value;
        } else {
          if (value < accumulator.min) accumulator.min = value;
          if (value > accumulator.max) accumulator.max = value;
        }
        accumulator.n += 1;
        accumulator.sum += value;
        accumulator.last = value;
        if (value !== 0) accumulator.trueCount += 1;
      }
    },

    closeOpen,

    pending: () => queue.length,

    due(): boolean {
      if (queue.length === 0) return false;
      if (queue.length >= AGGREGATE_FLUSH_ROWS) return true;
      return options.wall.now().getTime() - lastTakeMs >= AGGREGATE_FLUSH_INTERVAL_MS;
    },

    take(): AggregateRow[] {
      lastTakeMs = options.wall.now().getTime();
      return queue.splice(0, queue.length);
    },

    latestSimTs: () => (latestSimTsMs === undefined ? undefined : toIsoMs(new Date(latestSimTsMs))),
  };
}

function empty(): Accumulator {
  return { n: 0, min: 0, max: 0, sum: 0, last: 0, trueCount: 0 };
}

function reset(accumulator: Accumulator): void {
  accumulator.n = 0;
  accumulator.min = 0;
  accumulator.max = 0;
  accumulator.sum = 0;
  accumulator.last = 0;
  accumulator.trueCount = 0;
}
