// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The persistence repositories against the real schema.
 *
 * The unit tests prove what each repository sends; this file proves that the
 * statements fit the tables as the migrations ship them, with the credential
 * the backend runs as. Every repository is built over an `app_rw` pool; the
 * admin pool only reads the catalogue and states the expected order
 * independently of the code under test.
 *
 * Every payload that comes back is validated against its contract —
 * `suspect-event`, `decision`, `alert-system`, and the `api-events` and
 * `api-decisions` pages — so a column that loses a field fails here rather
 * than in a route. Each test works on a unit of its own, so no test reads
 * another's rows.
 */

import { validate, type AlertSystem, type Decision, type SuspectEvent } from "@fdp/contracts";
import { startPostgres, type PgTestStack } from "@fdp/db-migrate/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixedClock } from "../../src/clock.ts";
import { createPool, query, type Pool } from "../../src/db/pool.ts";
import {
  answered,
  eventAt,
  failed,
  sequentialIds,
} from "../../src/episodes/decisions.test-helper.ts";
import {
  createEpisodeManager,
  createEpisodeStore,
  type Episode,
} from "../../src/episodes/index.ts";
import { createEpisodeRepo } from "../../src/episodes/repo.ts";
import { createHeartbeat, type HeartbeatRow } from "../../src/heartbeat/index.ts";
import { createTelemetryRepo, type NativeAlarmRow } from "../../src/ingest/repo.ts";
import {
  candidateRows,
  createPersistence,
  InvalidCursorError,
  type Page,
  type Persistence,
} from "../../src/persistence/index.ts";
import { SIGNATURE_A_CANDIDATE_IDS, SIGNATURE_A_EVENT } from "../fixtures/catalog/events.ts";
import { candidatesFor } from "../fixtures/catalog/index.ts";

const CANDIDATES = candidatesFor(SIGNATURE_A_CANDIDATE_IDS);
const LEAK = "dryer_purge_leak";

/** How many rows the paging tests write: more than two full pages of the largest size. */
const PAGED_ROWS = 120;

let pg: PgTestStack;
let admin: Pool;
let app: Pool;
let gt: Pool;

beforeAll(async () => {
  pg = await startPostgres({ migrate: true });
  admin = createPool(pg.adminUrl, { applicationName: "fdp-backend-persistence-admin" });
  app = createPool(pg.urlFor("app_rw"), { applicationName: "fdp-backend-persistence" });
  gt = createPool(pg.urlFor("gt_rw"), { applicationName: "fdp-backend-persistence-gt" });
});

afterAll(async () => {
  await Promise.allSettled([admin?.end(), app?.end(), gt?.end()]);
  await pg?.stop();
});

/** `base` plus `minutes`, as an `iso_ts`. */
function at(minutes: number, base = "2020-06-05T11:00:00.000Z"): string {
  return new Date(Date.parse(base) + minutes * 60_000).toISOString();
}

/** The repositories of one unit, over the `app_rw` pool. */
function repos(unitId: string): Persistence {
  return createPersistence(app, { unitId });
}

/** The fixture event moved to another unit, instant and id. */
function event(unitId: string, eventId: string, simTs: string, symptomKey?: string): SuspectEvent {
  return eventAt(SIGNATURE_A_EVENT, eventId, simTs, {
    unit_id: unitId,
    ...(symptomKey === undefined ? {} : { symptom_key: symptomKey }),
  });
}

/** An open episode for `first`, persisted as the episode repository writes it. */
async function openEpisode(first: SuspectEvent, idSeed: number): Promise<Episode> {
  const manager = createEpisodeManager({
    store: createEpisodeStore(),
    cfg: { decisionIntervalSimMin: 30, episodeClearSimMin: 120 },
    ids: sequentialIds(idSeed),
  });
  const { episode } = manager.onEvent(first, true);
  await createEpisodeRepo(app).save(episode);
  return episode;
}

