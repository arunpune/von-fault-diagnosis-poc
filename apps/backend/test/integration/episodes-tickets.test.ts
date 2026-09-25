// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Episodes, tickets and heartbeats against the real schema.
 *
 * The unit tests prove the state machine and the lifecycle in memory; this
 * file proves that what they produce fits the tables as the migrations ship them, with
 * the credential the backend runs as. Everything is written and read as
 * `app_rw`, so a missing grant fails here rather than being papered over by
 * the container's owner role; the admin pool only reads the catalogue.
 *
 * Three rows this file needs are not its own: the suspect event an episode
 * points at (`first_event_id`), the decision a ticket points at
 * (`latest_decision_id`) and the heartbeat and alert rows, whose repositories
 * live in `src/persistence/`. They are written here with plain,
 * parameterised statements, just enough to satisfy the foreign keys and to
 * prove the heartbeat's rows fit `app.heartbeats` and `app.system_alerts`.
 *
 * Each test works on a unit of its own, so the one-open-episode-per-key index
 * never sees two tests' episodes and no test depends on another's rows.
 */

import { startPostgres, type PgTestStack } from "@fdp/db-migrate/testing";
import type { AlertSystem, Decision, SuspectEvent } from "@fdp/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/clock.ts";
import { createPool, query, type Pool, type Queryable } from "../../src/db/pool.ts";
import {
  answered,
  eventAt,
  sequentialIds,
  TEST_WALL_TS,
} from "../../src/episodes/decisions.test-helper.ts";
import {
  createEpisodeManager,
  createEpisodeStore,
  type Episode,
  type EpisodeManager,
} from "../../src/episodes/index.ts";
import { createEpisodeRepo, type EpisodeRepo } from "../../src/episodes/repo.ts";
import { createHeartbeat, toSystemAlertRow, type HeartbeatRow } from "../../src/heartbeat/index.ts";
import {
  createTicketManager,
  type TicketChange,
  type TicketManager,
  type TicketOutcome,
  type TicketRecord,
} from "../../src/tickets/index.ts";
import { createTicketRepo, type TicketRepo } from "../../src/tickets/repo.ts";
import { SIGNATURE_A_CANDIDATE_IDS, SIGNATURE_A_EVENT } from "../fixtures/catalog/events.ts";
import { candidatesFor } from "../fixtures/catalog/index.ts";
import { appliedVersions } from "../helpers/db.ts";

const CANDIDATES = candidatesFor(SIGNATURE_A_CANDIDATE_IDS);
const LEAK = "dryer_purge_leak";

/** 11:00 on the fixture day plus `minutes`, as an `iso_ts`. */
function at(minutes: number): string {
  return new Date(Date.parse("2020-06-05T11:00:00.000Z") + minutes * 60_000).toISOString();
}

let pg: PgTestStack;
let admin: Pool;
let app: Pool;
let episodeRepo: EpisodeRepo;
let ticketRepo: TicketRepo;

beforeAll(async () => {
  pg = await startPostgres({ migrate: true });
  admin = createPool(pg.adminUrl, { applicationName: "fdp-backend-episodes-admin" });
  app = createPool(pg.urlFor("app_rw"), { applicationName: "fdp-backend-episodes" });
  episodeRepo = createEpisodeRepo(app);
  ticketRepo = createTicketRepo(app);
});

afterAll(async () => {
  await Promise.allSettled([admin?.end(), app?.end()]);
  await pg?.stop();
});

/** The one suspect-event row an episode's `first_event_id` needs. */
async function insertEvent(db: Queryable, event: SuspectEvent): Promise<void> {
  await query(
    db,
    `INSERT INTO app.suspect_events
            (event_id, unit_id, sim_ts, wall_ts, symptom_key, rule_ids, machine_mode, evidence,
             observations, active_alarms, co_symptoms, ambient, window_from_sim_ts,
             window_to_sim_ts, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb)`,
    [
      event.event_id,
      event.unit_id,
      event.sim_ts,
      event.wall_ts,
      event.symptom_key,
      event.rule_ids,
      event.machine_state.mode,
      JSON.stringify(event.evidence),
      JSON.stringify(event.observations),
      event.active_alarms,
      event.co_symptoms,
      event.ambient,
      event.window.from_sim_ts,
      event.window.to_sim_ts,
      JSON.stringify(event),
    ],
  );
}

