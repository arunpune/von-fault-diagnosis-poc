// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The plain-SQL forward-only migration runner of
 * db/README.md#3-running-the-migrations, in TypeScript.
 *
 * `tools/init/src/fdp_init/migrate.py` is the second implementation, and it is
 * production. The two are held together by `db/conformance/expected.json`,
 * which both test suites iterate; change one and the other's suite goes red.
 *
 * Rules, all observable through the conformance fixture:
 *
 * - files are `NNNN_<slug>.sql` and apply in ascending version order; anything
 *   else in the directory but `README.md` and sub-directories is a refusal;
 * - one transaction per file, with the bookkeeping row written inside it, so a
 *   failure leaves neither the file's objects nor a record of it;
 * - the SHA-256 of an applied file's bytes is stored and re-checked, so an
 *   edit to an applied migration is refused rather than silently ignored;
 * - nothing is applied below the highest applied version, and no applied
 *   version may lose its file.
 *
 * This package imports nothing from the workspace.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Client, ClientBase, Pool } from "pg";

/** The refusals the two runners share. */
export type MigrationErrorCode =
  "invalid_filename" | "hash_mismatch" | "out_of_order" | "missing_file" | "apply_failed";

/** A refusal with the code and, where there is one, the file that caused it. */
export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly file?: string;

  constructor(code: MigrationErrorCode, message: string, file?: string) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
    this.file = file;
  }
}

/** One `NNNN_<slug>.sql` file on disk, with the hash that identifies it. */
export interface MigrationFile {
  /** The four-digit prefix as an integer, the primary key of the bookkeeping table. */
  version: number;
  /** The slug after the prefix, without the extension. */
  name: string;
  /** The base name, for messages and logs. */
  file: string;
  /** The absolute or directory-relative path the bytes were read from. */
  path: string;
  /** SHA-256 of the file's bytes, lower-case hex. */
  sha256: string;
}

/**
 * What the runner accepts: a connected client, or a pool it checks one client
 * out of for the whole run (the backend calls `migrate(pool, dir)`).
 */
export type MigrationDb = Client | Pool;

export interface MigrateOptions {
  /** Called once per applied file; never with SQL in it. */
  log?: (line: string) => void;
}

export interface MigrateResult {
  applied: MigrationFile[];
  /** How many files were already applied and therefore left alone. */
  skipped: number;
}

export interface StatusResult {
  applied: MigrationFile[];
  pending: MigrationFile[];
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** The only non-migration file a migrations directory may hold. */
const ALLOWED_OTHER_FILE = "README.md";

const CREATE_BOOKKEEPING =
  "CREATE TABLE IF NOT EXISTS public.schema_migrations (" +
  "version integer PRIMARY KEY, name text NOT NULL, sha256 char(64) NOT NULL, " +
  "applied_at timestamptz NOT NULL DEFAULT now())";

const LOCK_BOOKKEEPING = "LOCK TABLE public.schema_migrations IN EXCLUSIVE MODE";

interface AppliedRow {
  version: number;
  sha256: string;
}

/** SHA-256 of the file's bytes exactly as committed, lower-case hex. */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Every migration in `dir`, ascending by version.
 *
 * @throws MigrationError `invalid_filename` for a badly named file or for two
 * files claiming the same version.
 */
export function listMigrations(dir: string): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.name === ALLOWED_OTHER_FILE) continue;
    const match = FILE_PATTERN.exec(entry.name);
    if (match === null) {
      throw new MigrationError(
        "invalid_filename",
        `${entry.name} in ${dir} is not NNNN_<slug>.sql`,
        entry.name,
      );
    }
    const path = join(dir, entry.name);
    files.push({
      version: Number(match[1]),
      name: match[2] as string,
      file: entry.name,
      path,
      sha256: sha256File(path),
    });
  }
  files.sort((left, right) => left.version - right.version);
  for (let index = 1; index < files.length; index += 1) {
    const current = files[index] as MigrationFile;
    const previous = files[index - 1] as MigrationFile;
    if (current.version === previous.version) {
      throw new MigrationError(
        "invalid_filename",
        `${previous.file} and ${current.file} share version ${current.version}`,
        current.file,
      );
    }
  }
  return files;
}

