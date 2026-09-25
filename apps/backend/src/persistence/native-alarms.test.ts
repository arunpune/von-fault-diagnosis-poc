// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The native-alarm reads over a recording pool double. The statement runs
// against the schema in test/integration/persistence.test.ts.

import { describe, expect, it } from "vitest";

import { fakePool } from "./fake-pool.test-helper.ts";
import {
  createNativeAlarmsRepo,
  DEFAULT_NATIVE_ALARM_LIMIT,
  MAX_NATIVE_ALARM_LIMIT,
} from "./native-alarms.ts";

const UNIT = "cau-7";
const FROM = "2020-06-05T09:00:00.000Z";
const TO = "2020-06-05T12:00:00.000Z";

describe("createNativeAlarmsRepo().list", () => {
  it("reads a window of its own unit, oldest first, as contract timestamps", async () => {
    const fake = fakePool(() => ({
      rows: [
        {
          code: "W102",
          state: "raised",
          sim_ts: new Date("2020-06-05T10:00:10.000Z"),
          wall_ts: new Date("2026-09-22T08:00:00.000Z"),
          seq: "4294967295",
        },
        {
          code: "W102",
          state: "cleared",
          sim_ts: new Date("2020-06-05T10:05:00.000Z"),
          wall_ts: new Date("2026-09-22T08:00:01.000Z"),
          seq: null,
        },
      ],
    }));

    const alarms = await createNativeAlarmsRepo(fake.pool, UNIT).list({ from: FROM, to: TO });

    expect(alarms).toEqual([
      {
        code: "W102",
        state: "raised",
        sim_ts: "2020-06-05T10:00:10.000Z",
        wall_ts: "2026-09-22T08:00:00.000Z",
        seq: 4_294_967_295,
      },
      {
        code: "W102",
        state: "cleared",
        sim_ts: "2020-06-05T10:05:00.000Z",
        wall_ts: "2026-09-22T08:00:01.000Z",
        seq: null,
      },
    ]);
    expect(fake.statements[0]).toMatchObject({
      on: "pool",
      params: [UNIT, FROM, TO, null, DEFAULT_NATIVE_ALARM_LIMIT],
    });
    expect(fake.statements[0]!.text).toMatch(/sim_ts >= \$2::timestamptz AND sim_ts <= \$3/);
  });

  it("narrows to one code and bounds the row count", async () => {
    const fake = fakePool(() => ({ rows: [] }));

    await createNativeAlarmsRepo(fake.pool, UNIT).list({
      from: FROM,
      to: TO,
      code: "S301",
      limit: 50_000,
    });

    expect(fake.statements[0]!.params).toEqual([UNIT, FROM, TO, "S301", MAX_NATIVE_ALARM_LIMIT]);
  });
});
