// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `GET /api/overlay/*` through `fastify.inject`, with the recorder and the
// repository replaced by doubles. The bodies are asserted against the `gt-*`
// contracts, because those messages are what the user interface parses.

import { isValid } from "@fdp/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { overlayReadRoutes, type OverlayReadPorts } from "./routes-read.ts";
import {
  fakeOverlayRepo,
  gtActive,
  gtCatalog,
  gtInjectionStart,
  gtInjectionStop,
  gtMarker,
  type FakeOverlayRepo,
} from "../../test/helpers/overlay.ts";

const UNIT = "cau-7";

let fastify: FastifyInstance;
let repo: FakeOverlayRepo;
let ports: { catalog: OverlayReadPorts["catalog"]; active: OverlayReadPorts["active"] };

beforeEach(async () => {
  repo = fakeOverlayRepo();
  ports = { catalog: () => null, active: () => null };
  fastify = Fastify({ logger: false });
  await fastify.register(
    overlayReadRoutes({
      catalog: () => ports.catalog(),
      active: () => ports.active(),
      repo,
      unitId: UNIT,
    }),
    { prefix: "/api" },
  );
  await fastify.ready();
});

afterEach(async () => {
  await fastify.close();
});

describe("GET /api/overlay/catalog", () => {
  it("answers 404 before the simulator published one", async () => {
    const response = await fastify.inject({ method: "GET", url: "/api/overlay/catalog" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("answers the retained gt-catalog message", async () => {
    const catalog = gtCatalog();
    ports.catalog = () => catalog;

    const response = await fastify.inject({ method: "GET", url: "/api/overlay/catalog" });
    expect(response.statusCode).toBe(200);
    expect(isValid("gt-catalog", response.json())).toBe(true);
    expect(response.json()).toEqual(catalog);
  });
});

describe("GET /api/overlay/active", () => {
  it("answers 404 before the simulator published one", async () => {
    const response = await fastify.inject({ method: "GET", url: "/api/overlay/active" });
    expect(response.statusCode).toBe(404);
  });

  it("answers the retained gt-injection-active message", async () => {
    const active = gtActive();
    ports.active = () => active;

    const response = await fastify.inject({ method: "GET", url: "/api/overlay/active" });
    expect(response.statusCode).toBe(200);
    expect(isValid("gt-injection-active", response.json())).toBe(true);
  });
});

describe("GET /api/overlay/injections", () => {
  beforeEach(async () => {
    await repo.recordInjection(gtInjectionStart());
    await repo.recordInjection(gtInjectionStop());
  });

  it("returns one item per instance, with the end its stop reported", async () => {
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

  it("passes the window through to the repository", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/api/overlay/injections?from=2021-01-01T00:00:00.000Z",
    });
    expect(response.json()).toEqual({ items: [] });
  });

  it("refuses a bound that is not an iso_ts instant", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/api/overlay/injections?to=2020-02-01",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "bad_request", details: { parameter: "to" } },
    });
  });
});

describe("GET /api/overlay/markers", () => {
  it("returns whole gt-marker messages", async () => {
    await repo.recordMarker(gtMarker());

    const response = await fastify.inject({ method: "GET", url: "/api/overlay/markers" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: unknown[] }>();
    expect(body.items).toHaveLength(1);
    expect(isValid("gt-marker", body.items[0])).toBe(true);
    expect(body.items[0]).toEqual(gtMarker());
  });

  it("leaves the preset out when the jump named an instant", async () => {
    const marker = gtMarker();
    delete marker.preset_id;
    await repo.recordMarker(marker);

    const body = (await fastify.inject({ method: "GET", url: "/api/overlay/markers" })).json<{
      items: Record<string, unknown>[];
    }>();
    expect(body.items[0]).not.toHaveProperty("preset_id");
    expect(isValid("gt-marker", body.items[0])).toBe(true);
  });

  it("refuses a bound that is not an iso_ts instant", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/api/overlay/markers?from=yesterday",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { details: { parameter: "from" } } });
  });
});
