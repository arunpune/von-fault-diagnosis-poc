// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The pure parts of the database adapter. The statements themselves run against
// a real server in test/integration/smoke.test.ts.

import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  appliedMigration,
  assertMigrated,
  connectionErrorFields,
  createPool,
  IDLE_CONNECTION_LOST,
  MigrationStateError,
  query,
  queryOne,
  REQUIRED_MIGRATION,
  withTx,
  type Pool,
  type PoolLogger,
  type Queryable,
} from "./pool.ts";

/** A `Queryable` that answers with prepared rows and records what it was asked. */
function fakeDb(answer: unknown[] | Error): Queryable & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    query: vi.fn(async (text: string) => {
      calls.push(text);
      if (answer instanceof Error) throw answer;
      return { command: "SELECT", rowCount: answer.length, oid: 0, fields: [], rows: answer };
    }),
  } as Queryable & { calls: string[] };
}

function undefinedTable(): Error {
  return Object.assign(new Error('relation "public.schema_migrations" does not exist'), {
    code: "42P01",
  });
}

describe("query", () => {
  it("returns the rows and passes the parameters through", async () => {
    const db = fakeDb([{ version: 7 }]);
    await expect(query(db, "SELECT $1::int AS version", [7])).resolves.toEqual([{ version: 7 }]);
    expect(db.calls).toEqual(["SELECT $1::int AS version"]);
  });

  it("queryOne gives the first row, or undefined for an empty result", async () => {
    await expect(queryOne(fakeDb([{ a: 1 }, { a: 2 }]), "SELECT 1")).resolves.toEqual({ a: 1 });
    await expect(queryOne(fakeDb([]), "SELECT 1")).resolves.toBeUndefined();
  });
});

describe("appliedMigration", () => {
  it("reads the highest applied version", async () => {
    await expect(appliedMigration(fakeDb([{ version: 7 }]))).resolves.toBe(7);
  });

  it("reports an empty bookkeeping table as no migration at all", async () => {
    await expect(appliedMigration(fakeDb([{ version: null }]))).resolves.toBeNull();
    await expect(appliedMigration(fakeDb([]))).resolves.toBeNull();
  });
});

describe("assertMigrated", () => {
  it("passes when the database is at or above the required version", async () => {
    await expect(assertMigrated(fakeDb([{ version: 9 }]))).resolves.toBe(9);
    await expect(assertMigrated(fakeDb([{ version: 11 }]))).resolves.toBe(11);
  });

  it("names the fix when the schema is behind", async () => {
    await expect(assertMigrated(fakeDb([{ version: 3 }]))).rejects.toThrow(
      /at migration 3, this backend needs 9; run init first/,
    );
  });

  it("treats a database without the bookkeeping table as an uninitialised one", async () => {
    const error = await assertMigrated(fakeDb(undefinedTable())).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationStateError);
    expect((error as MigrationStateError).found).toBeNull();
    expect((error as Error).message).toMatch(/run init first/);
  });

  it("lets a connection failure through unchanged, so it is not read as a schema problem", async () => {
    const connectionRefused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    await expect(assertMigrated(fakeDb(connectionRefused))).rejects.toBe(connectionRefused);
  });

  it("requires every migration this tree ships", () => {
    expect(REQUIRED_MIGRATION).toBe(9);
  });
});

/** The error node-postgres hands over for a terminated backend, client attached. */
function terminatedBackend(): Error {
  return Object.assign(new Error("terminating connection due to administrator command"), {
    code: "57P01",
    severity: "FATAL",
    client: { connectionString: "postgres://app_rw:pool-secret@db:5432/fdp" },
  });
}

/** A logger that keeps what it is told. */
function recordingLogger(): PoolLogger & { lines: [Record<string, unknown>, string][] } {
  const lines: [Record<string, unknown>, string][] = [];
  return {
    lines,
    warn: (fields, message) => {
      lines.push([fields, message]);
    },
  };
}