/** Apply every pending migration in `dir`, in ascending version order. */
export async function migrate(
  db: MigrationDb,
  dir: string,
  opts: MigrateOptions = {},
): Promise<MigrateResult> {
  const files = listMigrations(dir);
  return withClient(db, async (client) => {
    const applied = await readApplied(client);
    for (const version of applied.keys()) {
      if (!files.some((file) => file.version === version)) {
        throw new MigrationError(
          "missing_file",
          `applied migration ${version} has no file in ${dir}`,
        );
      }
    }
    const highestApplied = Math.max(0, ...applied.keys());
    const fresh: MigrationFile[] = [];
    for (const file of files) {
      const recorded = applied.get(file.version);
      if (recorded !== undefined) {
        if (recorded !== file.sha256) {
          throw new MigrationError(
            "hash_mismatch",
            `${file.file} changed after it was applied (recorded ${recorded}, on disk ${file.sha256})`,
            file.file,
          );
        }
        continue;
      }
      if (file.version < highestApplied) {
        throw new MigrationError(
          "out_of_order",
          `${file.file} is below the applied version ${highestApplied}`,
          file.file,
        );
      }
      await applyOne(client, file);
      opts.log?.(`applied ${file.file} ${file.sha256.slice(0, 12)}`);
      fresh.push(file);
    }
    return { applied: fresh, skipped: files.length - fresh.length };
  });
}

/** What `dir` holds, split into what the database already has and what it does not. */
export async function status(db: MigrationDb, dir: string): Promise<StatusResult> {
  const files = listMigrations(dir);
  return withClient(db, async (client) => {
    const applied = await readApplied(client);
    return {
      applied: files.filter((file) => applied.has(file.version)),
      pending: files.filter((file) => !applied.has(file.version)),
    };
  });
}

/** The recorded version → hash map, creating the bookkeeping table if needed. */
async function readApplied(client: ClientBase): Promise<Map<number, string>> {
  await client.query(CREATE_BOOKKEEPING);
  await client.query("BEGIN");
  try {
    await client.query(LOCK_BOOKKEEPING);
    const result = await client.query<AppliedRow>(
      "SELECT version, sha256 FROM public.schema_migrations",
    );
    await client.query("COMMIT");
    return new Map(result.rows.map((row) => [row.version, row.sha256]));
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

/** One file, its objects and its bookkeeping row, in one transaction. */
async function applyOne(client: ClientBase, file: MigrationFile): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(LOCK_BOOKKEEPING);
    // One multi-statement batch through the simple query protocol, so dollar
    // quoting and DO blocks survive without the runner parsing SQL.
    await client.query(readFileSync(file.path, "utf8"));
    await client.query(
      "INSERT INTO public.schema_migrations (version, name, sha256) VALUES ($1, $2, $3)",
      [file.version, file.name, file.sha256],
    );
    await client.query("COMMIT");
  } catch (error) {
    await rollbackQuietly(client);
    throw new MigrationError("apply_failed", describeFailure(file, error), file.file);
  }
}

/** Undo the open transaction; a failing ROLLBACK must not hide why we got here. */
async function rollbackQuietly(client: ClientBase): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The error that opened this catch block is the one worth reporting.
  }
}

/** The file, the server's message and, when the server gave one, the position. */
function describeFailure(file: MigrationFile, error: unknown): string {
  const details = error as { message?: unknown; position?: unknown };
  const message = typeof details.message === "string" ? details.message : String(error);
  const at = details.position === undefined ? "" : ` at position ${String(details.position)}`;
  return `${file.file} failed${at}: ${message}`;
}

/** A pool has a client checked out for the whole run; a client is used as is. */
async function withClient<T>(db: MigrationDb, run: (client: ClientBase) => Promise<T>): Promise<T> {
  if (!isPool(db)) return run(db);
  const client = await db.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

/** `pg.Pool` counts its connections; `pg.Client` has no such property. */
function isPool(db: MigrationDb): db is Pool {
  return typeof (db as Pool).totalCount === "number";
}
