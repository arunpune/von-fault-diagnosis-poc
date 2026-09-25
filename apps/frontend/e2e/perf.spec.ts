// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The recorder's chart budget as a test: the fake backend streams 360 samples a second for 20 s
// of wall time, the 3600×-equivalent load, into the recorder's 6 h window while the pointer
// moves over a lane, so the synced tooltips redraw too. After a 2 s warm-up the page must show
//
//   * no long task over 100 ms, and a total blocking time under 500 ms (the part of each long
//     task beyond 50 ms, summed), from a `longtask` PerformanceObserver installed before the
//     app's first script;
//   * a recorder that lags the fake's clock (`GET /api/status`) by less than 1 s of wall time:
//     the stream plays 3,600 simulated seconds per wall second, so 1 s is an hour of data;
//   * fewer than 6,000 DOM nodes under the recorder (no unbounded SVG growth).
//
// Every wall-clock bound is multiplied by FDP_TIMING_SLACK. The metrics always go to
// reports/frontend-perf.json at the repository root. With PERF_REPORT_ONLY=1 (CI) a budget
// overrun is only reported: the job reads the file and applies its own loose ceiling.
// Locally (`make e2e-perf`, or `e2e:mock`) the budget is strict.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { Locator, Page } from "@playwright/test";

import { expect, test, timingSlack } from "./helpers.ts";

import type { ApiStatus } from "@/api/types";
import { tid } from "@/lib/testids";

const STREAM = { samplesPerS: 360, seconds: 20 } as const;
/** Each sample is ten simulated seconds, so the stream plays this many simulated ms per wall ms. */
const SIM_MS_PER_WALL_MS = STREAM.samplesPerS * 10;
const WARM_UP_MS = 2_000;
/** Wall time between two measurements of the lag and the DOM size. */
const SAMPLE_EVERY_MS = 1_000;
/** Time for the last long-task entries to reach the observer after the stream ends. */
const OBSERVER_SETTLE_MS = 500;
/** The part of a long task that counts as blocking starts after 50 ms (the TBT definition). */
const BLOCKING_AFTER_MS = 50;
/** Where along the lane the pointer rests at each measurement, as a fraction of its width. */
const HOVER_FRACTIONS = [0.25, 0.5, 0.75, 0.95, 0.6, 0.35] as const;

/** The chart budget; the three wall-clock bounds are widened by FDP_TIMING_SLACK. */
const BUDGET = {
  longTaskMs: 100 * timingSlack(),
  totalBlockingTimeMs: 500 * timingSlack(),
  lagMs: 1_000 * timingSlack(),
  recorderDomNodes: 6_000,
} as const;

const REPORT_ONLY = process.env.PERF_REPORT_ONLY === "1";
const REPORT_PATH = fileURLToPath(new URL("../../../reports/frontend-perf.json", import.meta.url));

interface LongTask {
  /** When the task started: `performance.now()` in the page, then ms from the stream's start. */
  readonly start: number;
  readonly duration: number;
}

declare global {
  interface Window {
    /** Filled by `observeLongTasks` from the page's first script on. */
    fdpLongTasks?: LongTask[];
  }
}

/** Runs in the page before any of its scripts (page.addInitScript). */
function observeLongTasks(): void {
  const tasks: LongTask[] = [];
  window.fdpLongTasks = tasks;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      tasks.push({ start: entry.startTime, duration: entry.duration });
    }
  }).observe({ type: "longtask", buffered: true });
}

interface StreamSamples {
  /** Recorder lag behind the fake's clock, in wall ms, one per measurement after warm-up. */
  readonly lagsMs: number[];
  readonly domNodes: number[];
  /** True once a lane other than the hovered one showed its synced tooltip. */
  tooltipSynced: boolean;
}

/** How far the recorder's newest point trails the fake's clock, in wall ms; null before data. */
async function lagMs(page: Page, recorder: Locator): Promise<number | null> {
  const [response, simNow] = await Promise.all([
    page.request.get("/api/status"),
    recorder.getAttribute("data-sim-now"),
  ]);
  const clock = Date.parse(((await response.json()) as ApiStatus).sim?.sim_ts ?? "");
  if (simNow === null || !Number.isFinite(clock)) {
    return null;
  }
  return Math.max(clock - Number(simNow), 0) / SIM_MS_PER_WALL_MS;
}

/**
 * Moves the pointer along the hovered lane once a second until the stream ends and, after the
 * warm-up, measures the lag, the recorder's DOM size and whether the tooltips are synced.
 */
async function sampleStream(page: Page, startedAt: number): Promise<StreamSamples> {
  const recorder = page.getByTestId(tid.recorder.root);
  const hovered = page.getByTestId(tid.recorder.lane("TP3"));
  const synced = page.getByTestId(tid.recorder.lane("Motor_current"));
  await expect(hovered).toBeVisible();
  const box = await hovered.boundingBox();
  if (box === null) {
    throw new Error("the pressure lane has no layout box to hover");
  }
  const samples: StreamSamples = { lagsMs: [], domNodes: [], tooltipSynced: false };

  for (let index = 0; ; index += 1) {
    const now = await page.evaluate(() => performance.now());
    if (now >= startedAt + STREAM.seconds * 1_000) {
      return samples;
    }
    const fraction = HOVER_FRACTIONS[index % HOVER_FRACTIONS.length] ?? 0.5;
    // The chart sits under the lane's readouts; aim at its middle.
    await page.mouse.move(box.x + box.width * fraction, box.y + box.height - 40);
    if (now >= startedAt + WARM_UP_MS) {
      const lag = await lagMs(page, recorder);
      if (lag !== null) {
        samples.lagsMs.push(lag);
      }
      samples.domNodes.push(await recorder.evaluate((root) => root.querySelectorAll("*").length));
      // The tooltip names the time under the pointer ("… UTC"); the readouts never do.
      samples.tooltipSynced ||= ((await synced.textContent()) ?? "").includes(" UTC");
    }
    await sleep(SAMPLE_EVERY_MS);
  }
}

