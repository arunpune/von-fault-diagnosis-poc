// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Turning a window of the ring, or of the folded minutes, into the
 * `api-telemetry-series` body the recorder charts.
 *
 * The cap is two thousand points per tag, and the interesting question is
 * which two thousand. Averaging is the obvious answer and the wrong one: a
 * dryer that vents for two samples out of a minute is a one-to-three-sample
 * excursion in `dryer_purge_pressure`, and an average erases it. So an analog
 * tag is bucketed into `points / 2` buckets and each bucket keeps its minimum
 * and its maximum, emitted in the order they occurred. The line still has the
 * right shape, and every spike that was in the window is still in the answer.
 *
 * A digital tag is a staircase, so it keeps its transitions instead: the first
 * sample of the window and every sample whose state differs from the one
 * before it. Only when a tag toggles more often than the budget allows does it
 * fall back to a duty cycle per bucket, which is the honest summary of "it was
 * on about a third of the time" when the individual edges no longer fit.
 *
 * `discontinuities` carries the data time of every sample in the window whose
 * discontinuity flag is set, so the client breaks its line there instead of
 * drawing a straight run across a gap.
 */

import { SIGNALS, toIsoMs, type ApiTelemetrySeries, type Signal } from "@fdp/contracts";

import type { RingBuffer } from "./ring.ts";
import { MAX_SERIES_POINTS, signalKind, type SeriesQuery, type SignalKind } from "./types.ts";

/** One point of the answer: the instant, then the value. */
type Point = [string, number | null];

/** The folded minutes the aggregate read path hands this module. */
export interface MinutePoint {
  readonly signal_id: string;
  /** Start of the minute in data time, epoch milliseconds. */
  readonly minuteMs: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly duty: number | null;
  readonly discontinuity: boolean;
}

export interface SeriesOptions {
  readonly unitId: string;
  /** The registry the tag list is checked against; the contracts one by default. */
  readonly signals?: readonly Signal[];
}

/**
 * The `api-telemetry-series` body for a window the ring still holds.
 *
 * Tags come back in the order the request named them, including tags the
 * registry does not declare — those get an empty point list rather than
 * disappearing, so a client can tell "nothing was recorded" from "you asked
 * for something that does not exist" by looking at `unit`.
 */
export function seriesFromRing(
  ring: RingBuffer,
  query: SeriesQuery,
  options: SeriesOptions,
): ApiTelemetrySeries {
  const registry = options.signals ?? SIGNALS;
  const points = clampPoints(query.points);
  // Segments are stored in the order they arrived, which is data order; a
  // backwards jump makes that differ from time order. The answer is a chart
  // axis, so the ranges are walked oldest instant first and `discontinuities`
  // says where the line breaks.
  const ranges = ring
    .range(query.fromMs, query.toMs)
    .sort((a, b) => ring.simTsAt(a.start) - ring.simTsAt(b.start));

  const series = query.signalIds.map((tag) => {
    const signal = registry.find((entry) => entry.tag === tag);
    const kind = signal === undefined ? "analog" : signalKind(signal);
    return {
      tag,
      kind,
      unit: unitOf(signal, kind),
      points: ring.has(tag) ? ringPoints(ring, ranges, tag, kind, query, points) : [],
    };
  });

  return {
    unit_id: options.unitId,
    from: isoOf(query.fromMs),
    to: isoOf(query.toMs),
    source: "ring",
    series,
    discontinuities: ringDiscontinuities(ring, ranges),
  };
}

/**
 * The `api-telemetry-series` body for a window older than the ring.
 *
 * The rows are already one per minute, so the budget is only ever a problem
 * for a window of more than a thousand minutes. Below that a bucket is a
 * single minute and the point is its average — the line the folded data was
 * kept for. Above it the minutes are bucketed and each bucket keeps its
 * envelope, `(first minute, min)` then `(last minute, max)`, so a long window
 * still shows where the extremes were.
 */
