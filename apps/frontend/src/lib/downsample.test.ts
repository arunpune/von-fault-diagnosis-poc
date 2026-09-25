// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  breakGaps,
  clipTransitions,
  GAP_MS,
  lowerBound,
  lttb,
  TRANSITION_CAP,
  upperBound,
  type ChartPoint,
  type Transition,
} from "@/lib/downsample";

const T0 = Date.parse("2020-06-05T00:00:00.000Z");
const STEP_MS = 10_000;

/** A seeded linear-congruential generator, so the "random" series is the same on every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/** A pressure-like cycle every 180 samples plus seeded noise, sampled every 10 s. */
function series(length: number, seed = 7): { t: Float64Array; v: Float64Array } {
  const random = seededRandom(seed);
  const t = new Float64Array(length);
  const v = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    t[index] = T0 + index * STEP_MS;
    v[index] = 8 + 2 * Math.sin((2 * Math.PI * index) / 180) + 0.05 * random();
  }
  return { t, v };
}

function isSubsetOf(points: readonly ChartPoint[], t: Float64Array, v: Float64Array): boolean {
  return points.every((point) => {
    const index = lowerBound(t, point.t);
    const value = v[index];
    return (
      t[index] === point.t &&
      value !== undefined &&
      (point.v === null ? Number.isNaN(value) : value === point.v)
    );
  });
}

describe("lttb", () => {
  it("returns every point, NaN as a break, when the input fits the threshold", () => {
    const t = [T0, T0 + STEP_MS, T0 + 2 * STEP_MS];
    const v = [1, Number.NaN, 3];

    expect(lttb(t, v, 600)).toEqual([
      { t: T0, v: 1 },
      { t: T0 + STEP_MS, v: null },
      { t: T0 + 2 * STEP_MS, v: 3 },
    ]);
    expect(lttb([], [], 600)).toEqual([]);
  });

  it.each([600, 100, 3])("reduces 10 000 points to exactly %i", (threshold) => {
    const { t, v } = series(10_000);

    expect(lttb(t, v, threshold)).toHaveLength(threshold);
  });

  it("keeps the first and the last point", () => {
    const { t, v } = series(5_000);
    const points = lttb(t, v, 600);

    expect(points[0]).toEqual({ t: t[0], v: v[0] });
    expect(points.at(-1)).toEqual({ t: t[4_999], v: v[4_999] });
  });

  it("returns a subset of the input in strictly ascending time", () => {
    const { t, v } = series(7_919, 11);
    const points = lttb(t, v, 600);

    expect(isSubsetOf(points, t, v)).toBe(true);
    for (let index = 1; index < points.length; index += 1) {
      expect(points[index]?.t).toBeGreaterThan(points[index - 1]?.t ?? Infinity);
    }
  });

  it("keeps a one-sample spike that averaging would flatten", () => {
    const { t, v } = series(20_000, 3);
    v[12_345] = 42;

    const points = lttb(t, v, 600);

    expect(points).toContainEqual({ t: t[12_345], v: 42 });
  });

  it("keeps a break inside a bucket as a null point", () => {
    const { t, v } = series(10_000);
    v[4_000] = Number.NaN;

    const points = lttb(t, v, 300);

    expect(points).toContainEqual({ t: t[4_000], v: null });
    expect(points).toHaveLength(300);
    expect(isSubsetOf(points, t, v)).toBe(true);
  });

  it("still picks points when the neighbours are breaks", () => {
    const t = Float64Array.from({ length: 50 }, (_, index) => T0 + index * STEP_MS);
    const v = Float64Array.from({ length: 50 }, (_, index) => (index < 10 ? Number.NaN : index));

    const points = lttb(t, v, 10);

    expect(points).toHaveLength(10);
    expect(points[0]).toEqual({ t: T0, v: null });
    expect(points.at(-1)).toEqual({ t: T0 + 49 * STEP_MS, v: 49 });
  });

  it("keeps only the first and the last point below three buckets", () => {
    const { t, v } = series(100);

    expect(lttb(t, v, 2)).toEqual([
      { t: t[0], v: v[0] },
      { t: t[99], v: v[99] },
    ]);
  });
});

