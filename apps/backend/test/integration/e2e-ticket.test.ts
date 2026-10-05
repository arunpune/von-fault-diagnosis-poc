// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telemetry to a closed ticket, end to end.
 *
 * The whole service runs — `startApp`, every connection and every timer —
 * against PostgreSQL with every migration and the fixture catalog stored as
 * init stores it, and against Mosquitto with the committed access list. The
 * test plays the gateway, publishing a replay of the unlabelled 19 May
 * episode (outside every scored window) at about two hundred batches a
 * second, and then watches the way the service's users do: the broker as the
 * read-only `eval` credential, `GET /ws` as a browser, the REST routes, and
 * the tables as their owner.
 *
 * Three runs:
 *
 *   * **von**, against the contracts' mock TypeSafe server with its
 *     `best-overlap` policy (confidence 0.9) and the SDK's retries off:
 *     suspect event → decision (`von-1.13.0`, billed at
 *     `input_tokens × 0.042 / 1e6`) → ticket opened → WebSocket frame →
 *     `GET /api/tickets` → `POST /api/tickets/:id/close {verdict}` →
 *     ticket closed, with every row in place;
 *   * **rules**, no mock at all: the same path with a review or open ticket
 *     and nothing billed;
 *   * the **February baseline**: no ticket at all.
 *
 * The recorded fixtures exist only where `make fixtures` and
 * `pnpm --filter @fdp/backend fixtures` ran; without them the suite
 * skips, and `FDP_REQUIRE_DATASET=1` turns that into a failure.
 */

import {
  isValid,
  validate,
  type ApiCost,
  type ApiTickets,
  type Decision,
  type StatusBackend,
  type SuspectEvent,
  type TelemetrySamples,
  type Ticket,
} from "@fdp/contracts";
import { MOCK_MODEL, startMockTypeSafe, type MockTypeSafe } from "@fdp/contracts/mock";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Secret } from "../../src/config/secret.ts";
import { createPool, query, queryOne, type Pool } from "../../src/db/pool.ts";
import { createVonBackend } from "../../src/decision/von/index.ts";
import type { Embedder } from "../../src/retrieval/embedder.ts";
import { FIXTURE_CATALOG, FIXTURE_LABELS } from "../fixtures/catalog/index.ts";
import { startStack, type TestStack } from "../helpers/containers.ts";
import { truncateApp } from "../helpers/db.ts";
import { hasFixture, loadFixture } from "../helpers/fixtures.ts";
import {
  chooseEmbedder,
  gatewayPublisher,
  observeBroker,
  openSocket,
  startAppOn,
  storeCatalog,
  UNIT,
  healthCounters,
  waitForBatches,
  waitUntil,
  type AppUnderTest,
  type BrokerObserver,
  type GatewayPublisher,
  type StartOptions,
  type WsClient,
} from "../helpers/runtime.ts";

/** A throwaway bearer the mock accepts; nothing like a real key. */
const MOCK_KEY = "mock-key-e2e";

const TOPICS = {
  suspect: `plant/${UNIT}/events/suspect`,
  decisions: `plant/${UNIT}/decisions`,
  tickets: `plant/${UNIT}/alerts/ticket`,
  status: `plant/${UNIT}/status/backend`,
};

/** The runtime's failure counters (`GET /api/health`), all of which must stay at zero. */
const NOTHING_LOST = {
  telemetry_failed: 0,
  telemetry_storage_errors: 0,
  mqtt_invalid: 0,
  mqtt_handler_failures: 0,
  sink_persist_failures: 0,
  sink_publish_failures: 0,
};

const HAS_FIXTURES = hasFixture("unlabelled-may19") && hasFixture("baseline-feb");

let stack: TestStack;
let admin: Pool;
let embedder: Embedder;
let may: readonly TelemetrySamples[];
let february: readonly TelemetrySamples[];

/** What one run opened, for the `afterEach` to close again. */
let open: {
  service?: AppUnderTest;
  observer?: BrokerObserver;
  socket?: WsClient;
  gateway?: GatewayPublisher;
  mock?: MockTypeSafe;
} = {};

async function run(
  env: Record<string, string>,
  decision?: StartOptions["decision"],
): Promise<{
  service: AppUnderTest;
  observer: BrokerObserver;
  socket: WsClient;
  gateway: GatewayPublisher;
}> {
  const observer = await observeBroker(stack, `plant/${UNIT}/#`);
  open.observer = observer;
  const service = await startAppOn(stack, { env, embedder, decision });
  open.service = service;
  const socket = await openSocket(service.wsUrl);
  open.socket = socket;
  const gateway = await gatewayPublisher(stack);
  open.gateway = gateway;
  return { service, observer, socket, gateway };
}

