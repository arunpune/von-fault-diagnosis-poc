// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The module's composition: five repositories over one pool, scoped to one unit.

import { describe, expect, it } from "vitest";

import { fakePool } from "./fake-pool.test-helper.ts";
import { createPersistence } from "./index.ts";

describe("createPersistence", () => {
  it("builds every repository over the one pool it is given, scoped to its unit", async () => {
    const fake = fakePool(() => ({ rows: [] }));
    const persistence = createPersistence(fake.pool, { unitId: "cau-9" });

    await persistence.events.list();
    await persistence.decisions.list();
    await persistence.alerts.list();
    await persistence.nativeAlarms.list({
      from: "2020-06-05T00:00:00.000Z",
      to: "2020-06-06T00:00:00.000Z",
    });
    await persistence.heartbeats.list();

    expect(fake.statements.map((statement) => statement.params[0])).toEqual([
      "cau-9",
      "cau-9",
      "cau-9",
      "cau-9",
      undefined,
    ]);
  });
});
