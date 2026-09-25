// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ComponentProps } from "react";
import type * as Recharts from "recharts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiTelemetrySeries } from "@/api/types";
import { dispatchFrame } from "@/api/ws-dispatch";
import type { FrameOf } from "@/api/ws-types";
import RecorderPanel from "@/features/recorder/RecorderPanel";
import { tid } from "@/lib/testids";
import { toIsoMs } from "@/lib/time";
import { resetLiveStore } from "@/store/live-store";
import { FLUSH_INTERVAL_MS, resetTelemetryStore } from "@/store/telemetry-store";
import { getUiPrefs, reloadUiPrefs } from "@/store/ui-prefs";
import { fixtures, frames } from "@/test/msw/fixtures";
import { server } from "@/test/msw/server";
import { renderWithProviders } from "@/test/render";

// Every lane chart counts its renders by chart id, so a test can tell which lanes redrew.
const chartRenders = vi.hoisted(() => new Map<string, number>());

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof Recharts>();
  const { createElement } = await import("react");
  function CountingLineChart(props: ComponentProps<typeof actual.LineChart>) {
    const id = String(props.id);
    chartRenders.set(id, (chartRenders.get(id) ?? 0) + 1);
    return createElement(actual.LineChart, props);
  }
  return { ...actual, LineChart: CountingLineChart };
});

// Noon on 5 Jun 2020: inside dataset failure F3 (from 10:00) and injection inj-7f3a-1 (08–18 h).
const T0 = Date.parse("2020-06-05T12:00:00.000Z");
const LANE_IDS = ["TP3", "H1", "Oil_temperature", "Motor_current"] as const;

function at(seconds: number): number {
  return T0 + seconds * 1_000;
}

type Points = Record<string, [number, number | null][]>;

function seriesFrame(points: Points): FrameOf<"telemetry.series"> {
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
      last: {},
      discontinuity: false,
    },
  };
}

/** One loaded sample of every charted tag at `seconds`. */
function everyTag(seconds: number, pressure = 9.11): Points {
  return {
    line_pressure: [[seconds, pressure]],
    discharge_pressure: [[seconds, pressure + 0.32]],
    separator_discharge_pressure: [[seconds, -0.01]],
    dryer_purge_pressure: [[seconds, 2.05]],
    oil_temperature: [[seconds, 76.1]],
    ambient_temperature: [[seconds, 21.4]],
    motor_current: [[seconds, 5.61]],
    intake_closed: [[seconds, 0]],
    load_valve: [[seconds, 1]],
    low_pressure_switch: [[seconds, 0]],
    dryer_tower: [[seconds, 1]],
  };
}

function emptyHistory(): ApiTelemetrySeries {
  return {
    unit_id: "cau-7",
    from: toIsoMs(T0 - 86_400_000),
    to: toIsoMs(T0),
    source: "ring",
    series: [],
    discontinuities: [],
  };
}

/** Lets fetches answer and the next flush (timer, then animation frame) run. */
async function flush(ms = FLUSH_INTERVAL_MS + 20): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

function stream(points: Points): void {
  act(() => {
    dispatchFrame(seriesFrame(points));
  });
}

// fireEvent rather than user-event: user-event's own timers do not advance under the fake
// clock these tests need for the flush scheduler.
function renderPanel() {
  return renderWithProviders(<RecorderPanel />);
}

beforeAll(async () => {
  // The charts are a chunk of their own that the panel fetches when it mounts; loading the
  // module here keeps that real-time import from racing the fake clock below.
  await import("@/features/recorder/RecorderCharts");
});

beforeEach(() => {
  window.localStorage.clear();
  reloadUiPrefs();
  chartRenders.clear();
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
    ],
  });
  // jsdom lays nothing out; give every chart container a size so Recharts draws.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 84 }),
  );
  server.use(http.get("/api/telemetry/series", () => HttpResponse.json(emptyHistory())));
});

afterEach(() => {
  resetTelemetryStore();
  resetLiveStore();
  vi.useRealTimers();
});

