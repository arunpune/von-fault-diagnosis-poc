// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The overlay end to end.
 *
 * One PostgreSQL and one Mosquitto from `test/helpers/containers.ts`, the real
 * `gt_rw` credential, the real access-control list, the real migrations, and
 * the routes registered the way `api/index.ts` registers them.
 *
 * Two halves:
 *
 *   1. the simulator publishes ground truth and it turns up in `gt.*` and on
 *      `GET /api/overlay/*` — including the retained catalog, which arrives on
 *      SUBACK rather than as a live message;
 *   2. `POST /api/sim/*` reaches a fake simulator over the broker, and its
 *      acknowledgement comes back inside the answer; with no simulator
 *      listening the same call answers with a null acknowledgement instead of
 *      hanging.
 */

import { topics, type GroundTruthCatalog } from "@fdp/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import type { MqttClient } from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_PREFIX, apiRoutes } from "../../src/api/index.ts";
import { fixedClock } from "../../src/clock.ts";
import { Secret } from "../../src/config/secret.ts";
import { createPool, query, type Pool } from "../../src/db/pool.ts";
import { createLogger } from "../../src/log.ts";
import { createOverlay, type Overlay, type OverlayConfig } from "../../src/overlay/index.ts";
import { startStack, type TestStack } from "../helpers/containers.ts";
import { truncateGt } from "../helpers/db.ts";
import { connectAs, disconnect, publishJson, subscribeGranted } from "../helpers/mqtt.ts";
import { gtCatalog, gtInjectionStart, gtInjectionStop, gtMarker } from "../helpers/overlay.ts";
import { withSlack } from "../helpers/timing.ts";

const UNIT = "cau-7";
const WALL = "2026-09-21T08:00:05.000Z";

const logger = createLogger({ logLevel: "silent", unitId: UNIT, version: "test" });

let stack: TestStack;
let overlay: Overlay;
let fastify: FastifyInstance;
let sim: MqttClient;
let adminPool: Pool;
let catalog: GroundTruthCatalog;

/** Poll until `predicate` holds, so a test never sleeps longer than it must. */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = withSlack(10_000),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function countIn(table: string): Promise<number> {
  const rows = await query<{ count: string }>(adminPool, `SELECT count(*)::text FROM ${table}`);
  return Number(rows[0]?.count ?? "0");
}

beforeAll(async () => {
  stack = await startStack({ migrate: true });
  adminPool = createPool(stack.pg.adminUrl, { applicationName: "fdp-backend-overlay-test" });

  // The simulator retains its catalog before the backend ever connects; the
  // recorder must pick it up from the broker's store on SUBACK.
  catalog = gtCatalog();
  sim = await connectAs(stack.mqtt, "sim");
  await publishJson(sim, topics.gtCatalog(UNIT), catalog, { retain: true });

  const config: OverlayConfig = {
    unitId: UNIT,
    db: {
      host: stack.pg.host,
      port: stack.pg.port,
      database: "fdp",
      password: new Secret("gt_rw"),
      url: new Secret(stack.pg.urlFor("gt_rw")),
    },
    mqtt: { url: stack.mqtt.url, password: new Secret(stack.mqtt.credentials["backend-ops"]) },
  };

  overlay = await createOverlay({ logger, wall: fixedClock(WALL), config });
  await overlay.start();

  fastify = Fastify({ logger: false });
  await fastify.register(
    apiRoutes({
      startedAt: new Date(WALL),
      health: {
        clock: fixedClock(WALL),
        version: "test",
        backend: { name: "rules", model: "rules-v1" },
        links: { "db.gt": () => true },
      },
      overlay: { read: overlay.readPorts, sim: overlay.simPorts },
    }),
    { prefix: API_PREFIX },
  );
  await fastify.ready();

  await waitUntil(() => overlay.recorder.catalog() !== null, "the retained catalog");
}, 240_000);

afterAll(async () => {
  await fastify?.close();
  await overlay?.stop();
  if (sim !== undefined) await disconnect(sim);
  await adminPool?.end().catch(() => undefined);
  await stack?.stop();
});

describe("what the simulator publishes", () => {
  it("records the retained catalog as one row, on the privileged credential", async () => {
    await waitUntil(async () => (await countIn("gt.catalog_snapshot")) === 1, "the catalog row");
    const rows = await query<{ payload_sha256: string; unit_id: string }>(
      adminPool,
      "SELECT payload_sha256, unit_id FROM gt.catalog_snapshot",
    );
    expect(rows[0]).toMatchObject({ unit_id: UNIT, payload_sha256: catalog.source_sha256 });
  });

  it("records an injection start and its stop as two rows", async () => {
    await publishJson(sim, topics.gtInjection(UNIT), gtInjectionStart());
    await publishJson(sim, topics.gtInjection(UNIT), gtInjectionStop());
    await waitUntil(async () => (await countIn("gt.injections")) === 2, "both injection rows");

    const rows = await query<{ event: string; reason: string | null }>(
      adminPool,
      "SELECT event, reason FROM gt.injections ORDER BY event",
    );
    expect(rows).toEqual([
      { event: "start", reason: null },
      { event: "stop", reason: "cleared" },
    ]);
  });

  it("absorbs a redelivered start instead of writing a second row", async () => {
    await publishJson(sim, topics.gtInjection(UNIT), gtInjectionStart());
    await waitUntil(
      () => overlay.recorder.counters().injection.duplicates === 1,
      "the duplicate counter",
    );
    expect(await countIn("gt.injections")).toBe(2);
  });

  it("records a marker", async () => {
    await publishJson(sim, topics.gtMarker(UNIT), gtMarker());
    await waitUntil(async () => (await countIn("gt.markers")) === 1, "the marker row");
  });
});