/** Every page of a list, following `next_cursor` until it runs out. */
async function allPages<T>(read: (before?: string) => Promise<Page<T>>): Promise<Page<T>[]> {
  const pages: Page<T>[] = [];
  let before: string | undefined;
  do {
    const page = await read(before);
    pages.push(page);
    before = page.next_cursor ?? undefined;
  } while (before !== undefined);
  return pages;
}

/** The SQLSTATE a rejected promise carries. */
async function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

describe("the credential", () => {
  it("is app_rw, with no privilege on the overlay schema", async () => {
    const rows = await query<{ role: string; gt: boolean }>(
      app,
      "SELECT current_user AS role, has_schema_privilege(current_user, 'gt', 'USAGE') AS gt",
    );
    expect(rows).toEqual([{ role: "app_rw", gt: false }]);
  });

  it("gt_rw cannot write or read the diagnosis tables through the same repositories (42501)", async () => {
    const overlay = createPersistence(gt, { unitId: "cau-90" });
    const probe = event("cau-90", "00000090-0000-4000-8000-000000000001", at(0));
    const decision = answered({
      event: probe,
      candidates: CANDIDATES,
      episodeId: "00000090-0000-4000-8000-000000000002",
      decisionId: "00000090-0000-4000-8000-000000000003",
      choice: LEAK,
      confidence: 0.9,
    }).decision;
    const clock = fixedClock("2026-09-22T12:00:00.000Z");
    const alerts: AlertSystem[] = [];
    const heartbeat = createHeartbeat({
      wall: clock,
      timeouts: { telemetryS: 1, decisionS: 2 },
      sink: { alert: (message) => alerts.push(message), heartbeat: () => undefined },
      unitId: "cau-90",
      ids: sequentialIds(0x90),
    });
    heartbeat.noteSimState("playing");
    clock.advance(2_000);
    heartbeat.tick();

    expect(await sqlState(overlay.events.insert(probe))).toBe("42501");
    expect(await sqlState(overlay.decisions.insert(decision, {}))).toBe("42501");
    expect(await sqlState(overlay.alerts.upsert(alerts[0]!))).toBe("42501");
    expect(
      await sqlState(
        overlay.heartbeats.update({
          source: "telemetry",
          status: "ok",
          last_ok_wall_ts: null,
          last_seen_wall_ts: null,
          consecutive_errors: 0,
          detail: {},
        }),
      ),
    ).toBe("42501");
    expect(await sqlState(overlay.events.list())).toBe("42501");

    const written = await query<{ n: string }>(
      admin,
      "SELECT count(*) AS n FROM app.suspect_events WHERE unit_id = 'cau-90'",
    );
    expect(written).toEqual([{ n: "0" }]);
  });
});

