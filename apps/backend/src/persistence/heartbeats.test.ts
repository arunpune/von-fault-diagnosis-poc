// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The heartbeat repository over a recording pool double. The statements run
// against the schema in test/integration/persistence.test.ts.

import { describe, expect, it } from "vitest";

import type { HeartbeatRow } from "../heartbeat/index.ts";
import { fakePool, texts } from "./fake-pool.test-helper.ts";
import { createHeartbeatsRepo } from "./heartbeats.ts";

const ROW: HeartbeatRow = {
  source: "decision_api",
  status: "silent",
  last_ok_wall_ts: "2026-09-22T12:00:00.000Z",
  last_seen_wall_ts: "2026-09-22T12:00:04.000Z",
  consecutive_errors: 3,
  detail: { timeout_s: 60, total: 4, ok: 1, failed: 3 },
};

describe("createHeartbeatsRepo()", () => {
  it("upserts a source's row inside a transaction", async () => {
    const fake = fakePool(() => ({ rowCount: 1 }));

    await createHeartbeatsRepo(fake.pool).update(ROW);

    expect(texts(fake.statements)).toEqual(["BEGIN", "INSERT INTO app.heartbeats", "COMMIT"]);
    expect(fake.released()).toBe(1);
    expect(fake.statements[1]!.text).toMatch(/ON CONFLICT \(source\) DO UPDATE/);
    expect(fake.statements[1]!.params).toEqual([
      "decision_api",
      "silent",
      "2026-09-22T12:00:00.000Z",
      "2026-09-22T12:00:04.000Z",
      3,
      JSON.stringify(ROW.detail),
    ]);
  });

  it("reads the rows back in the heartbeat's own shape", async () => {
    const fake = fakePool(() => ({
      rows: [
        {
          ...ROW,
          last_ok_wall_ts: new Date("2026-09-22T12:00:00.000Z"),
          last_seen_wall_ts: new Date("2026-09-22T12:00:04.000Z"),
        },
        {
          source: "telemetry",
          status: "unknown",
          last_ok_wall_ts: null,
          last_seen_wall_ts: null,
          consecutive_errors: 0,
          detail: {},
        },
      ],
    }));

    await expect(createHeartbeatsRepo(fake.pool).list()).resolves.toEqual([
      ROW,
      {
        source: "telemetry",
        status: "unknown",
        last_ok_wall_ts: null,
        last_seen_wall_ts: null,
        consecutive_errors: 0,
        detail: {},
      },
    ]);
  });
});
