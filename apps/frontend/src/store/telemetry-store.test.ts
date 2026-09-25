// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiTelemetrySeries, TelemetrySeries } from "@/api/types";
import { dispatchFrame } from "@/api/ws-dispatch";
import type { FrameOf } from "@/api/ws-types";
import { MACHINE_STATE } from "@/lib/machine-state";
import { toIsoMs } from "@/lib/time";
import { applyStatusSnapshot, resetLiveStore, useSimNow } from "@/store/live-store";
import {
  AXIS_TICKS,
  configureRecorder,
  createFlushScheduler,
  FLUSH_INTERVAL_MS,
  HIDDEN_FLUSH_INTERVAL_MS,
  LANE_POINTS,
  recorderVersion,
  resetTelemetryStore,
  SEED_POINTS,
  SEED_WINDOW_MS,
  subscribeRecorder,
  useAxis,
  useLaneSeries,
  useReanchoring,
  useRecorderNow,
  useStrip,
  type FlushSchedulerDeps,
  type LaneSpec,
  type RecorderConfig,
} from "@/store/telemetry-store";
import { fixtures, frames } from "@/test/msw/fixtures";
import { apiError } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";

const T0 = Date.parse("2020-06-05T12:00:00.000Z");
const HOUR_MS = 3_600_000;

const PRESSURE: LaneSpec = {
  id: "TP3",
  series: [
    { key: "TP3", tag: "line_pressure" },
    { key: "TP2", tag: "discharge_pressure" },
  ],
};
const OIL: LaneSpec = { id: "Oil_temperature", series: [{ key: "Oil", tag: "oil_temperature" }] };

const CONFIG: RecorderConfig = {
  signals: fixtures.signals.signals,
  tags: ["line_pressure", "discharge_pressure", "oil_temperature", "motor_current"],
  strips: { lps: "low_pressure_switch", towers: null },
};

function at(seconds: number): number {
  return T0 + seconds * 1_000;
}

function seriesFrame(
  points: Record<string, [number, number | null][]>,
  {
    discontinuity = false,
    last = {},
  }: Partial<Pick<TelemetrySeries, "discontinuity" | "last">> = {},
): FrameOf<"telemetry.series"> {
  const seconds = Object.values(points).flatMap((list) => list.map(([time]) => time));
  return {
    schema: "urn:fdp:schema:ws-server-message:v1",
    unit_id: "cau-7",
    wall_ts: "2026-09-19T10:00:00.000Z",
    type: "telemetry.series",
    payload: {
      from_sim_ts: toIsoMs(at(Math.min(...seconds))),
      to_sim_ts: toIsoMs(at(Math.max(...seconds))),
      bucket_ms: 1_000,
      series: Object.entries(points).map(([tag, list]) => ({
        tag,
        points: list.map(([time, value]): [string, number | null] => [toIsoMs(at(time)), value]),
      })),
      last,
      discontinuity,
    },
  };
}

function emptyHistory(): ApiTelemetrySeries {
  return {
    unit_id: "cau-7",
    from: toIsoMs(T0 - SEED_WINDOW_MS),
    to: toIsoMs(T0),
    source: "ring",
    series: [],
    discontinuities: [],
  };
}

let seriesRequests: URL[] = [];

function recordSeriesRequest({ request }: { request: Request }): void {
  const url = new URL(request.url);
  if (url.pathname === "/api/telemetry/series" || url.pathname === "/api/series") {
    seriesRequests.push(url);
  }
}

/** Lets pending fetches answer and due timers and animation frames run. */
async function settle(ms = 0): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

const unsubscribers: (() => void)[] = [];

/** The instants (fake ms) at which the store published a new version. */
function watchVersions(): number[] {
  const published: number[] = [];
  let seen = recorderVersion();
  unsubscribers.push(
    subscribeRecorder(() => {
      if (recorderVersion() !== seen) {
        seen = recorderVersion();
        published.push(performance.now());
      }
    }),
  );
  return published;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
    ],
  });
  seriesRequests = [];
  server.events.on("request:start", recordSeriesRequest);
});

afterEach(() => {
  server.events.removeListener("request:start", recordSeriesRequest);
  for (const unsubscribe of unsubscribers.splice(0)) {
    unsubscribe();
  }
  resetTelemetryStore();
  resetLiveStore();
  vi.useRealTimers();
});

