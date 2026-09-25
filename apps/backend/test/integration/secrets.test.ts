// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * A key never leaves the process: secrets come from the environment only and
 * never reach a log, a stored body or the image (docs/security.md).
 *
 * The service runs against the test stack with `TYPESAFE_API_KEY` set to a
 * sentinel nobody else could produce, `sentinel-<uuid>`, and the mock TypeSafe
 * server accepts exactly that bearer. The first call is answered 401 — the
 * error path is where a careless log line would print what it sent — and the
 * rest succeed, so the key is provably in use. Everything the service emits is
 * then searched for the sentinel:
 *
 *   * every log line, captured at `trace`;
 *   * every column of every table of both schemas, dumped as JSON by the
 *     owning role;
 *   * every REST body of the dashboard, the health and the overlay routes;
 *   * every WebSocket frame;
 *   * every MQTT payload the `eval` credential can see.
 *
 * Last, the image: the Dockerfile is built with a planted `.env.<id>` file
 * holding the sentinel in the build context, and `docker save` of the result
 * must hold no `.env` file and no trace of the sentinel in any layer — the
 * root `.dockerignore` keeps both out.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Decision, Ticket } from "@fdp/contracts";
import { startMockTypeSafe, type MockTypeSafe } from "@fdp/contracts/mock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Secret } from "../../src/config/secret.ts";
import { createPool, query, type Pool } from "../../src/db/pool.ts";
import { createJevBackend } from "../../src/decision/jev/index.ts";
import { FIXTURE_CATALOG, FIXTURE_LABELS } from "../fixtures/catalog/index.ts";
import { BASELINE_CYCLE, cycles, longLoadedRuns, runBatches } from "../fixtures/synthetic/index.ts";
import { startStack, type TestStack } from "../helpers/containers.ts";
import { tablesIn } from "../helpers/db.ts";
import { REPO_ROOT } from "../helpers/fixtures.ts";
import { buildBackendImage, removeImage, scanImage, BUILD_TIMEOUT_MS } from "../helpers/image.ts";
import {
  createHashEmbedder,
  gatewayPublisher,
  observeBroker,
  openSocket,
  startAppOn,
  storeCatalog,
  UNIT,
  waitForBatches,
  waitUntil,
  type AppUnderTest,
  type BrokerObserver,
  type WsClient,
} from "../helpers/runtime.ts";

const SENTINEL = `sentinel-${randomUUID()}`;

/** Every GET route the service answers, with the parameters the ones that need them take. */
function readRoutes(ticket: Ticket, decision: Decision): string[] {
  const window = "from=2020-02-03T00:00:00.000Z&to=2020-02-10T00:00:00.000Z";
  return [
    "/api/health",
    "/api/status",
    "/api/signals",
    "/api/telemetry/latest",
    "/api/features",
    `/api/telemetry/series?${window}&points=200`,
    `/api/alarms/native?${window}`,
    "/api/events/suspect",
    "/api/decisions",
    `/api/decisions/${decision.decision_id}`,
    "/api/episodes",
    "/api/tickets",
    `/api/tickets/${ticket.ticket_id}`,
    "/api/cost",
    "/api/cost/ledger",
    "/api/alerts/system",
    "/api/catalog/faults",
    "/api/overlay/catalog",
    "/api/overlay/active",
    "/api/overlay/injections",
    "/api/overlay/markers",
  ];
}

