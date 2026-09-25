// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The suspect-event repository over a recording pool double: what it sends and
// how it pages. The statements run against the schema in
// test/integration/persistence.test.ts.

import { describe, expect, it } from "vitest";

import { SIGNATURE_A_EVENT } from "../../test/fixtures/catalog/events.ts";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./cursor.ts";
import { createEventsRepo } from "./events.ts";
import { fakePool, texts } from "./fake-pool.test-helper.ts";

const UNIT = "cau-7";
const EPISODE_ID = "0000000e-0000-4000-8000-000000000001";

/** `count` rows of the list statement, newest first, keyed 1000, 999, … */
function listRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    cursor_id: String(1_000 - index),
    cursor_ts: `2020-06-05T11:${String(59 - index).padStart(2, "0")}:00.000000Z`,
    payload: { ...SIGNATURE_A_EVENT, event_id: `event-${index}` },
  }));
}

describe("createEventsRepo().insert", () => {
  it("writes one row inside a transaction on one connection", async () => {
    const fake = fakePool(() => ({ rowCount: 1 }));
    const repo = createEventsRepo(fake.pool, UNIT);

    await expect(repo.insert(SIGNATURE_A_EVENT, EPISODE_ID)).resolves.toBe(true);

    expect(texts(fake.statements)).toEqual(["BEGIN", "INSERT INTO app.suspect_events", "COMMIT"]);
    expect(fake.statements.every((statement) => statement.on === "client")).toBe(true);
    expect(fake.released()).toBe(1);
  });

  it("sends every value as a parameter, the message whole in payload", async () => {
    const fake = fakePool(() => ({ rowCount: 1 }));
    await createEventsRepo(fake.pool, UNIT).insert(SIGNATURE_A_EVENT, EPISODE_ID);

    const insert = fake.statements[1]!;
    expect(insert.text).not.toContain(SIGNATURE_A_EVENT.event_id);
    expect(insert.params.slice(0, 8)).toEqual([
      SIGNATURE_A_EVENT.event_id,
      SIGNATURE_A_EVENT.unit_id,
      SIGNATURE_A_EVENT.sim_ts,
      SIGNATURE_A_EVENT.wall_ts,
      EPISODE_ID,
      SIGNATURE_A_EVENT.symptom_key,
      SIGNATURE_A_EVENT.rule_ids,
      SIGNATURE_A_EVENT.machine_state.mode,
    ]);
    expect(JSON.parse(insert.params[15] as string)).toEqual(SIGNATURE_A_EVENT);
  });

  it("stores an event without an episode as NULL and reports a replay as not new", async () => {
    const fake = fakePool(() => ({ rowCount: 0 }));

    await expect(createEventsRepo(fake.pool, UNIT).insert(SIGNATURE_A_EVENT)).resolves.toBe(false);

    expect(fake.statements[1]!.params[4]).toBeNull();
  });
});

describe("createEventsRepo().list", () => {
  it("asks for one row more than the page, newest first, of its own unit", async () => {
    const fake = fakePool(() => ({ rows: listRows(3) }));

    const page = await createEventsRepo(fake.pool, UNIT).list({ limit: 2 });

    expect(fake.statements).toHaveLength(1);
    expect(fake.statements[0]).toMatchObject({ on: "pool", params: [UNIT, null, null, null, 3] });
    expect(fake.statements[0]!.text).toMatch(/ORDER BY sim_ts DESC, id DESC/);
    expect(page.items.map((event) => event.event_id)).toEqual(["event-0", "event-1"]);
    expect(decodeCursor(page.next_cursor!)).toEqual({
      simTs: "2020-06-05T11:58:00.000000Z",
      id: "999",
    });
  });

  it("starts the next page below the cursor's key and filters by symptom", async () => {
    const fake = fakePool(() => ({ rows: listRows(1) }));
    const before = encodeCursor({ simTs: "2020-06-05T11:58:00.000000Z", id: "999" });

    const page = await createEventsRepo(fake.pool, UNIT).list({
      before,
      symptom_key: "continuous_load",
    });

    expect(fake.statements[0]!.params).toEqual([
      UNIT,
      "continuous_load",
      "2020-06-05T11:58:00.000000Z",
      "999",
      51,
    ]);
    expect(page.next_cursor).toBeNull();
  });

  it("refuses a cursor it did not issue without sending a statement", async () => {
    const fake = fakePool();

    await expect(
      createEventsRepo(fake.pool, UNIT).list({ before: "not-a-cursor!" }),
    ).rejects.toBeInstanceOf(InvalidCursorError);

    expect(fake.statements).toEqual([]);
  });
});
