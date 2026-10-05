// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The fake backend as the browser sees it: the servers e2e/launch.ts starts, reached through
// `vite preview`'s `/api` and `/ws` proxy exactly as the page reaches them, plus the control API
// at `FAKE_BACKEND_URL`. Every REST body and every WebSocket frame is checked against the contract
// schemas; the preset and injection menus against the tables the README tour depends on.

import WebSocket from "ws";

import { expect, test, type FakeBackendControl } from "../helpers.ts";
import { contractIssues } from "./contract.ts";

import type { APIRequestContext } from "@playwright/test";

interface Frame {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** A WebSocket through the preview proxy that keeps every frame it receives. */
interface Listener {
  readonly frames: Frame[];
  readonly socket: WebSocket;
  closed: Promise<number>;
  of(type: string): Frame[];
  close(): void;
}

function listen(baseURL: string): Promise<Listener> {
  const socket = new WebSocket(`${baseURL.replace(/^http/, "ws")}/ws`);
  const frames: Frame[] = [];
  const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
  socket.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString("utf8")) as Frame));
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () =>
      resolve({
        frames,
        socket,
        closed,
        of: (type) => frames.filter((frame) => frame.type === type),
        close: () => socket.close(),
      }),
    );
  });
}

async function simCommand(
  request: APIRequestContext,
  segment: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await request.post(`/api/sim/${segment}`, { data: { args } });
  expect(response.status(), segment).toBe(202);
  const body = (await response.json()) as Record<string, unknown>;
  expect(contractIssues("api-sim-command-result", body), segment).toEqual([]);
  return body;
}

async function getValid(
  request: APIRequestContext,
  path: string,
  schema: string,
): Promise<Record<string, unknown>> {
  const response = await request.get(path);
  expect(response.status(), path).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(contractIssues(schema, body), path).toEqual([]);
  return body;
}

/** Play at 3600× from the F3 preset and wait for the ticket the scripted pipeline opens. */
async function runF3(
  request: APIRequestContext,
  status: "open" | "review",
): Promise<Record<string, unknown>> {
  await simCommand(request, "speed", { speed: 3600 });
  await simCommand(request, "play");
  await simCommand(request, "jump", { preset_id: "f3_air_leak_jun05" });
  let ticket: Record<string, unknown> | undefined;
  await expect
    .poll(
      async () => {
        const body = (await (await request.get(`/api/tickets?status=${status}`)).json()) as {
          items: Record<string, unknown>[];
        };
        ticket = body.items[0];
        return body.items.length;
      },
      { timeout: 20_000 },
    )
    .toBe(1);
  return ticket ?? {};
}

function control(fakeBackend: FakeBackendControl | null): FakeBackendControl {
  if (fakeBackend === null) {
    throw new Error("the fake backend specs run in mock mode only");
  }
  return fakeBackend;
}