describe("GET /api/overlay/*", () => {
  it("answers the retained catalog", async () => {
    const response = await fastify.inject({ method: "GET", url: "/api/overlay/catalog" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(catalog);
  });

  it("answers the injection window the view joined", async () => {
    const response = await fastify.inject({ method: "GET", url: "/api/overlay/injections" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          unit_id: UNIT,
          instance_id: "inj-7f3a-1",
          injection_id: "oil_cooler_fouling",
          fault_id: "oil_cooler_fouled",
          start_sim_ts: "2020-02-01T04:00:00.000Z",
          end_sim_ts: "2020-02-01T06:12:30.000Z",
          reason: "cleared",
          params: { magnitude: 1, duration_sim_min: 600 },
        },
      ],
    });
  });

  it("filters the window by the bounds the query names", async () => {
    const outside = await fastify.inject({
      method: "GET",
      url: "/api/overlay/injections?from=2021-01-01T00:00:00.000Z",
    });
    expect(outside.json()).toEqual({ items: [] });

    const inside = await fastify.inject({
      method: "GET",
      url: "/api/overlay/injections?from=2020-02-01T05:00:00.000Z&to=2020-02-01T05:30:00.000Z",
    });
    expect(inside.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it("answers the markers as gt-marker messages", async () => {
    const response = await fastify.inject({ method: "GET", url: "/api/overlay/markers" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [gtMarker()] });
  });

  it("answers 404 for an active list the simulator never published", async () => {
    const response = await fastify.inject({ method: "GET", url: "/api/overlay/active" });
    expect(response.statusCode).toBe(404);
  });
});

describe("POST /api/sim/*", () => {
  it("reaches a simulator listening on the command topic and returns its ack", async () => {
    const fakeSim = await connectAs(stack.mqtt, "sim", { clientId: "fake-sim-ack" });
    // The acknowledgement is published from the broker's message callback, which
    // cannot await it. Its QoS 1 PUBACK may therefore still be in flight once the
    // assertions below are done, and the forced disconnect in `finally` would
    // reject the publication with "Connection closed" — an unhandled rejection
    // that fails the run even though every assertion passed. Keeping the promise
    // here lets the teardown settle it first.
    const acks: Promise<void>[] = [];
    try {
      expect(await subscribeGranted(fakeSim, topics.controlCmd(UNIT))).toBe(1);
      fakeSim.on("message", (topic, raw) => {
        if (topic !== topics.controlCmd(UNIT)) return;
        const command = JSON.parse(raw.toString("utf8")) as { cmd_id: string; cmd: string };
        acks.push(
          publishJson(fakeSim, topics.controlAck(UNIT), {
            schema: "urn:fdp:schema:control-ack:v1",
            unit_id: UNIT,
            wall_ts: WALL,
            cmd_id: command.cmd_id,
            cmd: command.cmd,
            ok: true,
            error: null,
            status: {
              schema: "urn:fdp:schema:status-sim:v1",
              unit_id: UNIT,
              wall_ts: WALL,
              sim_ts: "2020-06-05T06:00:00.000Z",
              state: "playing",
              speed: 600,
              head_seq: 1,
              dataset: {
                first_ts: "2020-02-01T00:00:00.000Z",
                last_ts: "2020-09-01T03:59:50.000Z",
                rows: 1516948,
                sha256: "db30ccb4ea402e3c8bf2c99db06e288d4f2a772f6928f9dbe26a920d69793e24",
                source: "MetroPT3(AirCompressor).csv",
              },
              loop: false,
              uptime_s: 10,
            },
          }),
        );
      });

      const response = await fastify.inject({
        method: "POST",
        url: "/api/sim/jump",
        payload: { args: { preset_id: "f3_air_leak_jun05" } },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json<{ cmd_id: string; accepted: boolean; ack: { cmd: string } }>();
      expect(body.accepted).toBe(true);
      expect(body.ack).toMatchObject({ cmd: "jump", cmd_id: body.cmd_id, ok: true });
    } finally {
      await Promise.allSettled(acks);
      await disconnect(fakeSim);
    }
  });

  it("answers with a null acknowledgement when no simulator is listening", async () => {
    const started = Date.now();
    const response = await fastify.inject({ method: "POST", url: "/api/sim/play" });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: true, ack: null });
    expect(Date.now() - started).toBeLessThan(withSlack(2_500));
  });

  it("answers 400 for arguments the command does not take", async () => {
    const response = await fastify.inject({
      method: "POST",
      url: "/api/sim/speed",
      payload: { args: { speed: 4000 } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "bad_request" } });
  });
});

describe("the overlay schema after the suite", () => {
  it("is emptied by the owner, not by the overlay's own credential", async () => {
    expect(await truncateGt(adminPool)).toEqual(
      expect.arrayContaining(["injections", "markers", "catalog_snapshot"]),
    );
    expect(await countIn("gt.injections")).toBe(0);
  });
});
