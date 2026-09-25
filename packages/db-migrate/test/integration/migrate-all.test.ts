// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// This repository's own migrations against a fresh pgvector/PostgreSQL 18:
// they all apply, a second run changes nothing, and an edit to an applied file
// is refused (db/README.md#3-running-the-migrations).
//
// It also covers the two shapes other packages use: `migrate(pool, dir)`,
// which the backend calls, and `startPostgres()` from @fdp/db-migrate/testing.

import { execFile } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MigrationError, listMigrations, migrate, status } from "../../src/index.ts";
import { type PgTestStack, startPostgres } from "../../src/testing.ts";
import { MIGRATIONS_DIR, REPO_ROOT, withClient } from "./helpers.ts";

const run = promisify(execFile);
const CLI = join(REPO_ROOT, "packages", "db-migrate", "src", "cli.ts");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run src/cli.ts exactly as `pnpm --filter @fdp/db-migrate` does: from the
 * package directory, with INIT_CWD naming the directory the command was typed
 * in, so a relative `--dir` is resolved the way db/README.md documents.
 */
async function cli(...args: string[]): Promise<CliResult> {
  const options = {
    cwd: join(REPO_ROOT, "packages", "db-migrate"),
    env: { ...process.env, INIT_CWD: REPO_ROOT },
  };
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--conditions=@fdp/source", CLI, ...args],
      options,
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

let stack: PgTestStack;
let scratch: string;

beforeAll(async () => {
  stack = await startPostgres({ migrate: false });
  scratch = mkdtempSync(join(tmpdir(), "fdp-migrate-all-"));
});

afterAll(async () => {
  rmSync(scratch, { recursive: true, force: true });
  await stack.stop();
});

/** A new, empty database on the running container, and its admin url. */
async function freshDatabase(name: string): Promise<string> {
  await withClient(stack.adminUrl, async (client) => {
    await client.query(`CREATE DATABASE ${name}`);
  });
  const url = new URL(stack.adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** How many migrations `url` has recorded; an absent table counts as none. */
async function migrationCount(url: string): Promise<number> {
  return withClient(url, async (client) => {
    const present = await client.query<{ table: string | null }>(
      "SELECT to_regclass('public.schema_migrations')::text AS table",
    );
    if (present.rows[0]?.table === null) return 0;
    const rows = await client.query<{ count: string }>(
      "SELECT count(*) FROM public.schema_migrations",
    );
    return Number(rows.rows[0]?.count ?? 0);
  });
}

describe("db/migrations", () => {
  it("applies every file on a fresh database and then does nothing", async () => {
    const url = await freshDatabase("all_once");
    const files = listMigrations(MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThan(0);

    const lines: string[] = [];
    const first = await withClient(url, (client) =>
      migrate(client, MIGRATIONS_DIR, { log: (line) => lines.push(line) }),
    );
    expect(first.applied.map((file) => file.file)).toEqual(files.map((file) => file.file));
    expect(first.skipped).toBe(0);
    expect(lines).toHaveLength(files.length);
    for (const line of lines) expect(line).toMatch(/^applied \d{4}_[a-z0-9_]+\.sql [0-9a-f]{12}$/);

    const second = await withClient(url, (client) => migrate(client, MIGRATIONS_DIR));
    expect(second.applied).toEqual([]);
    expect(second.skipped).toBe(files.length);

    const state = await withClient(url, (client) => status(client, MIGRATIONS_DIR));
    expect(state.applied.map((file) => file.file)).toEqual(files.map((file) => file.file));
    expect(state.pending).toEqual([]);
  });

  it("refuses an applied file whose bytes changed", async () => {
    const url = await freshDatabase("all_edited");
    const copy = join(scratch, "migrations");
    cpSync(MIGRATIONS_DIR, copy, { recursive: true });

    await withClient(url, (client) => migrate(client, copy));
    appendFileSync(join(copy, "0001_extensions_schemas.sql"), "-- one more comment\n");

    const error = await withClient(url, async (client) => {
      try {
        await migrate(client, copy);
      } catch (caught) {
        return caught;
      }
      return undefined;
    });
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).code).toBe("hash_mismatch");
    expect((error as MigrationError).file).toBe("0001_extensions_schemas.sql");
  });

  it("accepts a pg.Pool and checks one client out of it", async () => {
    const url = await freshDatabase("all_pool");
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    try {
      const result = await migrate(pool, MIGRATIONS_DIR);
      expect(result.applied).toHaveLength(listMigrations(MIGRATIONS_DIR).length);
      expect(pool.idleCount).toBe(1);
      const rows = await pool.query<{ count: string }>(
        "SELECT count(*) FROM public.schema_migrations",
      );
      expect(rows.rows[0]?.count).toBe(String(result.applied.length));
    } finally {
      await pool.end();
    }
  });
});

describe("0001's role guard", () => {
  it("names the script to run when one of the three roles is absent", async () => {
    const url = await freshDatabase("all_no_roles");
    await withClient(stack.adminUrl, (client) =>
      client.query("ALTER ROLE app_rw RENAME TO app_rw_hidden"),
    );
    try {
      const error = await withClient(url, async (client) => {
        try {
          await migrate(client, MIGRATIONS_DIR);
        } catch (caught) {
          return caught;
        }
        return undefined;
      });
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe("apply_failed");
      expect((error as MigrationError).message).toContain(
        "role app_rw missing: run infra/postgres/initdb/00-roles.sh",
      );
    } finally {
      await withClient(stack.adminUrl, (client) =>
        client.query("ALTER ROLE app_rw_hidden RENAME TO app_rw"),
      );
    }
    expect(await migrationCount(url)).toBe(0);
  });
});

describe("the command line", () => {
  it("reports pending files, applies them, and exits 2 on a changed hash", async () => {
    const url = await freshDatabase("all_cli");
    const files = listMigrations(MIGRATIONS_DIR);

    // The path db/README.md documents: relative to the repository root,
    // although the script itself runs with the package as its directory.
    const pending = await cli("status", "--dir", "db/migrations", "--url", url);
    expect(pending.code).toBe(0);
    expect(pending.stdout).toContain(`0 applied, ${files.length} pending`);

    const applied = await cli("migrate", "--dir", "db/migrations", "--url", url);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain(`${files.length} applied, 0 already there`);
    expect(await migrationCount(url)).toBe(files.length);

    const edited = join(scratch, "cli-migrations");
    cpSync(MIGRATIONS_DIR, edited, { recursive: true });
    appendFileSync(join(edited, "0002_ground_truth.sql"), "-- one more comment\n");
    const refused = await cli("migrate", "--dir", edited, "--url", url);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("hash_mismatch");
    expect(refused.stderr).toContain("0002_ground_truth.sql");
  });

  it("explains a usage mistake and exits 1", async () => {
    const result = await cli("apply", "--dir", MIGRATIONS_DIR, "--url", "postgres://x/y");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown command");
  });
});

describe("startPostgres", () => {
  it("hands out a host port Docker chose and a url per role", () => {
    // Nothing pins 5432 on the host, which is what lets several worktrees run
    // this suite at the same time.
    expect(stack.port).toBeGreaterThan(1024);
    expect(stack.urlFor("app_rw")).toContain(`@${stack.host}:${stack.port}/`);
    expect(stack.urlFor("gt_rw")).toContain("gt_rw:gt_rw@");
    expect(stack.urlFor("eval")).toContain("eval:eval@");
  });

  it("labels the container with the worktree it was started from", () => {
    expect(stack.container.getLabels()["fdp.worktree"]).toBe(basename(process.cwd()));
  });
});