/** The one decision row a ticket's `latest_decision_id` needs. */
async function insertDecision(db: Queryable, decision: Decision): Promise<void> {
  await query(
    db,
    `INSERT INTO app.decisions
            (decision_id, episode_id, event_id, unit_id, sim_ts, wall_ts, backend, model, status,
             choice, confidence, probabilities, severity_level, severity_score,
             severity_confidence, gate_outcome, state, state_digest, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16,
             $17::jsonb, $18, $19::jsonb)`,
    [
      decision.decision_id,
      decision.episode_id,
      decision.event_id,
      decision.unit_id,
      decision.sim_ts,
      decision.wall_ts,
      decision.backend,
      decision.model,
      decision.status,
      decision.choice,
      decision.confidence,
      JSON.stringify(decision.probabilities),
      decision.severity.level,
      decision.severity.score,
      decision.severity.confidence,
      decision.gate.outcome,
      JSON.stringify({ choice: decision.choice }),
      decision.state_digest,
      JSON.stringify(decision),
    ],
  );
}

/**
 * The write path of `runtime/sinks.ts`, in its order, over one unit.
 *
 * Event row, episode row, decision row, then the ticket write-through; after
 * every step the changed episode is saved again, which is what the sinks do
 * with every `episode` output of the pipeline.
 */
interface Unit {
  readonly unitId: string;
  readonly episodes: EpisodeManager;
  readonly tickets: TicketManager;
  /** A persisted event on `symptomKey` at `minutes`, routed through the state machine. */
  event(minutes: number, symptomKey?: string): Promise<{ event: SuspectEvent; episode: Episode }>;
  /** A persisted decision on `episode`, then the ticket work it causes. */
  decide(
    episode: Episode,
    event: SuspectEvent,
    choice: string,
    confidence: number,
  ): Promise<TicketOutcome>;
}

function unit(unitId: string, idSeed: number): Unit {
  const episodes = createEpisodeManager({
    store: createEpisodeStore(),
    cfg: { decisionIntervalSimMin: 30, episodeClearSimMin: 120 },
    ids: sequentialIds(idSeed),
  });
  const tickets = createTicketManager({
    repo: ticketRepo,
    ids: sequentialIds(idSeed + 1),
    wall: fixedClock(TEST_WALL_TS),
  });
  const eventIds = sequentialIds(idSeed + 2);
  const decisionIds = sequentialIds(idSeed + 3);

  return {
    unitId,
    episodes,
    tickets,
    async event(minutes, symptomKey = "continuous_load") {
      const event = eventAt(SIGNATURE_A_EVENT, eventIds(), at(minutes), {
        unit_id: unitId,
        symptom_key: symptomKey,
        co_symptoms: [],
      });
      await insertEvent(app, event);
      const { episode } = episodes.onEvent(event, true);
      await episodeRepo.save(episode);
      return { event, episode };
    },
    async decide(episode, event, choice, confidence) {
      const { decision, gate } = answered({
        event,
        candidates: CANDIDATES,
        episodeId: episode.episode_id,
        decisionId: decisionIds(),
        choice,
        confidence,
      });
      await insertDecision(app, decision);
      const routed = episodes.onDecision(episode.episode_id, decision, gate);
      await episodeRepo.save(routed.episode);
      const candidate = CANDIDATES.find((entry) => entry.fault_id === choice);
      const outcome = await tickets.applyDecision(routed.target, decision, gate, candidate, event);
      if (outcome.action !== "none") {
        const noted = episodes.noteTicket(
          routed.target.episode_id,
          outcome.ticket.ticket_id,
          outcome.ticket.fault_id,
        );
        await episodeRepo.save(noted);
      }
      return outcome;
    },
  };
}

function changed(outcome: TicketOutcome): TicketChange {
  if (outcome.action === "none") throw new Error("expected the ticket to change");
  return outcome;
}

/** The ticket row as the database holds it, the columns a reader checks. */
async function ticketRow(ticketId: string) {
  const rows = await query<{
    status: string;
    fault_id: string;
    update_count: number;
    close_reason: string | null;
    latest_decision_id: string;
  }>(
    app,
    "SELECT status, fault_id, update_count, close_reason, latest_decision_id " +
      "FROM app.tickets WHERE ticket_id = $1",
    [ticketId],
  );
  return rows[0];
}

/** A record as it comes back from `real` columns: confidence to float4 precision. */
function asStored(ticket: TicketRecord): unknown {
  return {
    ...ticket,
    confidence: expect.closeTo(ticket.confidence, 6),
  };
}

