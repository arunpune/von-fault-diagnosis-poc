// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The backend's downsampling, reimplemented for the fake:
// an analog tag keeps the minimum and the maximum of every time bucket in the order they
// occurred, so a one-sample excursion survives; a digital tag keeps its first state and every
// change, falling back to the per-bucket envelope only when it toggles more often than the cap.
// The same rule shapes the live `telemetry.series` frames (at most 64 points per tag) and the
// REST history (`GET /api/telemetry/series`, at most 2,000 points per tag).

import type { Sample, SeriesPoint, TelemetrySeries } from "@/api/types";

/** The contract's cap on one `telemetry.series` frame. */
export const FRAME_POINTS_PER_TAG = 64;

/** The contract's cap on one tag of `GET /api/telemetry/series`. */
export const SERIES_POINTS_MAX = 2000;

/** One value of one tag; a digital state is 0 or 1. */
export interface Reading {
  readonly ms: number;
  readonly iso: string;
  readonly value: number;
}

/** The bucket width that lays `[firstMs, lastMs]` out in `maxPoints / 2` buckets. */
export function bucketWidthMs(firstMs: number, lastMs: number, maxPoints: number): number {
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  return Math.max(1, Math.ceil((lastMs - firstMs + 1) / buckets));
}

function pointOf(reading: Reading): SeriesPoint {
  return [reading.iso, reading.value];
}

/** Per bucket, the minimum and the maximum in time order; one point when they coincide. */
export function envelope(readings: readonly Reading[], maxPoints: number): SeriesPoint[] {
  const first = readings[0];
  const last = readings.at(-1);
  if (first === undefined || last === undefined) {
    return [];
  }
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  const widthMs = bucketWidthMs(first.ms, last.ms, maxPoints);
  const points: SeriesPoint[] = [];
  let bucket = -1;
  let low = first;
  let high = first;
  const close = (): void => {
    if (bucket < 0) {
      return;
    }
    if (low === high) {
      points.push(pointOf(low));
    } else {
      const [earlier, later] = low.ms <= high.ms ? [low, high] : [high, low];
      points.push(pointOf(earlier), pointOf(later));
    }
  };
  for (const reading of readings) {
    const index = Math.min(buckets - 1, Math.floor((reading.ms - first.ms) / widthMs));
    if (index !== bucket) {
      close();
      bucket = index;
      low = reading;
      high = reading;
    } else if (reading.value < low.value) {
      low = reading;
    } else if (reading.value > high.value) {
      high = reading;
    }
  }
  close();
  return points;
}

/** The first state and every change, or the envelope when the changes do not fit. */
export function transitions(readings: readonly Reading[], maxPoints: number): SeriesPoint[] {
  const changes = readings.filter(
    (reading, index) => index === 0 || readings[index - 1]?.value !== reading.value,
  );
  return changes.length > maxPoints ? envelope(readings, maxPoints) : changes.map(pointOf);
}

export function decimateTrack(
  readings: readonly Reading[],
  digital: boolean,
  maxPoints: number,
): SeriesPoint[] {
  return digital ? transitions(readings, maxPoints) : envelope(readings, maxPoints);
}

/**
 * One `telemetry.series` payload from a run of samples in ascending data time; the caller cuts
 * runs where data time jumps and says whether this one starts after a jump.
 */
export function decimateFrame(
  samples: readonly [Sample, ...Sample[]],
  discontinuity: boolean,
): TelemetrySeries {
  const [first] = samples;
  const last = samples.at(-1) ?? first;
  const firstMs = Date.parse(first.sim_ts);
  const lastMs = Date.parse(last.sim_ts);

  const tracks = new Map<string, Reading[]>();
  const digital = new Set<string>();
  const latest: TelemetrySeries["last"] = {};
  for (const sample of samples) {
    const ms = Date.parse(sample.sim_ts);
    for (const [tag, value] of Object.entries(sample.values)) {
      let track = tracks.get(tag);
      if (track === undefined) {
        track = [];
        tracks.set(tag, track);
      }
      if (typeof value === "boolean") {
        digital.add(tag);
      }
      track.push({ ms, iso: sample.sim_ts, value: Number(value) });
      latest[tag] = value;
    }
  }

  return {
    from_sim_ts: first.sim_ts,
    to_sim_ts: last.sim_ts,
    bucket_ms: bucketWidthMs(firstMs, lastMs, FRAME_POINTS_PER_TAG),
    series: [...tracks].map(([tag, readings]) => ({
      tag,
      points: decimateTrack(readings, digital.has(tag), FRAME_POINTS_PER_TAG),
    })),
    last: latest,
    discontinuity,
  };
}
