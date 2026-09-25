// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The shared conformance fixture (db/README.md#4-the-conformance-fixture),
// replayed against a real server.
//
// db/conformance/expected.json is the contract between this runner and
// tools/init/src/fdp_init/migrate.py; nothing TypeScript-specific may be read
// from it here, or the Python suite could not iterate the same file.
//
// Every case gets its own freshly created database inside one container, so a
// case never sees what another one applied.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MigrationError, migrate } from "../../src/index.ts";
import { type PgTestStack, startPostgres } from "../../src/testing.ts";
import { CONFORMANCE_DIR, withClient } from "./helpers.ts";

interface Step {
  dir: string;
  expect: string;
  applied?: number;
  applied_versions: number[];
  tables_exist: string[];
  tables_absent: string[];
}

interface Case {
  name: string;
  description: string;
  steps: Step[];
}

const fixture = JSON.parse(readFileSync(join(CONFORMANCE_DIR, "expected.json"), "utf8")) as {
  cases: Case[];
};

let stack: PgTestStack;

beforeAll(async () => {
  stack = await startPostgres({ migrate: false });
});

afterAll(async () => {
  await stack.stop();
});

/** The admin connection string for `database` on the running container. */
function urlForDatabase(database: string): string {
  const url = new URL(stack.adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** A new, empty database, named after the case that gets it. */
async function freshDatabase(name: string): Promise<string> {
  await withClient(stack.adminUrl, async (client) => {
    await client.query(`CREATE DATABASE conformance_${name}`);
  });
  return urlForDatabase(`conformance_${name}`);
}

/** The versions in public.schema_migrations; an absent table counts as none. */
async function appliedVersions(url: string): Promise<number[]> {
  return withClient(url, async (client) => {
    const exists = await client.query<{ present: string | null }>(
      "SELECT to_regclass('public.schema_migrations')::text AS present",
    );
    if (exists.rows[0]?.present === null) return [];
    const rows = await client.query<{ version: number }>(
      "SELECT version FROM public.schema_migrations ORDER BY version",
    );
    return rows.rows.map((row) => row.version);
  });
}

/** Which of `names` the database has, as a name → exists map. */
async function relationsPresent(url: string, names: string[]): Promise<Record<string, boolean>> {
  if (names.length === 0) return {};
  return withClient(url, async (client) => {
    const present: Record<string, boolean> = {};
    for (const name of names) {
      const row = await client.query<{ oid: string | null }>(
        "SELECT to_regclass($1)::text AS oid",
        [name],
      );
      present[name] = row.rows[0]?.oid !== null;
    }
    return present;
  });
}

/** Run one step and check everything it states. */
async function runStep(url: string, step: Step): Promise<void> {
  const before = await appliedVersions(url);
  const outcome = await withClient(url, async (client) => {
    try {
      const result = await migrate(client, join(CONFORMANCE_DIR, step.dir));
      return { code: "ok", applied: result.applied.length };
    } catch (error) {
      if (!(error instanceof MigrationError)) throw error;
      return { code: error.code, applied: undefined };
    }
  });

  expect(outcome.code, `${step.dir} outcome`).toBe(step.expect);
  const after = await appliedVersions(url);
  expect(after, `${step.dir} schema_migrations`).toEqual(step.applied_versions);
  if (step.applied !== undefined) {
    expect(after.length - before.length, `${step.dir} newly applied`).toBe(step.applied);
    if (outcome.applied !== undefined) expect(outcome.applied).toBe(step.applied);
  }
  expect(await relationsPresent(url, step.tables_exist)).toEqual(
    Object.fromEntries(step.tables_exist.map((name) => [name, true])),
  );
  expect(await relationsPresent(url, step.tables_absent)).toEqual(
    Object.fromEntries(step.tables_absent.map((name) => [name, false])),
  );
}

describe("db/conformance", () => {
  it("names the seven cases the runner contract lists", () => {
    expect(fixture.cases.map((entry) => entry.name)).toEqual([
      "basic",
      "rerun",
      "hash_change",
      "failing",
      "out_of_order",
      "missing_file",
      "bad_filename",
    ]);
  });

  for (const entry of fixture.cases) {
    it(`${entry.name}: ${entry.description}`, async () => {
      const url = await freshDatabase(entry.name);
      for (const step of entry.steps) await runStep(url, step);
    });
  }
});
