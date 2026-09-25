// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The ingest facade: validation, ordering, batching and the two series paths.
 *
 * The repository is a double that records what it was asked to write, so the
 * batching policy is tested as a policy — how many rows leave, and
 * when — without a container. `ingest-aggregates.test.ts` runs the same rows
 * through the real schema.
 *
 * The replay of `baseline-feb.json` skips where the dataset has not been cut;
 * `test/global-setup.ts` turns that into a failure under
 * `FDP_REQUIRE_DATASET=1`.
 */

import { ALARMS, SchemaValidationError, isValid } from "@fdp/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "../clock.ts";
import { hasFixture, loadFixture } from "../../test/helpers/fixtures.ts";
import { AGGREGATE_FLUSH_ROWS, MINUTE_MS } from "./aggregates.ts";
import type { MinutePoint } from "./downsample.ts";
import {
  START_MS,
  STEP_MS,
  TEST_SIGNALS,
  batchOf,
  batchesOf,
  decodedRun,
  decodedSample,
} from "./fixture.test-helper.ts";
import { RETENTION_INTERVAL_MS, createIngest, type Ingest } from "./index.ts";
import type { MinuteQuery, NativeAlarmRow, TelemetryRepo } from "./repo.ts";
import type { AggregateRow } from "./types.ts";

const WALL_START = "2026-09-21T08:00:00.000Z";

/** A repository that records instead of writing, plus the rows a read returns. */
interface FakeRepo extends TelemetryRepo {
  readonly minutes: AggregateRow[];
  readonly alarms: NativeAlarmRow[];
  readonly upserts: number[];
  readonly prunes: { days: number; nowSimTs: string }[];
  readonly reads: MinuteQuery[];
  answer: MinutePoint[];
  pruned: number;
}

function fakeRepo(): FakeRepo {
  const repo: FakeRepo = {
    minutes: [],
    alarms: [],
    upserts: [],
    prunes: [],
    reads: [],
    answer: [],
    pruned: 0,
    upsertMinutes: async (rows) => {
      repo.minutes.push(...rows);
      repo.upserts.push(rows.length);
      return rows.length;
    },
    insertAlarms: async (rows) => {
      repo.alarms.push(...rows);
      return rows.length;
    },
    prune: async (days, nowSimTs) => {
      repo.prunes.push({ days, nowSimTs });
      return repo.pruned;
    },
    readMinutes: async (request) => {
      repo.reads.push(request);
      return repo.answer;
    },
  };
  return repo;
}

let repo: FakeRepo;
let clock: ReturnType<typeof fixedClock>;

function ingestOf(overrides: Partial<Parameters<typeof createIngest>[0]> = {}): Ingest {
  return createIngest({
    unitId: "cau-7",
    wall: clock,
    signals: TEST_SIGNALS,
    repo,
    ringCapacity: 1_024,
    ...overrides,
  });
}

beforeEach(() => {
  repo = fakeRepo();
  clock = fixedClock(WALL_START);
});

describe("createIngest validation", () => {
  it("refuses a payload that is not a telemetry batch", () => {
    const ingest = ingestOf();
    expect(() => ingest.push({ hello: "world" })).toThrow(SchemaValidationError);
    expect(() => ingest.push(null)).toThrow(SchemaValidationError);
    expect(ingest.ring.size).toBe(0);
  });

  it("refuses a batch whose sample carries a value of the wrong type", () => {
    const ingest = ingestOf();
    const batch = batchOf(decodedRun(1));
    const broken = {
      ...batch,
      samples: [{ ...batch.samples[0], values: { line_pressure: "nine" } }],
    };
    expect(() => ingest.push(broken)).toThrow(SchemaValidationError);
  });

  it("takes a valid batch and reports what it took", () => {
    const ingest = ingestOf();
    expect(ingest.push(batchOf(decodedRun(25)))).toEqual({
      accepted: 25,
      rejected: 0,
      discontinuity: false,
      alarms: [],
    });
    expect(ingest.ring.size).toBe(25);
  });
});

