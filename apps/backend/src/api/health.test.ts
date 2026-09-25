// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { isValid } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.ts";
import { fixedClock } from "../clock.ts";
import { loadEnv } from "../config/env.ts";
import { healthReport, LINK_NAMES, type HealthPorts } from "./health.ts";

const STARTED_AT = new Date("2026-09-21T08:00:00.000Z");

function ports(overrides: Partial<HealthPorts> = {}): HealthPorts {
  return {
    clock: fixedClock("2026-09-21T08:00:42.000Z"),
    version: "1.0.0",
    backend: { name: "rules", model: "rules-v1" },
    links: {},
    ...overrides,
  };
}

describe("healthReport", () => {
  it("answers the contracts shape with every link up", async () => {
    const report = await healthReport(
      ports({
        links: Object.fromEntries(LINK_NAMES.map((name) => [name, () => true])),
        heartbeats: () => ({ telemetry: "ok", decision_api: "ok" }),
        sim: () => ({ state: "playing", speed: 600, sim_ts: "2020-06-05T09:49:00.000Z" }),
        counters: () => ({ decisions_total: 3 }),
      }),
      STARTED_AT,
    );
    expect(report.status).toBe(200);
    expect(isValid("api-health", report.body)).toBe(true);
    expect(report.body).toMatchObject({
      status: "ok",
      version: "1.0.0",
      backend: { name: "rules", model: "rules-v1" },
      mqtt: { diag: "ok", ops: "ok" },
      db: { app: "ok", gt: "ok" },
      heartbeats: { telemetry: "ok", decision_api: "ok" },
      uptime_s: 42,
    });
    expect(report.body.counters).toMatchObject({ decisions_total: 3, links_unwired: 0 });
  });

  it("answers 503 when a wired link is down", async () => {
    const report = await healthReport(
      ports({
        links: Object.fromEntries(LINK_NAMES.map((name) => [name, () => name !== "db.app"])),
      }),
      STARTED_AT,
    );
    expect(report.status).toBe(503);
    expect(report.body.status).toBe("degraded");
    expect(report.body.db.app).toBe("down");
    expect(isValid("api-health", report.body)).toBe(true);
  });

  it("treats a probe that throws as a link that is down", async () => {
    const report = await healthReport(
      ports({
        links: {
          "db.app": () => {
            throw new Error("connect ECONNREFUSED");
          },
        },
      }),
      STARTED_AT,
    );
    expect(report.status).toBe(503);
    expect(report.body.db.app).toBe("down");
  });

  it("reports an unwired link as down but does not fail the process for it", async () => {
    const report = await healthReport(ports({ links: { "db.app": () => true } }), STARTED_AT);
    expect(report.status).toBe(200);
    expect(report.body.status).toBe("degraded");
    expect(report.body.db).toEqual({ app: "ok", gt: "down" });
    expect(report.body.mqtt).toEqual({ diag: "down", ops: "down" });
    expect(report.body.counters).toMatchObject({ links_unwired: 3 });
  });

  it("defaults the two watchdogs to unknown before anything has reported", async () => {
    const report = await healthReport(ports(), STARTED_AT);
    expect(report.body.heartbeats).toEqual({ telemetry: "unknown", decision_api: "unknown" });
    expect(report.body.sim).toBeNull();
  });
});

describe("GET /api/health", () => {
  it("serves the report over the route the healthcheck calls", async () => {
    const env = loadEnv({ PORT: "0", LOG_LEVEL: "silent" });
    const app = createApp(env, {
      clock: fixedClock("2026-09-21T08:00:10.000Z"),
      links: { "db.app": () => true },
    });
    try {
      const response = await app.fastify.inject({ method: "GET", url: "/api/health" });
      expect(response.statusCode).toBe(200);
      const body: unknown = response.json();
      expect(isValid("api-health", body)).toBe(true);
      expect(body).toMatchObject({ backend: { name: "rules", model: "rules-v1" } });
    } finally {
      await app.stop();
    }
  });

  it("answers the api-error shape for an unknown route", async () => {
    const app = createApp(loadEnv({ PORT: "0", LOG_LEVEL: "silent" }));
    try {
      const response = await app.fastify.inject({ method: "GET", url: "/api/nowhere" });
      expect(response.statusCode).toBe(404);
      expect(isValid("api-error", response.json())).toBe(true);
    } finally {
      await app.stop();
    }
  });
});
