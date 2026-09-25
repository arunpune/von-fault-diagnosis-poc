// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Stack mode reads and never writes.
//
// The first guard is mechanical and lives here: every statement the module
// can issue is a SELECT, and this file reads the module's own source for any
// statement it could have built another way. The second — PostgreSQL refusing
// a write inside the read-only transaction, and the eval role refusing a
// write to `gt` — is proved against a real database by
// `test/integration/stack-score.test.ts`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type pg from "pg";
import { describe, expect, it } from "vitest";

import { MARKERS_SQL, STACK_STATEMENTS, readStack } from "./db.ts";
import type { Queryable } from "./db.ts";

/** A statement that changes something; none may appear in stack mode. */
const WRITE = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY)\b/i;

const SOURCES = ["db.ts", "score.ts", "report.ts"].map((name) =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8"),
);

describe("the stack reader", () => {
  it("issues nothing but SELECTs", () => {
    expect(STACK_STATEMENTS).toHaveLength(10);
    for (const statement of STACK_STATEMENTS) {
      expect(statement.trim()).toMatch(/^SELECT\b/);
      expect(statement).not.toMatch(WRITE);
    }
  });

  it("has no other statement anywhere in the module", () => {
    for (const source of SOURCES) {
      const quoted = source.match(/`[^`]*`/g) ?? [];
      for (const literal of quoted)
        expect(literal).not.toMatch(/\b(INSERT INTO|UPDATE \w+\.\w+ SET|DELETE FROM)\b/i);
    }
  });

  it("binds the unit and the optional range to every statement that takes them", async () => {
    const calls: { text: string; values: unknown[] | undefined }[] = [];
    const db: Queryable = {
      query<R extends pg.QueryResultRow>(text: string, values?: unknown[]) {
        calls.push({ text, values });
        return Promise.resolve({ rows: [] } as unknown as pg.QueryResult<R>);
      },
    };
    const from = new Date("2020-02-01T00:00:00.000Z");
    const read = await readStack(db, { unitId: "cau-7", from });

    expect(read.unitId).toBe("cau-7");
    expect(calls.map((call) => call.text).sort()).toEqual([...STACK_STATEMENTS].sort());
    for (const call of calls) {
      if (call.text === MARKERS_SQL) expect(call.values).toEqual(["cau-7"]);
      else expect(call.values).toEqual(["cau-7", from, null]);
    }
  });
});