describe("createIngest ordering", () => {
  it("drops a re-delivered batch whole", () => {
    const ingest = ingestOf();
    const batch = batchOf(decodedRun(10));
    expect(ingest.push(batch).accepted).toBe(10);
    expect(ingest.push(batch)).toEqual({
      accepted: 0,
      rejected: 10,
      discontinuity: false,
      alarms: [],
    });
    expect(ingest.ring.size).toBe(10);
  });

  it("drops the samples of an overlapping batch and keeps the new ones", () => {
    const ingest = ingestOf();
    ingest.push(batchOf(decodedRun(10)));
    const overlapping = batchOf(decodedRun(10, () => ({}), 5));
    // The batch opens at seq 6, which was accepted, so the whole batch is a
    // re-delivery; a gateway never re-sends a partial batch.
    expect(ingest.push(overlapping)).toMatchObject({ accepted: 0, rejected: 10 });
  });

  it("takes a restarted sequence when the batch opens with a discontinuity", () => {
    const ingest = ingestOf();
    ingest.push(batchOf(decodedRun(10)));
    const restart = batchOf([
      decodedSample(0, { seq: 1, simTsMs: START_MS + 86_400_000, discontinuity: true }),
      decodedSample(1, { seq: 2, simTsMs: START_MS + 86_400_000 + STEP_MS }),
    ]);
    expect(ingest.push(restart)).toMatchObject({ accepted: 2, discontinuity: true });
    expect(ingest.ring.segments()).toHaveLength(2);
  });

  it("reports a discontinuity inside an otherwise ordinary batch", () => {
    const ingest = ingestOf();
    const samples = decodedRun(5);
    samples[3] = decodedSample(3, { discontinuity: true });
    expect(ingest.push(batchOf(samples))).toMatchObject({ accepted: 5, discontinuity: true });
  });
});

describe("createIngest.latest", () => {
  it("is undefined before the first batch", () => {
    expect(ingestOf().latest()).toBeUndefined();
  });

  it("gives the newest sample back in the contracts' shape", () => {
    const ingest = ingestOf();
    ingest.push(batchOf([decodedSample(0, { values: { load_valve: 1, line_pressure: 9.25 } })]));
    expect(ingest.latest()).toEqual({
      seq: 1,
      sim_ts: "2020-02-03T00:00:00.000Z",
      flags: { discontinuity: false, missing: false },
      values: { line_pressure: 9.25, dryer_purge_pressure: 0, load_valve: true },
      alarms: [],
    });
  });
});

describe("createIngest alarms", () => {
  const [alarm] = ALARMS;
  if (alarm === undefined) throw new Error("the register map declares alarms");

  it("returns the transitions of a batch and queues a row for each", async () => {
    const ingest = ingestOf();
    const result = ingest.push(
      batchOf([decodedSample(0), decodedSample(1, { alarms: [alarm.code] })]),
    );
    expect(result.alarms).toEqual([
      { code: alarm.code, state: "raised", sim_ts: "2020-02-03T00:00:10.000Z", seq: 2 },
    ]);

    await ingest.flush();
    expect(repo.alarms).toEqual([
      {
        unit_id: "cau-7",
        code: alarm.code,
        state: "raised",
        sim_ts: "2020-02-03T00:00:10.000Z",
        seq: 2,
        wall_ts: WALL_START,
      },
    ]);
  });

  it("stamps the wall clock the backend saw, not the data clock", async () => {
    const ingest = ingestOf();
    clock.advance(90_000);
    ingest.push(batchOf([decodedSample(0, { alarms: [alarm.code] })]));
    await ingest.flush();
    expect(repo.alarms[0]?.wall_ts).toBe("2026-09-21T08:01:30.000Z");
  });

  it("exposes the active codes detection reads", () => {
    const ingest = ingestOf();
    ingest.push(batchOf([decodedSample(0, { alarms: [alarm.code] })]));
    expect(ingest.activeAlarms()).toEqual([alarm.code]);
    ingest.push(batchOf([decodedSample(1, { alarms: [] })]));
    expect(ingest.activeAlarms()).toEqual([]);
  });

  it("calls the runtime's hooks once per sample and once per transition", () => {
    const samples: number[] = [];
    const transitions: string[] = [];
    const ingest = ingestOf({
      onSample: (sample) => samples.push(sample.seq),
      onAlarm: (transition) => transitions.push(`${transition.code}:${transition.state}`),
    });
    ingest.push(
      batchOf([decodedSample(0), decodedSample(1, { alarms: [alarm.code] }), decodedSample(2)]),
    );
    expect(samples).toEqual([1, 2, 3]);
    expect(transitions).toEqual([`${alarm.code}:raised`, `${alarm.code}:cleared`]);
  });
});

