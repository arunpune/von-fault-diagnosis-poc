// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ingest against the real schema.
 *
 * The unit tests prove the fold; this one proves the four statements of
 * `repo.ts` against `app.telemetry_agg_1m`, `app.native_alarms` and
 * `app.prune_telemetry_agg` as the migrations ship them, run by the credential the
 * backend actually uses. Everything here happens as `app_rw`: a grant that is
 * missing is a failure of this test, not something the container's owner role
 * would paper over.
 *
 * Six sim hours of `baseline-feb.json` go in and 360 folded minutes per signal
 * come out. The expected values of one minute are computed from the fixture
 * rows inside the test, so the assertion checks the fold rather than repeating
 * it.
 *
 * The fixture is not committed: without it the suite skips, and
 * `test/global-setup.ts` turns that into a failure under
 * `FDP_REQUIRE_DATASET=1`.
 */

import { startPostgres, type PgTestStack } from "@fdp/db-migrate/testing";
import { toIsoMs, type TelemetrySamples } from "@fdp/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/clock.ts";
import { createPool, query, type Pool } from "../../src/db/pool.ts";
import { MINUTE_MS } from "../../src/ingest/aggregates.ts";
import { createIngest, createTelemetryRepo, type TelemetryRepo } from "../../src/ingest/index.ts";
import { hasFixture, loadFixture, type TelemetryFixture } from "../helpers/fixtures.ts";

/** The unit the replay is written for. */
const UNIT = "cau-7";

/** A second unit, so the alarm rows cannot disturb the minute counts. */
const ALARM_UNIT = "cau-9";

/** The wall clock every row is stamped with; no test here waits for a second. */
const WALL = "2026-09-21T08:00:00.000Z";

/** The minute whose numbers are checked against the fixture rows. */
const KNOWN_MINUTE_MS = Date.parse("2020-02-03T01:00:00.000Z");

/** The tag those numbers are checked for. */
const KNOWN_TAG = "line_pressure";

const skip = !hasFixture("baseline-feb");

let pg: PgTestStack;
let pool: Pool;
let repo: TelemetryRepo;
let fixture: TelemetryFixture;

beforeAll(async () => {
  if (skip) return;
  fixture = loadFixture("baseline-feb");
  pg = await startPostgres({ migrate: true });
  pool = createPool(pg.urlFor("app_rw"), { applicationName: "fdp-backend-ingest" });
  repo = createTelemetryRepo(pool);

  const ingest = createIngest({
    unitId: UNIT,
    wall: fixedClock(WALL),
    repo,
    ringCapacity: 65_536,
  });
  for (const batch of fixture.batches) {
    const result = ingest.push(batch);
    expect(result.rejected).toBe(0);
  }
  await ingest.flush({ final: true });
});

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await pg?.stop();
});

describe.skipIf(skip)("replaying baseline-feb.json into app.telemetry_agg_1m", () => {
  it("writes 360 ± 2 minutes for every analog signal", async () => {
    const rows = await query<{ signal_id: string; minutes: string }>(
      pool,
      "SELECT signal_id, count(*)::text AS minutes FROM app.telemetry_agg_1m " +
        "WHERE unit_id = $1 GROUP BY signal_id ORDER BY signal_id",
      [UNIT],
    );

    // Seven analog tags, eight digital ones and the synthetic ambient tag.
    expect(rows).toHaveLength(16);
    for (const row of rows) {
      expect(Number(row.minutes), `${row.signal_id} minutes`).toBeGreaterThanOrEqual(358);
      expect(Number(row.minutes), `${row.signal_id} minutes`).toBeLessThanOrEqual(362);
    }
  });

  it("gives an analog signal no duty cycle and a digital one a fraction", async () => {
    const rows = await query<{ signal_id: string; duty: number | null }>(
      pool,
      "SELECT signal_id, duty FROM app.telemetry_agg_1m " +
        "WHERE unit_id = $1 AND minute_sim_ts = $2 AND signal_id = ANY($3::text[])",
      [UNIT, toIsoMs(new Date(KNOWN_MINUTE_MS)), ["line_pressure", "load_valve"]],
    );
    const byTag = new Map(rows.map((row) => [row.signal_id, row.duty] as const));
    expect(byTag.get("line_pressure")).toBeNull();
    expect(byTag.get("load_valve")).not.toBeNull();
    expect(byTag.get("load_valve")).toBeGreaterThanOrEqual(0);
    expect(byTag.get("load_valve")).toBeLessThanOrEqual(1);
  });

  it("folds one known minute exactly as the fixture rows do", async () => {
    const expected = foldFixtureMinute(fixture, KNOWN_MINUTE_MS, KNOWN_TAG);
    expect(expected.n).toBeGreaterThan(0);

    const rows = await query<{
      n: number;
      min: number;
      max: number;
      avg: number;
      last: number;
      discontinuity: boolean;
    }>(
      pool,
      "SELECT n, min, max, avg, last, discontinuity FROM app.telemetry_agg_1m " +
        "WHERE unit_id = $1 AND minute_sim_ts = $2 AND signal_id = $3",
      [UNIT, toIsoMs(new Date(KNOWN_MINUTE_MS)), KNOWN_TAG],
    );

    const [row] = rows;
    expect(row).toBeDefined();
    expect(row?.n).toBe(expected.n);
    expect(row?.min).toBeCloseTo(expected.min, 5);
    expect(row?.max).toBeCloseTo(expected.max, 5);
    expect(row?.avg).toBeCloseTo(expected.avg, 5);
    expect(row?.last).toBeCloseTo(expected.last, 5);
    expect(row?.discontinuity).toBe(false);
  });
});