export function seriesFromMinutes(
  rows: readonly MinutePoint[],
  query: SeriesQuery,
  options: SeriesOptions,
): ApiTelemetrySeries {
  const registry = options.signals ?? SIGNALS;
  const points = clampPoints(query.points);
  const byTag = new Map<string, MinutePoint[]>();
  for (const row of rows) {
    const list = byTag.get(row.signal_id);
    if (list === undefined) byTag.set(row.signal_id, [row]);
    else list.push(row);
  }

  const series = query.signalIds.map((tag) => {
    const signal = registry.find((entry) => entry.tag === tag);
    const kind = signal === undefined ? "analog" : signalKind(signal);
    const minutes = (byTag.get(tag) ?? []).slice().sort((a, b) => a.minuteMs - b.minuteMs);
    return { tag, kind, unit: unitOf(signal, kind), points: minutePoints(minutes, kind, points) };
  });

  const discontinuities = [
    ...new Set(rows.filter((row) => row.discontinuity).map((row) => row.minuteMs)),
  ]
    .sort((a, b) => a - b)
    .map(isoOf);

  return {
    unit_id: options.unitId,
    from: isoOf(query.fromMs),
    to: isoOf(query.toMs),
    source: "agg_1m",
    series,
    discontinuities,
  };
}

/** `points`, defaulted and clamped to the contract's cap; at least two. */
export function clampPoints(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return MAX_SERIES_POINTS;
  return Math.max(2, Math.min(MAX_SERIES_POINTS, Math.floor(requested)));
}

/** The data time of every discontinuity inside the window, ascending. */
function ringDiscontinuities(
  ring: RingBuffer,
  ranges: readonly { start: number; end: number }[],
): string[] {
  const instants: number[] = [];
  for (const range of ranges) {
    for (let position = range.start; position < range.end; position += 1) {
      if (ring.discontinuityAt(position)) instants.push(ring.simTsAt(position));
    }
  }
  return instants.sort((a, b) => a - b).map(isoOf);
}

function ringPoints(
  ring: RingBuffer,
  ranges: readonly { start: number; end: number }[],
  tag: string,
  kind: SignalKind,
  query: SeriesQuery,
  budget: number,
): Point[] {
  if (kind === "digital") return digitalRingPoints(ring, ranges, tag, query, budget);
  return analogRingPoints(ring, ranges, tag, query, budget);
}

/**
 * Two points per bucket, the minimum and the maximum in the order they
 * occurred, so the budget is never exceeded and no excursion is lost.
 *
 * The buckets are laid over the requested window rather than over the samples
 * that happen to be there, which keeps the answer stable while new samples
 * arrive at the right-hand edge.
 */
function analogRingPoints(
  ring: RingBuffer,
  ranges: readonly { start: number; end: number }[],
  tag: string,
  query: SeriesQuery,
  budget: number,
): Point[] {
  const buckets = Math.max(1, Math.floor(budget / 2));
  const width = bucketWidth(query, buckets);
  const seen = new Uint8Array(buckets);
  const minValue = new Float64Array(buckets);
  const maxValue = new Float64Array(buckets);
  const minMs = new Float64Array(buckets);
  const maxMs = new Float64Array(buckets);

  for (const range of ranges) {
    for (let position = range.start; position < range.end; position += 1) {
      const value = ring.valueAt(tag, position);
      if (value === undefined || !Number.isFinite(value)) continue;
      const ms = ring.simTsAt(position);
      const bucket = Math.min(buckets - 1, Math.floor((ms - query.fromMs) / width));
      if (seen[bucket] === 0) {
        seen[bucket] = 1;
        minValue[bucket] = value;
        maxValue[bucket] = value;
        minMs[bucket] = ms;
        maxMs[bucket] = ms;
        continue;
      }
      if (value < (minValue[bucket] ?? value)) {
        minValue[bucket] = value;
        minMs[bucket] = ms;
      }
      if (value > (maxValue[bucket] ?? value)) {
        maxValue[bucket] = value;
        maxMs[bucket] = ms;
      }
    }
  }

  const out: Point[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    if (seen[bucket] === 0) continue;
    const low: Point = [isoOf(minMs[bucket] ?? 0), minValue[bucket] ?? 0];
    const high: Point = [isoOf(maxMs[bucket] ?? 0), maxValue[bucket] ?? 0];
    if (low[0] === high[0]) out.push(low);
    else if ((minMs[bucket] ?? 0) < (maxMs[bucket] ?? 0)) out.push(low, high);
    else out.push(high, low);
  }
  return out;
}