describe("suspect events", () => {
  it("round-trips a suspect-event message and its episode link", async () => {
    const { events } = repos("cau-41");
    const first = event("cau-41", "00000041-0000-4000-8000-000000000001", at(0));
    const episodeId = "00000041-0000-4000-8000-0000000000e1";

    await expect(events.insert(first, episodeId)).resolves.toBe(true);
    await expect(events.insert(first, episodeId)).resolves.toBe(false);

    const page = await events.list();
    expect(page).toEqual({ items: [first], next_cursor: null });
    expect(validate("api-events", page).ok).toBe(true);
    expect(validate("suspect-event", page.items[0]).ok).toBe(true);

    const rows = await query<{ episode_id: string; machine_mode: string; rule_ids: string[] }>(
      app,
      "SELECT episode_id, machine_mode, rule_ids FROM app.suspect_events WHERE event_id = $1",
      [first.event_id],
    );
    expect(rows).toEqual([
      { episode_id: episodeId, machine_mode: "loaded", rule_ids: first.rule_ids },
    ]);
  });

  it(`pages through ${PAGED_ROWS} rows without a duplicate or a gap, ties and microseconds included`, async () => {
    const unitId = "cau-42";
    const { events } = repos(unitId);
    const ids = sequentialIds(0x42);
    // Forty instants, three events on each: a page boundary regularly falls
    // between two rows of the same instant.
    for (let index = 0; index < PAGED_ROWS; index += 1) {
      const symptom = index % 2 === 0 ? "continuous_load" : "purge_pressure_high";
      await events.insert(event(unitId, ids(), at(Math.floor(index / 3)), symptom));
    }
    // Rows this backend did not write may carry sub-millisecond instants; the
    // cursor must not lose them at a page boundary.
    await query(
      app,
      "UPDATE app.suspect_events SET sim_ts = sim_ts + interval '400 microseconds' " +
        "WHERE unit_id = $1 AND id % 4 = 0",
      [unitId],
    );
    const expected = await query<{ event_id: string }>(
      admin,
      "SELECT event_id FROM app.suspect_events WHERE unit_id = $1 ORDER BY sim_ts DESC, id DESC",
      [unitId],
    );

    const pages = await allPages((before) => events.list({ before, limit: 25 }));

    expect(pages.map((page) => page.items.length)).toEqual([25, 25, 25, 25, 20]);
    const seen = pages.flatMap((page) => page.items.map((item) => item.event_id));
    expect(new Set(seen).size).toBe(PAGED_ROWS);
    expect(seen).toEqual(expected.map((row) => row.event_id));
    for (const page of pages) expect(validate("api-events", page).ok).toBe(true);

    const leakPages = await allPages((before) =>
      events.list({ before, limit: 7, symptom_key: "continuous_load" }),
    );
    const leaks = leakPages.flatMap((page) => page.items);
    expect(leaks).toHaveLength(PAGED_ROWS / 2);
    expect(new Set(leaks.map((item) => item.symptom_key))).toEqual(new Set(["continuous_load"]));
  });

  it("refuses a cursor it did not issue", async () => {
    await expect(repos("cau-43").events.list({ before: "AAAA" })).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
  });
});