describe.skipIf(skip)("app.native_alarms", () => {
  it("stores a raise and the clear that follows it, with seq", async () => {
    const ingest = createIngest({
      unitId: ALARM_UNIT,
      wall: fixedClock(WALL),
      repo,
      ringCapacity: 64,
    });
    const first = fixture.batches[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    ingest.push(withAlarms(first, 1, ["W101"]));
    ingest.push(withAlarms(first, 26, []));
    await ingest.flush({ final: true });

    const rows = await query<{ code: string; state: string; seq: string; sim_ts: Date }>(
      pool,
      "SELECT code, state, seq::text AS seq, sim_ts FROM app.native_alarms " +
        "WHERE unit_id = $1 ORDER BY id",
      [ALARM_UNIT],
    );
    expect(rows.map((row) => [row.code, row.state])).toEqual([
      ["W101", "raised"],
      ["W101", "cleared"],
    ]);
    expect(rows.map((row) => Number(row.seq))).toEqual([1, 26]);
    expect(rows[0]?.sim_ts.toISOString()).toBe(first.samples[0].sim_ts);
  });
});

describe.skipIf(skip)("the aggregate read path", () => {
  it("answers a window older than the ring from the folded minutes", async () => {
    // A ring of 64 samples holds about ten minutes; the first hour of the
    // replay is long gone from it and has to come out of the table.
    const ingest = createIngest({ unitId: UNIT, wall: fixedClock(WALL), repo, ringCapacity: 64 });
    for (const batch of fixture.batches) ingest.push(batch);

    const fromMs = Date.parse(fixture.window.from_sim_ts);
    const answer = await ingest.series({
      signalIds: [KNOWN_TAG, "load_valve"],
      fromMs,
      toMs: fromMs + 30 * MINUTE_MS,
      points: 2_000,
    });

    expect(answer.source).toBe("agg_1m");
    expect(answer.unit_id).toBe(UNIT);
    const [analog, digital] = answer.series;
    expect(analog?.points.length).toBeGreaterThan(25);
    expect(analog?.points.length).toBeLessThanOrEqual(2_000);
    expect(digital?.kind).toBe("digital");
    for (const [, value] of digital?.points ?? []) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe.skipIf(skip)("app.prune_telemetry_agg", () => {
  it("removes the minutes older than the retention window and nothing else", async () => {
    const latestMs = Date.parse(fixture.window.to_sim_ts);
    // The function takes whole days, so the cut-off is moved by moving "now":
    // one day of retention, three hours into the future, keeps the last three
    // hours of the replay.
    const nowSimTs = toIsoMs(new Date(latestMs + 86_400_000 - 3 * 3_600_000));
    const cutOffMs = latestMs - 3 * 3_600_000;

    // Retention is a property of the table, not of one unit: the function
    // names no unit, so the counts here are the whole table's.
    const before = await minuteCount();
    const removed = await repo.prune(1, nowSimTs);
    const after = await minuteCount();

    expect(removed).toBeGreaterThan(0);
    expect(after).toBe(before - removed);

    const oldest = await query<{ oldest: Date | null }>(
      pool,
      "SELECT min(minute_sim_ts) AS oldest FROM app.telemetry_agg_1m WHERE unit_id = $1",
      [UNIT],
    );
    expect(oldest[0]?.oldest?.getTime() ?? 0).toBeGreaterThanOrEqual(cutOffMs);
  });

  it("removes nothing when the retention window covers everything", async () => {
    const before = await minuteCount();
    await expect(repo.prune(365, toIsoMs(new Date(fixture.window.to_sim_ts)))).resolves.toBe(0);
    expect(await minuteCount()).toBe(before);
  });
});

/** How many folded minutes the table holds, for one unit or for all of them. */
async function minuteCount(unitId?: string): Promise<number> {
  const rows = await query<{ minutes: string }>(
    pool,
    "SELECT count(*)::text AS minutes FROM app.telemetry_agg_1m WHERE $1::text IS NULL " +
      "OR unit_id = $1",
    [unitId ?? null],
  );
  return Number(rows[0]?.minutes ?? 0);
}

/** The same minute, folded straight out of the fixture, as the assertion's truth. */
function foldFixtureMinute(
  source: TelemetryFixture,
  minuteMs: number,
  tag: string,
): { n: number; min: number; max: number; avg: number; last: number } {
  const values: number[] = [];
  for (const batch of source.batches) {
    for (const sample of batch.samples) {
      const ms = Date.parse(sample.sim_ts);
      if (ms < minuteMs || ms >= minuteMs + MINUTE_MS) continue;
      const value = sample.values[tag];
      if (typeof value === "number") values.push(value);
    }
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    n: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: sum / values.length,
    last: values[values.length - 1] ?? Number.NaN,
  };
}

/** One batch with a single sample, re-sequenced, carrying the given alarm codes. */
function withAlarms(batch: TelemetrySamples, seq: number, alarms: string[]): TelemetrySamples {
  const [sample] = batch.samples;
  return {
    ...batch,
    samples: [{ ...sample, seq, sim_ts: sample.sim_ts, alarms }],
  };
}
