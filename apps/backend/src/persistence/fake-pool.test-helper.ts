// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * A pool double for the repository unit tests.
 *
 * It records every statement with its parameters and says where it ran — on
 * the pool itself or on a client checked out for a transaction — so a test can
 * prove that a write is wrapped in `BEGIN … COMMIT` on one connection, that the
 * connection goes back, and that no value was spliced into the statement text.
 * The statements themselves run against the real schema in
 * `test/integration/persistence.test.ts`.
 *
 * The file is named `*.test-helper.ts` so Vitest does not collect it as a
 * suite of its own.
 */

import { EventEmitter } from "node:events";

import type { Pool } from "../db/pool.ts";

/** One statement the double was asked to run. */
export interface RecordedStatement {
  /** The statement text, whitespace collapsed so a test can match on it. */
  readonly text: string;
  readonly params: readonly unknown[];
  /** `pool` for a plain read, `client` for a statement inside a checked-out connection. */
  readonly on: "pool" | "client";
}

/** What the double answers a statement with: its rows and, for writes, its row count. */
export interface FakeResult {
  readonly rows?: readonly Record<string, unknown>[];
  readonly rowCount?: number;
}

export interface FakePool {
  readonly pool: Pool;
  readonly statements: RecordedStatement[];
  /** How many checked-out connections were released. */
  released(): number;
}

/**
 * A pool that answers every statement through `answer`, and `BEGIN`, `COMMIT`
 * and `ROLLBACK` with an empty result.
 */
export function fakePool(answer: (text: string) => FakeResult = () => ({})): FakePool {
  const statements: RecordedStatement[] = [];
  let released = 0;

  function run(on: RecordedStatement["on"], text: string, params: unknown[] = []) {
    const collapsed = text.replace(/\s+/g, " ").trim();
    statements.push({ text: collapsed, params, on });
    const result = /^(BEGIN|COMMIT|ROLLBACK)$/.test(collapsed) ? {} : answer(collapsed);
    const rows = result.rows ?? [];
    return Promise.resolve({ rows, rowCount: result.rowCount ?? rows.length });
  }

  const pool = {
    query: (text: string, params?: unknown[]) => run("pool", text, params),
    // The client is an emitter, as node-postgres's is: `withTx` listens on it
    // for the server ending the connection while the transaction holds it.
    connect: () =>
      Promise.resolve(
        Object.assign(new EventEmitter(), {
          query: (text: string, params?: unknown[]) => run("client", text, params),
          release: () => {
            released += 1;
          },
        }),
      ),
  };

  return { pool: pool as unknown as Pool, statements, released: () => released };
}

/** The statement texts of a recording, in order. */
export function texts(statements: readonly RecordedStatement[]): string[] {
  return statements.map((statement) => statement.text.split(" ").slice(0, 3).join(" "));
}
