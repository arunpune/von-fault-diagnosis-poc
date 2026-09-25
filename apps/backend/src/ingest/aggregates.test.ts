// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one-minute fold: when a minute closes, what it carries, and when the
 * closed rows leave.
 *
 * Wall time is the only clock the batching policy reads, and it comes from
 * `fixedClock`, so "five seconds have passed" is a line in the test rather
 * than a wait.
 */

import { describe, expect, it } from "vitest";

import { fixedClock } from "../clock.ts";
import {
  AGGREGATE_FLUSH_ROWS,
  MINUTE_MS,
  createAggregator,
  type Aggregator,
} from "./aggregates.ts";
import { decodedSample, START_MS, STEP_MS, TEST_SIGNALS } from "./fixture.test-helper.ts";
import type { AggregateRow } from "./types.ts";

const WALL_START = "2026-09-21T08:00:00.000Z";

function aggregatorOf(clock = fixedClock(WALL_START)): {
  aggregator: Aggregator;
  clock: ReturnType<typeof fixedClock>;
} {
  return {
    aggregator: createAggregator({ unitId: "cau-7", signals: TEST_SIGNALS, wall: clock }),
    clock,
  };
}

/** The rows of one signal, in the order they were closed. */
function rowsOf(rows: readonly AggregateRow[], tag: string): AggregateRow[] {
  return rows.filter((row) => row.signal_id === tag);
}

describe("createAggregator minute close", () => {
  it("closes a minute when a sample of the next one arrives", () => {
    const { aggregator } = aggregatorOf();
    for (let index = 0; index < 6; index += 1) {
      aggregator.push(decodedSample(index, { values: { line_pressure: 8 + index } }));
    }
    expect(aggregator.pending()).toBe(0);

    aggregator.push(decodedSample(6, { values: { line_pressure: 20 } }));
    const [row] = rowsOf(aggregator.take(), "line_pressure");
    expect(row).toMatchObject({
      unit_id: "cau-7",
      minute_sim_ts: "2020-02-03T00:00:00.000Z",
      signal_id: "line_pressure",
      n: 6,
      min: 8,
      max: 13,
      last: 13,
      duty: null,
      discontinuity: false,
    });
    expect(row?.avg).toBeCloseTo(10.5, 10);
  });

  it("leaves the minute still being folded open until asked to close it", () => {
    const { aggregator } = aggregatorOf();
    for (let index = 0; index < 3; index += 1) aggregator.push(decodedSample(index));
    expect(aggregator.take()).toEqual([]);

    aggregator.closeOpen();
    expect(rowsOf(aggregator.take(), "line_pressure")).toHaveLength(1);
  });

  it("closing twice writes the minute once", () => {
    const { aggregator } = aggregatorOf();
    aggregator.push(decodedSample(0));
    aggregator.closeOpen();
    aggregator.closeOpen();
    expect(rowsOf(aggregator.take(), "line_pressure")).toHaveLength(1);
  });

  it("folds one row per signal the samples carried", () => {
    const { aggregator } = aggregatorOf();
    aggregator.push(decodedSample(0));
    aggregator.closeOpen();
    expect(
      aggregator
        .take()
        .map((row) => row.signal_id)
        .sort(),
    ).toEqual(["dryer_purge_pressure", "line_pressure", "load_valve"]);
  });

  it("gives a digital signal its duty cycle and an analog signal none", () => {
    const { aggregator } = aggregatorOf();
    for (let index = 0; index < 4; index += 1) {
      aggregator.push(decodedSample(index, { values: { load_valve: index < 3 ? 1 : 0 } }));
    }
    aggregator.closeOpen();
    const rows = aggregator.take();
    expect(rowsOf(rows, "load_valve")[0]).toMatchObject({ n: 4, min: 0, max: 1, last: 0 });
    expect(rowsOf(rows, "load_valve")[0]?.duty).toBeCloseTo(0.75, 10);
    expect(rowsOf(rows, "line_pressure")[0]?.duty).toBeNull();
  });

  it("counts one row per minute over a long run", () => {
    const { aggregator } = aggregatorOf();
    // Six minutes of ten-second samples, and the last minute closed by hand.
    for (let index = 0; index < 36; index += 1) aggregator.push(decodedSample(index));
    aggregator.closeOpen();
    expect(rowsOf(aggregator.take(), "line_pressure")).toHaveLength(6);
  });
});

