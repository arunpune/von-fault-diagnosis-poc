// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The decimation of one flush into a `telemetry.series` payload: at
// most 64 points per tag whatever the replay speed, extremes kept, digitals as
// transitions, the last value of each tag in its own type, and a payload the
// contract accepts.

import { validate, type SampleValue, type TelemetrySeriesPayload } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { decimate, MAX_BUCKETS, MAX_POINTS_PER_TAG } from "./decimate.ts";
import { samplesFrom, STEP_MS } from "./fakes.test-helper.ts";

/** The payload inside a whole frame, checked against `ws-server-message`. */
function expectValidFrame(payload: TelemetrySeriesPayload): void {
  const frame = {
    schema: "urn:fdp:schema:ws-server-message:v1",
    unit_id: "cau-7",
    wall_ts: "2026-09-22T10:00:00.250Z",
    type: "telemetry.series",
    payload,
  };
  const result = validate("ws-server-message", frame);
  expect(result.ok ? [] : result.errors.map((error) => error.text)).toEqual([]);
}

function pointsOf(payload: TelemetrySeriesPayload, tag: string): [string, number | null][] {
  const entry = payload.series.find((series) => series.tag === tag);
  if (entry === undefined) throw new Error(`no series for ${tag}`);
  return entry.points;
}

function ascending(points: readonly [string, number | null][]): boolean {
  return points.every((point, index) => index === 0 || (points[index - 1]?.[0] ?? "") <= point[0]);
}

describe("decimate", () => {
  it("keeps the one sample of a slow flush as one point per tag", () => {
    const [only] = samplesFrom(1, () => ({ line_pressure: 8.9, load_valve: true }));
    if (only === undefined) throw new Error("no sample");
    const payload = decimate([only], false);

    expect(payload).toEqual({
      from_sim_ts: only.sim_ts,
      to_sim_ts: only.sim_ts,
      bucket_ms: 1,
      series: [
        { tag: "line_pressure", points: [[only.sim_ts, 8.9]] },
        { tag: "load_valve", points: [[only.sim_ts, 1]] },
      ],
      last: { line_pressure: 8.9, load_valve: true },
      discontinuity: false,
    });
    expectValidFrame(payload);
  });

  it("keeps every sample while the flush fits the buckets", () => {
    const samples = samplesFrom(MAX_BUCKETS, (position) => ({ oil_temperature: 70 + position }));
    const points = pointsOf(decimate(samples, false), "oil_temperature");
    expect(points.map(([, value]) => value)).toEqual(samples.map((_, position) => 70 + position));
  });

  it("caps a fast flush at 64 points per tag and keeps a one-sample spike", () => {
    // 360 samples: one flush of a replay at 3600x; a purge blip at position 211.
    const samples = samplesFrom(360, (position) => ({
      dryer_purge_pressure: position === 211 ? 1.4 : 0.02 + (position % 7) * 0.001,
      line_pressure: 8 + (position % 50) * 0.04,
    }));
    const payload = decimate(samples, false);

    for (const series of payload.series) {
      expect(series.points.length).toBeLessThanOrEqual(MAX_POINTS_PER_TAG);
      expect(ascending(series.points)).toBe(true);
    }
    const purge = pointsOf(payload, "dryer_purge_pressure");
    expect(purge).toContainEqual([samples[211]?.sim_ts, 1.4]);
    expect(
      Math.max(...pointsOf(payload, "line_pressure").map(([, value]) => value ?? 0)),
    ).toBeCloseTo(9.96);
    expect(payload.bucket_ms).toBe(Math.ceil((359 * STEP_MS + 1) / MAX_BUCKETS));
    expectValidFrame(payload);
  });

  it("carries the first state and every transition of a digital tag", () => {
    const states = [true, true, false, false, false, true, true, false];
    const samples = samplesFrom(states.length, (position) => ({
      load_valve: states[position] ?? false,
    }));
    const points = pointsOf(decimate(samples, false), "load_valve");
    expect(points).toEqual([
      [samples[0]?.sim_ts, 1],
      [samples[2]?.sim_ts, 0],
      [samples[5]?.sim_ts, 1],
      [samples[7]?.sim_ts, 0],
    ]);
  });

  it("falls back to the bucket envelope for a digital tag that toggles past the cap", () => {
    const samples = samplesFrom(300, (position) => ({ flow_pulse: position % 2 === 0 }));
    const payload = decimate(samples, false);
    const points = pointsOf(payload, "flow_pulse");
    expect(points.length).toBeLessThanOrEqual(MAX_POINTS_PER_TAG);
    expect(new Set(points.map(([, value]) => value))).toEqual(new Set([0, 1]));
    expectValidFrame(payload);
  });

  it("reports the last value of each tag in its own type, and a tag some samples lack", () => {
    const samples = samplesFrom(4, (position): Record<string, SampleValue> =>
      position < 2
        ? { motor_current: 6.1 + position, intake_closed: false }
        : { motor_current: 5.2 },
    );
    const payload = decimate(samples, false);
    expect(payload.last).toEqual({ motor_current: 5.2, intake_closed: false });
    expect(pointsOf(payload, "intake_closed")).toEqual([[samples[0]?.sim_ts, 0]]);
  });

  it("marks a run that starts after a jump", () => {
    const samples = samplesFrom(3, () => ({ line_pressure: 9 }));
    expect(decimate(samples, true).discontinuity).toBe(true);
  });

  it("refuses an empty run", () => {
    expect(() => decimate([], false)).toThrow(RangeError);
  });
});