/**
 * The staircase: the first sample of the window and every edge after it.
 *
 * A tag that toggles more often than the budget allows is summarised as a duty
 * cycle per bucket instead — one point per bucket, so the budget holds.
 */
function digitalRingPoints(
  ring: RingBuffer,
  ranges: readonly { start: number; end: number }[],
  tag: string,
  query: SeriesQuery,
  budget: number,
): Point[] {
  const edges: Point[] = [];
  let previous: number | undefined;
  let overflowed = false;

  for (const range of ranges) {
    for (let position = range.start; position < range.end; position += 1) {
      const value = ring.valueAt(tag, position);
      if (value === undefined) continue;
      const state = value === 0 ? 0 : 1;
      if (state === previous) continue;
      previous = state;
      if (edges.length >= budget) {
        overflowed = true;
        break;
      }
      edges.push([isoOf(ring.simTsAt(position)), state]);
    }
    if (overflowed) break;
  }
  if (!overflowed) return edges;

  const buckets = budget;
  const width = bucketWidth(query, buckets);
  const trueCount = new Float64Array(buckets);
  const total = new Float64Array(buckets);
  for (const range of ranges) {
    for (let position = range.start; position < range.end; position += 1) {
      const value = ring.valueAt(tag, position);
      if (value === undefined) continue;
      const bucket = Math.min(
        buckets - 1,
        Math.floor((ring.simTsAt(position) - query.fromMs) / width),
      );
      total[bucket] = (total[bucket] ?? 0) + 1;
      if (value !== 0) trueCount[bucket] = (trueCount[bucket] ?? 0) + 1;
    }
  }

  const out: Point[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const samples = total[bucket] ?? 0;
    if (samples === 0) continue;
    out.push([isoOf(query.fromMs + bucket * width), (trueCount[bucket] ?? 0) / samples]);
  }
  return out;
}

/** Folded minutes, bucketed only when there are more of them than the budget. */
function minutePoints(minutes: readonly MinutePoint[], kind: SignalKind, budget: number): Point[] {
  if (minutes.length === 0) return [];
  const perBucket = Math.max(1, Math.ceil(minutes.length / Math.max(1, Math.floor(budget / 2))));
  const out: Point[] = [];

  for (let start = 0; start < minutes.length; start += perBucket) {
    const bucket = minutes.slice(start, start + perBucket);
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    if (first === undefined || last === undefined) continue;
    if (kind === "digital") {
      const duty = mean(bucket.map((row) => row.duty ?? row.avg));
      out.push([isoOf(first.minuteMs), duty]);
      continue;
    }
    if (bucket.length === 1) {
      out.push([isoOf(first.minuteMs), first.avg]);
      continue;
    }
    out.push(
      [isoOf(first.minuteMs), Math.min(...bucket.map((row) => row.min))],
      [isoOf(last.minuteMs), Math.max(...bucket.map((row) => row.max))],
    );
  }
  return out;
}

/** The width of one bucket in milliseconds; never zero, so the division is safe. */
function bucketWidth(query: SeriesQuery, buckets: number): number {
  return Math.max(1, (query.toMs - query.fromMs) / buckets);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** A digital state has no unit; the registry's `bool` is not one a chart shows. */
function unitOf(signal: Signal | undefined, kind: SignalKind): string {
  if (kind === "digital") return "";
  return signal?.unit ?? "";
}

/** Epoch milliseconds as the one timestamp format of the contracts. */
function isoOf(ms: number): string {
  return toIsoMs(new Date(Math.round(ms)));
}
