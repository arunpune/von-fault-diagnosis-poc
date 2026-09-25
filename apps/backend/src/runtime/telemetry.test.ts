// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The telemetry path of the running service: the queue
// that keeps batches and ticket closes in order, the samples the charts get,
// the wall-time work of the one-second tick, and a shutdown that writes the
// open minute. The pipeline is the real one, over synthetic cycles; the
// database behind ingest is a recorder. The last two tests write through the
// real output sink into the diagnosis tables in memory, foreign keys included,
// to show that a batch whose retrieval or backend failed leaves those tables
// and the pipeline's store in step.

import type { Sample, TelemetrySamples } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { fixedClock } from "../clock.ts";
import { createEpisodeStore } from "../episodes/index.ts";
import type { AggregateRow, NativeAlarmRow, TelemetryRepo } from "../ingest/index.ts";
import { createLogger } from "../log.ts";
import { createCatalogRetriever, createPipeline, createRulesBackend } from "../pipeline/index.ts";
import type { DecisionBackend, Retriever } from "../pipeline/index.ts";
import type { Pipeline, PipelineOutput, PipelineTicket } from "../pipeline/types.ts";
import { FIXTURE_CATALOG } from "../../test/fixtures/catalog/index.ts";
import {
  BASELINE_CYCLE,
  CUT_IN_BAR,
  NORMAL_DECAY_BAR_PER_MIN,
  baseline,
  cycles,
  longLoadedRuns,
  runBatches,
  scenarioBatches,
  type Phase,
} from "../../test/fixtures/synthetic/index.ts";
import {
  confidentBackend,
  fakeDiagnosisDb,
  recordingHub,
  recordingPublisher,
  recordingWatchdog,
  type FakeDiagnosisDb,
} from "./fakes.test-helper.ts";
import { createOutputSink, type OutputSink } from "./sinks.ts";
import { createTelemetryRuntime, freshSamples, type TelemetryRuntime } from "./telemetry.ts";

const UNIT = "cau-7";
const WALL_START = "2026-09-22T08:00:00.000Z";
const logger = createLogger({ logLevel: "silent", unitId: UNIT, version: "test" });

/** `app.telemetry_agg_1m` and `app.native_alarms` as lists. */
function recordingTelemetryRepo(): TelemetryRepo & {
  minutes: AggregateRow[];
  alarms: NativeAlarmRow[];
  prunes: number;
} {
  const store = {
    minutes: [] as AggregateRow[],
    alarms: [] as NativeAlarmRow[],
    prunes: 0,
    upsertMinutes(rows: readonly AggregateRow[]) {
      store.minutes.push(...rows);
      return Promise.resolve(rows.length);
    },
    insertAlarms(rows: readonly NativeAlarmRow[]) {
      store.alarms.push(...rows);
      return Promise.resolve(rows.length);
    },
    prune() {
      store.prunes += 1;
      return Promise.resolve(0);
    },
    readMinutes: () => Promise.resolve([]),
  };
  return store;
}

function sample(seq: number, discontinuity = false): Sample {
  return {
    seq,
    sim_ts: new Date(Date.UTC(2020, 4, 19, 21, 0, seq * 10)).toISOString(),
    flags: { discontinuity, missing: false },
    values: {},
    alarms: [],
  };
}

interface Rig {
  readonly runtime: TelemetryRuntime;
  readonly pipeline: Pipeline;
  readonly hub: ReturnType<typeof recordingHub>;
  readonly watchdog: ReturnType<typeof recordingWatchdog>;
  readonly repo: ReturnType<typeof recordingTelemetryRepo>;
  readonly written: PipelineOutput[][];
  readonly clock: ReturnType<typeof fixedClock>;
}