describe("decisions", () => {
  it("round-trips a decision, its candidates and its stored state", async () => {
    const unitId = "cau-51";
    const { events, decisions } = repos(unitId);
    const first = event(unitId, "00000051-0000-4000-8000-000000000001", at(0));
    await events.insert(first);
    const episode = await openEpisode(first, 0x51);
    const state = { observations: ["purge pressure far above normal"], candidates: [LEAK] };
    const request = { model: "rules-v1", questions: { fault: { type: "choice" } } };
    const { decision } = answered({
      event: first,
      candidates: CANDIDATES,
      episodeId: episode.episode_id,
      decisionId: "00000051-0000-4000-8000-0000000000d1",
      choice: LEAK,
      confidence: 0.9,
    });
    const support = Object.fromEntries(
      CANDIDATES.map((candidate, index) => [candidate.fault_id, 1 - index / 10]),
    );
    const rows = candidateRows(decision, { support, retrieved: CANDIDATES });

    await expect(decisions.insert(decision, state, request)).resolves.toBe(true);
    await expect(decisions.insert(decision, state, request)).resolves.toBe(false);
    await expect(decisions.insertCandidates(decision.decision_id, rows)).resolves.toBe(6);
    await expect(decisions.insertCandidates(decision.decision_id, rows)).resolves.toBe(0);

    const stored = await decisions.get(decision.decision_id);
    expect(stored).toEqual(decision);
    expect(validate("decision", stored).ok).toBe(true);
    await expect(decisions.get(decision.decision_id, { withState: true })).resolves.toEqual({
      ...decision,
      state,
    });
    await expect(decisions.get("00000051-0000-4000-8000-0000000000ff")).resolves.toBeUndefined();

    const readBack = await decisions.candidates(decision.decision_id);
    expect(readBack).toEqual(
      rows.map((row) => ({
        ...row,
        probability: expect.closeTo(row.probability, 6),
        support: row.support === null ? null : expect.closeTo(row.support, 6),
      })),
    );

    const columns = await query<{
      request: unknown;
      response: unknown;
      gate_outcome: string;
      severity_level: string;
      state_digest: string;
      error: unknown;
    }>(
      app,
      "SELECT request, response, gate_outcome, severity_level, state_digest, error " +
        "FROM app.decisions WHERE decision_id = $1",
      [decision.decision_id],
    );
    expect(columns).toEqual([
      {
        request,
        response: null,
        gate_outcome: decision.gate.outcome,
        severity_level: decision.severity.level,
        state_digest: decision.state_digest,
        error: null,
      },
    ]);
  });

  it("stores a failed call with its error and no candidates", async () => {
    const unitId = "cau-52";
    const { events, decisions } = repos(unitId);
    const first = event(unitId, "00000052-0000-4000-8000-000000000001", at(0));
    await events.insert(first);
    const episode = await openEpisode(first, 0x52);
    const message = failed({
      event: first,
      candidates: CANDIDATES,
      episodeId: episode.episode_id,
      decisionId: "00000052-0000-4000-8000-0000000000d1",
    });

    await expect(decisions.insert(message, undefined)).resolves.toBe(true);
    await expect(
      decisions.insertCandidates(message.decision_id, candidateRows(message)),
    ).resolves.toBe(0);

    const stored = await decisions.get(message.decision_id, { withState: true });
    expect(stored).toEqual({ ...message, state: null });
    expect(validate("decision", stored).ok).toBe(true);
    expect(stored?.error).toMatchObject({ kind: "overloaded", status: 529 });
    await expect(decisions.candidates(message.decision_id)).resolves.toEqual([]);
  });

  it(`pages through ${PAGED_ROWS} decisions of one episode without a duplicate or a gap`, async () => {
    const unitId = "cau-53";
    const { events, decisions } = repos(unitId);
    const first = event(unitId, "00000053-0000-4000-8000-000000000001", at(0));
    const other = event(
      unitId,
      "00000053-0000-4000-8000-000000000002",
      at(0),
      "purge_pressure_high",
    );
    await events.insert(first);
    await events.insert(other);
    const episode = await openEpisode(first, 0x53);
    const otherEpisode = await openEpisode(other, 0x54);
    const decisionIds = sequentialIds(0x5d);

    const insertDecision = async (target: Episode, source: SuspectEvent, index: number) => {
      const { decision } = answered({
        event: source,
        candidates: CANDIDATES,
        episodeId: target.episode_id,
        decisionId: decisionIds(),
        choice: LEAK,
        confidence: 0.9,
        simTs: at(Math.floor(index / 4)),
      });
      await decisions.insert(decision, { index });
    };
    for (let index = 0; index < PAGED_ROWS; index += 1) {
      await insertDecision(episode, first, index);
    }
    for (let index = 0; index < 5; index += 1) await insertDecision(otherEpisode, other, index);

    const expected = await query<{ decision_id: string }>(
      admin,
      "SELECT decision_id FROM app.decisions WHERE episode_id = $1 ORDER BY sim_ts DESC, id DESC",
      [episode.episode_id],
    );
    const pages = await allPages((before) =>
      decisions.list({ before, limit: 50, episode_id: episode.episode_id }),
    );

    expect(pages.map((page) => page.items.length)).toEqual([50, 50, 20]);
    const seen: Decision[] = pages.flatMap((page) => page.items);
    expect(new Set(seen.map((item) => item.decision_id)).size).toBe(PAGED_ROWS);
    expect(seen.map((item) => item.decision_id)).toEqual(expected.map((row) => row.decision_id));
    for (const page of pages) expect(validate("api-decisions", page).ok).toBe(true);

    const everything = await allPages((before) => decisions.list({ before }));
    expect(everything.flatMap((page) => page.items)).toHaveLength(PAGED_ROWS + 5);
  });
});

