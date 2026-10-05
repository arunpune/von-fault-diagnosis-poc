// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The REST surface and the WebSocket hub over real sockets.
 *
 * A real Fastify server listens on an ephemeral port with the routes
 * registered the way `api/index.ts` and `ws/index.ts` register them, over the
 * fake dependencies of `src/api/fake-deps.test-helper.ts`; the clients are
 * Node's own `fetch` and `WebSocket`. No container is started.
 *
 * What it proves end to end: the REST bodies survive a real HTTP round trip
 * against their contracts; a WebSocket client receives `hello` first and the
 * runtime's `snapshot` after it, a `ticket` frame as soon as the hub
 * broadcasts one, decimated `telemetry.series` frames by default and raw
 * `telemetry.samples` only once it subscribes; `ping` changes nothing; a
 * client that leaves is forgotten; and shutting the server down closes the
 * remaining sockets with 1001.
 */

import { fixturesFor } from "@fdp/contracts/testing";
import {
  isValid,
  validate,
  type Decision,
  type SnapshotPayload,
  type Ticket,
  type WsServerMessage,
} from "@fdp/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_PREFIX, apiRoutes } from "../../src/api/index.ts";
import {
  fakeApiDeps,
  TELEMETRY,
  WALL_TS,
  type FakeApi,
} from "../../src/api/fake-deps.test-helper.ts";
import { fixedClock, systemClock } from "../../src/clock.ts";
import { samplesFrom, STEP_MS } from "../../src/ws/fakes.test-helper.ts";
import { createHub, type Hub } from "../../src/ws/hub.ts";
import { WS_PATH, wsRoutes } from "../../src/ws/index.ts";
import { withSlack } from "../helpers/timing.ts";

/** A short flush keeps the test quick; the hub's default is 250 ms. */
const TELEMETRY_INTERVAL_MS = 50;

function fixture<T>(schema: string, file: string): T {
  const found = fixturesFor(schema).valid.find((candidate) => candidate.file === file);
  if (found === undefined) throw new Error(`no fixture ${schema}/${file}`);
  return structuredClone(found.data) as T;
}

const TICKET = fixture<Ticket>("ticket", "valid-opened.json");
const DECISION = fixture<Decision>("decision", "valid-von-ticket.json");
const SNAPSHOT = fixture<{ payload: SnapshotPayload }>(
  "ws-server-message",
  "valid-snapshot.json",
).payload;

let fake: FakeApi;
let hub: Hub;
let fastify: FastifyInstance;
let httpUrl: string;
let wsUrl: string;
let serverClosed = false;

/** Poll until `predicate` holds, so a test never waits longer than it must. */
async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs = withSlack(5_000),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface WsClient {
  readonly socket: WebSocket;
  /** Every frame received, parsed, in arrival order. */
  readonly frames: WsServerMessage[];
  /** Resolves with the close code once the socket has closed. */
  readonly closed: Promise<number>;
}

async function connect(): Promise<WsClient> {
  const socket = new WebSocket(wsUrl);
  const frames: WsServerMessage[] = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as WsServerMessage);
  });
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener("close", (event) => resolve(event.code));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error(`cannot open ${wsUrl}`)));
  });
  return { socket, frames, closed };
}

/** Wait for the first frame of `type` at or after position `from`. */
async function frameOf(client: WsClient, type: string, from = 0): Promise<WsServerMessage> {
  let found: WsServerMessage | undefined;
  await waitUntil(() => {
    found = client.frames.slice(from).find((frame) => frame.type === type);
    return found !== undefined;
  }, `a ${type} frame`);
  if (found === undefined) throw new Error(`no ${type} frame`);
  return found;
}

function expectEveryFrameValid(client: WsClient): void {
  const invalid = client.frames.filter((frame) => !isValid("ws-server-message", frame));
  expect(invalid).toEqual([]);
}

beforeAll(async () => {
  fake = fakeApiDeps();
  hub = createHub({
    wall: systemClock,
    info: { serverVersion: "1.0.0", decisionBackend: "rules", model: "rules-v1", unitId: "cau-7" },
    telemetryIntervalMs: TELEMETRY_INTERVAL_MS,
    snapshot: () => SNAPSHOT,
    validation: "every",
  });

  fastify = Fastify({ logger: false });
  await fastify.register(
    apiRoutes({
      health: {
        clock: fixedClock(WALL_TS),
        version: "1.0.0",
        backend: { name: "rules", model: "rules-v1" },
        links: {},
      },
      startedAt: new Date(WALL_TS),
      dashboard: fake.deps,
    }),
    { prefix: API_PREFIX },
  );
  await fastify.register(wsRoutes(hub));
  httpUrl = await fastify.listen({ port: 0, host: "127.0.0.1" });
  wsUrl = `${httpUrl.replace(/^http/, "ws")}${WS_PATH}`;
});

afterAll(async () => {
  if (!serverClosed) await fastify.close();
});