function ticketsOn(observer: BrokerObserver): Ticket[] {
  return observer.on<Ticket>(TOPICS.tickets);
}

async function getJson<T>(service: AppUnderTest, path: string): Promise<T> {
  const response = await fetch(`${service.httpUrl}${path}`);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

async function count(table: string): Promise<number> {
  const row = await queryOne<{ n: string }>(admin, `SELECT count(*) AS n FROM app.${table}`);
  return Number(row?.n ?? 0);
}

/** Close the ticket through REST and wait for the broker to say so. */
async function closeThroughRest(
  service: AppUnderTest,
  observer: BrokerObserver,
  ticket: Ticket,
): Promise<Ticket> {
  const response = await fetch(`${service.httpUrl}/api/tickets/${ticket.ticket_id}/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verdict: "correct", note: "confirmed on site", closed_by: "tech-1" }),
  });
  expect(response.status).toBe(200);
  const closed = (await response.json()) as Ticket;
  await waitUntil(
    () =>
      ticketsOn(observer).some(
        (message) => message.ticket_id === ticket.ticket_id && message.action === "closed",
      ),
    "the closed ticket on the broker",
  );
  return closed;
}

beforeAll(async () => {
  if (!HAS_FIXTURES) return;
  stack = await startStack({ migrate: true });
  admin = createPool(stack.pg.adminUrl, { applicationName: "fdp-e2e-admin" });
  ({ embedder } = await chooseEmbedder());
  may = loadFixture("unlabelled-may19").batches;
  february = loadFixture("baseline-feb").batches;
}, 240_000);

afterAll(async () => {
  await admin?.end();
  await stack?.stop();
});

beforeEach(async () => {
  if (!HAS_FIXTURES) return;
  // A fresh diagnosis schema per run, so a hydrating service starts from
  // nothing; the catalog goes back in as init would put it.
  await truncateApp(admin);
  await storeCatalog(admin, FIXTURE_CATALOG, embedder);
});

afterEach(async () => {
  await open.socket?.close();
  await open.gateway?.close();
  await open.service?.stop();
  await open.observer?.close();
  await open.mock?.close();
  open = {};
});

describe.skipIf(!HAS_FIXTURES)("telemetry to a closed ticket", () => {
  it("opens, shows, bills and closes a ticket with the Von backend against the mock", async () => {
    const mock = await startMockTypeSafe({
      port: 0,
      apiKey: MOCK_KEY,
      answerPolicy: "best-overlap",
    });
    open.mock = mock;
    const { service, observer, socket, gateway } = await run(
      { DECISION_BACKEND: "von", TYPESAFE_API_KEY: MOCK_KEY, TYPESAFE_BASE_URL: mock.url },
      {
        von: (env) =>
          createVonBackend({
            apiKey: env.typesafeApiKey ?? new Secret(""),
            baseURL: env.typesafeBaseUrl,
            model: env.vonModel,
            maxRetries: 0,
            labels: FIXTURE_LABELS,
          }),
      },
    );

    const opened = (): Ticket | undefined =>
      ticketsOn(observer).find((ticket) => ticket.action === "opened");
    const published = await gateway.publish(may, { until: () => opened() !== undefined });
    await waitUntil(() => opened() !== undefined, "an opened ticket on the broker");
    // Everything published so far is handled before the tables are compared.
    await waitForBatches(service, published);
    expect(await healthCounters(service)).toMatchObject(NOTHING_LOST);
    const ticket = opened() as Ticket;

    // The broker: suspect event → decision → ticket, each on its contract.
    const events = observer.on<SuspectEvent>(TOPICS.suspect);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => isValid("suspect-event", event))).toBe(true);
    const decided = observer
      .on<Decision>(TOPICS.decisions)
      .find((decision) => decision.decision_id === ticket.latest_decision_id);
    expect(decided).toMatchObject({ status: "ok", backend: "von", model: MOCK_MODEL });
    expect(decided?.usage.input_tokens).toBeGreaterThan(0);
    expect(decided?.cost.usd).toBeCloseTo(((decided?.usage.input_tokens ?? 0) * 0.042) / 1e6, 12);
    expect(ticket).toMatchObject({ status: "open", backend: "von", model: MOCK_MODEL });
    expect(validate("ticket", ticket).ok).toBe(true);
    expect(mock.requests.length).toBeGreaterThan(0);

    // The retained backend status names the backend that answered.
    const status = observer.on<StatusBackend>(TOPICS.status).at(-1);
    expect(status?.backend).toEqual({ name: "von", model: "von-1.13.0" });

    // The browser got the same ticket as a frame.
    await waitUntil(
      () =>
        socket.frames.some(
          (frame) =>
            frame.type === "ticket" && (frame.payload as Ticket).ticket_id === ticket.ticket_id,
        ),
      "the ticket frame on /ws",
    );
    expect(socket.frames[0]?.type).toBe("hello");
    expect(socket.frames.every((frame) => isValid("ws-server-message", frame))).toBe(true);

    // REST lists it open, and the cost summary is the ledger's.
    const listed = await getJson<ApiTickets>(service, "/api/tickets?status=open");
    expect(listed.items.map((item) => item.ticket_id)).toContain(ticket.ticket_id);
    const cost = await getJson<ApiCost>(service, "/api/cost");
    const ledger = await queryOne<{ usd: string; calls: string }>(
      admin,
      "SELECT coalesce(sum(cost_usd), 0) AS usd, count(*) AS calls FROM app.cost_ledger",
    );
    expect(cost.totals.usd).toBeCloseTo(Number(ledger?.usd), 12);
    expect(cost.totals.calls).toBe(Number(ledger?.calls));
    const billed = await queryOne<{ cost_usd: string }>(
      admin,
      "SELECT cost_usd FROM app.cost_ledger WHERE decision_id = $1",
      [ticket.latest_decision_id],
    );
    expect(Number(billed?.cost_usd)).toBeCloseTo(decided?.cost.usd ?? -1, 12);

    // A technician closes it; the broker and the database agree.
    const closed = await closeThroughRest(service, observer, ticket);
    expect(closed).toMatchObject({
      ticket_id: ticket.ticket_id,
      action: "closed",
      status: "closed",
      closure: { verdict: "correct", note: "confirmed on site", closed_by: "tech-1" },
    });

    for (const table of ["suspect_events", "decisions", "decision_candidates", "tickets"]) {
      expect(await count(table), table).toBeGreaterThan(0);
    }
    expect(await count("cost_ledger")).toBe(Number(ledger?.calls));
    const stored = await queryOne<{ status: string; verdict: string }>(
      admin,
      "SELECT t.status, c.verdict FROM app.tickets t JOIN app.ticket_closures c USING (ticket_id) " +
        "WHERE t.ticket_id = $1",
      [ticket.ticket_id],
    );
    expect(stored).toEqual({ status: "closed", verdict: "correct" });
  });

  it("opens a review or open ticket with the rules backend and bills nothing", async () => {
    const { service, observer, gateway } = await run({ DECISION_BACKEND: "rules" });

    const opened = (): Ticket | undefined =>
      ticketsOn(observer).find((ticket) => ticket.action === "opened");
    const published = await gateway.publish(may, { until: () => opened() !== undefined });
    await waitUntil(() => opened() !== undefined, "an opened ticket on the broker");
    // Everything published so far is handled before the tables are compared.
    await waitForBatches(service, published);
    expect(await healthCounters(service)).toMatchObject(NOTHING_LOST);
    const ticket = opened() as Ticket;

    expect(["review", "open"]).toContain(ticket.status);
    expect(ticket).toMatchObject({ backend: "rules", model: "rules-v1" });
    const decisions = observer.on<Decision>(TOPICS.decisions);
    expect(decisions.length).toBeGreaterThan(0);
    for (const decision of decisions) {
      expect(decision.cost.usd).toBe(0);
      expect(decision.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    }

    const listed = await getJson<ApiTickets>(service, `/api/tickets?status=${ticket.status}`);
    expect(listed.items.map((item) => item.ticket_id)).toContain(ticket.ticket_id);
    const cost = await getJson<ApiCost>(service, "/api/cost");
    expect(cost.totals.usd).toBe(0);

    await closeThroughRest(service, observer, ticket);
    for (const table of [
      "suspect_events",
      "decisions",
      "decision_candidates",
      "tickets",
      "cost_ledger",
    ]) {
      expect(await count(table), table).toBeGreaterThan(0);
    }
    const ledger = await query<{ cost_usd: string }>(admin, "SELECT cost_usd FROM app.cost_ledger");
    expect(ledger.every((row) => Number(row.cost_usd) === 0)).toBe(true);
  });

  it("opens no ticket on the February baseline", async () => {
    const { service, observer, gateway } = await run({ DECISION_BACKEND: "rules" });

    const published = await gateway.publish(february);
    await waitForBatches(service, published);

    expect(ticketsOn(observer)).toEqual([]);
    const listed = await getJson<ApiTickets>(service, "/api/tickets");
    expect(listed.items).toEqual([]);
    expect(await count("tickets")).toBe(0);
    // The telemetry itself went through: the folded minutes are in the table
    // once the service has written them at shutdown.
    await service.stop();
    open.service = undefined;
    expect(await count("telemetry_agg_1m")).toBeGreaterThan(0);
  });
});