describe("system alerts and heartbeats", () => {
  it("raises and clears an alert in place and reads it back as its latest message", async () => {
    const unitId = "cau-61";
    const { alerts, heartbeats } = repos(unitId);
    const wall = fixedClock("2026-09-22T12:00:00.000Z");
    const messages: AlertSystem[] = [];
    const rows: HeartbeatRow[] = [];
    let writes: Promise<unknown> = Promise.resolve();
    const heartbeat = createHeartbeat({
      wall,
      timeouts: { telemetryS: 1, decisionS: 2 },
      sink: {
        alert: (message) => {
          messages.push(message);
          writes = writes.then(() => alerts.upsert(message));
        },
        heartbeat: (row) => {
          rows.push(row);
          writes = writes.then(() => heartbeats.update(row));
        },
      },
      unitId,
      ids: sequentialIds(0x61),
    });

    heartbeat.noteSimState("playing");
    heartbeat.noteSample();
    wall.advance(2_000);
    heartbeat.tick();
    await writes;

    const raised = messages[0]!;
    await expect(alerts.list({ active: true })).resolves.toEqual([raised]);
    await expect(alerts.list({ active: false })).resolves.toEqual([]);

    wall.advance(1_000);
    heartbeat.noteSample();
    await writes;

    const cleared = messages[1]!;
    expect(cleared).toMatchObject({ alert_id: raised.alert_id, state: "cleared" });
    await expect(alerts.list({ active: true })).resolves.toEqual([]);
    const all = await alerts.list();
    expect(all).toEqual([cleared]);
    for (const alert of all) expect(validate("alert-system", alert).ok).toBe(true);
    await expect(alerts.list({ active: false })).resolves.toEqual([cleared]);

    const lastRow = (source: HeartbeatRow["source"]) =>
      rows.filter((row) => row.source === source).at(-1);
    await expect(heartbeats.list()).resolves.toEqual([
      lastRow("decision_api"),
      lastRow("telemetry"),
    ]);
  });

  it("writes a heartbeat row even when the seeded rows are gone", async () => {
    const { heartbeats } = repos("cau-62");
    await query(app, "DELETE FROM app.heartbeats");
    const row: HeartbeatRow = {
      source: "decision_api",
      status: "silent",
      last_ok_wall_ts: "2026-09-22T12:00:00.000Z",
      last_seen_wall_ts: "2026-09-22T12:00:04.000Z",
      consecutive_errors: 3,
      detail: { timeout_s: 2, total: 4, ok: 1, failed: 3 },
    };

    await heartbeats.update(row);
    await heartbeats.update({ ...row, status: "ok", consecutive_errors: 0 });

    await expect(heartbeats.list()).resolves.toEqual([
      { ...row, status: "ok", consecutive_errors: 0 },
    ]);
  });
});

describe("native alarms", () => {
  it("reads inclusive windows of the transitions ingest wrote, oldest first", async () => {
    const unitId = "cau-71";
    const { nativeAlarms } = repos(unitId);
    const transition = (
      code: string,
      state: NativeAlarmRow["state"],
      minutes: number,
      seq: number,
    ): NativeAlarmRow => ({
      unit_id: unitId,
      code,
      state,
      sim_ts: at(minutes),
      wall_ts: "2026-09-22T08:00:00.000Z",
      seq,
    });
    const written = [
      transition("W102", "raised", 0, 10),
      transition("W103", "raised", 5, 40),
      transition("W102", "cleared", 10, 70),
      transition("W103", "cleared", 20, 130),
      transition("S301", "raised", 30, 190),
    ];
    await createTelemetryRepo(app).insertAlarms([...written].reverse());
    await createTelemetryRepo(app).insertAlarms([
      { ...transition("W102", "raised", 5, 41), unit_id: "cau-72" },
    ]);
    const asRead = (row: NativeAlarmRow) => ({
      code: row.code,
      state: row.state,
      sim_ts: row.sim_ts,
      wall_ts: row.wall_ts,
      seq: row.seq,
    });

    await expect(nativeAlarms.list({ from: at(5), to: at(20) })).resolves.toEqual(
      written.slice(1, 4).map(asRead),
    );
    await expect(nativeAlarms.list({ from: at(0), to: at(30), code: "W102" })).resolves.toEqual(
      [written[0]!, written[2]!].map(asRead),
    );
    await expect(nativeAlarms.list({ from: at(0), to: at(30), limit: 2 })).resolves.toEqual(
      written.slice(0, 2).map(asRead),
    );
    await expect(nativeAlarms.list({ from: at(31), to: at(60) })).resolves.toEqual([]);
  });
});