describe("connectionErrorFields", () => {
  it("keeps the pool, the code and the reason, and nothing the error carries beside them", () => {
    const fields = connectionErrorFields("fdp-backend-app", terminatedBackend());
    expect(fields).toEqual({
      pool: "fdp-backend-app",
      code: "57P01",
      reason: "terminating connection due to administrator command",
    });
    expect(JSON.stringify(fields)).not.toContain("pool-secret");
  });

  it("reads a socket error's system code, and a thrown non-error as text", () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(connectionErrorFields("p", reset)).toEqual({
      pool: "p",
      code: "ECONNRESET",
      reason: "read ECONNRESET",
    });
    expect(connectionErrorFields("p", "gone")).toEqual({ pool: "p", code: null, reason: "gone" });
  });
});

describe("createPool", () => {
  // No connection is opened: the pool connects on its first statement, and
  // these only emit the event node-postgres emits for a dropped idle client.
  const UNREACHABLE = "postgres://app_rw:pool-secret@127.0.0.1:1/fdp";

  it("logs a connection the server ended while it sat idle, without the credential", async () => {
    const logger = recordingLogger();
    const pool = createPool(UNREACHABLE, { applicationName: "fdp-backend-app", logger });
    try {
      expect(() => pool.emit("error", terminatedBackend(), {})).not.toThrow();
      expect(logger.lines).toEqual([
        [
          {
            pool: "fdp-backend-app",
            code: "57P01",
            reason: "terminating connection due to administrator command",
          },
          IDLE_CONNECTION_LOST,
        ],
      ]);
      expect(JSON.stringify(logger.lines)).not.toContain("pool-secret");
    } finally {
      await pool.end();
    }
  });

  it("handles the event without a logger too, so no pool of this package can end the process", async () => {
    const pool = createPool(UNREACHABLE, { applicationName: "fdp-test" });
    try {
      expect(pool.listenerCount("error")).toBe(1);
      expect(() => pool.emit("error", terminatedBackend(), {})).not.toThrow();
    } finally {
      await pool.end();
    }
  });
});

/** A checked-out client: an emitter, as node-postgres's is, with scripted answers. */
class FakeClient extends EventEmitter {
  readonly statements: string[] = [];
  readonly release = vi.fn<(destroy?: boolean | Error) => void>();
  private readonly failing: ReadonlySet<string>;

  constructor(failing: readonly string[] = []) {
    super();
    this.failing = new Set(failing);
  }

  query(text: string): Promise<{ rows: [] }> {
    this.statements.push(text);
    if (this.failing.has(text)) {
      return Promise.reject(new Error(`Client has encountered a connection error: ${text}`));
    }
    return Promise.resolve({ rows: [] });
  }
}

function fakePool(client: FakeClient): Pool {
  return { connect: () => Promise.resolve(client) } as unknown as Pool;
}

describe("withTx", () => {
  it("commits, and hands a healthy connection back for reuse", async () => {
    const client = new FakeClient();
    await expect(withTx(fakePool(client), async () => "done")).resolves.toBe("done");
    expect(client.statements).toEqual(["BEGIN", "COMMIT"]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("rolls back a failed body, and still reuses a connection the rollback worked on", async () => {
    const client = new FakeClient(["INSERT"]);
    const failure = withTx(fakePool(client), async (tx) => tx.query("INSERT"));
    await expect(failure).rejects.toThrow(/INSERT/);
    expect(client.statements).toEqual(["BEGIN", "INSERT", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("outlives the server ending the connection mid-transaction, and discards it", async () => {
    const client = new FakeClient(["SELECT 2", "ROLLBACK"]);
    const failure = withTx(fakePool(client), async (tx) => {
      await tx.query("SELECT 1");
      // What node-postgres does when the server ends a checked-out connection:
      // without a listener this throws, here and in the socket callback alike.
      client.emit("error", terminatedBackend());
      await tx.query("SELECT 2");
    });
    await expect(failure).rejects.toThrow(/SELECT 2/);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("discards a connection that reported an error even when every statement answered", async () => {
    const client = new FakeClient();
    await withTx(fakePool(client), async () => {
      client.emit("error", terminatedBackend());
    });
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("discards a connection the rollback failed on", async () => {
    const client = new FakeClient(["INSERT", "ROLLBACK"]);
    await expect(withTx(fakePool(client), async (tx) => tx.query("INSERT"))).rejects.toThrow(
      /INSERT/,
    );
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
