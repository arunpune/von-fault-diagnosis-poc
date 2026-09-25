// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@fdp/db-migrate` on the command line (db/README.md#3-running-the-migrations).
 *
 *   pnpm --filter @fdp/db-migrate migrate --dir db/migrations --url postgres://…
 *   pnpm --filter @fdp/db-migrate status  --dir db/migrations --url postgres://…
 *
 * `--dir` defaults to `MIGRATIONS_DIR` and then to `db/migrations`; `--url`
 * defaults to `DATABASE_URL`. Exit codes: 0 fine, 1 a usage or connection
 * problem, 2 a `MigrationError`, whose code and file are printed.
 *
 * A relative `--dir` is resolved against the directory the command was typed
 * in, which `pnpm` reports as `INIT_CWD`: a package script runs with the
 * package as its working directory, so `--dir db/migrations` would otherwise
 * mean `packages/db-migrate/db/migrations`.
 *
 * Connect as the migrating role (`fdp_admin`), never as `app_rw` or `gt_rw`:
 * the schemas and every object in them are owned by whoever runs this.
 */

import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { MigrationError, migrate, status } from "./index.ts";

const USAGE =
  "usage: fdp-db-migrate <migrate|status> [--dir <path>] [--url <postgres url>]\n" +
  "       --dir defaults to $MIGRATIONS_DIR or db/migrations and is resolved\n" +
  "       against the directory the command was typed in; --url to $DATABASE_URL";

const EXIT_USAGE = 1;
const EXIT_MIGRATION_ERROR = 2;

interface Invocation {
  command: "migrate" | "status";
  dir: string;
  url: string;
}

/**
 * Parse `argv`, or explain what is wrong with it.
 *
 * The returned `dir` is absolute, resolved against `INIT_CWD` when the process
 * was started by a package manager and against the working directory otherwise.
 */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation | string {
  const [command, ...rest] = argv;
  if (command !== "migrate" && command !== "status") {
    return `unknown command ${command === undefined ? "(none given)" : `'${command}'`}`;
  }
  let dir = env.MIGRATIONS_DIR ?? "db/migrations";
  let url = env.DATABASE_URL ?? "";
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) return `option ${String(flag)} needs a value`;
    if (flag === "--dir") dir = value;
    else if (flag === "--url") url = value;
    else return `unknown option ${String(flag)}`;
  }
  if (url === "") return "no database url: pass --url or set DATABASE_URL";
  return { command, dir: resolve(env.INIT_CWD ?? process.cwd(), dir), url };
}

async function run(invocation: Invocation): Promise<void> {
  const client = new pg.Client({ connectionString: invocation.url });
  await client.connect();
  try {
    if (invocation.command === "migrate") {
      const result = await migrate(client, invocation.dir, { log: (line) => console.log(line) });
      console.log(`migrate: ${result.applied.length} applied, ${result.skipped} already there`);
      return;
    }
    const result = await status(client, invocation.dir);
    for (const file of result.applied) console.log(`applied ${file.file}`);
    for (const file of result.pending) console.log(`pending ${file.file}`);
    console.log(`status: ${result.applied.length} applied, ${result.pending.length} pending`);
  } finally {
    await client.end();
  }
}

/** Run the CLI and return the process exit code. */
export async function main(): Promise<number> {
  const invocation = parseArgs(process.argv.slice(2), process.env);
  if (typeof invocation === "string") {
    console.error(`fdp-db-migrate: ${invocation}\n${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    await run(invocation);
    return 0;
  } catch (error) {
    if (error instanceof MigrationError) {
      const where = error.file === undefined ? "" : ` (${error.file})`;
      console.error(`fdp-db-migrate: ${error.code}${where}: ${error.message}`);
      return EXIT_MIGRATION_ERROR;
    }
    console.error(`fdp-db-migrate: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_USAGE;
  }
}

// Only when this file is what Node was started on, so the unit tests can
// import `parseArgs` without opening a connection.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await main();
}
