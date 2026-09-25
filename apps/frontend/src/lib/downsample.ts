// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Downsampling on the way out of the telemetry buffer. The live feed arrives already decimated by
// the backend, but a window can still hold far more points than a lane can draw: the 2 000-point
// history seed, or hours of live points once the window is widened. Each flush therefore reduces
// a lane's slice with Largest-Triangle-Three-Buckets, breaks its line where data time has a gap,
// and clips the digital and state lanes to the window. Everything here is pure and
// allocation-light, so it runs once per flush and lane.

/** One charted point; `v: null` breaks the line (Recharts draws with `connectNulls={false}`). */
export interface ChartPoint {
  readonly t: number;
  readonly v: number | null;
}

/** One entry of a transition list: from `t` (epoch ms) on, the value is `value`. */
export type Transition<V> = readonly [t: number, value: V];

/** A step in data time longer than this is a gap (docs/dataset.md, "Gaps"). */
export const GAP_MS = 60_000;

/** The most transitions a digital, state or alarm row draws per window. */
export const TRANSITION_CAP = 2_000;

/** A threshold below this keeps only the first and the last point: LTTB needs a middle bucket. */
const MIN_LTTB_THRESHOLD = 3;

function chartPoint(t: number, v: number): ChartPoint {
  return { t, v: Number.isFinite(v) ? v : null };
}

/**
 * The first index in `[0, length)` whose key is greater than `x` (`strict`) or not less than `x`;
 * `length` when there is none. The keys must ascend.
 */
