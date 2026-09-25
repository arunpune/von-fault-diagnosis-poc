// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ground-truth isolation at run time (docs/architecture.md#ground-truth-isolation).
 *
 * The other three boundaries are proven without a container by
 * `test/arch/imports.test.ts`. This file proves the one that only a real server
 * can show: the diagnosis credentials cannot reach ground truth even when the
 * code asks them to.
 *
 * Both halves are here on purpose. The database and the broker enforce the same
 * rule with different machinery, and a reader checking ground-truth isolation
 * should find the whole proof in one file.
 *
 * The broker half asserts **non-delivery**, not a refused subscription:
 * Mosquitto 2.0.22 grants a subscription its access list does
 * not cover and then delivers nothing on it. A non-delivery assertion is only
 * worth something beside a positive control, so every one of them runs against
 * a second client that does receive the same retained message. A denied
 * *publish* does report itself, as PUBACK reason code 0x87 on MQTT 5.
 */

import { topics } from "@fdp/contracts";
import mqtt, { type MqttClient } from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Secret } from "../../src/config/secret.ts";
import { createPool, query, type Pool } from "../../src/db/pool.ts";
import { createLogger } from "../../src/log.ts";
import { createOpsClient, OpsCredentialError } from "../../src/mqtt/ops-client.ts";
import { startStack, type TestStack } from "../helpers/containers.ts";
import { connectAs, disconnect, publishJson, subscribeGranted } from "../helpers/mqtt.ts";
import { gtCatalog } from "../helpers/overlay.ts";
import { withSlack } from "../helpers/timing.ts";

/** PUBACK reason code 0x87, "Not authorized" (MQTT 5 §3.4.2.1). */
const NOT_AUTHORIZED = 135;

/** How long a non-delivery assertion waits before it believes the silence. */
const SILENCE_MS = 2_000;

const UNIT = "cau-7";
const logger = createLogger({ logLevel: "silent", unitId: UNIT, version: "test" });

let stack: TestStack;
let adminPool: Pool;
const pools: Pool[] = [];

/** A pool on one of the three login roles (db/README.md). */
function poolFor(role: "app_rw" | "gt_rw" | "eval"): Pool {
  const pool = createPool(stack.pg.urlFor(role), { applicationName: `fdp-roles-${role}` });
  pools.push(pool);
  return pool;
}

/** A client with no credentials at all; `allow_anonymous` is on for the UI. */
function connectAnonymously(): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(stack.mqtt.url, {
      clientId: `test-anonymous-${Math.random().toString(36).slice(2, 10)}`,
      protocolVersion: 4,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: withSlack(10_000),
    });
    client.once("error", (error) => {
      client.end(true, () => {
        reject(error);
      });
    });
    client.once("connect", () => {
      resolve(client);
    });
  });
}

/** The same user, speaking MQTT 5, so a refused publish comes back as a reason code. */
function connectAsV5(user: "backend-ops" | "backend-diag"): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(stack.mqtt.url, {
      clientId: `test-v5-${user}-${Math.random().toString(36).slice(2, 10)}`,
      username: user,
      password: stack.mqtt.credentials[user],
      protocolVersion: 5,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: withSlack(10_000),
    });
    client.once("error", (error) => {
      client.end(true, () => {
        reject(error);
      });
    });
    client.once("connect", () => {
      resolve(client);
    });
  });
}

/**
 * Start collecting the topics a client receives; the returned function stops
 * after `ms` and resolves with them.
 *
 * Deliberately not `async`, and called *before* subscribing: Mosquitto sends a
 * retained message straight after the SUBACK, often in the same read, so a
 * listener attached once `subscribeGranted` has resolved can miss it and turn
 * a positive control into an empty list. It is the race
 * `test/helpers/mqtt.ts` documents on `waitForMessage`.
 */
function startCollecting(client: MqttClient): (ms: number) => Promise<string[]> {
  const seen: string[] = [];
  const onMessage = (topic: string): void => {
    seen.push(topic);
  };
  client.on("message", onMessage);
  return (ms) =>
    new Promise((resolve) => {
      setTimeout(() => {
        client.removeListener("message", onMessage);
        resolve([...seen]);
      }, ms);
    });
}

beforeAll(async () => {
  stack = await startStack({ migrate: true });
  adminPool = createPool(stack.pg.adminUrl, { applicationName: "fdp-roles-admin" });

  // The retained catalog is what every broker assertion below is about: the
  // credentials that may see it, and the credentials that may not.
  const sim = await connectAs(stack.mqtt, "sim");
  try {
    await publishJson(sim, topics.gtCatalog(UNIT), gtCatalog(), { retain: true });
  } finally {
    await disconnect(sim);
  }
}, 240_000);

afterAll(async () => {
  await Promise.allSettled([adminPool?.end(), ...pools.map((pool) => pool.end())]);
  await stack?.stop();
});

