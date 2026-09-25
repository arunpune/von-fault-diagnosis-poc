// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The stack this package tests against, start to finish.
 *
 * It answers four questions once, so every later integration test can take
 * them for granted: do both containers start from the committed
 * configuration, is the database the schema the migrations ship, do the three login
 * roles exist, and does the composition root answer `GET /api/health` against
 * that database.
 *
 * It also checks the one thing the health route cannot check for itself —
 * that a pool whose server has gone away reports `down` rather than `ok` — and
 * that a pool whose server ends one of its connections (a restart, an idle
 * timeout, `pg_terminate_backend`) neither takes the process down with it nor
 * stays broken: the next statement opens a fresh connection.
 */

import { execFile } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isValid } from "@fdp/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.ts";
import { fixedClock } from "../../src/clock.ts";
import { loadEnv } from "../../src/config/env.ts";
import {
  createPool,
  assertMigrated,
  IDLE_CONNECTION_LOST,
  REQUIRED_MIGRATION,
  type Pool,
} from "../../src/db/pool.ts";
import { appliedVersions, loginRoles, tablesIn, truncateApp } from "../helpers/db.ts";
import { startStack, type TestStack } from "../helpers/containers.ts";
import {
  connectAs,
  disconnect,
  publishJson,
  subscribeGranted,
  waitForMessage,
} from "../helpers/mqtt.ts";
import {
  POOL_DROP_APPLICATION,
  POOL_DROP_ENV,
  type PoolDropReport,
  type PoolDropScenario,
} from "../helpers/pool-drop.ts";
import { withSlack } from "../helpers/timing.ts";

/** The script `runPoolDrop` starts; see `test/helpers/pool-drop.ts`. */
const POOL_DROP_SCRIPT = fileURLToPath(new URL("../helpers/pool-drop.ts", import.meta.url));

interface ChildResult {
  code: number | string | null;
  stdout: string;
  stderr: string;
}

/**
 * Run one scenario of `pool-drop.ts` in a fresh Node process.
 *
 * The child gets its three variables and nothing else of the runner's
 * environment. An error the pool throws where nothing catches it ends the
 * child with a non-zero code, which is the failure this looks for.
 */
function runPoolDrop(scenario: PoolDropScenario): Promise<ChildResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [POOL_DROP_SCRIPT],
      {
        encoding: "utf8",
        timeout: withSlack(60_000),
        env: {
          [POOL_DROP_ENV.scenario]: scenario,
          [POOL_DROP_ENV.url]: stack.pg.urlFor("app_rw"),
          [POOL_DROP_ENV.adminUrl]: stack.pg.adminUrl,
        },
      },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : (error.code ?? null), stdout, stderr });
      },
    );
  });
}

let stack: TestStack;
let appPool: Pool;
let adminPool: Pool;

beforeAll(async () => {
  stack = await startStack({ migrate: true });
  appPool = createPool(stack.pg.urlFor("app_rw"), { applicationName: "fdp-backend-smoke" });
  adminPool = createPool(stack.pg.adminUrl, { applicationName: "fdp-backend-smoke-admin" });
});

afterAll(async () => {
  await Promise.allSettled([appPool?.end(), adminPool?.end()]);
  await stack?.stop();
});

