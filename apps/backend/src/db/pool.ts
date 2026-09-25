// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The database adapter: pools, transactions and the migration check.
 *
 * Two pools exist in the running process and they never mix. This module
 * builds either of them from a connection string; `db/app.ts` and `db/gt.ts`
 * are the two call sites, and only they know which credential goes where.
 *
 * Five connections is enough for the workload — one ingest flush, one pipeline
 * write path, the REST routes and a spare — and small enough that a leaked
 * client shows up as a stall in a test rather than as a slow drift in
 * production.
 *
 * A connection the server ends (a restart, an idle timeout, an operator's
 * `pg_terminate_backend`) is an `error` event in node-postgres: on the pool
 * when the connection sat idle in it, on the client when it was checked out.
 * An `error` event nobody listens for is thrown from the socket callback that
 * emitted it, where no caller can catch it, and it ends the process. So every
 * pool built here listens: the pool has already dropped the connection by the
 * time the event fires and the next statement opens a fresh one, so the
 * listener only logs. `withTx` listens on the client it holds for the same
 * reason. Neither raises a system alert: the two watchdogs of `heartbeat/`
 * are the only alert kinds the `alert-system` contract and `app.system_alerts`
 * know, and a server that stays away already shows as `down` in
 * `GET /api/health` and as a failed statement wherever one was needed.
 */

import pg from "pg";

/**
 * The migration version the code in this tree needs.
 *
 * 0001-0007 are the schema, 0008 adds the chunk links and 0009 the episode
 * link. `assertMigrated` compares against the database so a backend started
 * before `make up` finished says so instead of failing later on a missing
 * table.
 */
export const REQUIRED_MIGRATION = 9;

/** How many connections one pool opens at most. */
export const POOL_MAX_CONNECTIONS = 5;

/**
 * Anything the helpers below can run a statement on: a pool, a client checked
 * out of one, or a test double.
 *
 * It is this package's own port rather than `Pick<pg.Pool, "query">`, whose
 * five overloads a caller has to satisfy all of. The single signature is the
 * only shape the repositories use, and `pg.Pool` and `pg.PoolClient` both
 * match it.
 */
export interface Queryable {
  query<Row extends pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<Row>>;
}

export type Pool = pg.Pool;

/** Where a pool reports a connection the server ended; the package's pino logger fits. */
export interface PoolLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface PoolOptions {
  /** Shows up in `pg_stat_activity`, so a stuck query names the process that ran it. */
  readonly applicationName: string;
  /** Milliseconds a caller waits for a free connection before the pool gives up. */
  readonly connectionTimeoutMs?: number;
  /**
   * Told when the server ends a connection the pool held idle.
   *
   * The service's pools always pass one (`db/app.ts`, `db/gt.ts`). Without one
   * the event is still handled, so the process survives it, but nothing is
   * written: that is for the short-lived pools of the tests.
   */
  readonly logger?: PoolLogger;
}

/** The line a dropped idle connection is logged as. */
export const IDLE_CONNECTION_LOST =
  "the database ended an idle connection; the pool will open a new one";

/**
 * The fields a dropped connection is logged with: the pool, the error's code
 * (the SQLSTATE for an error the server sent, `57P01` for a terminated
 * backend; the system code for a socket error) and its message.
 *
 * Picked one by one rather than handing the error to the logger: node-postgres
 * attaches the client to it, and the client carries the connection's
 * settings, which no log line may hold.
 */
export function connectionErrorFields(
  applicationName: string,
  error: unknown,
): Record<string, unknown> {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return {
    pool: applicationName,
    code: typeof code === "string" ? code : null,
    reason: error instanceof Error ? error.message : String(error),
  };
}

/** Thrown when the database is reachable but is not the schema this code needs. */
export class MigrationStateError extends Error {
  readonly found: number | null;
  readonly required: number;

  constructor(found: number | null, required: number, reason?: string) {
    super(
      reason ??
        (found === null
          ? `the database has no applied migration; run init first (needs ${required})`
          : `the database is at migration ${found}, this backend needs ${required}; run init first`),
    );
    this.name = "MigrationStateError";
    this.found = found;
    this.required = required;
  }
}

/**
 * A pool over one connection string. Nothing here reads the environment.
 *
 * It listens for the `error` event of a connection the server ended while it
 * sat idle (see the module comment): the pool has already let it go, so the
 * listener logs through `options.logger` and nothing else.
 */
export function createPool(connectionString: string, options: PoolOptions): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: POOL_MAX_CONNECTIONS,
    application_name: options.applicationName,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
  });
  pool.on("error", (error) => {
    options.logger?.warn(
      connectionErrorFields(options.applicationName, error),
      IDLE_CONNECTION_LOST,
    );
  });
  return pool;
}

/**
 * Run `text` and return its rows, typed.
 *
 * The cast is the one place the row shape is asserted rather than proven: the
 * callers are the repositories, each of which owns one statement and its row
 * type, and the integration tests run every statement against the real schema.
 */
export async function query<Row extends pg.QueryResultRow>(
  db: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<Row[]> {
  const result = await db.query<Row>(text, params as unknown[]);
  return result.rows;
}

/** Run `text` and return the first row, or `undefined` when there is none. */
export async function queryOne<Row extends pg.QueryResultRow>(
  db: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<Row | undefined> {
  const rows = await query<Row>(db, text, params);
  return rows[0];
}

/**
 * Run `body` inside one transaction on one connection.
 *
 * The client is released whatever happens, and a failure rolls back before the
 * error is re-thrown, so a caller never has to remember either.
 *
 * While it is checked out the client has no listener of the pool's, so this
 * one listens for the server ending the connection (see the module comment).
 * The statement in flight, or the next one, fails to the caller with the
 * reason, so the listener only marks the connection broken, and a broken
 * connection is handed back to be discarded rather than reused.
 */
export async function withTx<T>(
  pool: Pool,
  body: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  const onError = (): void => {
    broken = true;
  };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is already broken; the original error is the useful one.
      broken = true;
    }
    throw error;
  } finally {
    client.removeListener("error", onError);
    client.release(broken);
  }
}

/** The highest applied migration version, or `null` for an empty database. */
export async function appliedMigration(db: Queryable): Promise<number | null> {
  const row = await queryOne<{ version: number | null }>(
    db,
    "SELECT max(version)::int AS version FROM public.schema_migrations",
  );
  return row?.version ?? null;
}

/**
 * Throw unless the database carries at least `required` migrations.
 *
 * `public.schema_migrations` is readable by the three login roles because
 * `infra/postgres/initdb/00-roles.sh` sets a default privilege for the role the
 * runner creates it as; the grant cannot live in a migration, since an applied
 * migration is never edited (db/README.md). A database whose volume predates
 * that line refuses the read, and the message below says so rather than
 * reporting a schema problem that is not there.
 */
export async function assertMigrated(
  db: Queryable,
  required: number = REQUIRED_MIGRATION,
): Promise<number> {
  let found: number | null;
  try {
    found = await appliedMigration(db);
  } catch (error) {
    // An undefined table is the same operator problem as an empty one.
    if (hasSqlState(error, "42P01")) throw new MigrationStateError(null, required);
    if (hasSqlState(error, "42501")) {
      throw new MigrationStateError(
        null,
        required,
        "this role may not read public.schema_migrations; the database predates the grant in " +
          "infra/postgres/initdb/00-roles.sh, so run `make reset` and then init",
      );
    }
    throw error;
  }
  if (found === null || found < required) throw new MigrationStateError(found, required);
  return found;
}

function hasSqlState(error: unknown, state: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === state
  );
}