describe("the database keeps the two schemas apart", () => {
  it("gives the diagnosis role no usage on the overlay schema at all", async () => {
    const rows = await query<{ app_gt: boolean; gt_app: boolean; eval_gt: boolean }>(
      adminPool,
      `SELECT has_schema_privilege('app_rw', 'gt', 'USAGE') AS app_gt,
              has_schema_privilege('gt_rw', 'app', 'USAGE') AS gt_app,
              has_schema_privilege('eval', 'gt', 'USAGE') AS eval_gt`,
    );
    expect(rows[0]).toEqual({ app_gt: false, gt_app: false, eval_gt: true });
  });

  it("refuses a diagnosis query that names an overlay table (42501)", async () => {
    await expect(poolFor("app_rw").query("SELECT 1 FROM gt.injections")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("refuses an overlay query that names a diagnosis table (42501)", async () => {
    await expect(poolFor("gt_rw").query("SELECT 1 FROM app.decisions")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("holds no grant for the diagnosis role on any overlay relation", async () => {
    const rows = await query<{ table_name: string }>(
      adminPool,
      "SELECT table_name FROM information_schema.role_table_grants " +
        "WHERE grantee = 'app_rw' AND table_schema = 'gt'",
    );
    expect(rows).toEqual([]);
  });

  it("lets the evaluation role read the overlay, and only read it", async () => {
    const evalPool = poolFor("eval");
    await expect(evalPool.query("SELECT 1 FROM gt.injections")).resolves.toMatchObject({
      rowCount: 0,
    });
    await expect(
      evalPool.query(
        "INSERT INTO gt.markers (unit_id, kind, sim_ts_from, sim_ts_to, wall_ts) " +
          "VALUES ('cau-7', 'reset', now(), now(), now())",
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("lets the overlay role write its own schema", async () => {
    await expect(
      poolFor("gt_rw").query(
        "INSERT INTO gt.markers (unit_id, kind, sim_ts_from, sim_ts_to, wall_ts) " +
          "VALUES ('cau-7', 'reset', now(), now(), now())",
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});

describe("the broker keeps ground truth from the diagnosis credential", () => {
  it("lets the ops credential subscribe the overlay root and read the retained catalog", async () => {
    const ops = await connectAs(stack.mqtt, "backend-ops");
    try {
      const collect = startCollecting(ops);
      expect(await subscribeGranted(ops, "gt/#")).toBe(1);
      const seen = await collect(withSlack(SILENCE_MS));
      expect(seen).toContain(topics.gtCatalog(UNIT));
    } finally {
      await disconnect(ops);
    }
  }, 60_000);

  it("delivers nothing to the diagnosis credential, while the ops one receives", async () => {
    const diag = await connectAs(stack.mqtt, "backend-diag");
    const ops = await connectAs(stack.mqtt, "backend-ops");
    try {
      // Mosquitto grants the subscription and then delivers nothing on it:
      // the SUBACK is not the proof, the silence is.
      const collectDenied = startCollecting(diag);
      const collectGranted = startCollecting(ops);
      expect(await subscribeGranted(diag, "gt/#")).toBe(1);
      expect(await subscribeGranted(ops, "gt/#")).toBe(1);

      const [denied, granted] = await Promise.all([
        collectDenied(withSlack(SILENCE_MS)),
        collectGranted(withSlack(SILENCE_MS)),
      ]);

      expect(denied).toEqual([]);
      expect(granted).toContain(topics.gtCatalog(UNIT));
    } finally {
      await disconnect(diag);
      await disconnect(ops);
    }
  }, 60_000);

  it("delivers nothing to an anonymous client, while eval receives", async () => {
    const anonymous = await connectAnonymously();
    const evaluation = await connectAs(stack.mqtt, "eval");
    try {
      const collectDenied = startCollecting(anonymous);
      const collectGranted = startCollecting(evaluation);
      expect(await subscribeGranted(anonymous, "gt/#")).toBe(1);
      expect(await subscribeGranted(evaluation, "gt/#")).toBe(1);

      const [denied, granted] = await Promise.all([
        collectDenied(withSlack(SILENCE_MS)),
        collectGranted(withSlack(SILENCE_MS)),
      ]);

      expect(denied).toEqual([]);
      expect(granted).toContain(topics.gtCatalog(UNIT));
    } finally {
      await disconnect(anonymous);
      await disconnect(evaluation);
    }
  }, 60_000);

  it("lets the ops credential publish a replay command", async () => {
    const ops = await connectAsV5("backend-ops");
    try {
      await expect(
        ops.publishAsync(topics.controlCmd(UNIT), JSON.stringify({ probe: true }), { qos: 1 }),
      ).resolves.toBeDefined();
    } finally {
      await disconnect(ops);
    }
  }, 60_000);

  it("refuses a diagnosis publish onto the overlay root with PUBACK 0x87", async () => {
    const diag = await connectAsV5("backend-diag");
    try {
      await expect(
        diag.publishAsync(topics.gtCatalog(UNIT), JSON.stringify({ probe: true }), { qos: 1 }),
      ).rejects.toMatchObject({ code: NOT_AUTHORIZED });
    } finally {
      await disconnect(diag);
    }
  }, 60_000);

  it("refuses a diagnosis publish onto the command topic with PUBACK 0x87", async () => {
    const diag = await connectAsV5("backend-diag");
    try {
      await expect(
        diag.publishAsync(topics.controlCmd(UNIT), JSON.stringify({ probe: true }), { qos: 1 }),
      ).rejects.toMatchObject({ code: NOT_AUTHORIZED });
    } finally {
      await disconnect(diag);
    }
  }, 60_000);
});

describe("the overlay refuses to start without its credential", () => {
  it("throws before it opens a socket when the password is unset", async () => {
    await expect(
      createOpsClient({ url: stack.mqtt.url, password: new Secret("") }, { logger }),
    ).rejects.toBeInstanceOf(OpsCredentialError);
  });

  it("connects with the credential the password file carries", async () => {
    const client = await createOpsClient(
      { url: stack.mqtt.url, password: new Secret(stack.mqtt.credentials["backend-ops"]) },
      { logger, clientId: "ops-credential-probe" },
    );
    try {
      expect(client.connected()).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);

  it("refuses a wrong password rather than retrying for ever", async () => {
    await expect(
      createOpsClient(
        { url: stack.mqtt.url, password: new Secret("not-the-password") },
        { logger, clientId: "ops-credential-wrong" },
      ),
    ).rejects.toThrow();
  }, 60_000);
});