function rig(decision = createRulesBackend()): Rig {
  const clock = fixedClock(WALL_START);
  const repo = recordingTelemetryRepo();
  const pipeline = createPipeline({
    wall: clock,
    retriever: createCatalogRetriever(FIXTURE_CATALOG),
    decision,
    telemetry: { repo, retentionSimDays: 365 },
  });
  const hub = recordingHub();
  const watchdog = recordingWatchdog();
  const written: PipelineOutput[][] = [];
  const runtime = createTelemetryRuntime({
    pipeline,
    sink: {
      write: (outputs) => {
        written.push([...outputs]);
        return Promise.resolve();
      },
    },
    hub,
    watchdog,
    logger,
  });
  return { runtime, pipeline, hub, watchdog, repo, written, clock };
}

/** A runtime whose sink writes into the diagnosis tables in memory, foreign keys and all. */
interface PersistingRig {
  readonly runtime: TelemetryRuntime;
  readonly pipeline: Pipeline;
  readonly db: FakeDiagnosisDb;
  readonly sink: OutputSink;
}

function persistingRig(ports: {
  retriever?: Retriever;
  decision?: DecisionBackend;
}): PersistingRig {
  const store = createEpisodeStore();
  const pipeline = createPipeline({
    wall: fixedClock(WALL_START),
    retriever: ports.retriever ?? createCatalogRetriever(FIXTURE_CATALOG),
    decision: ports.decision ?? confidentBackend(),
    store,
  });
  const db = fakeDiagnosisDb();
  const hub = recordingHub();
  const sink = createOutputSink({
    repos: db.repos,
    publisher: recordingPublisher(),
    hub,
    store,
    watchdog: recordingWatchdog(),
    logger,
  });
  const runtime = createTelemetryRuntime({
    pipeline,
    sink,
    hub,
    watchdog: recordingWatchdog(),
    logger,
  });
  return { runtime, pipeline, db, sink };
}

/** Feed the long-loaded-runs scenario until the database holds a ticket. */
async function untilTicketed({ runtime, db }: PersistingRig): Promise<void> {
  for (const batch of scenarioBatches(longLoadedRuns(20))) {
    await runtime.onBatch(batch);
    if (db.tickets.size > 0) return;
  }
  throw new Error("the scenario opened no ticket");
}

/**
 * Whether the database holds every episode and ticket the pipeline does, as
 * the pipeline holds them — the counters a skipped event bumps aside, which
 * the next decision on the episode writes.
 */
function mirrored({ pipeline, db }: PersistingRig): void {
  const { episodes, tickets } = pipeline.snapshot();
  for (const episode of episodes) {
    expect(db.episodes.get(episode.episode_id)).toMatchObject({
      status: episode.status,
      decision_count: episode.decision_count,
      ticket_id: episode.ticket_id,
      merged_into: episode.merged_into,
    });
  }
  for (const ticket of tickets) {
    expect(db.tickets.get(ticket.ticket_id)).toMatchObject({
      status: ticket.status,
      latest_decision_id: ticket.latest_decision_id,
      update_count: ticket.update_count,
    });
  }
}

/** The fixture catalog's retriever, failing its `failing`-th call the way a lost pool does. */
function retrieverFailingOn(failing: number): Retriever {
  const catalog = createCatalogRetriever(FIXTURE_CATALOG);
  let calls = 0;
  return {
    retrieve(event) {
      calls += 1;
      if (calls === failing) {
        return Promise.reject(new Error("Connection terminated unexpectedly"));
      }
      return catalog.retrieve(event);
    },
  };
}

/** The confident stub, throwing a plain `TypeError` (a defect, not an outage) on one call. */
function backendFailingOn(failing: number): DecisionBackend {
  const backend = confidentBackend();
  let calls = 0;
  return {
    name: backend.name,
    model: backend.model,
    decide(input, options) {
      calls += 1;
      if (calls === failing) return Promise.reject(new TypeError("the backend has a defect"));
      return backend.decide(input, options);
    },
  };
}

describe("freshSamples", () => {
  it("keeps every sample of a first batch", () => {
    expect(freshSamples([sample(1), sample(2)], undefined).map((s) => s.seq)).toEqual([1, 2]);
  });

  it("drops samples at or before the last accepted seq", () => {
    expect(freshSamples([sample(4), sample(5), sample(6)], 5).map((s) => s.seq)).toEqual([6]);
  });

  it("takes a restart that carries the discontinuity flag, and what follows it", () => {
    const restart = [sample(1, true), sample(2), sample(3)];
    expect(freshSamples(restart, 900).map((s) => s.seq)).toEqual([1, 2, 3]);
  });
});