describe("the sentinel key through a running service", () => {
  let stack: TestStack;
  let admin: Pool;
  let mock: MockTypeSafe;
  let service: AppUnderTest;
  let observer: BrokerObserver;
  let socket: WsClient;
  const bodies: { path: string; status: number; text: string }[] = [];
  const rows: { table: string; text: string }[] = [];

  beforeAll(async () => {
    stack = await startStack({ migrate: true });
    admin = createPool(stack.pg.adminUrl, { applicationName: "fdp-secrets-admin" });
    await storeCatalog(admin, FIXTURE_CATALOG, createHashEmbedder());
    mock = await startMockTypeSafe({ port: 0, apiKey: SENTINEL, answerPolicy: "best-overlap" });
    mock.failNext(401);

    observer = await observeBroker(stack, "#");
    service = await startAppOn(stack, {
      env: {
        LOG_LEVEL: "trace",
        DECISION_BACKEND: "jev",
        TYPESAFE_API_KEY: SENTINEL,
        TYPESAFE_BASE_URL: mock.url,
      },
      decision: {
        jev: (env) =>
          createJevBackend({
            apiKey: env.typesafeApiKey ?? new Secret(""),
            baseURL: env.typesafeBaseUrl,
            model: env.jevModel,
            maxRetries: 0,
            labels: FIXTURE_LABELS,
          }),
      },
    });
    socket = await openSocket(service.wsUrl);

    // Ordinary cycles, then the long runs that make detection ask for decisions.
    const batches = runBatches([...cycles(BASELINE_CYCLE, 3), ...longLoadedRuns(20).phases]);
    const opened = (): Ticket | undefined =>
      observer
        .on<Ticket>(`plant/${UNIT}/alerts/ticket`)
        .find((ticket) => ticket.action === "opened");
    const gateway = await gatewayPublisher(stack);
    try {
      const published = await gateway.publish(batches, { until: () => opened() !== undefined });
      await waitUntil(() => opened() !== undefined, "an opened ticket");
      await waitForBatches(service, published);
    } finally {
      await gateway.close();
    }

    const ticket = opened() as Ticket;
    const decision = observer
      .on<Decision>(`plant/${UNIT}/decisions`)
      .find((candidate) => candidate.decision_id === ticket.latest_decision_id) as Decision;
    for (const path of readRoutes(ticket, decision)) {
      const response = await fetch(`${service.httpUrl}${path}`);
      bodies.push({ path, status: response.status, text: await response.text() });
    }
    const close = await fetch(`${service.httpUrl}/api/tickets/${ticket.ticket_id}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "wrong", note: "not the cause" }),
    });
    bodies.push({ path: "POST close", status: close.status, text: await close.text() });

    // Stop first: the last rows, the last frames and the last log lines are in.
    await socket.close();
    await service.stop();
    for (const schema of ["app", "gt"] as const) {
      for (const table of await tablesIn(admin, schema)) {
        const dumped = await query<{ row: string }>(
          admin,
          `SELECT row_to_json(t)::text AS row FROM "${schema}"."${table}" t`,
        );
        for (const { row } of dumped) rows.push({ table: `${schema}.${table}`, text: row });
      }
    }
  }, 240_000);

  afterAll(async () => {
    await observer?.close();
    await mock?.close();
    await admin?.end();
    await stack?.stop();
  });

  it("used the key: the provider refused one call and answered the rest", () => {
    const decisions = observer.on<Decision>(`plant/${UNIT}/decisions`);
    expect(decisions[0]).toMatchObject({ status: "failed", error: { kind: "auth" } });
    expect(decisions.some((decision) => decision.status === "ok")).toBe(true);
  });

  it("appears in no log line", () => {
    expect(service.logs.length).toBeGreaterThan(50);
    expect(service.logs.some((line) => line.includes('"msg":"backend started"'))).toBe(true);
    expect(service.logs.some((line) => line.includes('"msg":"incoming request"'))).toBe(true);
    expect(service.logs.filter((line) => line.includes(SENTINEL))).toEqual([]);
  });

  it("appears in no column of any table of either schema", () => {
    const tables = new Set(rows.map((row) => row.table));
    for (const expected of [
      "app.decisions",
      "app.tickets",
      "app.suspect_events",
      "app.cost_ledger",
    ]) {
      expect(tables).toContain(expected);
    }
    expect(rows.filter((row) => row.text.includes(SENTINEL)).map((row) => row.table)).toEqual([]);
  });

  it("appears in no REST body", () => {
    expect(bodies.filter((body) => body.status === 200).length).toBeGreaterThan(15);
    expect(bodies.filter((body) => body.text.includes(SENTINEL)).map((body) => body.path)).toEqual(
      [],
    );
  });

  it("appears in no WebSocket frame", () => {
    expect(socket.raw.length).toBeGreaterThan(2);
    expect(socket.raw.filter((frame) => frame.includes(SENTINEL))).toEqual([]);
  });

  it("appears in no MQTT payload", () => {
    expect(observer.messages.length).toBeGreaterThan(10);
    expect(
      observer.messages.filter((message) => message.raw.includes(SENTINEL)).map((m) => m.topic),
    ).toEqual([]);
  });
});

describe("the backend image", () => {
  const tag = `fdp-backend:it-secrets-${randomUUID().slice(0, 8)}`;
  const planted = join(REPO_ROOT, `.env.fdp-sentinel-${randomUUID().slice(0, 8)}`);
  let workDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "fdp-image-"));
    writeFileSync(planted, `TYPESAFE_API_KEY=${SENTINEL}\n`, { mode: 0o600 });
    try {
      await buildBackendImage(tag);
    } finally {
      rmSync(planted, { force: true });
    }
  }, BUILD_TIMEOUT_MS);

  afterAll(() => {
    rmSync(planted, { force: true });
    removeImage(tag);
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
  });

  it("holds no .env file and no trace of a key planted in the build context", () => {
    const scan = scanImage(tag, SENTINEL, workDir);

    expect(scan.layers).toBeGreaterThan(0);
    expect(scan.envFiles).toEqual([]);
    expect(scan.hits).toEqual([]);
  }, 300_000);
});