describe("RecorderPanel", () => {
  it("asks to press Play until the first point arrives", async () => {
    renderPanel();
    await flush();

    const root = screen.getByTestId(tid.recorder.root);
    expect(within(root).getByTestId(tid.recorder.empty)).toHaveTextContent(
      "Press Play to start the replay.",
    );
    expect(root).not.toHaveAttribute("data-sim-now");
    expect(screen.queryByTestId(tid.recorder.lane("TP3"))).not.toBeInTheDocument();
  });

  it("draws the lanes, rows, controls and legend once data arrives", async () => {
    renderPanel();
    await flush();

    stream(everyTag(0));
    await flush();

    expect(screen.queryByTestId(tid.recorder.empty)).not.toBeInTheDocument();
    for (const id of [...LANE_IDS, "state", "LPS", "Towers", "alarms"]) {
      expect(screen.getByTestId(tid.recorder.lane(id))).toBeInTheDocument();
    }
    expect(
      within(screen.getByTestId(tid.recorder.lane("TP3"))).getByText("Line pressure", {
        selector: "span",
      }),
    ).toBeInTheDocument();
    const window = screen.getByTestId(tid.recorder.window);
    expect(
      within(window)
        .getAllByRole("radio")
        .map((item) => item.textContent),
    ).toEqual(["1 h", "6 h", "24 h"]);
    expect(within(window).getByRole("radio", { name: "Last 6 hours" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Reference windows" })).toBeChecked();
    expect(
      within(screen.getByRole("list", { name: "Reference windows" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Dataset failure", "Excluded", "Injected fault", "Jump"]);
    expect(screen.getByTestId(tid.recorder.root)).toHaveAttribute("data-sim-now", String(at(0)));
    expect(document.querySelectorAll("pattern")).toHaveLength(2);
  });

  it("makes its scrolling body a tab stop named after the panel", async () => {
    renderPanel();
    await flush();
    stream(everyTag(0));
    await flush();

    const body = screen.getByRole("group", { name: "Recorder" });
    expect(body).toHaveAttribute("tabindex", "0");
    expect(body).toContainElement(screen.getByTestId(tid.recorder.lane("TP3")));
  });

  it("updates the readouts and data-sim-now at the next flush, not per frame", async () => {
    renderPanel();
    await flush();
    stream(everyTag(0, 9.11));
    await flush();
    const pressure = within(screen.getByTestId(tid.recorder.lane("TP3")));
    expect(pressure.getByText("9.11")).toBeInTheDocument();

    stream(everyTag(10, 9.2));
    stream(everyTag(20, 9.34));
    expect(pressure.getByText("9.11")).toBeInTheDocument();

    await flush();
    expect(pressure.getByText("9.34")).toBeInTheDocument();
    expect(pressure.getByText("9.66")).toBeInTheDocument();
    expect(screen.getByTestId(tid.recorder.root)).toHaveAttribute("data-sim-now", String(at(20)));
  });

  it("shows and hides the reference-window bands with the switch, remembering the choice", async () => {
    renderPanel();
    await flush();
    stream(everyTag(0));
    await flush();

    expect(screen.getByTestId(tid.recorder.band("F3"))).toBeInTheDocument();
    expect(screen.getByTestId(tid.recorder.band("inj-7f3a-1"))).toBeInTheDocument();
    // The fixture's jump landed at 06:00, the first instant of the 6 h window.
    const marker = screen.getByTestId(tid.recorder.marker("jump-2020-06-05T06:00:00.000Z"));
    expect(marker).toHaveTextContent("Jump to 2020-06-05 06:00:00");

    fireEvent.click(screen.getByRole("switch", { name: "Reference windows" }));
    await flush();
    expect(screen.queryByTestId(tid.recorder.band("F3"))).not.toBeInTheDocument();
    expect(marker).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Reference windows" })).not.toBeInTheDocument();
    expect(getUiPrefs().overlays).toBe(false);

    fireEvent.click(screen.getByRole("switch", { name: "Reference windows" }));
    await flush();
    expect(screen.getByTestId(tid.recorder.band("F3"))).toBeInTheDocument();
  });

  it("switches and remembers the time window", async () => {
    renderPanel();
    await flush();
    stream(everyTag(0));
    await flush();

    fireEvent.click(screen.getByRole("radio", { name: "Last hour" }));
    await flush();

    expect(screen.getByRole("radio", { name: "Last hour" })).toBeChecked();
    expect(getUiPrefs().windowMs).toBe(3_600_000);
    // Noon minus one hour starts after 10:00, so F3 now covers the whole window.
    expect(screen.getByTestId(tid.recorder.band("F3"))).toBeInTheDocument();
  });

  it("says Re-anchoring… while a jump's history is on its way", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderPanel();
    await flush();
    stream(everyTag(0));
    await flush();
    server.use(
      http.get("/api/telemetry/series", async () => {
        await gate;
        return HttpResponse.json(emptyHistory());
      }),
    );

    act(() => {
      dispatchFrame(frames["overlay.marker"]);
    });
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Re-anchoring…");

    release();
    await flush();
    expect(screen.queryByText("Re-anchoring…")).not.toBeInTheDocument();
  });

  it("names the lanes the signal map cannot resolve and leaves them out", async () => {
    const signals = fixtures.signals.signals.filter(
      (signal) => !["H1", "Towers"].includes(signal.metropt_column ?? ""),
    );
    server.use(http.get("/api/signals", () => HttpResponse.json({ signals })));
    renderPanel();
    await flush();
    stream(everyTag(0));
    await flush();

    expect(
      screen.getByText("Not available in this signal map: Separator and purge, Dryer towers."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId(tid.recorder.lane("H1"))).not.toBeInTheDocument();
    expect(screen.queryByTestId(tid.recorder.lane("Towers"))).not.toBeInTheDocument();
    expect(screen.getByTestId(tid.recorder.lane("TP3"))).toBeInTheDocument();
  });

  it("draws the machine state, LPS and alarm rows as titled segments", async () => {
    renderPanel();
    await flush();
    stream({
      ...everyTag(0),
      intake_closed: [
        [0, 0],
        [120, 1],
      ],
      load_valve: [
        [0, 1],
        [121, 0],
      ],
      motor_current: [
        [0, 6.0],
        [122, 3.77],
        [600, 0.04],
      ],
      low_pressure_switch: [
        [0, 0],
        [300, 1],
      ],
      line_pressure: [
        [0, 9.1],
        [900, 8.4],
      ],
    });
    act(() => {
      dispatchFrame({
        ...frames["alarm.native"],
        payload: { code: "W102", active: true, sim_ts: toIsoMs(at(700)) },
      });
    });
    await flush();

    const titles = (id: string): string[] =>
      Array.from(
        screen.getByTestId(tid.recorder.lane(id)).querySelectorAll("rect > title"),
        (title) => title.textContent,
      );
    expect(titles("state")).toEqual([
      "Loaded, 12:00–12:02",
      "Unloaded, 12:02–12:10",
      "Off, 12:10–12:15",
    ]);
    expect(titles("LPS")).toEqual(["Low-pressure switch on, 12:05–12:15"]);
    expect(titles("Towers")).toEqual(["Tower 1, 12:00–12:15"]);
    expect(titles("alarms")).toEqual(["W102, 12:11–12:15"]);
  });

  it("reads every series of a lane at the hovered time in its tooltip", async () => {
    renderPanel();
    await flush();
    stream({
      ...everyTag(0, 9.0),
      line_pressure: [
        [0, 9.0],
        [600, 9.5],
        [1_200, 10.0],
      ],
      discharge_pressure: [
        [0, 9.32],
        [1_200, 10.32],
      ],
    });
    await flush();

    const wrapper = screen
      .getByTestId(tid.recorder.lane("TP3"))
      .querySelector<HTMLElement>(".recharts-wrapper");
    if (wrapper === null) {
      throw new Error("the line-pressure lane draws a chart");
    }
    fireEvent.mouseMove(wrapper, { clientX: 790, clientY: 40 });
    await flush();

    const tooltip = within(wrapper);
    expect(tooltip.getByText("2020-06-05 12:20:00 UTC")).toBeInTheDocument();
    expect(tooltip.getByText("10.00 bar")).toBeInTheDocument();
    expect(tooltip.getByText("10.32 bar")).toBeInTheDocument();
  });

  it("offers a retry when the signal map cannot be loaded", async () => {
    server.use(
      http.get("/api/signals", () =>
        HttpResponse.json({ error: { code: "internal", message: "boom" } }, { status: 500 }),
      ),
    );
    renderPanel();
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the signal map.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("redraws only the lane whose slice changed", async () => {
    renderPanel();
    await flush();
    stream({
      ...everyTag(0),
      line_pressure: [
        [0, 9.1],
        [600, 9.3],
      ],
    });
    await flush();
    const before = new Map(chartRenders);
    expect([...before.keys()].sort()).toEqual(
      LANE_IDS.map((id) => `recorder-lane-chart-${id}`).sort(),
    );

    // Oil points older than the newest line pressure: the shared window does not move.
    for (const seconds of [100, 200, 300, 400]) {
      stream({ oil_temperature: [[seconds, 77 + seconds / 100]] });
      await flush();
    }

    const redraws = (id: string): number =>
      (chartRenders.get(`recorder-lane-chart-${id}`) ?? 0) -
      (before.get(`recorder-lane-chart-${id}`) ?? 0);
    expect(redraws("Oil_temperature")).toBeGreaterThanOrEqual(1);
    expect(redraws("TP3")).toBe(0);
    expect(redraws("H1")).toBe(0);
    expect(redraws("Motor_current")).toBe(0);
    expect(
      within(screen.getByTestId(tid.recorder.lane("Oil_temperature"))).getByText("81.0"),
    ).toBeInTheDocument();
  });
});