describe("createTelemetryRuntime", () => {
  it("handles batches in arrival order and feeds the hub each sample once", async () => {
    const { runtime, hub, watchdog, written } = rig();
    const batches: TelemetrySamples[] = scenarioBatches(baseline(1)).slice(0, 3);
    const [first, second, third] = batches as [
      TelemetrySamples,
      TelemetrySamples,
      TelemetrySamples,
    ];

    await Promise.all([
      runtime.onBatch(first),
      runtime.onBatch(second),
      runtime.onBatch(second),
      runtime.onBatch(third),
    ]);

    const expected = [first, second, third].flatMap((batch) => batch.samples.map((s) => s.seq));
    expect(hub.samples.map((s) => s.seq)).toEqual(expected);
    expect(watchdog.notes.sample).toBe(4);
    expect(written).toHaveLength(4);
    expect(runtime.counters()).toMatchObject({ batches: 4, samples: expected.length, queued: 0 });
  });

  it("writes the folded minutes once ingest's five seconds are up, not before", async () => {
    const { runtime, repo, clock, watchdog } = rig();
    for (const batch of scenarioBatches(baseline(1)).slice(0, 3)) await runtime.onBatch(batch);

    await runtime.tick();
    expect(watchdog.notes.tick).toBe(1);
    expect(repo.minutes).toEqual([]);

    clock.advance(5_000);
    await runtime.tick();
    expect(repo.minutes.length).toBeGreaterThan(0);
    expect(new Set(repo.minutes.map((row) => row.unit_id))).toEqual(new Set([UNIT]));
  });

  it("runs the retention every ten wall minutes", async () => {
    const { runtime, repo, clock } = rig();
    for (const batch of scenarioBatches(baseline(1)).slice(0, 2)) await runtime.onBatch(batch);

    await runtime.tick();
    expect(repo.prunes).toBe(0);
    clock.advance(600_000);
    await runtime.tick();
    expect(repo.prunes).toBe(1);
  });

  it("writes the open minute on stop and refuses what arrives after it", async () => {
    const { runtime, repo, hub } = rig();
    const [first, second] = scenarioBatches(baseline(1)) as [TelemetrySamples, TelemetrySamples];
    await runtime.onBatch(first);

    await runtime.stop();
    const lastMinute = repo.minutes.at(-1)?.minute_sim_ts;
    const lastSample = first.samples.at(-1)?.sim_ts ?? "";
    expect(lastMinute?.slice(0, 16)).toBe(lastSample.slice(0, 16));

    await runtime.onBatch(second);
    expect(runtime.counters().refused).toBe(1);
    expect(hub.samples).toHaveLength(first.samples.length);
  });

  it("queues a ticket close behind the telemetry and resolves with the closed ticket", async () => {
    const { runtime, written } = rig(confidentBackend());
    const batches = scenarioBatches(longLoadedRuns(20));
    let opened: PipelineTicket | undefined;
    for (const batch of batches) {
      await runtime.onBatch(batch);
      opened = written.flat().find((output): output is PipelineTicket => output.type === "ticket");
      if (opened !== undefined) break;
    }
    if (opened === undefined) throw new Error("the scenario opened no ticket");

    const closed = await runtime.closeTicket(opened.ticket.ticket_id, { verdict: "correct" });

    expect(closed).toMatchObject({
      ticket_id: opened.ticket.ticket_id,
      action: "closed",
      status: "closed",
      closure: { verdict: "correct" },
    });
    expect(written.at(-1)).toEqual([expect.objectContaining({ type: "ticket" })]);
  });

  it("counts a batch the pipeline rejects and keeps going", async () => {
    const { runtime } = rig();
    const [good] = scenarioBatches(baseline(1)) as [TelemetrySamples];
    const broken = { ...good, samples: [] } as unknown as TelemetrySamples;

    await runtime.onBatch(broken);
    await runtime.onBatch(good);

    expect(runtime.counters()).toMatchObject({ failed: 1, batches: 1 });
  });

  it("writes the failed decision of a batch whose retrieval failed, and its episode with it", async () => {
    const rig = persistingRig({ retriever: retrieverFailingOn(1) });
    await untilTicketed(rig);

    expect(rig.runtime.counters()).toMatchObject({ failed: 0 });
    expect(rig.sink.failures()).toEqual({ persist: 0, publish: 0 });
    const failed = [...rig.db.decisions.values()].filter(
      (decision) => decision.status === "failed",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toMatchObject({ kind: "unknown" });
    // The episode the failed decision was taken on is saved, and nothing was
    // aborted by a jump the telemetry never made.
    expect(rig.db.episodes.get(failed[0]?.episode_id ?? "")).toMatchObject({ status: "open" });
    expect([...rig.db.episodes.values()].map((episode) => episode.status)).not.toContain("aborted");
    mirrored(rig);
  });

  it("writes an episode that waits for persistence without a decision, then its decision and ticket", async () => {
    const rig = persistingRig({});
    /** A loaded run of `loadedS` seconds with the purge side up, and the rest after it. */
    const drainSide = (loadedS: number): Phase[] => [
      { mode: "loaded", seconds: loadedS, fromBar: CUT_IN_BAR, toBar: 9.2, purgeBar: 1 },
      { mode: "unloaded", seconds: 400, fromBar: 9.2, decayBarPerMin: NORMAL_DECAY_BAR_PER_MIN },
      { mode: "off", seconds: 600, fromBar: 8.74, decayBarPerMin: NORMAL_DECAY_BAR_PER_MIN },
    ];
    // A one-minute blip, then — once its episode has closed — eight minutes of the same.
    const batches = runBatches([
      ...cycles(BASELINE_CYCLE, 2),
      ...drainSide(120),
      ...cycles(BASELINE_CYCLE, 5),
      ...drainSide(480),
      ...cycles(BASELINE_CYCLE, 1),
    ]);

    const blipEnd = batches.findIndex((batch) =>
      batch.samples.some((sample) => sample.sim_ts === "2020-02-03T01:40:00.000Z"),
    );
    for (const batch of batches.slice(0, blipEnd)) await rig.runtime.onBatch(batch);
    // The blip: its event and its episode are written, no decision and no ticket.
    expect(rig.db.events.size).toBe(1);
    expect([...rig.db.episodes.values()]).toEqual([
      expect.objectContaining({ status: "open", decision_count: 0, ticket_id: null }),
    ]);
    expect(rig.db.decisions.size).toBe(0);
    expect(rig.db.tickets.size).toBe(0);
    expect(rig.db.ledger).toEqual([]);

    for (const batch of batches.slice(blipEnd)) await rig.runtime.onBatch(batch);
    expect(rig.sink.failures()).toEqual({ persist: 0, publish: 0 });
    const episodes = [...rig.db.episodes.values()];
    expect(episodes.map((episode) => episode.decision_count)).toEqual([0, 1]);
    expect(rig.db.decisions.size).toBe(1);
    const [ticket] = [...rig.db.tickets.values()];
    expect(ticket).toMatchObject({ status: "open", episode_id: episodes[1]?.episode_id });
    const [decision] = [...rig.db.decisions.values()];
    expect(decision?.gate).toMatchObject({ outcome: "ticket", persist_sim_min: 1 });
    mirrored(rig);
  });

  it("keeps the database and the pipeline in step across a batch the pipeline rejects", async () => {
    const rig = persistingRig({ decision: backendFailingOn(1) });
    await untilTicketed(rig);

    expect(rig.runtime.counters()).toMatchObject({ failed: 1 });
    // No row was refused: every episode written starts on an event that was written.
    expect(rig.sink.failures()).toEqual({ persist: 0, publish: 0 });
    for (const episode of rig.db.episodes.values()) {
      expect(rig.db.events.has(episode.first_event_id)).toBe(true);
    }
    mirrored(rig);
  });
});