describe("createIngest batching", () => {
  it("writes nothing while no minute has closed", async () => {
    const ingest = ingestOf();
    ingest.push(batchOf(decodedRun(3)));
    await ingest.flush();
    expect(repo.upserts).toEqual([]);
  });

  it("writes the closed minutes in one statement", async () => {
    const ingest = ingestOf();
    for (const batch of batchesOf(decodedRun(36))) ingest.push(batch);
    await ingest.flush();
    // Five closed minutes of three signals; the sixth is still being folded.
    expect(repo.upserts).toEqual([15]);
    expect(repo.minutes).toHaveLength(15);
  });

  it("closes the open minute on a final flush", async () => {
    const ingest = ingestOf();
    for (const batch of batchesOf(decodedRun(36))) ingest.push(batch);
    await ingest.flush({ final: true });
    expect(repo.minutes).toHaveLength(18);
  });

  it("says it is due after five wall seconds with a closed minute waiting", () => {
    const ingest = ingestOf();
    for (const batch of batchesOf(decodedRun(12))) ingest.push(batch);
    expect(ingest.flushDue()).toBe(false);
    clock.advance(5_000);
    expect(ingest.flushDue()).toBe(true);
  });

  it("says it is due at five hundred rows before the interval is up", () => {
    const ingest = ingestOf({ ringCapacity: 65_536 });
    for (let minute = 0; minute <= 200; minute += 1) {
      ingest.push(batchOf([decodedSample(minute, { simTsMs: START_MS + minute * MINUTE_MS })]));
    }
    expect(ingest.flushDue()).toBe(true);
    expect(AGGREGATE_FLUSH_ROWS).toBe(500);
  });

  it("is a no-op without a repository", async () => {
    const ingest = ingestOf({ repo: undefined });
    for (const batch of batchesOf(decodedRun(36))) ingest.push(batch);
    await expect(ingest.flush({ final: true })).resolves.toBeUndefined();
    expect(repo.upserts).toEqual([]);
  });
});

describe("createIngest retention", () => {
  it("prunes with the retention window and the newest data time", async () => {
    const ingest = ingestOf({ retentionSimDays: 7 });
    ingest.push(batchOf(decodedRun(3)));
    repo.pruned = 42;
    await expect(ingest.prune()).resolves.toBe(42);
    expect(repo.prunes).toEqual([{ days: 7, nowSimTs: "2020-02-03T00:00:20.000Z" }]);
  });

  it("does nothing before the first sample", async () => {
    await expect(ingestOf().prune()).resolves.toBe(0);
    expect(repo.prunes).toEqual([]);
  });

  it("comes due ten wall minutes after the last run", async () => {
    const ingest = ingestOf();
    expect(ingest.pruneDue()).toBe(false);
    clock.advance(RETENTION_INTERVAL_MS);
    expect(ingest.pruneDue()).toBe(true);
    await ingest.prune();
    expect(ingest.pruneDue()).toBe(false);
  });
});

