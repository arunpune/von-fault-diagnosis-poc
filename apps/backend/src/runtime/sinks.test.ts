// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The two sinks of the runtime over in-memory tables that keep PostgreSQL's
// foreign keys. The outputs are real: a pipeline
// over the fixture catalog and a synthetic long-loaded-runs scenario, with a
// backend confident enough to open a ticket. The same path runs against the
// real schema in test/integration/e2e-ticket.test.ts.

import { ALARMS, validate, type AlertSystem, type TelemetrySamples } from "@fdp/contracts";
import { fixturesFor } from "@fdp/contracts/testing";
import { beforeAll, describe, expect, it } from "vitest";

import { fixedClock } from "../clock.ts";
import { createEpisodeStore, type EpisodeStore } from "../episodes/index.ts";
import type { HeartbeatRow } from "../heartbeat/index.ts";
import { createLogger } from "../log.ts";
import { createCatalogRetriever, createPipeline } from "../pipeline/index.ts";
import type { Pipeline, PipelineOutput, PipelineTicket } from "../pipeline/types.ts";
import { FIXTURE_CATALOG } from "../../test/fixtures/catalog/index.ts";
import {
  BASELINE_CYCLE,
  CUT_IN_BAR,
  NORMAL_DECAY_BAR_PER_MIN,
  cycles,
  longLoadedRuns,
  runRows,
  scenarioBatches,
} from "../../test/fixtures/synthetic/index.ts";
import { toBatches } from "../../test/fixtures/telemetry/rows.ts";
import {
  confidentBackend,
  fakeDiagnosisDb,
  recordingHub,
  recordingPublisher,
  recordingWatchdog,
  type FakeDiagnosisDb,
  type RecordingHub,
  type RecordingPublisher,
  type RecordingWatchdog,
} from "./fakes.test-helper.ts";
import { createOutputSink, createWatchdogSink, type OutputSink } from "./sinks.ts";

const UNIT = "cau-7";
const logger = createLogger({ logLevel: "silent", unitId: UNIT, version: "test" });

/** Jev's price list, so the ledger rows carry the configured prices. */
const PRICES = {
  price_input_per_mtok: 0.042,
  price_output_per_mtok: 0,
  prices_as_of: "2026-09-19",
};

interface Harness {
  readonly db: FakeDiagnosisDb;
  readonly hub: RecordingHub;
  readonly publisher: RecordingPublisher;
  readonly watchdog: RecordingWatchdog;
  readonly sink: OutputSink;
  readonly changes: { count: number };
}

function harness(store: EpisodeStore): Harness {
  const db = fakeDiagnosisDb();
  const hub = recordingHub();
  const publisher = recordingPublisher();
  const watchdog = recordingWatchdog();
  const changes = { count: 0 };
  const sink = createOutputSink({
    repos: db.repos,
    publisher,
    hub,
    store,
    watchdog,
    logger,
    onChange: () => {
      changes.count += 1;
    },
  });
  return { db, hub, publisher, watchdog, sink, changes };
}

/** Every push of the scenario up to and including the one that opened a ticket. */
interface Run {
  readonly store: EpisodeStore;
  readonly pipeline: Pipeline;
  readonly pushes: readonly PipelineOutput[][];
}

async function ticketedRun(): Promise<Run> {
  const store = createEpisodeStore();
  const pipeline = createPipeline({
    wall: fixedClock("2026-09-22T08:00:00.000Z"),
    retriever: createCatalogRetriever(FIXTURE_CATALOG),
    decision: confidentBackend(),
    store,
    prices: PRICES,
  });
  const pushes: PipelineOutput[][] = [];
  const batches: TelemetrySamples[] = scenarioBatches(longLoadedRuns(20));
  for (const batch of batches) {
    const outputs = await pipeline.push(batch);
    if (outputs.length > 0) pushes.push(outputs);
    if (outputs.some((output) => output.type === "ticket")) return { store, pipeline, pushes };
  }
  throw new Error("the scenario opened no ticket");
}

function all(run: Run): PipelineOutput[] {
  return run.pushes.flat();
}

async function writeAll(sink: OutputSink, pushes: readonly PipelineOutput[][]): Promise<void> {
  for (const outputs of pushes) await sink.write(outputs);
}