describe("createAggregator discontinuity", () => {
  it("flags the minute a discontinuity fell into", () => {
    const { aggregator } = aggregatorOf();
    aggregator.push(decodedSample(0));
    aggregator.push(decodedSample(1, { discontinuity: true }));
    aggregator.closeOpen();
    expect(rowsOf(aggregator.take(), "line_pressure")[0]?.discontinuity).toBe(true);
  });

  it("closes the minute before the jump and flags only the one after it", () => {
    const { aggregator } = aggregatorOf();
    aggregator.push(decodedSample(0));
    aggregator.push(decodedSample(1, { simTsMs: START_MS + 3 * MINUTE_MS, discontinuity: true }));
    aggregator.closeOpen();

    const rows = rowsOf(aggregator.take(), "line_pressure");
    expect(rows.map((row) => [row.minute_sim_ts, row.discontinuity])).toEqual([
      ["2020-02-03T00:00:00.000Z", false],
      ["2020-02-03T00:03:00.000Z", true],
    ]);
  });

  it("folds a jump backwards into its own minute", () => {
    const { aggregator } = aggregatorOf();
    aggregator.push(decodedSample(0));
    aggregator.push(decodedSample(1, { simTsMs: START_MS - MINUTE_MS, discontinuity: true }));
    aggregator.closeOpen();
    expect(rowsOf(aggregator.take(), "line_pressure").map((row) => row.minute_sim_ts)).toEqual([
      "2020-02-03T00:00:00.000Z",
      "2020-02-02T23:59:00.000Z",
    ]);
  });
});

describe("createAggregator batching policy", () => {
  it("is not due while nothing is closed", () => {
    const { aggregator, clock } = aggregatorOf();
    aggregator.push(decodedSample(0));
    clock.advance(60_000);
    expect(aggregator.due()).toBe(false);
  });

  it("is due once five wall seconds have passed with a closed row waiting", () => {
    const { aggregator, clock } = aggregatorOf();
    aggregator.push(decodedSample(0));
    aggregator.closeOpen();
    expect(aggregator.due()).toBe(false);

    clock.advance(4_999);
    expect(aggregator.due()).toBe(false);
    clock.advance(1);
    expect(aggregator.due()).toBe(true);
  });

  it("is due at five hundred rows whatever the clock says", () => {
    const { aggregator } = aggregatorOf();
    // Three signals per minute, so one hundred and sixty-seven minutes is five
    // hundred and one rows.
    for (let minute = 0; minute <= 167; minute += 1) {
      aggregator.push(decodedSample(0, { simTsMs: START_MS + minute * MINUTE_MS }));
    }
    expect(aggregator.pending()).toBeGreaterThanOrEqual(AGGREGATE_FLUSH_ROWS);
    expect(aggregator.due()).toBe(true);
  });

  it("restarts the five seconds when the rows are taken", () => {
    const { aggregator, clock } = aggregatorOf();
    aggregator.push(decodedSample(0));
    aggregator.closeOpen();
    clock.advance(6_000);
    expect(aggregator.take()).not.toEqual([]);

    aggregator.push(decodedSample(6, { simTsMs: START_MS + MINUTE_MS }));
    aggregator.closeOpen();
    expect(aggregator.due()).toBe(false);
    clock.advance(5_000);
    expect(aggregator.due()).toBe(true);
  });

  it("hands each row over exactly once", () => {
    const { aggregator } = aggregatorOf();
    aggregator.push(decodedSample(0));
    aggregator.closeOpen();
    expect(aggregator.take()).toHaveLength(3);
    expect(aggregator.take()).toEqual([]);
  });
});

describe("createAggregator latest data time", () => {
  it("is undefined before the first sample and the newest sample afterwards", () => {
    const { aggregator } = aggregatorOf();
    expect(aggregator.latestSimTs()).toBeUndefined();
    aggregator.push(decodedSample(0));
    aggregator.push(decodedSample(1));
    expect(aggregator.latestSimTs()).toBe("2020-02-03T00:00:10.000Z");
  });

  it("does not move backwards when data time does", () => {
    const { aggregator } = aggregatorOf();
    aggregator.push(decodedSample(5));
    aggregator.push(decodedSample(0, { simTsMs: START_MS - STEP_MS, discontinuity: true }));
    expect(aggregator.latestSimTs()).toBe("2020-02-03T00:00:50.000Z");
  });
});
