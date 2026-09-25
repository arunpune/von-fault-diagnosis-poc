// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The routes that read stored records — events, decisions, episodes, cost,
// system alerts and the catalog — through `fastify.inject` with fake
// repositories. Bodies are validated against their `api-*` contract where one
// exists; the query string must reach the repository as the route says.

import { isValid, validate } from "@fdp/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeCursor } from "../persistence/cursor.ts";
import { apiServer, DECISION_STATE, fakeApiDeps, type FakeApi } from "./fake-deps.test-helper.ts";

let fake: FakeApi;
let fastify: FastifyInstance;

beforeEach(async () => {
  fake = fakeApiDeps();
  fastify = await apiServer(fake.deps);
});

afterEach(async () => {
  await fastify.close();
});

async function get(url: string) {
  return fastify.inject({ method: "GET", url });
}

/** A cursor the persisted repositories issue. */
const CURSOR = encodeCursor({ simTs: "2020-06-05T09:41:12.000000Z", id: "42" });

async function expectError(url: string, status: number, code: string): Promise<void> {
  const response = await get(url);
  expect(response.statusCode).toBe(status);
  const body: unknown = response.json();
  expect(isValid("api-error", body)).toBe(true);
  expect(body).toMatchObject({ error: { code } });
}

describe("GET /api/events/suspect and its alias /api/events", () => {
  it.each(["/api/events/suspect", "/api/events"])("%s answers an api-events page", async (path) => {
    const response = await get(path);
    expect(response.statusCode).toBe(200);
    expect(isValid("api-events", response.json())).toBe(true);
    expect(fake.calls.events).toEqual([
      { before: undefined, limit: undefined, symptom_key: undefined },
    ]);
  });

  it("passes the cursor, the limit and the symptom to the repository", async () => {
    const response = await get(
      `/api/events/suspect?before=${CURSOR}&limit=20&symptom_key=continuous_load`,
    );
    expect(response.statusCode).toBe(200);
    expect(fake.calls.events).toEqual([
      { before: CURSOR, limit: 20, symptom_key: "continuous_load" },
    ]);
  });

  it("refuses a cursor the API never issued with 400 bad_cursor", async () => {
    await expectError("/api/events/suspect?before=not-a-cursor", 400, "bad_cursor");
  });

  it("refuses a malformed symptom and a limit that is not a positive integer", async () => {
    await expectError("/api/events?symptom_key=Continuous%20Load", 400, "bad_request");
    await expectError("/api/events?limit=ten", 400, "bad_request");
  });
});

describe("GET /api/decisions", () => {
  it("answers an api-decisions page, failed decisions included", async () => {
    const response = await get("/api/decisions");
    expect(response.statusCode).toBe(200);
    const body = validate("api-decisions", response.json());
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.value.items.map((decision) => decision.status)).toEqual(["failed", "ok"]);
  });

  it("narrows the page to one episode", async () => {
    const response = await get("/api/decisions?episode_id=b71d4a09-3e52-4c88-9f61-0a2b3c4d5e6f");
    expect(response.statusCode).toBe(200);
    expect(fake.calls.decisions.at(-1)).toMatchObject({
      episode_id: "b71d4a09-3e52-4c88-9f61-0a2b3c4d5e6f",
    });
  });

  it("answers one decision with the state the backend saw", async () => {
    const response = await get("/api/decisions/6a0c8e37-2b41-4f9d-8c05-1d2e3f4a5b60");
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(isValid("decision", body)).toBe(true);
    expect(body).toMatchObject({
      decision_id: "6a0c8e37-2b41-4f9d-8c05-1d2e3f4a5b60",
      state: DECISION_STATE,
    });
  });

  it("answers 404 for a decision nobody took", async () => {
    await expectError("/api/decisions/00000000-0000-4000-8000-000000000000", 404, "not_found");
  });
});

describe("GET /api/episodes", () => {
  it("answers an api-episodes page, newest first", async () => {
    const response = await get("/api/episodes");
    expect(response.statusCode).toBe(200);
    const body = validate("api-episodes", response.json());
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    const opened = body.value.items.map((episode) => episode.opened_sim_ts);
    expect(opened).toEqual([...opened].sort().reverse());
    expect(body.value.next_cursor).toBeNull();
  });

  it("narrows the page to one status and pages with the cursor it issued", async () => {
    const first = await get("/api/episodes?status=open&limit=1");
    const page = first.json<{ items: { status: string }[]; next_cursor: string }>();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.status).toBe("open");
    expect(page.next_cursor).toEqual(expect.any(String));

    const second = await get(`/api/episodes?status=open&limit=1&before=${page.next_cursor}`);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ items: [{ status: "open" }], next_cursor: null });
  });

  it("refuses a status that is not an episode status", async () => {
    await expectError("/api/episodes?status=review", 400, "bad_request");
  });
});

describe("GET /api/cost and GET /api/cost/ledger", () => {
  it("answers the api-cost summary", async () => {
    const response = await get("/api/cost");
    expect(response.statusCode).toBe(200);
    expect(isValid("api-cost", response.json())).toBe(true);
  });

  it("answers the ledger, passing the limit through", async () => {
    const response = await get("/api/cost/ledger?limit=25");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
    expect(fake.calls.ledger).toEqual([25]);
  });

  it("refuses a ledger limit above 1000", async () => {
    await expectError("/api/cost/ledger?limit=1001", 400, "bad_request");
  });
});

describe("GET /api/alerts/system", () => {
  it("answers every alert when active is not given", async () => {
    const response = await get("/api/alerts/system");
    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: unknown[] }>();
    expect(body.items).toHaveLength(2);
    for (const item of body.items) expect(isValid("alert-system", item)).toBe(true);
  });

  it("answers only the raised alerts for active=true", async () => {
    const response = await get("/api/alerts/system?active=true");
    expect(response.json()).toMatchObject({ items: [{ state: "raised" }] });
    expect(fake.calls.alerts.at(-1)).toEqual({ active: true, limit: undefined });
  });

  it("refuses an active flag that is not true or false", async () => {
    await expectError("/api/alerts/system?active=yes", 400, "bad_request");
  });
});

describe("GET /api/catalog/faults", () => {
  it("answers every cause of the active document as catalog-entry items", async () => {
    const response = await get("/api/catalog/faults");
    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: unknown[] }>();
    expect(body.items).toHaveLength(fake.catalog.length);
    for (const item of body.items) expect(isValid("catalog-entry", item)).toBe(true);
  });

  it("answers one cause by fault_id", async () => {
    const response = await get("/api/catalog/faults/downstream_air_leak");
    expect(response.statusCode).toBe(200);
    expect(isValid("catalog-entry", response.json())).toBe(true);
    expect(response.json()).toMatchObject({ fault_id: "downstream_air_leak" });
  });

  it("answers 404 for a cause the catalog does not have", async () => {
    await expectError("/api/catalog/faults/no_such_cause", 404, "not_found");
  });
});
