// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Downsampling: the budget, the spikes and the staircases.
 *
 * The test that matters most is the first one. A dryer that vents for twenty
 * seconds is two samples out of twenty thousand, and an averaging chart draws
 * a flat line straight through it — the excursion this system exists to notice
 * would be invisible in the picture a technician is shown. So the spike is put
 * into a window far larger than the point budget and has to come back out.
 */

import { isValid, parseIsoMs } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { seriesFromMinutes, seriesFromRing, type MinutePoint } from "./downsample.ts";
import { decodedSample, START_MS, STEP_MS, TEST_SIGNALS } from "./fixture.test-helper.ts";
import { RingBuffer } from "./ring.ts";
import { MAX_SERIES_POINTS, type SeriesQuery } from "./types.ts";

const OPTIONS = { unitId: "cau-7", signals: TEST_SIGNALS } as const;

/** A ring holding `count` samples, with per-sample values from `valuesAt`. */
function ringOf(
  count: number,
  valuesAt: (index: number) => Readonly<Record<string, number>> = () => ({}),
  capacity = 32_768,
): RingBuffer {
  const ring = new RingBuffer({ signals: TEST_SIGNALS, capacity });
  for (let index = 0; index < count; index += 1) {
    ring.push(decodedSample(index, { values: valuesAt(index) }));
  }
  return ring;
}

/** The whole window a run of `count` ten-second samples covers. */
function windowOf(count: number, signalIds: string[], points?: number): SeriesQuery {
  return { signalIds, fromMs: START_MS, toMs: START_MS + (count - 1) * STEP_MS, points };
}

describe("seriesFromRing on analog tags", () => {
  const SPIKE_AT = 12_345;
  const SAMPLES = 20_000;

  /** Baseline purge pressure with a two-sample, six bar excursion in the middle. */
  const spikeValues = (index: number): Record<string, number> => ({
    dryer_purge_pressure: index === SPIKE_AT || index === SPIKE_AT + 1 ? 6 : 0.02,
  });

  it("keeps a two-sample spike in a twenty-thousand-sample window", () => {
    const ring = ringOf(SAMPLES, spikeValues);
    const answer = seriesFromRing(
      ring,
      windowOf(SAMPLES, ["dryer_purge_pressure"], MAX_SERIES_POINTS),
      OPTIONS,
    );

    const [entry] = answer.series;
    expect(entry?.tag).toBe("dryer_purge_pressure");
    const values = (entry?.points ?? []).map(([, value]) => value);
    expect(Math.max(...values.map((value) => value ?? 0))).toBeCloseTo(6, 5);

    const spikeMs = START_MS + SPIKE_AT * STEP_MS;
    const carried = (entry?.points ?? []).filter(([, value]) => value === 6);
    expect(carried.length).toBeGreaterThan(0);
    for (const [instant] of carried) {
      const ms = parseIsoMs(instant).getTime();
      expect(Math.abs(ms - spikeMs)).toBeLessThanOrEqual(STEP_MS);
    }
  });

  it("never returns more than the requested number of points", () => {
    const ring = ringOf(SAMPLES, spikeValues);
    for (const points of [2, 10, 101, 999, MAX_SERIES_POINTS]) {
      const answer = seriesFromRing(
        ring,
        windowOf(SAMPLES, ["dryer_purge_pressure", "line_pressure", "load_valve"], points),
        OPTIONS,
      );
      for (const entry of answer.series) expect(entry.points.length).toBeLessThanOrEqual(points);
    }
  });

  it("caps an over-large request at the contract's two thousand", () => {
    const ring = ringOf(SAMPLES, spikeValues);
    const answer = seriesFromRing(
      ring,
      windowOf(SAMPLES, ["dryer_purge_pressure"], 10_000),
      OPTIONS,
    );
    expect(answer.series[0]?.points.length).toBeLessThanOrEqual(MAX_SERIES_POINTS);
  });

  it("emits the minimum and the maximum of a bucket in the order they occurred", () => {
    // Four samples, one bucket: the minimum is second, the maximum is last.
    const ring = ringOf(4, (index) => ({ line_pressure: [9, 8, 9.5, 10][index] ?? 9 }));
    const answer = seriesFromRing(ring, windowOf(4, ["line_pressure"], 2), OPTIONS);
    expect(answer.series[0]?.points).toEqual([
      ["2020-02-03T00:00:10.000Z", 8],
      ["2020-02-03T00:00:30.000Z", 10],
    ]);
  });

  it("emits one point for a bucket whose extremes are the same sample", () => {
    const ring = ringOf(1, () => ({ line_pressure: 9 }));
    const answer = seriesFromRing(
      ring,
      { signalIds: ["line_pressure"], fromMs: START_MS, toMs: START_MS + STEP_MS, points: 20 },
      OPTIONS,
    );
    expect(answer.series[0]?.points).toEqual([["2020-02-03T00:00:00.000Z", 9]]);
  });

  it("skips buckets no sample fell into", () => {
    const ring = ringOf(3);
    const answer = seriesFromRing(
      ring,
      { signalIds: ["line_pressure"], fromMs: START_MS, toMs: START_MS + 600_000, points: 60 },
      OPTIONS,
    );
    expect(answer.series[0]?.points.length).toBeLessThanOrEqual(2);
  });

  it("answers a tag it stores nothing for with an empty point list", () => {
    const ring = ringOf(10);
    const answer = seriesFromRing(ring, windowOf(10, ["motor_current"]), OPTIONS);
    // Neither this ring nor the registry it was built from knows the tag, so
    // the entry is there — the request named it — but it carries nothing.
    expect(answer.series[0]).toEqual({
      tag: "motor_current",
      kind: "analog",
      unit: "",
      points: [],
    });
  });
});