test.describe("the fake backend behind vite preview", () => {
  test.beforeEach(async ({ fakeBackend }) => {
    await control(fakeBackend).reset();
  });

  test.afterAll(async ({ playwright }) => {
    const reset = await playwright.request.newContext({ baseURL: process.env.FAKE_BACKEND_URL });
    await reset.post("/__test/reset", { data: { backend: "von" } });
    await reset.dispose();
  });

  test("every REST route answers through the proxy with a contract-valid body", async ({
    request,
  }) => {
    await getValid(request, "/api/health", "api-health");
    await getValid(request, "/api/signals", "api-signals");
    const ticket = await runF3(request, "open");
    // Paused, so the injection's own script cannot add a second decision while the routes are read.
    await simCommand(request, "pause");
    const inject = await simCommand(request, "inject", { injection_id: "oil_cooler_fouling" });
    expect(inject).toMatchObject({ ack: { ok: true, instance_id: expect.any(String) } });

    const status = await getValid(request, "/api/status", "api-status");
    expect(status).toMatchObject({
      sim: { state: "paused", speed: 3600 },
      injections_active: [{ injection_id: "oil_cooler_fouling" }],
    });
    const series = await getValid(
      request,
      "/api/telemetry/series?tags=line_pressure,dryer_purge_pressure,load_valve&from=2020-06-05T00:00:00.000Z&to=2020-06-06T00:00:00.000Z&points=200",
      "api-telemetry-series",
    );
    expect(series.discontinuities).toEqual(["2020-06-05T06:00:00.000Z"]);
    await getValid(
      request,
      "/api/series?from=2020-06-05T00:00:00.000Z&to=2020-06-06T00:00:00.000Z",
      "api-telemetry-series",
    );
    const events = await getValid(request, "/api/events/suspect?limit=10", "api-events");
    expect(events.items).toHaveLength(1);
    await getValid(request, "/api/events", "api-events");
    const decisions = await getValid(request, "/api/decisions", "api-decisions");
    const [decision] = decisions.items as { decision_id: string; episode_id: string }[];
    const detail = await getValid(
      request,
      `/api/decisions/${decision?.decision_id ?? ""}`,
      "decision",
    );
    expect(detail.state).toBeDefined();
    await getValid(
      request,
      `/api/decisions?episode_id=${decision?.episode_id ?? ""}`,
      "api-decisions",
    );
    for (const filter of ["review", "open", "resolved", "closed", "all"]) {
      await getValid(request, `/api/tickets?status=${filter}`, "api-tickets");
    }
    const ticketDetail = await getValid(
      request,
      `/api/tickets/${String(ticket.ticket_id)}`,
      "ticket",
    );
    expect(ticketDetail.decisions).toHaveLength(1);
    const cost = await getValid(request, "/api/cost", "api-cost");
    expect(cost.totals).toMatchObject({ usd: 0.0001302, calls: 1, input_tokens: 3100 });
    const alerts = await request.get("/api/alerts/system?active=true");
    expect(await alerts.json()).toEqual({ items: [] });
    await getValid(request, "/api/catalog/faults/dryer_purge_leak", "catalog-entry");
    await getValid(request, "/api/catalog/faults/oil_cooler_fouled", "catalog-entry");
    await getValid(request, "/api/overlay/catalog", "gt-catalog");
    await getValid(request, "/api/overlay/active", "gt-injection-active");
    const markers = (await (await request.get("/api/overlay/markers")).json()) as {
      items: unknown[];
    };
    expect(markers.items).toHaveLength(1);
    expect(markers.items.every((marker) => contractIssues("gt-marker", marker).length === 0)).toBe(
      true,
    );
    const intervals = (await (
      await request.get("/api/overlay/injections?from=2020-06-05T00:00:00.000Z")
    ).json()) as {
      items: unknown[];
    };
    expect(intervals.items).toMatchObject([
      { injection_id: "oil_cooler_fouling", end_sim_ts: null },
    ]);

    const refused = await request.post(`/api/tickets/${String(ticket.ticket_id)}/close`, {
      data: { outcome: "correct" },
    });
    expect(refused.status()).toBe(400);
    expect(contractIssues("api-error", await refused.json())).toEqual([]);
    const closed = await request.post(`/api/tickets/${String(ticket.ticket_id)}/close`, {
      data: { verdict: "correct", note: "purge valve replaced" },
    });
    expect(closed.status()).toBe(200);
    const closedTicket = (await closed.json()) as Record<string, unknown>;
    expect(contractIssues("ticket", closedTicket)).toEqual([]);
    expect(closedTicket).toMatchObject({ status: "closed", closure: { verdict: "correct" } });

    for (const [path, code] of [
      ["/api/decisions/nope", 404],
      ["/api/tickets/nope", 404],
      ["/api/catalog/faults/nope", 404],
      ["/api/tickets?status=pending", 400],
      ["/api/telemetry/series?from=2020-06-05T00:00:00.000Z", 400],
      ["/api/nothing-here", 404],
    ] as const) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(code);
      expect(contractIssues("api-error", await response.json()), path).toEqual([]);
    }
  });

  test("the WebSocket greets, feeds decimated telemetry and pushes the pipeline's frames", async ({
    request,
    baseURL,
  }) => {
    const socket = await listen(baseURL ?? "");
    await runF3(request, "open");
    await expect.poll(() => socket.of("cost.update").length, { timeout: 10_000 }).toBe(1);
    socket.close();

    expect(socket.frames.slice(0, 2).map((frame) => frame.type)).toEqual(["hello", "snapshot"]);
    expect(socket.frames[0]?.payload).toMatchObject({
      schema_major: 1,
      decision_backend: "von",
      model: "von-1.13.0",
    });
    const series = socket.of("telemetry.series");
    expect(series.length).toBeGreaterThan(2);
    expect(series.some((frame) => frame.payload.discontinuity === true)).toBe(true);
    expect(socket.of("telemetry.samples")).toEqual([]);
    const pipeline = socket.frames
      .map((frame) => frame.type)
      .filter((type) => ["event.suspect", "decision", "ticket", "cost.update"].includes(type));
    expect(pipeline).toEqual(["event.suspect", "decision", "ticket", "cost.update"]);
    for (const type of ["status.sim", "overlay.marker"]) {
      expect(socket.of(type).length, type).toBeGreaterThan(0);
    }
    for (const frame of socket.frames) {
      expect(contractIssues("ws-server-message", frame), frame.type).toEqual([]);
    }
  });

  test("a socket that subscribes to telemetry.samples gets raw frames of at most 25 samples", async ({
    request,
    baseURL,
  }) => {
    const socket = await listen(baseURL ?? "");
    socket.socket.send(JSON.stringify({ type: "subscribe", channels: ["telemetry.samples"] }));
    await simCommand(request, "speed", { speed: 3600 });
    await simCommand(request, "play");
    await expect
      .poll(() => socket.of("telemetry.samples").length, { timeout: 5_000 })
      .toBeGreaterThan(3);
    socket.close();
    const sizes = socket
      .of("telemetry.samples")
      .map((frame) => (frame.payload.samples as unknown[]).length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(25);
    expect(socket.of("telemetry.series")).toEqual([]);
  });

  test("/__test/emit pushes any frame and keeps the record it carries", async ({
    fakeBackend,
    request,
    baseURL,
  }) => {
    const socket = await listen(baseURL ?? "");
    const alert = {
      schema: "urn:fdp:schema:alert-system:v1",
      unit_id: "cau-7",
      wall_ts: "2026-09-23T08:00:00.000Z",
      alert_id: "0f8f3b0a-1d3a-4f5e-9c2b-6a7d8e9f0a1b",
      kind: "telemetry_silent",
      state: "raised",
      since_wall_ts: "2026-09-23T07:59:30.000Z",
      details: { timeout_s: 15, message: "No telemetry sample arrived for 15 s." },
    } as const;
    await control(fakeBackend).emit({ type: "alert.system", payload: alert });
    await expect.poll(() => socket.of("alert.system").length).toBe(1);
    socket.close();
    expect(socket.of("alert.system")[0]?.payload).toEqual(alert);
    const active = (await (await request.get("/api/alerts/system?active=true")).json()) as {
      items: unknown[];
    };
    expect(active.items).toEqual([alert]);
  });

  test("/__test/stream replays at its own rate whatever the speed, then restores the replay", async ({
    fakeBackend,
    request,
  }) => {
    await simCommand(request, "speed", { speed: 1 });
    const before = Date.parse(
      ((await (await request.get("/api/status")).json()) as { sim: { sim_ts: string } }).sim.sim_ts,
    );
    await control(fakeBackend).stream(200, 2);
    await expect
      .poll(
        async () =>
          ((await (await request.get("/api/status")).json()) as { sim: { state: string } }).sim
            .state,
        {
          timeout: 10_000,
        },
      )
      .toBe("stopped");
    const after = (await (await request.get("/api/status")).json()) as {
      sim: { sim_ts: string; speed: number };
    };
    // 200 samples a second for two seconds, ten simulated seconds each: about 4,000 s of data time.
    const advancedS = (Date.parse(after.sim.sim_ts) - before) / 1000;
    expect(advancedS).toBeGreaterThan(3600);
    expect(advancedS).toBeLessThan(4400);
    expect(after.sim.speed).toBe(1);
  });

  test("/__test/restart-ws closes every socket and a new one is greeted again", async ({
    fakeBackend,
    baseURL,
  }) => {
    const first = await listen(baseURL ?? "");
    await control(fakeBackend).restartWs();
    expect(await first.closed).toBe(1012);
    const second = await listen(baseURL ?? "");
    await expect
      .poll(() => second.frames.map((frame) => frame.type).slice(0, 2))
      .toEqual(["hello", "snapshot"]);
    second.close();
  });

  test("/__test/reset with the rules backend opens a review ticket after the F3 jump", async ({
    fakeBackend,
    request,
    baseURL,
  }) => {
    await control(fakeBackend).reset("rules");
    const socket = await listen(baseURL ?? "");
    const ticket = await runF3(request, "review");
    socket.close();
    expect(socket.frames[0]?.payload).toMatchObject({
      decision_backend: "rules",
      model: "rules-v1",
    });
    expect(ticket).toMatchObject({
      status: "review",
      backend: "rules",
      fault_id: "dryer_purge_leak",
    });
    const cost = (await (await request.get("/api/cost")).json()) as { totals: { calls: number } };
    expect(cost.totals.calls).toBe(0);
    const closed = await request.post(`/api/tickets/${String(ticket.ticket_id)}/close`, {
      data: { verdict: "correct" },
    });
    expect(closed.status()).toBe(200);
  });

  test("the preset and injection menus carry the ids and labels the README tour uses", async ({
    request,
  }) => {
    const catalog = (await (await request.get("/api/overlay/catalog")).json()) as {
      presets: { presets: Record<string, unknown>[] };
      injections: { injection_id: string; label: string; fault_id: string; params: unknown[] }[];
      failures: { failures: { id: string }[] };
    };
    expect(
      catalog.presets.presets.map(
        ({ preset_id, label, kind, sim_ts, lead_in_min, failure_id }) => ({
          preset_id,
          label,
          kind,
          sim_ts,
          lead_in_min,
          failure_id,
        }),
      ),
    ).toEqual([
      {
        preset_id: "baseline_feb",
        label: "Normal operation – 1 Feb 2020",
        kind: "baseline",
        sim_ts: "2020-02-01T00:00:00.000Z",
        lead_in_min: 0,
        failure_id: null,
      },
      {
        preset_id: "f1_air_leak_apr18",
        label: "Air leak – 18 Apr 2020",
        kind: "failure",
        sim_ts: "2020-04-18T00:00:00.000Z",
        lead_in_min: 120,
        failure_id: "F1",
      },
      {
        preset_id: "f2_air_leak_may30",
        label: "Air leak – 30 May 2020",
        kind: "failure",
        sim_ts: "2020-05-29T23:30:00.000Z",
        lead_in_min: 330,
        failure_id: "F2",
      },
      {
        preset_id: "f3_air_leak_jun05",
        label: "Air leak – 5 Jun 2020",
        kind: "failure",
        sim_ts: "2020-06-05T10:00:00.000Z",
        lead_in_min: 240,
        failure_id: "F3",
      },
      {
        preset_id: "f4_precursor_jul14",
        label: "Air leak precursor – 14 Jul 2020",
        kind: "precursor",
        sim_ts: "2020-07-14T21:30:00.000Z",
        lead_in_min: 0,
        failure_id: "F4",
      },
      {
        preset_id: "f4_air_leak_jul15",
        label: "Air leak – 15 Jul 2020",
        kind: "failure",
        sim_ts: "2020-07-15T14:30:00.000Z",
        lead_in_min: 90,
        failure_id: "F4",
      },
      {
        preset_id: "unlabelled_leak_may19",
        label: "Unlabelled leak – 19 May 2020",
        kind: "diagnostic",
        sim_ts: "2020-05-19T22:22:00.000Z",
        lead_in_min: 142,
        failure_id: null,
      },
      {
        preset_id: "frozen_logger_jun22",
        label: "Frozen logger – 22 Jun 2020",
        kind: "diagnostic",
        sim_ts: "2020-06-22T15:06:00.000Z",
        lead_in_min: 66,
        failure_id: null,
      },
      {
        preset_id: "depot_lps_jul31",
        label: "Depot depressurisation – 31 Jul 2020",
        kind: "diagnostic",
        sim_ts: "2020-07-31T01:35:00.000Z",
        lead_in_min: 30,
        failure_id: null,
      },
    ]);
    expect(
      catalog.injections.map(({ injection_id, label, fault_id }) => ({
        injection_id,
        label,
        fault_id,
      })),
    ).toEqual([
      {
        injection_id: "oil_cooler_fouling",
        label: "Oil cooler fouling",
        fault_id: "oil_cooler_fouled",
      },
      {
        injection_id: "high_ambient_temperature",
        label: "High ambient temperature",
        fault_id: "high_ambient_temperature",
      },
      { injection_id: "heavy_air_demand", label: "Heavy air demand", fault_id: "high_air_demand" },
      {
        injection_id: "air_leak_downstream",
        label: "Air leak downstream",
        fault_id: "downstream_air_leak",
      },
      {
        injection_id: "intake_valve_sticking",
        label: "Intake valve sticking",
        fault_id: "intake_valve_not_opening",
      },
      {
        injection_id: "dryer_tower_switching_failure",
        label: "Dryer tower switching failure",
        fault_id: "tower_changeover_valve_fault",
      },
      {
        injection_id: "separator_drain_blocked",
        label: "Separator drain blocked",
        fault_id: "condensate_drain_blocked",
      },
      { injection_id: "motor_overload", label: "Motor overload", fault_id: "airend_bearing_wear" },
      {
        injection_id: "oil_temperature_sensor_fault",
        label: "Oil temperature sensor fault",
        fault_id: "oil_temperature_sensor_fault",
      },
    ]);
    expect(catalog.injections.every((entry) => entry.params.length > 0)).toBe(true);
    expect(catalog.failures.failures.map((failure) => failure.id)).toEqual([
      "F1",
      "F2",
      "F3",
      "F4",
      "F4b",
    ]);
  });

  test("the dashboard loads against the fake and every /api request it makes succeeds", async ({
    page,
  }) => {
    const answers: { url: string; status: number }[] = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith("/api/")) {
        answers.push({ url: response.url(), status: response.status() });
      }
    });
    await page.goto("/");
    await expect.poll(() => answers.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.waitForLoadState("networkidle");
    expect(answers.filter((answer) => answer.status >= 400)).toEqual([]);
  });
});