describe("REST over HTTP", () => {
  it("answers the dashboard routes with their contracts", async () => {
    const status = await fetch(`${httpUrl}/api/status`);
    expect(status.status).toBe(200);
    expect(isValid("api-status", await status.json())).toBe(true);

    const review = await fetch(`${httpUrl}/api/tickets?status=review`);
    const page = validate("api-tickets", await review.json());
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.value.items.map((ticket) => ticket.status)).toEqual(["review"]);

    const from = TELEMETRY.samples[0]?.sim_ts ?? "";
    const to = TELEMETRY.samples.at(-1)?.sim_ts ?? "";
    const series = await fetch(
      `${httpUrl}/api/telemetry/series?from=${from}&to=${to}&signals=line_pressure&points=20`,
    );
    expect(series.status).toBe(200);
    expect(isValid("api-telemetry-series", await series.json())).toBe(true);
  });

  it("closes a ticket once, then answers 409", async () => {
    const id = fake.tickets.find((ticket) => ticket.status === "open")?.ticket_id ?? "";
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "correct", note: "purge valve replaced" }),
    };

    const first = await fetch(`${httpUrl}/api/tickets/${id}/close`, request);
    expect(first.status).toBe(200);
    const closed: unknown = await first.json();
    expect(isValid("ticket", closed)).toBe(true);
    expect(closed).toMatchObject({ status: "closed", closure: { verdict: "correct" } });

    const second = await fetch(`${httpUrl}/api/tickets/${id}/close`, request);
    expect(second.status).toBe(409);
    expect(isValid("api-error", await second.json())).toBe(true);
  });

  it("answers api-error for a route that does not exist", async () => {
    const response = await fetch(`${httpUrl}/api/review`);
    expect(response.status).toBe(404);
    expect(isValid("api-error", await response.json())).toBe(true);
  });
});

describe("GET /ws", () => {
  it("sends hello first, the snapshot after it, and a ticket frame when the hub broadcasts one", async () => {
    const client = await connect();
    await frameOf(client, "snapshot");
    expect(client.frames.slice(0, 2).map((frame) => frame.type)).toEqual(["hello", "snapshot"]);
    expect(client.frames[0]).toMatchObject({
      payload: { schema_major: 1, decision_backend: "rules", model: "rules-v1", unit_id: "cau-7" },
    });

    hub.broadcast("ticket", TICKET);
    const ticket = await frameOf(client, "ticket");
    expect(ticket.payload).toEqual(TICKET);

    expectEveryFrameValid(client);
    client.socket.close(1000, "done");
    expect(await client.closed).toBe(1000);
  });

  it("feeds decimated series by default and raw samples only after subscribe; ping changes nothing", async () => {
    const client = await connect();
    await frameOf(client, "hello");

    hub.pushSamples(samplesFrom(90, (position) => ({ line_pressure: 8 + position * 0.01 })));
    const series = await frameOf(client, "telemetry.series");
    if (series.type !== "telemetry.series") throw new Error("not a series frame");
    for (const entry of series.payload.series) expect(entry.points.length).toBeLessThanOrEqual(64);
    expect(client.frames.some((frame) => frame.type === "telemetry.samples")).toBe(false);

    client.socket.send(
      JSON.stringify({ type: "subscribe", channels: ["telemetry.samples", "ticket"] }),
    );
    client.socket.send(JSON.stringify({ type: "ping" }));

    // The raw channel can only reach the client once the subscribe has landed.
    let startMs = Date.parse("2020-06-05T12:00:00.000Z");
    await waitUntil(() => {
      if (client.frames.some((frame) => frame.type === "telemetry.samples")) return true;
      hub.pushSamples(
        samplesFrom(30, () => ({ line_pressure: 9 }), { start: new Date(startMs).toISOString() }),
      );
      startMs += 30 * STEP_MS;
      return false;
    }, "a telemetry.samples frame after subscribe");

    const mark = client.frames.length;
    hub.broadcast("decision", DECISION);
    hub.broadcast("ticket", TICKET);
    await frameOf(client, "ticket", mark);
    const after = client.frames.slice(mark).map((frame) => frame.type);
    expect(after).not.toContain("decision");
    expect(after).not.toContain("telemetry.series");

    for (const frame of client.frames) {
      if (frame.type === "telemetry.samples") {
        expect(frame.payload.samples.length).toBeLessThanOrEqual(25);
      }
    }
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expectEveryFrameValid(client);

    client.socket.close(1000, "done");
    expect(await client.closed).toBe(1000);
    await waitUntil(() => hub.counters().clients === 0, "the hub to forget the client");
  });

  it("closes every socket with 1001 when the server shuts down", async () => {
    const client = await connect();
    await frameOf(client, "hello");
    expect(hub.counters().clients).toBe(1);

    await fastify.close();
    serverClosed = true;
    expect(await client.closed).toBe(1001);
    expect(hub.counters().clients).toBe(0);
  });
});
