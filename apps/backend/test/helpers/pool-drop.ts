// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * A pool whose server ends one of its connections, run in a process of its own.
 *
 * node-postgres reports a connection the server ends as an `error` event: on
 * the pool when the connection sat idle in it, on the client when it was
 * checked out. An `error` event nobody listens for is thrown from the socket
 * callback that emitted it, where no caller can catch it, and the process
 * ends. A test runner would catch that throw for the test it runs, so
 * `test/integration/smoke.test.ts` starts this file with `node` and reads the
 * exit code and the one JSON line it prints instead.
 *
 * The environment names the scenario and the two connection strings:
 *
 *   * `idle` — one statement leaves its connection idle in the pool, the
 *     server ends that connection, and the pool is asked for another
 *     statement;
 *   * `transaction` — the server ends the connection `withTx` holds between
 *     two statements of its body, and the pool is asked for another statement
 *     after `withTx` has failed.
 *
 * The pool reports through a logger that keeps what it is handed, and the
 * printed line carries it, so the test can check what an operator would read.
 */

import process from "node:process";
import { pathToFileURL } from "node:url";

import { createPool, query, queryOne, withTx, type Pool } from "../../src/db/pool.ts";

/** The `application_name` of the pool under test, which is how the server finds its connection. */
export const POOL_DROP_APPLICATION = "fdp-backend-pool-drop";

export type PoolDropScenario = "idle" | "transaction";

/** One line the pool logged. */
export interface PoolDropWarning {
  fields: Record<string, unknown>;
  message: string;
}

/** What the child prints when it gets to the end, as one JSON line. */
export interface PoolDropReport {
  scenario: PoolDropScenario;
  /** Connections of the pool under test the server ended. */
  terminated: number;
  /** The code of the error `withTx` failed with, for the `transaction` scenario. */
  transactionError: string | null;
  /** The answer of the statement run after the drop. */
  after: number | null;
  warnings: PoolDropWarning[];
}

/** How long to wait for the server and the pool to notice, before giving up. */
const WAIT_MS = 10_000;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** Poll `done` until it holds, or throw after {@link WAIT_MS}. */
async function until(what: string, done: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * End every connection of the pool under test, and wait until the server has let them go.
 *
 * The connections are found first and ended in a second statement: in one
 * statement the planner may call `pg_terminate_backend` before it has
 * filtered on the application name, and end every connection it can see.
 */
async function terminate(admin: Pool): Promise<number> {
  const targets = await query<{ pid: number }>(
    admin,
    "SELECT pid FROM pg_stat_activity WHERE application_name = $1",
    [POOL_DROP_APPLICATION],
  );
  const rows = await query<{ ended: boolean }>(
    admin,
    "SELECT pg_terminate_backend(pid) AS ended FROM unnest($1::int[]) AS pid",
    [targets.map((target) => target.pid)],
  );
  await until("the server has ended the connections", async () => {
    const row = await queryOne<{ n: number }>(
      admin,
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1",
      [POOL_DROP_APPLICATION],
    );
    return row?.n === 0;
  });
  return rows.filter((row) => row.ended).length;
}

/** Run `scenario` against the server and report what happened. */
export async function runPoolDrop(
  scenario: PoolDropScenario,
  url: string,
  adminUrl: string,
): Promise<PoolDropReport> {
  const warnings: PoolDropWarning[] = [];
  const pool = createPool(url, {
    applicationName: POOL_DROP_APPLICATION,
    logger: {
      warn: (fields, message) => {
        warnings.push({ fields, message });
      },
    },
  });
  const admin = createPool(adminUrl, { applicationName: `${POOL_DROP_APPLICATION}-admin` });
  try {
    let terminated = 0;
    let transactionError: string | null = null;

    if (scenario === "idle") {
      await pool.query("SELECT 1");
      terminated = await terminate(admin);
      await until("the pool has let the ended connection go", () => pool.totalCount === 0);
    } else {
      transactionError = await withTx(pool, async (client) => {
        await client.query("SELECT 1");
        terminated = await terminate(admin);
        await client.query("SELECT 1");
        return "committed";
      }).catch((error: unknown) => {
        const code = (error as { code?: unknown }).code;
        return typeof code === "string" ? code : error instanceof Error ? error.message : "thrown";
      });
    }

    const row = await queryOne<{ answer: number }>(pool, "SELECT 42 AS answer");
    return { scenario, terminated, transactionError, after: row?.answer ?? null, warnings };
  } finally {
    await Promise.allSettled([pool.end(), admin.end()]);
  }
}

/** Environment variables the parent sets for the child. */
export const POOL_DROP_ENV = {
  scenario: "FDP_POOL_DROP_SCENARIO",
  url: "FDP_POOL_DROP_URL",
  adminUrl: "FDP_POOL_DROP_ADMIN_URL",
} as const;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scenario = required(POOL_DROP_ENV.scenario) as PoolDropScenario;
  const report = await runPoolDrop(
    scenario,
    required(POOL_DROP_ENV.url),
    required(POOL_DROP_ENV.adminUrl),
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
