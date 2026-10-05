// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The routes that read the live state — status, signals, series, the latest
// sample, the feature frame and the native alarms — through `fastify.inject`
// with fake dependencies. Every body that has a contract is validated against
// it; every refused query answers `api-error` with the parameter named.

import { isValid, SIGNALS, validate } from "@fdp/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApiDeps } from "./deps.ts";
import {
  apiServer,
  fakeApiDeps,
  NATIVE_ALARMS,
  runtimeStatus,
  TELEMETRY,
  type FakeApi,
} from "./fake-deps.test-helper.ts";

let fake: FakeApi;
let fastify: FastifyInstance;

beforeEach(async () => {
  fake = fakeApiDeps();
  fastify = await apiServer(fake.deps);
});

afterEach(async () => {
  await fastify.close();
});

/** Serve `deps` instead of the default fakes for the rest of the test. */
async function serve(deps: ApiDeps): Promise<void> {
  await fastify.close();
  fastify = await apiServer(deps);
}

async function get(url: string) {
  return fastify.inject({ method: "GET", url });
}

/** A 400 in the `api-error` shape, naming the parameter at fault. */
async function expectBadRequest(url: string, parameter: string): Promise<void> {
  const response = await get(url);
  expect(response.statusCode).toBe(400);
  const body: unknown = response.json();
  expect(isValid("api-error", body)).toBe(true);
  expect(body).toMatchObject({ error: { code: "bad_request", details: { parameter } } });
}

const FIRST = TELEMETRY.samples[0]?.sim_ts ?? "";
const LAST = TELEMETRY.samples.at(-1)?.sim_ts ?? "";

describe("GET /api/status", () => {
  it("answers api-status with the runtime's picture, the gate thresholds and the persistence", async () => {
    const response = await get("/api/status");
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(isValid("api-status", body)).toBe(true);
    expect(body).toMatchObject({
      gate: { ticket_min_confidence: 0.85, review_min_confidence: 0.6, persist_sim_min: 1 },
      backend: { backend: { name: "von" } },
      alerts_active: [{ state: "raised" }],
    });
    expect(body).not.toHaveProperty("features");
  });

  it("reports the thresholds of the running backend: Von's own pair, GATE_* for the others", async () => {
    // The gate applies VON_GATE_* to Von and GATE_* to the rules and llm backends,
    // and the status says what the running gate applies.
    const gate = {
      ticketMinConfidence: 0.85,
      reviewMinConfidence: 0.6,
      persistSimMin: 1,
      von: { ticketMinConfidence: 0.9, reviewMinConfidence: 0.7 },
    };
    await serve({ ...fake.deps, env: { gate, decisionBackend: "von" } });
    expect((await get("/api/status")).json()).toMatchObject({
      gate: { ticket_min_confidence: 0.9, review_min_confidence: 0.7, persist_sim_min: 1 },
    });
    await serve({ ...fake.deps, env: { gate, decisionBackend: "rules" } });
    expect((await get("/api/status")).json()).toMatchObject({
      gate: { ticket_min_confidence: 0.85, review_min_confidence: 0.6, persist_sim_min: 1 },
    });
  });

  it("answers 500 without details when the runtime reports an off-contract status", async () => {
    const broken = { ...runtimeStatus(), backend: null };
    await serve({ ...fake.deps, runtime: { status: () => broken as never } });
    const response = await get("/api/status");
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "internal_error", message: "the request failed on the server" },
    });
  });
});

describe("GET /api/signals", () => {
  it("answers every registry signal in register order, as api-signals", async () => {
    const response = await get("/api/signals");
    expect(response.statusCode).toBe(200);
    const body = validate("api-signals", response.json());
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.value.signals.map((signal) => signal.signal_id)).toEqual(
      SIGNALS.map((signal) => signal.tag),
    );
  });

  it("names the English label, the panel tag, the kind and the source", async () => {
    const body = validate("api-signals", (await get("/api/signals")).json());
    if (!body.ok) throw new Error("api-signals did not validate");
    const byId = new Map(body.value.signals.map((signal) => [signal.signal_id, signal]));

    expect(byId.get("line_pressure")).toMatchObject({
      label: "Line pressure",
      panel_label: "P2",
      unit: "bar",
      kind: "analog",
      metropt_column: "TP3",
      source: "recorded",
      normal_bands: { loaded: [8.4, 9.8], unloaded: [8.2, 9.8] },
    });
    expect(byId.get("oil_level_ok")).toMatchObject({ kind: "digital", unit: "", scale: 1 });
    expect(byId.get("ambient_temperature")).toMatchObject({
      metropt_column: null,
      source: "synthetic",
    });
    expect(byId.get("oil_level_ok")).not.toHaveProperty("normal_bands");
  });
});

