// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The recorder's streaming integration test: 2 000 samples of every lane's tags go through
// dispatchFrame as the backend's telemetry.series frames, far faster than the flush interval,
// into the mounted recorder. The store must publish at most one version per 250 ms however fast
// the frames come, and each lane must still draw at most 600 points. The browser-level budget
// (layout, long tasks, DOM size) is e2e/perf.spec.ts.

import { act, renderHook, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { dispatchFrame } from "@/api/ws-dispatch";
import type { FrameOf } from "@/api/ws-types";
import { resolveLayout } from "@/features/recorder/lanes";
import RecorderPanel from "@/features/recorder/RecorderPanel";
import { tid } from "@/lib/testids";
import { toIsoMs } from "@/lib/time";
import { resetLiveStore } from "@/store/live-store";
import {
  FLUSH_INTERVAL_MS,
  LANE_POINTS,
  recorderVersion,
  resetTelemetryStore,
  subscribeRecorder,
  useLaneSeries,
} from "@/store/telemetry-store";
import { reloadUiPrefs } from "@/store/ui-prefs";
import { fixtures } from "@/test/msw/fixtures";
import { server } from "@/test/msw/server";
import { renderWithProviders } from "@/test/render";

const T0 = Date.parse("2020-06-05T06:00:00.000Z");
const SAMPLES = 2_000;
const SAMPLE_STEP_MS = 10_000;
const SAMPLES_PER_FRAME = 25;
const FRAME_INTERVAL_MS = 20;
const SIX_HOURS_MS = 21_600_000;
/** Eighty rendered frames take about a second; coverage instrumentation makes it several. */
const STREAM_TIMEOUT_MS = 30_000;

const LAYOUT = resolveLayout(fixtures.signals.signals);

/** A plausible load/unload cycle: 180 samples a period, a pressure saw-tooth and current steps. */
function sampleValues(index: number): Record<string, number> {
  const phase = index % 180;
  const loaded = phase < 11;
  const running = phase < 52;
  const pressure = loaded ? 8.05 + phase * 0.18 : 10.03 - (phase - 11) * 0.011;
  return {
    line_pressure: pressure,
    discharge_pressure: loaded ? pressure + 0.32 : 0,
    separator_discharge_pressure: loaded ? 0 : pressure,
    dryer_purge_pressure: loaded ? 2.1 : -0.02,
    oil_temperature: 56 + (running ? 4 : 0),
    ambient_temperature: 21,
    motor_current: loaded ? 6.0 : running ? 3.77 : 0.04,
    intake_closed: loaded ? 0 : 1,
    load_valve: loaded ? 1 : 0,
    low_pressure_switch: 0,
    dryer_tower: Math.floor(index / 180) % 2,
  };
}

function frameOf(first: number): FrameOf<"telemetry.series"> {
  const indexes = Array.from({ length: SAMPLES_PER_FRAME }, (_, offset) => first + offset);
  const tags = Object.keys(sampleValues(0));
  return {
    schema: "urn:fdp:schema:ws-server-message:v1",
    unit_id: "cau-7",
    wall_ts: "2026-09-19T10:00:00.000Z",
    type: "telemetry.series",
    payload: {
      from_sim_ts: toIsoMs(T0 + first * SAMPLE_STEP_MS),
      to_sim_ts: toIsoMs(T0 + (first + SAMPLES_PER_FRAME - 1) * SAMPLE_STEP_MS),
      bucket_ms: SAMPLE_STEP_MS,
      series: tags.map((tag) => ({
        tag,
        points: indexes.map((index): [string, number] => [
          toIsoMs(T0 + index * SAMPLE_STEP_MS),
          sampleValues(index)[tag] ?? 0,
        ]),
      })),
      last: {},
      discontinuity: false,
    },
  };
}

beforeAll(async () => {
  // The charts are a chunk of their own that the panel fetches when it mounts; loading the
  // module here keeps that real-time import from racing the fake clock below.
  await import("@/features/recorder/RecorderCharts");
});

beforeEach(() => {
  window.localStorage.clear();
  reloadUiPrefs();
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
    ],
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 84 }),
  );
  server.use(
    http.get("/api/telemetry/series", () =>
      HttpResponse.json({ ...fixtures.series["api-telemetry-series"], series: [] }),
    ),
  );
});

afterEach(() => {
  resetTelemetryStore();
  resetLiveStore();
  vi.useRealTimers();
});

it(
  "streams 2 000 samples into at most one store version per 250 ms and ≤ 600 points a lane",
  async () => {
    renderWithProviders(<RecorderPanel />);
    const pressureLane = LAYOUT.lanes[0];
    if (pressureLane === undefined) {
      throw new Error("signals.json resolves the line-pressure lane");
    }
    const probe = renderHook(() => useLaneSeries(pressureLane, SIX_HOURS_MS));
    await act(() => vi.advanceTimersByTimeAsync(0));

    const versionTimes: number[] = [];
    let seen = recorderVersion();
    const unsubscribe = subscribeRecorder(() => {
      if (recorderVersion() !== seen) {
        seen = recorderVersion();
        versionTimes.push(performance.now());
      }
    });
    const started = performance.now();
    for (let first = 0; first < SAMPLES; first += SAMPLES_PER_FRAME) {
      act(() => {
        dispatchFrame(frameOf(first));
      });
      await act(() => vi.advanceTimersByTimeAsync(FRAME_INTERVAL_MS));
    }
    const streamedFor = performance.now() - started;
    await act(() => vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 2));
    unsubscribe();

    // 80 frames over 1.6 s of wall time: 80 potential renders, at most 8 or so versions.
    expect(versionTimes.length).toBeGreaterThanOrEqual(
      Math.floor(streamedFor / FLUSH_INTERVAL_MS) - 1,
    );
    expect(versionTimes.length).toBeLessThanOrEqual(Math.ceil(streamedFor / FLUSH_INTERVAL_MS) + 2);
    for (let index = 1; index < versionTimes.length; index += 1) {
      expect((versionTimes[index] ?? 0) - (versionTimes[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        FLUSH_INTERVAL_MS,
      );
    }

    const lastSample = T0 + (SAMPLES - 1) * SAMPLE_STEP_MS;
    expect(screen.getByTestId(tid.recorder.root)).toHaveAttribute(
      "data-sim-now",
      String(lastSample),
    );
    const drawn = probe.result.current.points[0] ?? [];
    expect(drawn.length).toBeLessThanOrEqual(LANE_POINTS);
    expect(drawn.length).toBeGreaterThan(LANE_POINTS / 2);
    expect(drawn.at(-1)).toEqual({ t: lastSample, v: sampleValues(SAMPLES - 1).line_pressure });
    expect(
      screen.getByTestId(tid.recorder.lane("TP3")).querySelectorAll("path.recharts-line-curve"),
    ).toHaveLength(2);
  },
  STREAM_TIMEOUT_MS,
);