describe("seriesFromRing on digital tags", () => {
  it("run-length encodes the transitions and nothing else", () => {
    const ring = ringOf(40, (index) => ({ load_valve: index >= 10 && index < 25 ? 1 : 0 }));
    const answer = seriesFromRing(ring, windowOf(40, ["load_valve"]), OPTIONS);
    expect(answer.series[0]?.kind).toBe("digital");
    expect(answer.series[0]?.unit).toBe("");
    expect(answer.series[0]?.points).toEqual([
      ["2020-02-03T00:00:00.000Z", 0],
      ["2020-02-03T00:01:40.000Z", 1],
      ["2020-02-03T00:04:10.000Z", 0],
    ]);
  });

  it("falls back to a duty cycle per bucket when the edges do not fit", () => {
    const ring = ringOf(400, (index) => ({ load_valve: index % 2 }));
    const answer = seriesFromRing(ring, windowOf(400, ["load_valve"], 10), OPTIONS);
    const points = answer.series[0]?.points ?? [];
    expect(points.length).toBeLessThanOrEqual(10);
    expect(points.length).toBeGreaterThan(1);
    for (const [, duty] of points) {
      expect(duty).toBeGreaterThanOrEqual(0);
      expect(duty).toBeLessThanOrEqual(1);
    }
    expect(points[0]?.[1]).toBeCloseTo(0.5, 2);
  });
});

