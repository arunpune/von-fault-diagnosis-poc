// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Getting a container database back to a known state between tests.
 *
 * The tables are not listed here. A hand-written list drifts the moment a
 * migration adds a table, and a test that silently stops truncating one is the
 * hardest kind of flake to find, so the helpers ask the catalogue which tables
 * the schema holds right now and truncate those.
 *
 * `app.schema_migrations` does not exist — the bookkeeping table lives in
 * `public` and is never touched here, so a truncated database is still a
 * migrated one.
 */

import type { Pool, Queryable } from "../../src/db/pool.ts";
import { query } from "../../src/db/pool.ts";

/** The two schemas (db/README.md). */
export type FdpSchema = "app" | "gt";

/**
 * The catalogue tables of a schema, in no particular order.
 *
 * Views and the PostgreSQL system catalogues are excluded; only ordinary
 * tables come back.
 */
export async function tablesIn(db: Queryable, schema: FdpSchema): Promise<string[]> {
  const rows = await query<{ table_name: string }>(
    db,
    "SELECT table_name FROM information_schema.tables " +
      "WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
    [schema],
  );
  return rows.map((row) => row.table_name);
}

/**
 * Empty every table of `schema` in one statement.
 *
 * `TRUNCATE … CASCADE` in a single call keeps the foreign keys between the
 * diagnosis tables happy without the test having to know their order, and
 * `RESTART IDENTITY` puts the sequences back so an identifier in an assertion
 * means the same thing in the next test.
 *
 * `TRUNCATE` is an owner privilege, which `app_rw` and `gt_rw` deliberately do
 * not have: pass a pool on `stack.pg.adminUrl`. A test that
 * wants to prove what the unprivileged role may do should use its own pool and
 * ordinary statements instead.
 */
export async function truncateSchema(db: Queryable, schema: FdpSchema): Promise<string[]> {
  const tables = await tablesIn(db, schema);
  if (tables.length === 0) return [];
  const list = tables.map((table) => `"${schema}"."${table}"`).join(", ");
  await query(db, `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  return tables;
}

/** Empty the diagnosis schema; the pool must hold the owning role. */
export async function truncateApp(pool: Pool): Promise<string[]> {
  return truncateSchema(pool, "app");
}

/** Empty the overlay schema; the pool must hold the owning role. */
export async function truncateGt(pool: Pool): Promise<string[]> {
  return truncateSchema(pool, "gt");
}

/** The login roles the roles script created, as the server sees them. */
export async function loginRoles(db: Queryable): Promise<string[]> {
  const rows = await query<{ rolname: string }>(
    db,
    "SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname NOT LIKE 'pg\\_%' ORDER BY rolname",
  );
  return rows.map((row) => row.rolname);
}

/** Every applied migration version, ascending. */
export async function appliedVersions(db: Queryable): Promise<number[]> {
  const rows = await query<{ version: number }>(
    db,
    "SELECT version FROM public.schema_migrations ORDER BY version",
  );
  return rows.map((row) => row.version);
}