describe("GET /api/telemetry/series and its alias /api/series", () => {
  it.each(["/api/telemetry/series", "/api/series"])(
    "%s answers api-telemetry-series from the ring for the named tags",
    async (path) => {
      const response = await get(
        `${path}?from=${FIRST}&to=${LAST}&signals=line_pressure,load_valve&points=10`,
      );
      expect(response.statusCode).toBe(200);
      const body = validate("api-telemetry-series", response.json());
      expect(body.ok).toBe(true);
      if (!body.ok) return;
      expect(body.value.source).toBe("ring");
      expect(body.value.series.map((entry) => entry.tag)).toEqual(["line_pressure", "load_valve"]);
      const [pressure, valve] = body.value.series;
      expect(pressure?.points.length).toBeGreaterThan(0);
      expect(pressure?.points.length).toBeLessThanOrEqual(10);
      expect(valve?.kind).toBe("digital");
    },
  );

  it("accepts the list under the name the user interface uses, tags", async () => {
    const response = await get(`/api/series?from=${FIRST}&to=${LAST}&tags=oil_temperature`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ series: [{ tag: "oil_temperature" }] });
  });

  it("answers every registry tag when the request names none", async () => {
    const response = await get(`/api/series?from=${FIRST}&to=${LAST}`);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ series: { tag: string }[] }>();
    expect(body.series.map((entry) => entry.tag)).toEqual(SIGNALS.map((signal) => signal.tag));
  });

  it("refuses a window without both ends, or backwards", async () => {
    await expectBadRequest(`/api/series?to=${LAST}`, "from");
    await expectBadRequest(`/api/series?from=${FIRST}`, "to");
    await expectBadRequest(`/api/series?from=${LAST}&to=${FIRST}`, "from");
    await expectBadRequest(`/api/series?from=yesterday&to=${LAST}`, "from");
  });

  it("refuses more than 2000 points, a point count that is not a number, and malformed tags", async () => {
    await expectBadRequest(`/api/series?from=${FIRST}&to=${LAST}&points=2001`, "points");
    await expectBadRequest(`/api/series?from=${FIRST}&to=${LAST}&points=-3`, "points");
    await expectBadRequest(
      `/api/series?from=${FIRST}&to=${LAST}&signals=Line%20Pressure`,
      "signals",
    );
  });

  it("refuses a parameter given twice", async () => {
    await expectBadRequest(`/api/series?from=${FIRST}&from=${FIRST}&to=${LAST}`, "from");
  });
});

describe("GET /api/telemetry/latest and GET /api/features", () => {
  it("answers the newest sample and the machine state derived from it", async () => {
    const response = await get("/api/telemetry/latest");
    expect(response.statusCode).toBe(200);
    const body = response.json<{ sample: { seq: number }; machine_state: { mode: string } }>();
    expect(body.sample.seq).toBe(TELEMETRY.samples.at(-1)?.seq);
    expect(["loaded", "unloaded", "off"]).toContain(body.machine_state.mode);
  });

  it("answers the current feature frame for debugging", async () => {
    const response = await get("/api/features");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ frame: { sim_ts: expect.any(String) } });
  });

  it("answers null for both before the first sample", async () => {
    await serve({
      ...fake.deps,
      ingest: { ...fake.deps.ingest, latest: () => undefined },
      detector: { frame: () => undefined },
    });
    expect((await get("/api/telemetry/latest")).json()).toEqual({
      sample: null,
      machine_state: null,
    });
    expect((await get("/api/features")).json()).toEqual({ frame: null });
  });
});

describe("GET /api/alarms/native", () => {
  it("answers the transitions of an open window when no bounds are given", async () => {
    const response = await get("/api/alarms/native");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: NATIVE_ALARMS });
    expect(fake.calls.nativeAlarms).toEqual([
      {
        from: "0001-01-01T00:00:00.000Z",
        to: "9999-12-31T23:59:59.999Z",
        code: undefined,
        limit: undefined,
      },
    ]);
  });

  it("passes the window, the code and the limit to the repository", async () => {
    const response = await get(
      "/api/alarms/native?from=2020-06-05T09:00:00.000Z&to=2020-06-05T10:00:00.000Z&code=W101&limit=5",
    );
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(fake.calls.nativeAlarms.at(-1)).toEqual({
      from: "2020-06-05T09:00:00.000Z",
      to: "2020-06-05T10:00:00.000Z",
      code: "W101",
      limit: 5,
    });
  });

  it("refuses a code that is not a controller alarm code, and a backwards window", async () => {
    await expectBadRequest("/api/alarms/native?code=w101", "code");
    await expectBadRequest(
      "/api/alarms/native?from=2020-06-05T10:00:00.000Z&to=2020-06-05T09:00:00.000Z",
      "from",
    );
    await expectBadRequest("/api/alarms/native?limit=0", "limit");
  });
});
