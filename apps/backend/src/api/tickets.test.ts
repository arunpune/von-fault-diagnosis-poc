// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The ticket routes through `fastify.inject`:
// the list and its status filter (the Review tab is `?status=review`), the
// ticket with its decision history, and the technician's close — its body
// contract, the ticket message it answers, 404 for an unknown ticket and 409
// for a second verdict. There is no review route.

import { fixturesFor } from "@fdp/contracts/testing";
import { isValid, validate } from "@fdp/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { apiServer, fakeApiDeps, type FakeApi } from "./fake-deps.test-helper.ts";

let fake: FakeApi;
let fastify: FastifyInstance;

beforeEach(async () => {
  fake = fakeApiDeps();
  fastify = await apiServer(fake.deps);
});

afterEach(async () => {
  await fastify.close();
});

function ticketId(status: string): string {
  const ticket = fake.tickets.find((candidate) => candidate.status === status);
  if (ticket === undefined) throw new Error(`the fake holds no ${status} ticket`);
  return ticket.ticket_id;
}

async function close(id: string, payload: unknown) {
  return fastify.inject({
    method: "POST",
    url: `/api/tickets/${id}/close`,
    payload: payload as object,
  });
}

describe("GET /api/tickets", () => {
  it("answers every ticket by default, newest first, as api-tickets", async () => {
    const response = await fastify.inject({ method: "GET", url: "/api/tickets" });
    expect(response.statusCode).toBe(200);
    const body = validate("api-tickets", response.json());
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.value.items).toHaveLength(4);
    const opened = body.value.items.map((ticket) => ticket.opened_sim_ts);
    expect(opened).toEqual([...opened].sort().reverse());
  });

  it.each(["review", "open", "resolved", "closed"])(
    "narrows the list to status=%s",
    async (status) => {
      const response = await fastify.inject({
        method: "GET",
        url: `/api/tickets?status=${status}`,
      });
      expect(response.statusCode).toBe(200);
      const body = validate("api-tickets", response.json());
      if (!body.ok) throw new Error("api-tickets did not validate");
      expect(body.value.items.map((ticket) => ticket.status)).toEqual([status]);
    },
  );

  it("answers every ticket for status=all", async () => {
    const response = await fastify.inject({ method: "GET", url: "/api/tickets?status=all" });
    expect(response.json<{ items: unknown[] }>().items).toHaveLength(4);
  });

  it("refuses a status outside the four ticket statuses and all", async () => {
    const response = await fastify.inject({ method: "GET", url: "/api/tickets?status=pending" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "bad_request", details: { parameter: "status" } },
    });
  });

  it("has no review route: the review queue is a ticket status", async () => {
    const response = await fastify.inject({ method: "GET", url: "/api/review" });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /api/tickets/:id", () => {
  it("answers the ticket with the decisions of its episode", async () => {
    const id = ticketId("open");
    const response = await fastify.inject({ method: "GET", url: `/api/tickets/${id}` });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ ticket_id: string; decisions: unknown[] }>();
    expect(isValid("ticket", body)).toBe(true);
    expect(body.ticket_id).toBe(id);
    expect(body.decisions).toHaveLength(2);
    for (const decision of body.decisions) expect(isValid("decision", decision)).toBe(true);
  });

  it("answers 404 for an unknown ticket", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/api/tickets/00000000-0000-4000-8000-000000000000",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("POST /api/tickets/:id/close", () => {
  it("closes an open ticket on a verdict and answers the ticket message", async () => {
    const id = ticketId("open");
    const response = await close(id, {
      verdict: "correct",
      note: "valve seat worn",
      closed_by: "shift-2",
    });
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(isValid("ticket", body)).toBe(true);
    expect(body).toMatchObject({
      ticket_id: id,
      action: "closed",
      status: "closed",
      closure: { verdict: "correct", note: "valve seat worn", closed_by: "shift-2" },
    });
    expect(fake.calls.closes).toEqual([
      {
        ticketId: id,
        closure: { verdict: "correct", note: "valve seat worn", closed_by: "shift-2" },
      },
    ]);
  });

  it("closes a review ticket as well", async () => {
    const response = await close(ticketId("review"), { verdict: "wrong" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "closed", closure: { verdict: "wrong" } });
  });

  it("answers 409 for a ticket that already has a verdict", async () => {
    const response = await close(ticketId("closed"), { verdict: "correct" });
    expect(response.statusCode).toBe(409);
    const body: unknown = response.json();
    expect(isValid("api-error", body)).toBe(true);
    expect(body).toMatchObject({ error: { code: "conflict" } });
  });

  it("answers 404 for an unknown ticket", async () => {
    const response = await close("00000000-0000-4000-8000-000000000000", { verdict: "correct" });
    expect(response.statusCode).toBe(404);
  });

  it.each(fixturesFor("api-ticket-close").invalid)(
    "refuses the contract's invalid body $file with 400 and closes nothing",
    async ({ data }) => {
      const response = await close(ticketId("open"), data);
      expect(response.statusCode).toBe(400);
      const body: unknown = response.json();
      expect(isValid("api-error", body)).toBe(true);
      expect(body).toMatchObject({
        error: { code: "bad_request", details: { issues: expect.any(Array) } },
      });
      expect(fake.calls.closes).toEqual([]);
    },
  );

  it("refuses a body that is not JSON with 400", async () => {
    const response = await fastify.inject({
      method: "POST",
      url: `/api/tickets/${ticketId("open")}/close`,
      headers: { "content-type": "application/json" },
      payload: "{verdict:",
    });
    expect(response.statusCode).toBe(400);
    expect(isValid("api-error", response.json())).toBe(true);
    expect(fake.calls.closes).toEqual([]);
  });
});
