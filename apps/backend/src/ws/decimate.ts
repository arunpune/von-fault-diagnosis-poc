// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The decimation of one flush into a `telemetry.series` payload (contracts
 * `ws-server-message`).
 *
 * The charts are fed downsampled series by the backend. Every flush
 * interval the hub hands this module the samples that arrived since the last
 * one — a run in ascending data time, cut where data time jumped — and gets
 * back one payload that never carries more than {@link MAX_POINTS_PER_TAG}
 * points per tag, whatever the replay speed:
 *
 * - the run is laid out in {@link MAX_BUCKETS} buckets of `bucket_ms`
 *   simulated milliseconds, so a slow replay (one sample per flush) and a
 *   fast one (a hundred samples per flush) produce the same shape;
 * - an **analog** tag keeps, per bucket, its minimum and its maximum in the
 *   order they occurred — the rule `ingest/downsample.ts` applies to the REST
 *   history, so the seeded chart and the live chart agree, and a one-sample
 *   excursion (a dryer purge blip) survives;
 * - a **digital** tag keeps its first state and every transition, as `0`/`1`;
 *   only a tag that toggles more often than the cap allows falls back to the
 *   per-bucket minimum and maximum, which still shows that both states
 *   occurred;
 * - `last` carries the final value of every tag in its own type (a digital
 *   state stays a boolean), for the numeric readouts beside the charts.
 *
 * A tag is analog or digital by the type of its values, which the gateway
 * decodes from the register map, so this module needs no registry.
 */

import { parseIsoMs, type Sample, type TelemetrySeriesPayload } from "@fdp/contracts";

/** The contract's cap: at most this many points per tag in one frame. */
export const MAX_POINTS_PER_TAG = 64;

/** Two points per bucket, the minimum and the maximum, fill the cap exactly. */
export const MAX_BUCKETS = MAX_POINTS_PER_TAG / 2;

type Point = [string, number];

/** One value of one tag, with the position of the sample that carried it. */
interface Reading {
  readonly index: number;
  readonly value: number;
}

/** What the bucket layout needs of the run. */
interface Layout {
  readonly fromMs: number;
  readonly bucketMs: number;
  readonly times: readonly number[];
  readonly simTs: readonly string[];
}

function bucketOf(layout: Layout, index: number): number {
  const offset = (layout.times[index] ?? layout.fromMs) - layout.fromMs;
  return Math.min(MAX_BUCKETS - 1, Math.floor(offset / layout.bucketMs));
}

function pointAt(layout: Layout, reading: Reading): Point {
  return [layout.simTs[reading.index] ?? "", reading.value];
}

/**
 * Per bucket, the minimum and the maximum in the order they occurred; one
 * point when they are the same reading. Ties keep the earliest reading.
 */
function envelope(layout: Layout, readings: readonly Reading[]): Point[] {
  const low = new Map<number, Reading>();
  const high = new Map<number, Reading>();
  for (const reading of readings) {
    const bucket = bucketOf(layout, reading.index);
    const min = low.get(bucket);
    const max = high.get(bucket);
    if (min === undefined || reading.value < min.value) low.set(bucket, reading);
    if (max === undefined || reading.value > max.value) high.set(bucket, reading);
  }

  const points: Point[] = [];
  for (const [bucket, min] of [...low.entries()].sort(([a], [b]) => a - b)) {
    const max = high.get(bucket) ?? min;
    const ordered = min.index <= max.index ? [min, max] : [max, min];
    for (const reading of min.index === max.index ? [min] : ordered) {
      points.push(pointAt(layout, reading));
    }
  }
  return points;
}

/** The first state and every change of state, or the envelope when they do not fit. */
function transitions(layout: Layout, readings: readonly Reading[]): Point[] {
  const changes = readings.filter(
    (reading, position) => position === 0 || readings[position - 1]?.value !== reading.value,
  );
  if (changes.length > MAX_POINTS_PER_TAG) return envelope(layout, readings);
  return changes.map((reading) => pointAt(layout, reading));
}

/**
 * The `telemetry.series` payload of one run.
 *
 * @param samples at least one sample, in ascending data time (the hub cuts a
 *   run wherever data time jumps).
 * @param discontinuity whether data time jumped at the start of this run.
 * @throws RangeError when `samples` is empty.
 */
export function decimate(
  samples: readonly Sample[],
  discontinuity: boolean,
): TelemetrySeriesPayload {
  const first = samples[0];
  const lastSample = samples.at(-1);
  if (first === undefined || lastSample === undefined) {
    throw new RangeError("decimate: a run holds at least one sample");
  }

  const times = samples.map((sample) => parseIsoMs(sample.sim_ts).getTime());
  const fromMs = times[0] ?? 0;
  const spanMs = (times.at(-1) ?? fromMs) - fromMs;
  const layout: Layout = {
    fromMs,
    bucketMs: Math.max(1, Math.ceil((spanMs + 1) / MAX_BUCKETS)),
    times,
    simTs: samples.map((sample) => sample.sim_ts),
  };

  const readings = new Map<string, Reading[]>();
  const digital = new Set<string>();
  const last: TelemetrySeriesPayload["last"] = {};
  samples.forEach((sample, index) => {
    for (const [tag, value] of Object.entries(sample.values)) {
      if (!readings.has(tag)) {
        readings.set(tag, []);
        if (typeof value === "boolean") digital.add(tag);
      }
      readings.get(tag)?.push({ index, value: typeof value === "boolean" ? Number(value) : value });
      last[tag] = value;
    }
  });

  return {
    from_sim_ts: first.sim_ts,
    to_sim_ts: lastSample.sim_ts,
    bucket_ms: layout.bucketMs,
    series: [...readings.entries()].map(([tag, list]) => ({
      tag,
      points: digital.has(tag) ? transitions(layout, list) : envelope(layout, list),
    })),
    last,
    discontinuity,
  };
}