describe("createFlushScheduler", () => {
  function fakeDeps(hidden = false) {
    let clock = 0;
    const timers: { at: number; run: () => void }[] = [];
    const framesDue: (() => void)[] = [];
    const publishes: number[] = [];
    const deps: FlushSchedulerDeps = {
      publish: () => publishes.push(clock),
      now: () => clock,
      isHidden: () => hidden,
      setTimer: (run, delayMs) => {
        const timer = { at: clock + delayMs, run };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => {
        timers.splice(timers.indexOf(handle as (typeof timers)[number]), 1);
      },
      requestFrame: (run) => {
        framesDue.push(run);
        return run;
      },
      cancelFrame: (handle) => {
        framesDue.splice(framesDue.indexOf(handle as () => void), 1);
      },
    };
    /** Moves the clock by `ms`, firing timers and then a 16 ms animation frame on the way. */
    function advance(ms: number): void {
      for (let step = 0; step < ms; step += 1) {
        clock += 1;
        for (const timer of timers.filter((due) => due.at <= clock)) {
          timers.splice(timers.indexOf(timer), 1);
          timer.run();
        }
        if (clock % 16 === 0) {
          for (const run of framesDue.splice(0)) {
            run();
          }
        }
      }
    }
    return { deps, publishes, advance, pendingTimers: () => timers.length };
  }

  it("coalesces 100 rapid requests into at most one publish per 250 ms", () => {
    const { deps, publishes, advance } = fakeDeps();
    const scheduler = createFlushScheduler(deps);

    for (let request = 0; request < 100; request += 1) {
      scheduler.request();
      advance(10);
    }
    advance(500);

    expect(publishes.length).toBeGreaterThanOrEqual(4);
    expect(publishes.length).toBeLessThanOrEqual(Math.ceil(1_500 / FLUSH_INTERVAL_MS));
    for (let index = 1; index < publishes.length; index += 1) {
      expect((publishes[index] ?? 0) - (publishes[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        FLUSH_INTERVAL_MS,
      );
    }
  });

  it("publishes at most once a second, straight from the timer, while hidden", () => {
    const { deps, publishes, advance } = fakeDeps(true);
    const scheduler = createFlushScheduler(deps);

    for (let request = 0; request < 300; request += 1) {
      scheduler.request();
      advance(10);
    }

    expect(publishes.length).toBeLessThanOrEqual(Math.ceil(3_000 / HIDDEN_FLUSH_INTERVAL_MS));
    for (let index = 1; index < publishes.length; index += 1) {
      expect((publishes[index] ?? 0) - (publishes[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        HIDDEN_FLUSH_INTERVAL_MS,
      );
    }
  });

  it("drops a pending publish on cancel, before or after the timer fired", () => {
    const { deps, publishes, advance, pendingTimers } = fakeDeps();
    const scheduler = createFlushScheduler(deps);

    scheduler.request();
    scheduler.cancel();
    advance(100);
    expect(publishes).toEqual([]);
    expect(pendingTimers()).toBe(0);

    scheduler.request();
    advance(1);
    scheduler.cancel();
    advance(100);
    expect(publishes).toEqual([]);

    scheduler.request();
    advance(20);
    expect(publishes).toHaveLength(1);
  });
});

describe("the store's flush", () => {
  beforeEach(() => {
    server.use(http.get("/api/telemetry/series", () => HttpResponse.json(emptyHistory())));
  });

  it("publishes at most one version per 250 ms under 100 rapid frames", async () => {
    const published = watchVersions();

    for (let frame = 0; frame < 100; frame += 1) {
      dispatchFrame(seriesFrame({ line_pressure: [[frame * 10, 8 + frame / 100]] }));
      await settle(5);
    }
    await settle(FLUSH_INTERVAL_MS * 2);

    expect(published.length).toBeGreaterThanOrEqual(2);
    expect(published.length).toBeLessThanOrEqual(Math.ceil(1_000 / FLUSH_INTERVAL_MS));
    for (let index = 1; index < published.length; index += 1) {
      expect((published[index] ?? 0) - (published[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        FLUSH_INTERVAL_MS,
      );
    }
  });

  it("publishes at most one version per second while the tab is hidden", async () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const published = watchVersions();

    for (let frame = 0; frame < 100; frame += 1) {
      dispatchFrame(seriesFrame({ line_pressure: [[frame * 10, 8]] }));
      await settle(30);
    }
    await settle(HIDDEN_FLUSH_INTERVAL_MS);

    expect(published.length).toBeLessThanOrEqual(Math.ceil(4_000 / HIDDEN_FLUSH_INTERVAL_MS));
    for (let index = 1; index < published.length; index += 1) {
      expect((published[index] ?? 0) - (published[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        HIDDEN_FLUSH_INTERVAL_MS,
      );
    }
  });

  it("publishes the newest point as the recorder's now and the live store's sim clock", async () => {
    const { result } = renderHook(() => ({ now: useRecorderNow(), simNow: useSimNow() }));
    expect(result.current.now).toBeNull();

    act(() => {
      dispatchFrame(
        seriesFrame({
          line_pressure: [
            [0, 8],
            [30, 8.2],
          ],
        }),
      );
    });
    await settle(FLUSH_INTERVAL_MS);

    expect(result.current).toEqual({ now: at(30), simNow: at(30) });
  });
});

describe("history seeds", () => {
  it("asks for the history once when the first data arrives", async () => {
    configureRecorder(CONFIG);

    dispatchFrame(seriesFrame({ line_pressure: [[0, 8]] }));
    dispatchFrame(seriesFrame({ line_pressure: [[10, 8.1]] }));
    await settle();

    expect(seriesRequests).toHaveLength(1);
    const query = seriesRequests[0]?.searchParams;
    expect(query?.get("tags")).toBe(CONFIG.tags.join(","));
    expect(query?.get("to")).toBe(toIsoMs(at(0)));
    expect(query?.get("from")).toBe(toIsoMs(at(0) - SEED_WINDOW_MS));
    expect(query?.get("points")).toBe(String(SEED_POINTS));
  });

  it("re-anchors on a jump marker with exactly one series request at the marker's target", async () => {
    const { result } = renderHook(() => ({ busy: useReanchoring(), now: useRecorderNow() }));
    dispatchFrame(seriesFrame({ line_pressure: [[0, 8]] }));
    await settle(FLUSH_INTERVAL_MS);
    seriesRequests = [];

    act(() => {
      dispatchFrame(frames["overlay.marker"]);
    });
    expect(result.current.busy).toBe(true);
    await settle(FLUSH_INTERVAL_MS);

    expect(seriesRequests).toHaveLength(1);
    const target = frames["overlay.marker"].payload.sim_ts_to;
    expect(seriesRequests[0]?.searchParams.get("to")).toBe(target);
    expect(seriesRequests[0]?.searchParams.has("tags")).toBe(false);
    expect(result.current.busy).toBe(false);
    // The jump emptied the buffer; what the recorder shows now is the seeded history.
    expect(result.current.now).toBe(Date.parse("2020-06-05T09:41:12.000Z"));
  });

  it("reseeds on link.open with exactly one series request ending at the newest point", async () => {
    dispatchFrame(
      seriesFrame({
        line_pressure: [
          [0, 8],
          [20, 8.1],
        ],
      }),
    );
    await settle(FLUSH_INTERVAL_MS);
    seriesRequests = [];

    dispatchFrame({ type: "link.open", wall_ts: "2026-09-19T10:00:05.000Z" });
    await settle();

    expect(seriesRequests).toHaveLength(1);
    expect(seriesRequests[0]?.searchParams.get("to")).toBe(toIsoMs(at(20)));
  });

  it("does nothing on link.open before any data", async () => {
    dispatchFrame({ type: "link.open", wall_ts: "2026-09-19T10:00:05.000Z" });
    await settle();

    expect(seriesRequests).toEqual([]);
  });

  it("seeds up to the paused replay's position on link.open when nothing is buffered", async () => {
    configureRecorder(CONFIG);
    const { result } = renderHook(() => useLaneSeries(PRESSURE, HOUR_MS));
    applyStatusSnapshot({ ...fixtures.status, sim: { ...fixtures.status.sim!, state: "paused" } });

    dispatchFrame({ type: "link.open", wall_ts: "2026-09-19T10:00:05.000Z" });
    await settle(FLUSH_INTERVAL_MS);

    expect(seriesRequests).toHaveLength(1);
    expect(seriesRequests[0]?.searchParams.get("to")).toBe(fixtures.status.sim!.sim_ts);
    expect(result.current.latest).toEqual([8.34, null]);
  });

  it("does nothing on link.open while the replay stands on the dataset's first row", async () => {
    const sim = fixtures.status.sim!;
    applyStatusSnapshot({ ...fixtures.status, sim: { ...sim, sim_ts: sim.dataset.first_ts } });

    dispatchFrame({ type: "link.open", wall_ts: "2026-09-19T10:00:05.000Z" });
    await settle();

    expect(seriesRequests).toEqual([]);
  });

  it("runs a seed asked for while another is in flight after it, discarding a stale answer", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale: ApiTelemetrySeries = {
      ...emptyHistory(),
      series: [
        {
          tag: "oil_temperature",
          kind: "analog",
          unit: "degC",
          points: [["2020-06-05T11:00:00.000Z", 99]],
        },
      ],
    };
    server.use(
      http.get(
        "/api/telemetry/series",
        async () => {
          await gate;
          return HttpResponse.json(stale);
        },
        { once: true },
      ),
    );
    const { result } = renderHook(() => useLaneSeries(OIL, 24 * HOUR_MS));

    dispatchFrame(seriesFrame({ line_pressure: [[0, 8]] }));
    await settle();
    act(() => {
      dispatchFrame(frames["overlay.marker"]);
    });
    await settle();
    expect(seriesRequests).toHaveLength(1);

    release();
    await settle(FLUSH_INTERVAL_MS);

    expect(seriesRequests).toHaveLength(2);
    expect(result.current.latest).toEqual([null]);
  });

  it("keeps drawing the live feed when the seed fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    server.use(http.get("/api/telemetry/series", () => apiError(500, "internal", "boom")));
    const { result } = renderHook(() => ({
      busy: useReanchoring(),
      lane: useLaneSeries(PRESSURE, HOUR_MS),
    }));

    act(() => {
      dispatchFrame(
        seriesFrame({
          line_pressure: [
            [0, 8],
            [10, 8.2],
          ],
        }),
      );
    });
    await settle(FLUSH_INTERVAL_MS);

    expect(warn).toHaveBeenCalledOnce();
    expect(result.current.busy).toBe(false);
    expect(result.current.lane.latest).toEqual([8.2, null]);
  });
});

describe("views", () => {
  beforeEach(() => {
    server.use(http.get("/api/telemetry/series", () => HttpResponse.json(emptyHistory())));
    configureRecorder(CONFIG);
  });

  it("return the same lane object while its slice is unchanged", async () => {
    act(() => {
      dispatchFrame(
        seriesFrame({
          line_pressure: [
            [0, 8],
            [100, 8.5],
          ],
          discharge_pressure: [
            [0, 8.3],
            [100, 8.8],
          ],
          oil_temperature: [[0, 60]],
        }),
      );
    });
    await settle(FLUSH_INTERVAL_MS);
    const { result, rerender } = renderHook(() => ({
      pressure: useLaneSeries(PRESSURE, HOUR_MS),
      oil: useLaneSeries(OIL, HOUR_MS),
    }));
    const pressure = result.current.pressure;
    const oil = result.current.oil;
    expect(pressure.latest).toEqual([8.5, 8.8]);

    // Oil points older than the newest line pressure: the window does not move.
    act(() => {
      dispatchFrame(
        seriesFrame({
          oil_temperature: [
            [50, 61],
            [90, 62],
          ],
        }),
      );
    });
    await settle(FLUSH_INTERVAL_MS);
    rerender();

    expect(result.current.pressure).toBe(pressure);
    expect(result.current.oil).not.toBe(oil);
    expect(result.current.oil.latest).toEqual([62]);
  });

  it("keep the latest values' array when only the window moved", async () => {
    act(() => {
      dispatchFrame(seriesFrame({ line_pressure: [[0, 8]], oil_temperature: [[0, 60]] }));
    });
    await settle(FLUSH_INTERVAL_MS);
    const { result } = renderHook(() => useLaneSeries(OIL, HOUR_MS));
    const before = result.current;

    act(() => {
      dispatchFrame(seriesFrame({ line_pressure: [[60, 8.2]] }));
    });
    await settle(FLUSH_INTERVAL_MS);

    expect(result.current).not.toBe(before);
    expect(result.current.latest).toBe(before.latest);
  });

  it("reduce a long slice to at most 600 points and break it at a real gap", async () => {
    const points: [number, number][] = Array.from({ length: 3_000 }, (_, index) => [
      index * 10 + (index >= 1_500 ? 3_600 : 0),
      8 + Math.sin(index / 20),
    ]);
    for (let start = 0; start < points.length; start += 60) {
      dispatchFrame(seriesFrame({ line_pressure: points.slice(start, start + 60) }));
    }
    await settle(FLUSH_INTERVAL_MS);
    const { result } = renderHook(() => useLaneSeries(PRESSURE, 24 * HOUR_MS));

    const drawn = result.current.points[0] ?? [];
    const breaks = drawn.filter((point) => point.v === null);
    expect(drawn.length - breaks.length).toBeLessThanOrEqual(LANE_POINTS);
    expect(breaks).toHaveLength(1);
  });

  it("compute six axis ticks inside the window, with dates across midnight", async () => {
    act(() => {
      dispatchFrame(seriesFrame({ line_pressure: [[0, 8]] }));
    });
    await settle(FLUSH_INTERVAL_MS);
    const { result } = renderHook(() => ({
      hour: useAxis(HOUR_MS),
      day: useAxis(24 * HOUR_MS),
    }));

    expect(result.current.hour).toEqual({
      from: T0 - HOUR_MS,
      to: T0,
      ticks: Array.from({ length: AXIS_TICKS }, (_, index) => T0 - HOUR_MS + (index + 1) * 600_000),
      withDate: false,
    });
    expect(result.current.day?.ticks).toHaveLength(AXIS_TICKS);
    expect(result.current.day?.withDate).toBe(true);
  });

  it("return empty views before the first point", () => {
    const { result } = renderHook(() => ({
      lane: useLaneSeries(PRESSURE, HOUR_MS),
      strip: useStrip("state", HOUR_MS),
      axis: useAxis(HOUR_MS),
    }));

    expect(result.current).toEqual({ lane: { points: [], latest: [] }, strip: [], axis: null });
  });

  it("clip the state, LPS and alarm rows to the window", async () => {
    act(() => {
      dispatchFrame(
        seriesFrame({
          intake_closed: [
            [0, 0],
            [100, 1],
          ],
          load_valve: [
            [0, 1],
            [101, 0],
          ],
          low_pressure_switch: [
            [0, 0],
            [50, 1],
          ],
          motor_current: [
            [0, 6],
            [102, 3.77],
            [600, 0.04],
          ],
        }),
      );
      dispatchFrame({
        ...frames["alarm.native"],
        payload: { code: "W102", active: true, sim_ts: toIsoMs(at(200)) },
      });
    });
    await settle(FLUSH_INTERVAL_MS);
    const { result } = renderHook(() => ({
      state: useStrip("state", HOUR_MS),
      lps: useStrip("lps", HOUR_MS),
      towers: useStrip("towers", HOUR_MS),
      alarms: useStrip("alarms", HOUR_MS),
    }));

    expect(result.current.state).toEqual([
      [at(0), MACHINE_STATE.loaded],
      [at(100), MACHINE_STATE.unloaded],
      [at(600), MACHINE_STATE.off],
    ]);
    expect(result.current.lps).toEqual([
      [at(0), 0],
      [at(50), 1],
    ]);
    expect(result.current.towers).toEqual([]);
    expect(result.current.alarms).toEqual([[at(200), ["W102"]]]);
  });

  it("read raw telemetry.samples frames too", async () => {
    act(() => {
      dispatchFrame(frames["telemetry.samples"]);
    });
    await settle(FLUSH_INTERVAL_MS);
    const { result } = renderHook(() => useLaneSeries(PRESSURE, HOUR_MS));

    expect(result.current.latest).toEqual([9.67, -0.01]);
  });
});