describe("seriesFromRing envelope", () => {
  it("names the window, the unit and the ring as its source", () => {
    const ring = ringOf(10);
    const answer = seriesFromRing(ring, windowOf(10, ["line_pressure"]), OPTIONS);
    expect(answer.unit_id).toBe("cau-7");
    expect(answer.source).toBe("ring");
    expect(answer.from).toBe("2020-02-03T00:00:00.000Z");
    expect(answer.to).toBe("2020-02-03T00:01:30.000Z");
  });

  it("lists every discontinuity inside the window, ascending", () => {
    const ring = new RingBuffer({ signals: TEST_SIGNALS, capacity: 64 });
    for (let index = 0; index < 5; index += 1) ring.push(decodedSample(index));
    const jumpMs = START_MS + 3_600_000;
    ring.push(decodedSample(5, { simTsMs: jumpMs, discontinuity: true }));
    ring.push(decodedSample(6, { simTsMs: jumpMs + STEP_MS }));

    const answer = seriesFromRing(
      ring,
      { signalIds: ["line_pressure"], fromMs: START_MS, toMs: jumpMs + STEP_MS },
      OPTIONS,
    );
    expect(answer.discontinuities).toEqual(["2020-02-03T01:00:00.000Z"]);
  });

  it("answers the tags in the order the request named them", () => {
    const ring = ringOf(10);
    const answer = seriesFromRing(
      ring,
      windowOf(10, ["load_valve", "line_pressure", "dryer_purge_pressure"]),
      OPTIONS,
    );
    expect(answer.series.map((entry) => entry.tag)).toEqual([
      "load_valve",
      "line_pressure",
      "dryer_purge_pressure",
    ]);
  });

  it("validates against api-telemetry-series", () => {
    const ring = ringOf(5_000, (index) => ({
      line_pressure: 8 + (index % 200) / 100,
      load_valve: index % 400 < 120 ? 1 : 0,
    }));
    const answer = seriesFromRing(
      ring,
      windowOf(5_000, ["line_pressure", "load_valve"], MAX_SERIES_POINTS),
      OPTIONS,
    );
    expect(isValid("api-telemetry-series", answer)).toBe(true);
  });
});

describe("seriesFromMinutes", () => {
  /** `count` folded minutes of one tag, starting at the fixture's first minute. */
  function minutes(count: number, tag = "line_pressure"): MinutePoint[] {
    return Array.from({ length: count }, (_unused, index) => ({
      signal_id: tag,
      minuteMs: START_MS + index * 60_000,
      min: 8 + index / 1000,
      max: 10 + index / 1000,
      avg: 9 + index / 1000,
      duty: tag === "load_valve" ? 0.25 : null,
      discontinuity: false,
    }));
  }

  it("names the aggregates as its source", () => {
    const answer = seriesFromMinutes(minutes(10), windowOf(10, ["line_pressure"]), OPTIONS);
    expect(answer.source).toBe("agg_1m");
    expect(isValid("api-telemetry-series", answer)).toBe(true);
  });

  it("gives one average per minute while the budget allows it", () => {
    const answer = seriesFromMinutes(minutes(3), windowOf(3, ["line_pressure"]), OPTIONS);
    expect(answer.series[0]?.points).toEqual([
      ["2020-02-03T00:00:00.000Z", 9],
      ["2020-02-03T00:01:00.000Z", 9.001],
      ["2020-02-03T00:02:00.000Z", 9.002],
    ]);
  });

  it("keeps the envelope of a bucket once the minutes outnumber the budget", () => {
    const answer = seriesFromMinutes(
      minutes(1_000),
      { signalIds: ["line_pressure"], fromMs: START_MS, toMs: START_MS + 60_000_000, points: 20 },
      OPTIONS,
    );
    const points = answer.series[0]?.points ?? [];
    expect(points.length).toBeLessThanOrEqual(20);
    expect(points[0]?.[1]).toBeCloseTo(8, 5);
    expect(points[1]?.[1]).toBeCloseTo(10.099, 3);
  });

  it("gives a digital tag its duty cycle", () => {
    const answer = seriesFromMinutes(
      minutes(4, "load_valve"),
      windowOf(4, ["load_valve"]),
      OPTIONS,
    );
    expect(answer.series[0]?.kind).toBe("digital");
    expect(answer.series[0]?.points.map(([, value]) => value)).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it("lists the minutes a discontinuity fell into", () => {
    const rows = minutes(4).map((row, index) => ({ ...row, discontinuity: index === 2 }));
    const answer = seriesFromMinutes(rows, windowOf(4, ["line_pressure"]), OPTIONS);
    expect(answer.discontinuities).toEqual(["2020-02-03T00:02:00.000Z"]);
  });

  it("returns an empty list for a tag the table holds nothing for", () => {
    const answer = seriesFromMinutes(minutes(4), windowOf(4, ["dryer_purge_pressure"]), OPTIONS);
    expect(answer.series[0]?.points).toEqual([]);
  });
});