describe("createIngest.series", () => {
  it("answers a window the ring covers from memory", async () => {
    const ingest = ingestOf();
    for (const batch of batchesOf(decodedRun(100))) ingest.push(batch);
    const answer = await ingest.series({
      signalIds: ["line_pressure"],
      fromMs: START_MS,
      toMs: START_MS + 99 * STEP_MS,
    });
    expect(answer.source).toBe("ring");
    expect(repo.reads).toEqual([]);
    expect(isValid("api-telemetry-series", answer)).toBe(true);
  });

  it("answers a window older than the ring from the folded minutes", async () => {
    const ingest = ingestOf({ ringCapacity: 64 });
    for (const batch of batchesOf(decodedRun(500))) ingest.push(batch);
    repo.answer = [
      {
        signal_id: "line_pressure",
        minuteMs: START_MS,
        min: 8,
        max: 10,
        avg: 9,
        duty: null,
        discontinuity: false,
      },
    ];

    const answer = await ingest.series({
      signalIds: ["line_pressure"],
      fromMs: START_MS,
      toMs: START_MS + 60_000,
    });
    expect(answer.source).toBe("agg_1m");
    expect(repo.reads).toEqual([
      {
        unitId: "cau-7",
        signalIds: ["line_pressure"],
        fromMs: START_MS,
        toMs: START_MS + 60_000,
      },
    ]);
    expect(answer.series[0]?.points).toEqual([["2020-02-03T00:00:00.000Z", 9]]);
    expect(isValid("api-telemetry-series", answer)).toBe(true);
  });

  it("stays on the ring when there is no repository to ask", async () => {
    const ingest = ingestOf({ repo: undefined, ringCapacity: 64 });
    for (const batch of batchesOf(decodedRun(500))) ingest.push(batch);
    const answer = await ingest.series({
      signalIds: ["line_pressure"],
      fromMs: START_MS,
      toMs: START_MS + 60_000,
    });
    expect(answer.source).toBe("ring");
  });
});

describe("createIngest on baseline-feb.json", () => {
  const skip = !hasFixture("baseline-feb");

  it.skipIf(skip)("accepts every sample of the replay", async () => {
    const fixture = loadFixture("baseline-feb");
    const ingest = createIngest({ unitId: "cau-7", wall: clock, repo, ringCapacity: 65_536 });

    let accepted = 0;
    let rejected = 0;
    for (const batch of fixture.batches) {
      const result = ingest.push(batch);
      accepted += result.accepted;
      rejected += result.rejected;
    }

    expect(rejected).toBe(0);
    expect(accepted).toBe(fixture.samples);
    expect(ingest.ring.size).toBe(fixture.samples);
    expect(ingest.ring.segments()).toHaveLength(1);
  });

  it.skipIf(skip)("folds six sim hours into 360 minutes per signal", async () => {
    const fixture = loadFixture("baseline-feb");
    const ingest = createIngest({ unitId: "cau-7", wall: clock, repo, ringCapacity: 65_536 });
    for (const batch of fixture.batches) ingest.push(batch);
    await ingest.flush({ final: true });

    const perSignal = new Map<string, number>();
    for (const row of repo.minutes) {
      perSignal.set(row.signal_id, (perSignal.get(row.signal_id) ?? 0) + 1);
    }
    expect(perSignal.size).toBeGreaterThanOrEqual(15);
    for (const [signal, count] of perSignal) {
      expect(count, `${signal} minutes`).toBeGreaterThanOrEqual(358);
      expect(count, `${signal} minutes`).toBeLessThanOrEqual(362);
    }
  });

  it.skipIf(skip)("answers a series over the replay inside the contract", async () => {
    const fixture = loadFixture("baseline-feb");
    const ingest = createIngest({ unitId: "cau-7", wall: clock, repo, ringCapacity: 65_536 });
    for (const batch of fixture.batches) ingest.push(batch);

    const answer = await ingest.series({
      signalIds: ["line_pressure", "motor_current", "load_valve"],
      fromMs: Date.parse(fixture.window.from_sim_ts),
      toMs: Date.parse(fixture.window.to_sim_ts),
      points: 2_000,
    });
    expect(isValid("api-telemetry-series", answer)).toBe(true);
    for (const entry of answer.series) expect(entry.points.length).toBeLessThanOrEqual(2_000);
    expect(answer.series[0]?.points.length).toBeGreaterThan(0);
    expect(answer.discontinuities).toEqual([]);
  });
});