/** The SQLSTATE of a rejected statement. */
async function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

describe("migration 0009", () => {
  it("is applied on top of 0001-0008", async () => {
    expect(await appliedVersions(admin)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const rows = await query<{ name: string }>(
      admin,
      "SELECT name FROM public.schema_migrations WHERE version = 9",
    );
    expect(rows).toEqual([{ name: "backend_episode_links" }]);
  });

  it("documents merged_into and indexes the rows that point somewhere", async () => {
    const comment = await query<{ comment: string | null }>(
      admin,
      "SELECT col_description('app.episodes'::regclass, attnum) AS comment " +
        "FROM pg_attribute WHERE attrelid = 'app.episodes'::regclass AND attname = 'merged_into'",
    );
    expect(comment[0]?.comment).toMatch(/same fault_id/);

    const index = await query<{ indexdef: string }>(
      admin,
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'app' AND indexname = 'episodes_merged_into_idx'",
    );
    expect(index[0]?.indexdef).toMatch(/\(merged_into\) WHERE \(merged_into IS NOT NULL\)/);
  });

  it("is what the backend's pool connects to as app_rw", async () => {
    const rows = await query<{ role: string }>(app, "SELECT current_user AS role");
    expect(rows).toEqual([{ role: "app_rw" }]);
  });
});

describe("episodes", () => {
  it("round-trips an episode through app.episodes", async () => {
    const u = unit("cau-11", 0x11);
    const { event, episode } = await u.event(0);
    await u.event(10);
    await u.decide(episode, event, LEAK, 0.4);

    const loaded = await episodeRepo.load(u.unitId);

    expect(loaded).toEqual([u.episodes.store.byId(episode.episode_id)]);
    expect(loaded[0]).toMatchObject({
      status: "open",
      event_count: 2,
      decision_count: 1,
      last_event_sim_ts: at(10),
      last_decision_sim_ts: at(0),
      first_event_id: event.event_id,
      merged_into: null,
      ticket_id: null,
      fault_id: null,
    });
  });

  it("persists a merge, a silence close and a discontinuity abort", async () => {
    const u = unit("cau-12", 0x21);
    const purge = await u.event(0, "purge_pressure_high");
    await u.decide(purge.episode, purge.event, LEAK, 0.9);
    const load = await u.event(5);
    await u.decide(load.episode, load.event, LEAK, 0.9);

    const merged = u.episodes.store.byId(load.episode.episode_id);
    expect(merged?.merged_into).toBe(purge.episode.episode_id);
    expect((await episodeRepo.load(u.unitId)).map((row) => row.merged_into)).toEqual([
      null,
      purge.episode.episode_id,
    ]);

    for (const end of u.episodes.onTick(at(125), ["continuous_load"])) {
      await episodeRepo.save(end.episode);
    }
    for (const end of u.episodes.onDiscontinuity(at(130))) await episodeRepo.save(end.episode);

    const rows = await query<{ symptom_key: string; status: string; close_reason: string }>(
      app,
      "SELECT symptom_key, status, close_reason FROM app.episodes WHERE unit_id = $1 ORDER BY id",
      [u.unitId],
    );
    expect(rows).toEqual([
      { symptom_key: "purge_pressure_high", status: "closed", close_reason: "silence" },
      { symptom_key: "continuous_load", status: "aborted", close_reason: "discontinuity" },
    ]);
  });

  it("refuses a second open episode on one key (episodes_one_open)", async () => {
    const u = unit("cau-13", 0x31);
    const { episode } = await u.event(0);
    const second: Episode = {
      ...episode,
      episode_id: "0000ffff-0000-4000-8000-000000000001",
    };

    expect(await sqlState(episodeRepo.save(second))).toBe("23505");

    await episodeRepo.save({ ...episode, status: "closed", close_reason: "silence" });
    await expect(episodeRepo.save(second)).resolves.toBeUndefined();
  });
});

describe("tickets", () => {
  it("creates, updates and closes a ticket with its closure row", async () => {
    const u = unit("cau-21", 0x41);
    const { event, episode } = await u.event(0);
    const opened = changed(await u.decide(episode, event, LEAK, 0.9));
    expect(await ticketRow(opened.ticket.ticket_id)).toMatchObject({
      status: "open",
      fault_id: LEAK,
      update_count: 0,
    });

    const later = await u.event(30);
    const updated = changed(await u.decide(episode, later.event, "purge_silencer_damaged", 0.5));
    expect(await ticketRow(opened.ticket.ticket_id)).toEqual({
      status: "open",
      fault_id: "purge_silencer_damaged",
      update_count: 1,
      close_reason: null,
      latest_decision_id: updated.ticket.latest_decision_id,
    });

    const closed = await u.tickets.close(
      opened.ticket.ticket_id,
      { verdict: "correct", note: "purge valve replaced", closed_by: "technician-4" },
      at(45),
    );
    expect(await ticketRow(opened.ticket.ticket_id)).toMatchObject({
      status: "closed",
      close_reason: "technician",
    });
    const closures = await query<{
      verdict: string;
      note: string;
      closed_by: string;
      sim_ts: Date;
    }>(
      app,
      "SELECT verdict, note, closed_by, sim_ts FROM app.ticket_closures WHERE ticket_id = $1",
      [opened.ticket.ticket_id],
    );
    expect(closures).toEqual([
      {
        verdict: "correct",
        note: "purge valve replaced",
        closed_by: "technician-4",
        sim_ts: new Date(at(45)),
      },
    ]);

    const [loaded] = await ticketRepo.load(u.unitId);
    expect(loaded).toEqual(asStored(closed.ticket));
  });

  it("promotes a review-status ticket to open", async () => {
    const u = unit("cau-22", 0x51);
    const { event, episode } = await u.event(0);
    const review = changed(await u.decide(episode, event, LEAK, 0.7));
    expect(await ticketRow(review.ticket.ticket_id)).toMatchObject({ status: "review" });

    const later = await u.event(30);
    const promoted = changed(await u.decide(episode, later.event, LEAK, 0.9));

    expect(promoted.action).toBe("promoted");
    expect(promoted.message).toMatchObject({ action: "updated", status: "open" });
    expect(await ticketRow(review.ticket.ticket_id)).toMatchObject({
      status: "open",
      update_count: 1,
    });
  });

  it("refuses a second ticket for one episode (tickets.episode_id)", async () => {
    const u = unit("cau-23", 0x61);
    const { event, episode } = await u.event(0);
    const opened = changed(await u.decide(episode, event, LEAK, 0.9));
    const duplicate: TicketRecord = {
      ...opened.ticket,
      ticket_id: "0000ffff-0000-4000-8000-000000000002",
    };

    expect(await sqlState(ticketRepo.save(duplicate))).toBe("23505");
  });
});

describe("hydration", () => {
  it("rebuilds the store and the tickets a restarted backend needs", async () => {
    const u = unit("cau-31", 0x71);
    const first = await u.event(0);
    const review = changed(await u.decide(first.episode, first.event, LEAK, 0.7));
    const second = await u.event(1, "purge_pressure_high");
    // Another fault, so the second episode opens a ticket of its own instead of merging.
    const closedTicket = changed(
      await u.decide(second.episode, second.event, "purge_silencer_damaged", 0.95),
    );
    await u.tickets.close(closedTicket.ticket.ticket_id, { verdict: "wrong" }, at(20));
    await episodeRepo.save(u.episodes.noteTechnicianClosure(second.episode.episode_id));
    const third = await u.event(2, "oil_temperature_high");
    for (const end of u.episodes.onTick(at(200), ["continuous_load", "purge_pressure_high"])) {
      await episodeRepo.save(end.episode);
    }

    const store = createEpisodeStore(await episodeRepo.load(u.unitId));
    const tickets = createTicketManager({
      ids: sequentialIds(0x79),
      wall: fixedClock(TEST_WALL_TS),
    });
    tickets.hydrate(await ticketRepo.load(u.unitId));

    expect(store.listOpen().map((episode) => episode.symptom_key)).toEqual([
      "continuous_load",
      "purge_pressure_high",
    ]);
    expect(store.byId(third.episode.episode_id)).toBeUndefined();
    expect(store.get({ unit_id: u.unitId, symptom_key: "continuous_load" })).toMatchObject({
      ticket_id: review.ticket.ticket_id,
      fault_id: LEAK,
      closed_by_technician: false,
    });
    expect(store.get({ unit_id: u.unitId, symptom_key: "purge_pressure_high" })).toMatchObject({
      ticket_id: closedTicket.ticket.ticket_id,
      closed_by_technician: true,
    });

    expect(tickets.byEpisode(first.episode.episode_id)).toEqual(
      asStored(u.tickets.byId(review.ticket.ticket_id)!),
    );
    const closed = tickets.byEpisode(second.episode.episode_id);
    expect(closed?.status).toBe("closed");
    expect(closed?.closure).toMatchObject({ verdict: "wrong" });
    expect(tickets.openCount()).toBe(1);
  });
});

describe("heartbeats", () => {
  /** A sink that writes like the `src/persistence/` repositories do, in arrival order. */
  function databaseSink() {
    let chain: Promise<unknown> = Promise.resolve();
    const updated: number[] = [];
    const writeRow = async (row: HeartbeatRow) => {
      const result = await app.query(
        `UPDATE app.heartbeats
            SET status = $2, last_ok_wall_ts = $3, last_seen_wall_ts = $4,
                consecutive_errors = $5, detail = $6::jsonb
          WHERE source = $1`,
        [
          row.source,
          row.status,
          row.last_ok_wall_ts,
          row.last_seen_wall_ts,
          row.consecutive_errors,
          JSON.stringify(row.detail),
        ],
      );
      updated.push(result.rowCount ?? 0);
    };
    const writeAlert = async (message: AlertSystem) => {
      const row = toSystemAlertRow(message);
      await app.query(
        `INSERT INTO app.system_alerts
                (alert_id, unit_id, kind, state, raised_wall_ts, cleared_wall_ts, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (alert_id) DO UPDATE
            SET state = excluded.state, cleared_wall_ts = excluded.cleared_wall_ts,
                details = excluded.details`,
        [
          row.alert_id,
          row.unit_id,
          row.kind,
          row.state,
          row.raised_wall_ts,
          row.cleared_wall_ts,
          JSON.stringify(row.details),
        ],
      );
    };
    return {
      updated,
      sink: {
        alert: (message: AlertSystem) => {
          chain = chain.then(() => writeAlert(message));
        },
        heartbeat: (row: HeartbeatRow) => {
          chain = chain.then(() => writeRow(row));
        },
      },
      drained: () => chain,
    };
  }

  it("updates app.heartbeats and app.system_alerts as the watchdogs raise and clear", async () => {
    const wall = fixedClock("2026-09-22T12:00:00.000Z");
    const db = databaseSink();
    const heartbeat = createHeartbeat({
      wall,
      timeouts: { telemetryS: 1, decisionS: 2 },
      sink: db.sink,
      unitId: "cau-7",
      ids: sequentialIds(0x81),
    });

    heartbeat.noteSimState("playing");
    heartbeat.noteSample();
    heartbeat.noteDecisionError();
    heartbeat.tick();
    wall.advance(2_000);
    heartbeat.tick();
    await db.drained();

    const silent = await query<{ source: string; status: string; consecutive_errors: number }>(
      app,
      "SELECT source, status, consecutive_errors FROM app.heartbeats ORDER BY source",
    );
    expect(silent).toEqual([
      { source: "decision_api", status: "ok", consecutive_errors: 1 },
      { source: "telemetry", status: "silent", consecutive_errors: 0 },
    ]);
    wall.advance(1_000);
    heartbeat.tick();
    heartbeat.noteSample();
    heartbeat.noteDecisionOk();
    heartbeat.tick();
    await db.drained();

    const rows = await query<{ source: string; status: string; last_ok_wall_ts: Date }>(
      app,
      "SELECT source, status, last_ok_wall_ts FROM app.heartbeats ORDER BY source",
    );
    expect(rows).toEqual([
      {
        source: "decision_api",
        status: "ok",
        last_ok_wall_ts: new Date("2026-09-22T12:00:03.000Z"),
      },
      { source: "telemetry", status: "ok", last_ok_wall_ts: new Date("2026-09-22T12:00:03.000Z") },
    ]);
    const alerts = await query<{ kind: string; state: string; cleared: Date | null }>(
      app,
      "SELECT kind, state, cleared_wall_ts AS cleared FROM app.system_alerts ORDER BY raised_wall_ts, kind",
    );
    expect(alerts).toEqual([
      { kind: "telemetry_silent", state: "cleared", cleared: new Date("2026-09-22T12:00:03.000Z") },
      {
        kind: "decision_api_silent",
        state: "cleared",
        cleared: new Date("2026-09-22T12:00:03.000Z"),
      },
    ]);
    expect(db.updated.every((count) => count === 1)).toBe(true);
  });
});
