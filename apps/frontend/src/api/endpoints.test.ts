// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiError, CLIENT_ERROR_CODES } from "@/api/client";
import {
  closeTicket,
  getActiveAlerts,
  getCatalogFault,
  getCost,
  getDecision,
  getDecisions,
  getEvents,
  getHealth,
  getOverlayActive,
  getOverlayCatalog,
  getOverlayInjections,
  getOverlayMarkers,
  getSeries,
  getSignals,
  getStatus,
  getTicket,
  getTickets,
  SIM_TIMEOUT_CODE,
  simCommand,
  toSeries,
} from "@/api/endpoints";
import { fixtures } from "@/test/msw/fixtures";
import { apiError } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";

interface SeenRequest {
  method: string;
  path: string;
  query: Record<string, string>;
}

let seen: SeenRequest[] = [];

function record({ request }: { request: Request }): void {
  const url = new URL(request.url);
  seen.push({
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
  });
}

beforeEach(() => {
  seen = [];
  server.events.on("request:start", record);
});

afterEach(() => {
  server.events.removeListener("request:start", record);
});

const TICKET_ID = fixtures.ticket.ticket_id;
const DECISION_ID = fixtures.decision.decision_id;

describe("the read routes", () => {
  it("reads the health, status and signal registry", async () => {
    await expect(getHealth()).resolves.toEqual(fixtures.health);
    await expect(getStatus()).resolves.toEqual(fixtures.status);
    await expect(getSignals()).resolves.toEqual(fixtures.signals);
    expect(seen.map((request) => request.path)).toEqual([
      "/api/health",
      "/api/status",
      "/api/signals",
    ]);
  });

  it("returns the degraded health body the backend answers with 503", async () => {
    const degraded = { ...fixtures.health, status: "degraded" };
    server.use(http.get("/api/health", () => HttpResponse.json(degraded, { status: 503 })));

    await expect(getHealth()).resolves.toEqual(degraded);
  });

  it("pages the suspect events on /api/events/suspect", async () => {
    await expect(getEvents()).resolves.toEqual(fixtures.events);
    await getEvents({ limit: 20, before: "cursor-1" });
    expect(seen).toEqual([
      { method: "GET", path: "/api/events/suspect", query: {} },
      { method: "GET", path: "/api/events/suspect", query: { limit: "20", before: "cursor-1" } },
    ]);
  });

  it("reads the decisions, one episode's history and one decision with its state", async () => {
    await expect(getDecisions()).resolves.toEqual(fixtures.decisions);
    const history = await getDecisions({ episodeId: fixtures.ticket.episode_id, limit: 200 });
    expect(history.items.map((decision) => decision.decision_id)).toEqual(
      fixtures.ticket.decisions.map((decision) => decision.decision_id),
    );
    await expect(getDecision(DECISION_ID)).resolves.toHaveProperty("state");
    expect(seen.map(({ path, query }) => ({ path, query }))).toEqual([
      { path: "/api/decisions", query: {} },
      {
        path: "/api/decisions",
        query: { limit: "200", episode_id: fixtures.ticket.episode_id },
      },
      { path: `/api/decisions/${DECISION_ID}`, query: {} },
    ]);
  });

  it("filters tickets by status, the Review tab included", async () => {
    const review = await getTickets("review");
    expect(review.items.map((ticket) => ticket.status)).toEqual(["review"]);
    await getTickets("all", { limit: 10 });
    expect(seen.map((request) => request.query)).toEqual([
      { status: "review" },
      { status: "all", limit: "10" },
    ]);
  });

  it("reads one ticket with its decision history", async () => {
    await expect(getTicket(TICKET_ID)).resolves.toEqual(fixtures.ticket);
  });

  it("encodes an id that is not URL-safe", async () => {
    await expect(getTicket("a/b c")).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(seen[0]?.path).toBe("/api/tickets/a%2Fb%20c");
  });

  it("reads the cost summary, the raised alerts and a catalog cause", async () => {
    await expect(getCost()).resolves.toEqual(fixtures.cost);
    await expect(getActiveAlerts()).resolves.toEqual(fixtures.alerts);
    await expect(getCatalogFault(fixtures.catalogFault.fault_id)).resolves.toEqual(
      fixtures.catalogFault,
    );
    expect(seen.map(({ path, query }) => ({ path, query }))).toEqual([
      { path: "/api/cost", query: {} },
      { path: "/api/alerts/system", query: { active: "true" } },
      { path: `/api/catalog/faults/${fixtures.catalogFault.fault_id}`, query: {} },
    ]);
  });

  it("reads the overlay, with sim windows given as instants or epoch milliseconds", async () => {
    await expect(getOverlayCatalog()).resolves.toEqual(fixtures.overlayCatalog);
    await expect(getOverlayActive()).resolves.toEqual(fixtures.overlayActive);
    await expect(
      getOverlayInjections({ from: Date.UTC(2020, 5, 5), to: "2020-06-06T00:00:00.000Z" }),
    ).resolves.toEqual(fixtures.overlayInjections);
    await expect(getOverlayMarkers()).resolves.toEqual(fixtures.overlayMarkers);
    expect(seen.map(({ path, query }) => ({ path, query }))).toEqual([
      { path: "/api/overlay/catalog", query: {} },
      { path: "/api/overlay/active", query: {} },
      {
        path: "/api/overlay/injections",
        query: { from: "2020-06-05T00:00:00.000Z", to: "2020-06-06T00:00:00.000Z" },
      },
      { path: "/api/overlay/markers", query: {} },
    ]);
  });
});