/** Let the publications the sink did not await settle. */
function flushPublications(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

let run: Run;

beforeAll(async () => {
  run = await ticketedRun();
});

describe("the output sink", () => {
  it("writes every row after the rows it references", async () => {
    const { db, sink } = harness(run.store);
    await writeAll(sink, run.pushes);

    expect(sink.failures()).toEqual({ persist: 0, publish: 0 });
    const outputs = all(run);
    const suspects = outputs.filter((output) => output.type === "suspect");
    const decisions = outputs.filter((output) => output.type === "decision");
    expect(db.events.size).toBe(suspects.length);
    expect(db.decisions.size).toBe(decisions.length);
    expect(db.tickets.size).toBe(1);
    for (const { decision } of decisions) {
      expect(db.candidates.get(decision.decision_id)).toHaveLength(decision.candidates.length);
    }
  });

  it("links each suspect event to the episode its decision belongs to", async () => {
    const { db, sink } = harness(run.store);
    await writeAll(sink, run.pushes);

    for (const output of all(run)) {
      if (output.type !== "decision") continue;
      expect(db.events.get(output.decision.event_id)?.episodeId).toBe(output.decision.episode_id);
    }
  });

  it("links the opening event of an episode that was never decided, even once it has ended", async () => {
    // A one-frame drain-side blip opens an episode that waits for persistence, and a
    // replay jump aborts it. At a replay speed where one batch carries both, one push
    // holds suspect → episode opened → episode aborted: no decision names the event's
    // episode, and by the time the push is written the store holds it open no more.
    const store = createEpisodeStore();
    const pipeline = createPipeline({
      wall: fixedClock("2026-09-23T08:00:00.000Z"),
      retriever: createCatalogRetriever(FIXTURE_CATALOG),
      decision: confidentBackend(),
      store,
      prices: PRICES,
    });
    const before = runRows(
      [
        ...cycles(BASELINE_CYCLE, 2),
        { mode: "loaded", seconds: 120, fromBar: CUT_IN_BAR, toBar: 9.2, purgeBar: 1 },
        { mode: "unloaded", seconds: 60, fromBar: 9.2, decayBarPerMin: NORMAL_DECAY_BAR_PER_MIN },
      ],
      { startSimTs: "2020-02-03T00:00:00.000Z" },
    );
    const after = runRows(
      [{ mode: "off", seconds: 300, fromBar: 8.74, decayBarPerMin: NORMAL_DECAY_BAR_PER_MIN }],
      { startSimTs: "2020-02-03T04:00:00.000Z" },
    );
    const batches = toBatches([...before, ...after], {
      unitId: UNIT,
      wallStartMs: Date.parse("2026-09-23T00:00:00.000Z"),
    });
    const outputs: PipelineOutput[] = [];
    for (const batch of batches) outputs.push(...(await pipeline.push(batch)));

    expect(
      outputs.map((output) => (output.type === "episode" ? output.action : output.type)),
    ).toEqual(["suspect", "opened", "aborted"]);
    const [suspect, opened] = outputs as [
      Extract<PipelineOutput, { type: "suspect" }>,
      Extract<PipelineOutput, { type: "episode" }>,
    ];
    expect(opened.episode).toMatchObject({
      decision_count: 0,
      first_event_id: suspect.event.event_id,
    });

    const { db, sink } = harness(store);
    await sink.write(outputs);
    expect(sink.failures()).toEqual({ persist: 0, publish: 0 });
    expect(db.events.get(suspect.event.event_id)?.episodeId).toBe(opened.episode.episode_id);
  });

  it("bills every answered decision once, at the message's own prices", async () => {
    const { db, sink, hub } = harness(run.store);
    await writeAll(sink, run.pushes);
    await writeAll(sink, run.pushes);

    const answered = all(run).filter(
      (output) => output.type === "decision" && output.decision.status === "ok",
    );
    expect(db.ledger).toHaveLength(answered.length);
    expect(db.ledger[0]).toMatchObject({ price_input_per_mtok: 0.042, prices_as_of: "2026-09-19" });
    const updates = hub.frames.filter((frame) => frame.type === "cost.update");
    expect(updates).toHaveLength(answered.length);
    expect(updates.at(-1)?.payload).toMatchObject({ calls: answered.length, backend: "rules" });
  });

  it("publishes and broadcasts every message in the order the pipeline emitted it", async () => {
    const { sink, publisher, hub } = harness(run.store);
    await writeAll(sink, run.pushes);
    await flushPublications();

    const expected = all(run).flatMap((output) => {
      if (output.type === "suspect") return [["suspect", output.event.event_id]];
      if (output.type === "decision") return [["decision", output.decision.decision_id]];
      if (output.type === "ticket") return [["ticket", output.ticket.ticket_id]];
      return [];
    });
    const idOf = (payload: unknown): string => {
      const message = payload as { event_id?: string; decision_id?: string; ticket_id?: string };
      return message.ticket_id ?? message.decision_id ?? message.event_id ?? "";
    };
    expect(publisher.published.map((entry) => [entry.kind, idOf(entry.payload)])).toEqual(expected);

    const frames = hub.frames.filter((frame) => frame.type !== "cost.update");
    expect(frames.map((frame) => frame.type)).toEqual(
      expected.map(([kind]) => (kind === "suspect" ? "event.suspect" : kind)),
    );
    for (const entry of publisher.published) {
      const schema =
        entry.kind === "suspect"
          ? "suspect-event"
          : entry.kind === "decision"
            ? "decision"
            : "ticket";
      expect(validate(schema, entry.payload).ok).toBe(true);
    }
  });

  it("tells the decision watchdog about every call and reports the change", async () => {
    const { sink, watchdog, changes } = harness(run.store);
    await writeAll(sink, run.pushes);

    const decisions = all(run).filter((output) => output.type === "decision");
    expect(watchdog.notes.ok).toBe(decisions.length);
    expect(watchdog.notes.error).toBe(0);
    expect(changes.count).toBe(run.pushes.filter((push) => push.some(isChange)).length);
  });

  it("records a technician's verdict after the ticket it closes", async () => {
    const local = await ticketedRun();
    const { db, sink } = harness(local.store);
    await writeAll(sink, local.pushes);
    const ticket = all(local).find((output): output is PipelineTicket => output.type === "ticket");
    if (ticket === undefined) throw new Error("no ticket");

    await sink.write(
      await local.pipeline.closeTicket(ticket.ticket.ticket_id, { verdict: "correct" }),
    );

    expect(sink.failures().persist).toBe(0);
    expect(db.closures).toEqual([expect.objectContaining({ verdict: "correct" })]);
    expect(db.tickets.get(ticket.ticket.ticket_id)?.status).toBe("closed");
    expect(db.episodes.get(ticket.ticket.episode_id)?.closed_by_technician).toBe(true);
  });

  it("turns a controller alarm transition into an alarm.native frame", async () => {
    const { sink, hub } = harness(run.store);
    const [alarm] = ALARMS;
    if (alarm === undefined) throw new Error("the register map has no alarm");
    const sim_ts = "2020-05-19T21:00:00.000Z";

    await sink.write([
      { type: "alarm", transition: { code: alarm.code, state: "raised", sim_ts, seq: 7 } },
      { type: "alarm", transition: { code: alarm.code, state: "cleared", sim_ts, seq: 9 } },
    ]);

    expect(hub.frames).toEqual([
      { type: "alarm.native", payload: { code: alarm.code, active: true, sim_ts } },
      { type: "alarm.native", payload: { code: alarm.code, active: false, sim_ts } },
    ]);
  });

  it("logs and counts a lost database without throwing, and still publishes", async () => {
    const { db, sink, publisher } = harness(run.store);
    db.failWrites();

    await expect(writeAll(sink, run.pushes)).resolves.toBeUndefined();
    await flushPublications();

    expect(sink.failures().persist).toBeGreaterThan(0);
    expect(publisher.published.length).toBeGreaterThan(0);
  });

  it("counts a publication the broker refused", async () => {
    const { sink, publisher } = harness(run.store);
    publisher.failNext();

    await writeAll(sink, run.pushes);
    await flushPublications();

    expect(sink.failures().publish).toBe(1);
  });
});

function isChange(output: PipelineOutput): boolean {
  return output.type === "decision" || output.type === "episode" || output.type === "ticket";
}

function alertFixture(file: string): AlertSystem {
  const found = fixturesFor("alert-system").valid.find((fixture) => fixture.file === file);
  if (found === undefined) throw new Error(`no alert-system fixture ${file}`);
  return structuredClone(found.data) as AlertSystem;
}

describe("the watchdog sink", () => {
  function watchdogHarness() {
    const db = fakeDiagnosisDb();
    const hub = recordingHub();
    const publisher = recordingPublisher();
    const changes = { count: 0 };
    const sink = createWatchdogSink({
      repos: db.watchdogRepos,
      publisher,
      hub,
      logger,
      onChange: () => {
        changes.count += 1;
      },
    });
    return { db, hub, publisher, changes, sink };
  }

  it("stores, publishes and broadcasts an alert, in the order raised then cleared", async () => {
    const { db, hub, publisher, changes, sink } = watchdogHarness();
    const raised = alertFixture("valid-raised.json");
    const cleared = alertFixture("valid-cleared.json");

    sink.alert(raised);
    sink.alert(cleared);
    await sink.settled();
    await flushPublications();

    expect(db.alerts).toEqual([raised, cleared]);
    expect(publisher.published).toEqual([
      { kind: "alert", payload: raised },
      { kind: "alert", payload: cleared },
    ]);
    expect(hub.frames).toEqual([
      { type: "alert.system", payload: raised },
      { type: "alert.system", payload: cleared },
    ]);
    expect(changes.count).toBe(2);
  });

  it("writes the heartbeat rows it is handed", async () => {
    const { db, sink } = watchdogHarness();
    const row: HeartbeatRow = {
      source: "telemetry",
      status: "ok",
      last_ok_wall_ts: "2026-09-22T08:00:00.000Z",
      last_seen_wall_ts: "2026-09-22T08:00:00.000Z",
      consecutive_errors: 0,
      detail: { timeout_s: 15 },
    };

    sink.heartbeat(row);
    await sink.settled();

    expect(db.heartbeats).toEqual([row]);
  });

  it("counts a failed write and keeps the queue running", async () => {
    const { db, sink } = watchdogHarness();
    db.failWrites();

    sink.alert(alertFixture("valid-raised.json"));
    await sink.settled();

    expect(sink.failures().persist).toBe(1);
  });
});