describe("breakGaps", () => {
  const point = (seconds: number, v: number | null = 1): ChartPoint => ({
    t: T0 + seconds * 1_000,
    v,
  });

  it("returns the same array when no neighbours are a gap apart", () => {
    const points = [point(0), point(10), point(70)];

    expect(breakGaps(points)).toBe(points);
  });

  it("inserts a null halfway across every step longer than 60 s", () => {
    const points = [point(0), point(10), point(100), point(110), point(300)];

    expect(breakGaps(points)).toEqual([
      point(0),
      point(10),
      point(55, null),
      point(100),
      point(110),
      point(205, null),
      point(300),
    ]);
    expect(GAP_MS).toBe(60_000);
  });

  it("honours a wider gap for coarser data and leaves existing breaks alone", () => {
    const points = [point(0), point(100), point(150, null), point(400), point(700)];

    expect(breakGaps(points, 200_000)).toEqual([
      point(0),
      point(100),
      point(150, null),
      point(400),
      point(550, null),
      point(700),
    ]);
  });
});

describe("clipTransitions", () => {
  const at = (minutes: number): number => T0 + minutes * 60_000;
  const list: Transition<number>[] = [
    [at(0), 0],
    [at(10), 1],
    [at(20), 0],
    [at(30), 1],
    [at(40), 0],
  ];

  it("leads with the state in force at `from` and keeps the transitions inside the window", () => {
    expect(clipTransitions(list, at(15), at(35))).toEqual([
      [at(15), 1],
      [at(20), 0],
      [at(30), 1],
    ]);
  });

  it("reads a transition at exactly `from` as the leading state and one at `to` as inside", () => {
    expect(clipTransitions(list, at(10), at(30))).toEqual([
      [at(10), 1],
      [at(20), 0],
      [at(30), 1],
    ]);
  });

  it("has no leading state before the first transition", () => {
    expect(clipTransitions(list, at(-5), at(5))).toEqual([[at(0), 0]]);
    expect(clipTransitions([], at(0), at(10))).toEqual([]);
  });

  it("returns the leading state alone for a window without transitions", () => {
    expect(clipTransitions(list, at(41), at(50))).toEqual([[at(41), 0]]);
    expect(clipTransitions(list, at(50), at(41))).toEqual([[at(50), 0]]);
  });

  it("caps a dense window with a stride that ends on the newest transition", () => {
    const dense: Transition<number>[] = Array.from({ length: 10_001 }, (_, index) => [
      at(index),
      index % 2,
    ]);

    const clipped = clipTransitions(dense, at(0.5), at(10_000));

    expect(clipped.length).toBeLessThanOrEqual(TRANSITION_CAP);
    expect(clipped[0]).toEqual([at(0.5), 0]);
    expect(clipped.at(-1)).toEqual([at(10_000), 0]);
    const times = clipped.map(([time]) => time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("works on any value type, such as alarm code lists", () => {
    const alarms: Transition<readonly string[]>[] = [
      [at(0), ["W102"]],
      [at(5), []],
    ];

    expect(clipTransitions(alarms, at(1), at(9), 3)).toEqual([
      [at(1), ["W102"]],
      [at(5), []],
    ]);
  });
});

describe("lowerBound and upperBound", () => {
  const values = Float64Array.from([1, 2, 2, 3]);

  it("find the first index at or above, and strictly above, a value", () => {
    expect(lowerBound(values, 2)).toBe(1);
    expect(upperBound(values, 2)).toBe(3);
    expect(lowerBound(values, 0)).toBe(0);
    expect(upperBound(values, 3)).toBe(4);
  });
});
