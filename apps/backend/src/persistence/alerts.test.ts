// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The system-alert repository over a recording pool double: the message → row
// mapping on the way in and the row → message mapping on the way out. The
// statements run against the schema in test/integration/persistence.test.ts.

import { assertValid, type AlertSystem } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { ALERT_SYSTEM_SCHEMA } from "../heartbeat/index.ts";
import { createAlertsRepo, DEFAULT_ALERT_LIMIT, MAX_ALERT_LIMIT } from "./alerts.ts";
import { fakePool, texts } from "./fake-pool.test-helper.ts";

const UNIT = "cau-7";
const ALERT_ID = "000000a1-0000-4000-8000-000000000001";
const RAISED_AT = "2026-09-22T12:00:02.000Z";
const CLEARED_AT = "2026-09-22T12:00:05.000Z";

const RAISE: AlertSystem = assertValid("alert-system", {
  schema: ALERT_SYSTEM_SCHEMA,
  unit_id: UNIT,
  wall_ts: RAISED_AT,
  alert_id: ALERT_ID,
  kind: "telemetry_silent",
  state: "raised",
  since_wall_ts: RAISED_AT,
  details: { timeout_s: 15, message: "no telemetry sample for more than 15 s" },
});

const CLEAR: AlertSystem = { ...RAISE, wall_ts: CLEARED_AT, state: "cleared", details: {} };

describe("createAlertsRepo().upsert", () => {
  it("writes the row of a raise inside a transaction", async () => {
    const fake = fakePool(() => ({ rowCount: 1 }));

    await createAlertsRepo(fake.pool, UNIT).upsert(RAISE);

    expect(texts(fake.statements)).toEqual(["BEGIN", "INSERT INTO app.system_alerts", "COMMIT"]);
    expect(fake.released()).toBe(1);
    expect(fake.statements[1]!.params).toEqual([
      ALERT_ID,
      UNIT,
      "telemetry_silent",
      "raised",
      RAISED_AT,
      null,
      JSON.stringify(RAISE.details),
    ]);
  });

  it("clears in place: the raise instant stays, the clear instant arrives", async () => {
    const fake = fakePool(() => ({ rowCount: 1 }));

    await createAlertsRepo(fake.pool, UNIT).upsert(CLEAR);

    expect(fake.statements[1]!.text).toMatch(/ON CONFLICT \(alert_id\) DO UPDATE/);
    expect(fake.statements[1]!.params.slice(3, 6)).toEqual(["cleared", RAISED_AT, CLEARED_AT]);
  });
});

describe("createAlertsRepo().list", () => {
  const rows = [
    {
      alert_id: ALERT_ID,
      unit_id: UNIT,
      kind: "telemetry_silent",
      state: "cleared",
      raised_wall_ts: new Date(RAISED_AT),
      cleared_wall_ts: new Date(CLEARED_AT),
      details: {},
    },
    {
      alert_id: "000000a1-0000-4000-8000-000000000002",
      unit_id: UNIT,
      kind: "decision_api_silent",
      state: "raised",
      raised_wall_ts: new Date(RAISED_AT),
      cleared_wall_ts: null,
      details: { consecutive_errors: 3 },
    },
  ];

  it("hands every row back as its latest alert-system message", async () => {
    const fake = fakePool(() => ({ rows }));

    const alerts = await createAlertsRepo(fake.pool, UNIT).list();

    expect(alerts[0]).toEqual(CLEAR);
    expect(alerts[1]).toMatchObject({ wall_ts: RAISED_AT, since_wall_ts: RAISED_AT });
    for (const alert of alerts) expect(() => assertValid("alert-system", alert)).not.toThrow();
    expect(fake.statements[0]!.params).toEqual([UNIT, null, DEFAULT_ALERT_LIMIT]);
  });

  it("filters on the state and bounds the row count", async () => {
    const fake = fakePool(() => ({ rows: [] }));
    const repo = createAlertsRepo(fake.pool, UNIT);

    await repo.list({ active: true });
    await repo.list({ active: false, limit: 1_000_000 });

    expect(fake.statements.map((statement) => statement.params)).toEqual([
      [UNIT, "raised", DEFAULT_ALERT_LIMIT],
      [UNIT, "cleared", MAX_ALERT_LIMIT],
    ]);
  });
});