interface PerfReport {
  readonly measured_at: string;
  readonly report_only: boolean;
  readonly timing_slack: number;
  readonly stream: { samples_per_s: number; seconds: number; warm_up_ms: number; window: string };
  readonly budget: {
    long_task_ms: number;
    total_blocking_time_ms: number;
    lag_ms: number;
    recorder_dom_nodes: number;
  };
  readonly measured: {
    long_tasks: number;
    longest_long_task_ms: number;
    total_blocking_time_ms: number;
    max_lag_ms: number | null;
    lag_samples: number;
    max_recorder_dom_nodes: number | null;
    tooltip_synced: boolean;
    /** Every long task after the warm-up: its start from the stream's start, and its length. */
    long_task_list: { at_ms: number; duration_ms: number }[];
  };
  readonly violations: string[];
  readonly within_budget: boolean;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `tasks` start from the stream's start (`start` 0 is the stream request). */
function buildReport(tasks: readonly LongTask[], samples: StreamSamples): PerfReport {
  const durations = tasks.map((task) => task.duration);
  const longest = Math.max(0, ...durations);
  const blocking = durations.reduce((sum, ms) => sum + Math.max(ms - BLOCKING_AFTER_MS, 0), 0);
  const maxLag = samples.lagsMs.length === 0 ? null : Math.max(...samples.lagsMs);
  const maxNodes = samples.domNodes.length === 0 ? null : Math.max(...samples.domNodes);

  const violations: string[] = [];
  const overBudget = durations.filter((ms) => ms > BUDGET.longTaskMs);
  if (overBudget.length > 0) {
    violations.push(
      `${overBudget.length} long task(s) over ${BUDGET.longTaskMs} ms, the longest ${round(longest)} ms`,
    );
  }
  if (blocking >= BUDGET.totalBlockingTimeMs) {
    violations.push(
      `total blocking time ${round(blocking)} ms, budget ${BUDGET.totalBlockingTimeMs} ms`,
    );
  }
  if (maxLag === null) {
    violations.push("the recorder never showed a point to measure its lag against");
  } else if (maxLag >= BUDGET.lagMs) {
    violations.push(`the recorder lagged ${round(maxLag)} ms behind, budget ${BUDGET.lagMs} ms`);
  }
  if (maxNodes === null || maxNodes >= BUDGET.recorderDomNodes) {
    violations.push(`${maxNodes ?? "no"} recorder DOM nodes, budget ${BUDGET.recorderDomNodes}`);
  }
  if (!samples.tooltipSynced) {
    violations.push("hovering the pressure lane never showed the synced tooltip on another lane");
  }

  return {
    measured_at: new Date().toISOString(),
    report_only: REPORT_ONLY,
    timing_slack: timingSlack(),
    stream: {
      samples_per_s: STREAM.samplesPerS,
      seconds: STREAM.seconds,
      warm_up_ms: WARM_UP_MS,
      window: "6 h",
    },
    budget: {
      long_task_ms: BUDGET.longTaskMs,
      total_blocking_time_ms: BUDGET.totalBlockingTimeMs,
      lag_ms: BUDGET.lagMs,
      recorder_dom_nodes: BUDGET.recorderDomNodes,
    },
    measured: {
      long_tasks: tasks.length,
      longest_long_task_ms: round(longest),
      total_blocking_time_ms: round(blocking),
      max_lag_ms: maxLag === null ? null : round(maxLag),
      lag_samples: samples.lagsMs.length,
      max_recorder_dom_nodes: maxNodes,
      tooltip_synced: samples.tooltipSynced,
      long_task_list: tasks.map((task) => ({
        at_ms: round(task.start),
        duration_ms: round(task.duration),
      })),
    },
    violations,
    within_budget: violations.length === 0,
  };
}

test("a 360 samples/s stream stays within the chart budget", async ({
  page,
  fakeBackend,
}, testInfo) => {
  test.skip(fakeBackend === null, "the stream is driven through the fake's control API");
  await fakeBackend?.reset();
  await page.addInitScript(observeLongTasks);
  await page.goto("/");
  await expect(page.getByTestId(tid.status.link)).toHaveAttribute("data-lamp", "ok");
  const sixHours = page.getByRole("radio", { name: "Last 6 hours" });
  await sixHours.click();
  await expect(sixHours).toBeChecked();

  const startedAt = await page.evaluate(() => performance.now());
  await fakeBackend?.stream(STREAM.samplesPerS, STREAM.seconds);
  const samples = await sampleStream(page, startedAt);
  await sleep(OBSERVER_SETTLE_MS);
  const tasks = (await page.evaluate(() => window.fdpLongTasks ?? []))
    .map((task) => ({ start: task.start - startedAt, duration: task.duration }))
    .filter((task) => task.start >= WARM_UP_MS && task.start <= STREAM.seconds * 1_000);

  const report = buildReport(tasks, samples);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, body);
  await testInfo.attach("frontend-perf.json", { body, contentType: "application/json" });

  if (REPORT_ONLY) {
    for (const violation of report.violations) {
      testInfo.annotations.push({ type: "perf budget (report only)", description: violation });
    }
    return;
  }
  expect(report.violations, `the chart budget; the metrics are in ${REPORT_PATH}`).toEqual([]);
});