describe("the series route", () => {
  const range = { from: Date.UTC(2020, 5, 5, 9, 40), to: "2020-06-05T09:41:12.000Z" };

  it("asks /api/telemetry/series for the tags, window and point budget", async () => {
    const series = await getSeries({
      ...range,
      tags: ["line_pressure", "load_valve"],
      points: 2000,
    });

    expect(seen).toEqual([
      {
        method: "GET",
        path: "/api/telemetry/series",
        query: {
          tags: "line_pressure,load_valve",
          from: "2020-06-05T09:40:00.000Z",
          to: "2020-06-05T09:41:12.000Z",
          points: "2000",
        },
      },
    ]);
    expect(series.series.map((track) => track.tag)).toEqual([
      "line_pressure",
      "dryer_purge_pressure",
      "load_valve",
    ]);
  });

  it("asks nothing else when the route fails, not even its alias", async () => {
    server.use(http.get("/api/telemetry/series", () => apiError(404, "not_found", "no route")));

    await expect(getSeries(range)).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(seen.map((request) => request.path)).toEqual(["/api/telemetry/series"]);
  });
});

describe("toSeries", () => {
  it("reads the window, the tracks and the discontinuities of the contract body", () => {
    const body = fixtures.series["api-telemetry-series"];
    expect(toSeries(body)).toEqual({
      from: body.from,
      to: body.to,
      series: body.series.map(({ tag, kind, unit, points }) => ({ tag, kind, unit, points })),
      discontinuities: body.discontinuities,
    });
  });

  const track = { tag: "x", kind: "analog", unit: "bar", points: [] };

  it.each([
    ["a non-object", 42],
    ["a body without a window", { series: [], discontinuities: [] }],
    ["the earlier api-series window", { from_sim_ts: "a", to_sim_ts: "b", series: [] }],
    ["a body without series", { from: "a", to: "b", discontinuities: [] }],
    ["a body without discontinuities", { from: "a", to: "b", series: [] }],
    ["a track that is not an object", { from: "a", to: "b", series: [7], discontinuities: [] }],
    [
      "a track without a tag",
      { from: "a", to: "b", series: [{ ...track, tag: undefined }], discontinuities: [] },
    ],
    [
      "the earlier signal_id track",
      {
        from: "a",
        to: "b",
        series: [{ ...track, tag: undefined, signal_id: "x" }],
        discontinuities: [],
      },
    ],
    [
      "a track without a kind",
      { from: "a", to: "b", series: [{ ...track, kind: "other" }], discontinuities: [] },
    ],
    [
      "a track without a unit",
      { from: "a", to: "b", series: [{ ...track, unit: null }], discontinuities: [] },
    ],
    [
      "malformed points",
      { from: "a", to: "b", series: [{ ...track, points: [["a", "9"]] }], discontinuities: [] },
    ],
  ])("refuses %s", (_what, body) => {
    expect(() => toSeries(body)).toThrow(ApiError);
    try {
      toSeries(body);
    } catch (error) {
      expect(error).toMatchObject({ code: CLIENT_ERROR_CODES.badResponse });
    }
  });
});

describe("the write routes", () => {
  it("closes a ticket with the technician's verdict", async () => {
    let body: unknown = null;
    server.use(
      http.post("/api/tickets/:id/close", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...fixtures.tickets.items[0], status: "closed" });
      }),
    );

    await closeTicket(TICKET_ID, { verdict: "wrong", note: "Found a loose coupling instead." });

    expect(body).toEqual({ verdict: "wrong", note: "Found a loose coupling instead." });
    expect(seen[0]).toMatchObject({ method: "POST", path: `/api/tickets/${TICKET_ID}/close` });
  });

  it("posts a simulator command's arguments as { args } to /api/sim/:segment", async () => {
    let body: unknown = null;
    server.use(
      http.post("/api/sim/:cmd", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(fixtures.simCommandResult, { status: 202 });
      }),
    );

    await expect(simCommand("jump", { preset_id: "f3_air_leak_jun05" })).resolves.toEqual(
      fixtures.simCommandResult,
    );
    expect(body).toEqual({ args: { preset_id: "f3_air_leak_jun05" } });
    expect(seen[0]).toMatchObject({ method: "POST", path: "/api/sim/jump" });
  });

  it("turns a proxy timeout into sim_timeout", async () => {
    server.use(http.post("/api/sim/:cmd", () => new HttpResponse(null, { status: 504 })));

    await expect(simCommand("play", {})).rejects.toMatchObject({
      status: 504,
      code: SIM_TIMEOUT_CODE,
      message: "The simulator did not answer in time",
    });
  });

  it("passes any other failure through", async () => {
    server.use(
      http.post("/api/sim/:cmd", () =>
        apiError(503, "sim_unreachable", "the broker connection is down"),
      ),
    );

    await expect(simCommand("pause", {})).rejects.toMatchObject({
      status: 503,
      code: "sim_unreachable",
    });
  });
});