describe("the container stack", () => {
  it("starts PostgreSQL with every migration db/migrations ships", async () => {
    // 0001-0007 are the schema, 0008 the chunk links, 0009 the episode link.
    expect(await appliedVersions(adminPool)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("created the three login roles", async () => {
    const roles = await loginRoles(adminPool);
    expect(roles).toContain("app_rw");
    expect(roles).toContain("gt_rw");
    expect(roles).toContain("eval");
  });

  it("lets the diagnosis role read the migration bookkeeping", async () => {
    await expect(assertMigrated(appPool)).resolves.toBeGreaterThanOrEqual(REQUIRED_MIGRATION);
  });

  it("gives the diagnosis role the app schema and nothing of the overlay", async () => {
    expect(await tablesIn(appPool, "app")).toContain("decisions");
    await expect(appPool.query("SELECT 1 FROM gt.injections")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("empties the app schema without touching the migration bookkeeping", async () => {
    expect(await truncateApp(adminPool)).toContain("decisions");
    expect(await assertMigrated(appPool)).toBeGreaterThanOrEqual(REQUIRED_MIGRATION);
  });

  it("starts Mosquitto with the committed credentials and access list", async () => {
    const publisher = await connectAs(stack.mqtt, "gateway");
    const subscriber = await connectAs(stack.mqtt, "backend-diag");
    try {
      expect(await subscribeGranted(subscriber, "plant/cau-7/telemetry/#")).toBe(1);
      const received = waitForMessage(subscriber, "plant/cau-7/telemetry/#");
      await publishJson(publisher, "plant/cau-7/telemetry/samples", { hello: "stack" });
      await expect(received).resolves.toMatchObject({
        topic: "plant/cau-7/telemetry/samples",
        payload: { hello: "stack" },
      });
    } finally {
      await disconnect(publisher);
      await disconnect(subscriber);
    }
  });

  it("refuses a credential the password file does not carry", async () => {
    await expect(
      connectAs(
        { ...stack.mqtt, credentials: { ...stack.mqtt.credentials, eval: "wrong" } },
        "eval",
      ),
    ).rejects.toThrow();
  });
});

describe("GET /api/health against the container database", () => {
  it("answers 200 with the app link up", async () => {
    const env = loadEnv({
      PORT: "0",
      DATABASE_URL_APP: stack.pg.urlFor("app_rw"),
      MQTT_URL: stack.mqtt.url,
      LOG_LEVEL: "silent",
    });
    const app = createApp(env, {
      clock: fixedClock("2026-09-21T08:00:05.000Z"),
      links: {
        "db.app": async () => {
          await appPool.query("SELECT 1");
          return true;
        },
      },
    });
    try {
      const response = await app.fastify.inject({ method: "GET", url: "/api/health" });
      expect(response.statusCode).toBe(200);
      const body: unknown = response.json();
      expect(isValid("api-health", body)).toBe(true);
      expect(body).toMatchObject({ db: { app: "ok" }, backend: { name: "rules" } });
    } finally {
      await app.stop();
    }
  });

  it("answers 503 when the wired pool cannot reach its server", async () => {
    const env = loadEnv({ PORT: "0", LOG_LEVEL: "silent" });
    const closed = createPool("postgres://app_rw:app_rw@127.0.0.1:1/fdp", {
      applicationName: "fdp-backend-smoke-unreachable",
      connectionTimeoutMs: 1_000,
    });
    const app = createApp(env, {
      links: {
        "db.app": async () => {
          await closed.query("SELECT 1");
          return true;
        },
      },
    });
    try {
      const response = await app.fastify.inject({ method: "GET", url: "/api/health" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: "degraded", db: { app: "down" } });
    } finally {
      await app.stop();
      await closed.end().catch(() => undefined);
    }
  });
});

describe("a pool whose server ends one of its connections", () => {
  it("outlives an idle connection being ended, says so, and reconnects", async () => {
    const result = await runPoolDrop("idle");
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as PoolDropReport;
    expect(report).toMatchObject({ scenario: "idle", terminated: 1, after: 42 });

    // One line naming the pool and the server's reason, and nothing of the
    // connection: the error node-postgres hands over carries the client, and
    // the client carries the credential.
    expect(report.warnings).toEqual([
      {
        fields: {
          pool: POOL_DROP_APPLICATION,
          code: "57P01",
          reason: "terminating connection due to administrator command",
        },
        message: IDLE_CONNECTION_LOST,
      },
    ]);
    const logged = JSON.stringify(report.warnings);
    expect(logged).not.toContain(stack.pg.urlFor("app_rw"));
    expect(logged).not.toContain(":app_rw@");
  });

  it("outlives the connection of an open transaction being ended, and reconnects", async () => {
    const result = await runPoolDrop("transaction");
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as PoolDropReport;
    expect(report).toMatchObject({ scenario: "transaction", terminated: 1, after: 42 });
    // The transaction fails to its caller; it never reports a commit.
    expect(report.transactionError).not.toBeNull();
    expect(report.transactionError).not.toBe("committed");
  });
});