function bound(length: number, keyAt: (index: number) => number, x: number, strict: boolean) {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const key = keyAt(middle);
    if (key < x || (strict && key === x)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** The first index of ascending `values` holding a value not less than `x`. */
export function lowerBound(values: ArrayLike<number>, x: number): number {
  return bound(values.length, (index) => values[index] ?? Number.NaN, x, false);
}

/** The first index of ascending `values` holding a value greater than `x`. */
export function upperBound(values: ArrayLike<number>, x: number): number {
  return bound(values.length, (index) => values[index] ?? Number.NaN, x, true);
}

function allPoints(t: ArrayLike<number>, v: ArrayLike<number>, length: number): ChartPoint[] {
  const points: ChartPoint[] = new Array<ChartPoint>(length);
  for (let index = 0; index < length; index += 1) {
    points[index] = chartPoint(t[index] ?? Number.NaN, v[index] ?? Number.NaN);
  }
  return points;
}

/** The mean time and the mean finite value of `[start, end)`; the value is NaN when none is finite. */
function bucketAverage(t: ArrayLike<number>, v: ArrayLike<number>, start: number, end: number) {
  let sumT = 0;
  let sumV = 0;
  let finite = 0;
  for (let index = start; index < end; index += 1) {
    sumT += t[index] ?? 0;
    const value = v[index] ?? Number.NaN;
    if (Number.isFinite(value)) {
      sumV += value;
      finite += 1;
    }
  }
  const count = end - start;
  return { t: count > 0 ? sumT / count : Number.NaN, v: finite > 0 ? sumV / finite : Number.NaN };
}

/**
 * The index LTTB keeps from the bucket `[start, end)`: the point spanning the largest triangle
 * with the previously kept point `(ax, ay)` and the next bucket's average `(cx, cy)`. A bucket
 * holding a NaN (a missing sample or an explicit break) keeps that point instead, so the line
 * still breaks there after downsampling.
 */
function pickInBucket(
  t: ArrayLike<number>,
  v: ArrayLike<number>,
  start: number,
  end: number,
  anchor: { t: number; v: number },
  next: { t: number; v: number },
): number {
  let picked = start;
  let largest = -1;
  for (let index = start; index < end; index += 1) {
    const value = v[index] ?? Number.NaN;
    if (!Number.isFinite(value)) {
      return index;
    }
    const time = t[index] ?? 0;
    const area = Math.abs(
      (anchor.t - next.t) * (value - anchor.v) - (anchor.t - time) * (next.v - anchor.v),
    );
    if (area > largest) {
      largest = area;
      picked = index;
    }
  }
  return picked;
}

/**
 * Largest-Triangle-Three-Buckets (Steinarsson, 2013) over the parallel arrays `t` (ascending
 * epoch ms) and `v`: at most `threshold` points, the first and the last always kept, every kept
 * point one of the input's, in one O(n) pass. NaN values come out as `null` breaks; a bucket that
 * holds one keeps the break rather than its largest triangle. With `threshold` at or above the
 * input length every point is returned; below three only the first and the last are.
 */
export function lttb(t: ArrayLike<number>, v: ArrayLike<number>, threshold: number): ChartPoint[] {
  const length = Math.min(t.length, v.length);
  if (length <= Math.max(threshold, 2)) {
    return allPoints(t, v, length);
  }
  const first = chartPoint(t[0] ?? Number.NaN, v[0] ?? Number.NaN);
  const last = chartPoint(t[length - 1] ?? Number.NaN, v[length - 1] ?? Number.NaN);
  if (threshold < MIN_LTTB_THRESHOLD) {
    return [first, last];
  }

  const points: ChartPoint[] = [first];
  const bucketSize = (length - 2) / (threshold - 2);
  let anchorIndex = 0;
  for (let bucket = 0; bucket < threshold - 2; bucket += 1) {
    const start = Math.floor(bucket * bucketSize) + 1;
    const end = Math.floor((bucket + 1) * bucketSize) + 1;
    const nextEnd = Math.min(Math.floor((bucket + 2) * bucketSize) + 1, length);
    const next = bucketAverage(t, v, end, nextEnd);
    const anchorValue = v[anchorIndex] ?? Number.NaN;
    // A break as the previous point, or a next bucket of breaks, leaves no triangle: fall back
    // to the finite neighbour so the pick still favours the most extreme value.
    const anchor = {
      t: t[anchorIndex] ?? 0,
      v: Number.isFinite(anchorValue) ? anchorValue : next.v,
    };
    const target = { t: next.t, v: Number.isFinite(next.v) ? next.v : anchor.v };
    anchorIndex = pickInBucket(t, v, start, end, anchor, target);
    points.push(chartPoint(t[anchorIndex] ?? Number.NaN, v[anchorIndex] ?? Number.NaN));
  }
  points.push(last);
  return points;
}

/**
 * Inserts a `null` point halfway between two neighbours more than `maxGapMs` apart, so the line
 * breaks at a gap in data time instead of bridging it. Neighbours already separated by a break
 * are left alone. Returns `points` itself when nothing needs breaking.
 */
export function breakGaps(
  points: readonly ChartPoint[],
  maxGapMs: number = GAP_MS,
): readonly ChartPoint[] {
  let broken: ChartPoint[] | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const isGap = current.t - previous.t > maxGapMs && previous.v !== null && current.v !== null;
    if (isGap && broken === null) {
      broken = points.slice(0, index);
    }
    if (broken !== null) {
      if (isGap) {
        broken.push({ t: previous.t + (current.t - previous.t) / 2, v: null });
      }
      broken.push(current);
    }
  }
  return broken ?? points;
}

/**
 * The transitions of an ascending list that fall inside `(from, to]`, led by `[from, value]` —
 * the value in force at `from` — when the list says what it was. At most `cap` entries: a denser
 * window keeps an evenly strided subset whose last entry is always the newest transition, so the
 * row still ends in the right state.
 */
export function clipTransitions<V>(
  list: readonly Transition<V>[],
  from: number,
  to: number,
  cap: number = TRANSITION_CAP,
): Transition<V>[] {
  const keyAt = (index: number): number => list[index]?.[0] ?? Number.NaN;
  const firstInside = bound(list.length, keyAt, from, true);
  const end = Math.max(firstInside, bound(list.length, keyAt, to, true));
  const clipped: Transition<V>[] = [];
  const leading = list[firstInside - 1];
  if (leading !== undefined) {
    clipped.push([from, leading[1]]);
  }
  const room = Math.max(cap - clipped.length, 0);
  const inside = end - firstInside;
  if (inside === 0 || room === 0) {
    return clipped;
  }
  const stride = Math.ceil(inside / room);
  for (let index = firstInside; index < end; index += stride) {
    const entry = list[index];
    if (entry !== undefined) {
      clipped.push(entry);
    }
  }
  const newest = list[end - 1];
  if (stride > 1 && newest !== undefined && clipped[clipped.length - 1] !== newest) {
    clipped[clipped.length - 1] = newest;
  }
  return clipped;
}
