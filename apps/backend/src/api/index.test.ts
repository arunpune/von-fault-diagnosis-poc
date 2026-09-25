// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The plugin that assembles the REST surface: which routes it
// registers with and without the dashboard dependencies, the one error shape
// every failure answers, and the development-only CORS switch.

import { isValid } from "@fdp/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { InvalidCursorError } from "../persistence/cursor.ts";
import { TicketClosedError, UnknownTicketError } from "../tickets/index.ts";
import { BadRequestError, NotFoundError, toHttpError } from "./errors.ts";
import { apiServer, fakeApiDeps } from "./fake-deps.test-helper.ts";

let fastify: FastifyInstance | undefined;

afterEach(async () => {
  await fastify?.close();
  fastify = undefined;
});

describe("apiRoutes", () => {
  it("serves only the health route until the runtime hands over the dashboard dependencies", async () => {
    fastify = await apiServer(undefined);
    expect((await fastify.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    const status = await fastify.inject({ method: "GET", url: "/api/status" });
    expect(status.statusCode).toBe(404);
    expect(isValid("api-error", status.json())).toBe(true);
  });

  it("serves health beside the dashboard routes", async () => {
    fastify = await apiServer(fakeApiDeps().deps);
    expect((await fastify.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await fastify.inject({ method: "GET", url: "/api/status" })).statusCode).toBe(200);
  });

  it("answers an unexpected failure with 500 and no detail of the cause", async () => {
    const fake = fakeApiDeps();
    fastify = await apiServer({
      ...fake.deps,
      repos: {
        ...fake.deps.repos,
        cost: {
          ...fake.deps.repos.cost,
          summary: () => Promise.reject(new Error("relation app.cost_ledger does not exist")),
        },
      },
    });
    const response = await fastify.inject({ method: "GET", url: "/api/cost" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("cost_ledger");
    expect(isValid("api-error", response.json())).toBe(true);
  });

  it("answers cross-origin requests only when asked to (development)", async () => {
    const preflight = {
      method: "OPTIONS" as const,
      url: "/api/status",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
    };

    fastify = await apiServer(fakeApiDeps().deps, { crossOrigin: true });
    const allowed = await fastify.inject(preflight);
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    await fastify.close();

    fastify = await apiServer(fakeApiDeps().deps, { crossOrigin: false });
    const refused = await fastify.inject(preflight);
    expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("toHttpError", () => {
  it.each([
    [new BadRequestError("limit is not a positive integer", "limit"), 400, "bad_request"],
    [new InvalidCursorError("not a token this API issued"), 400, "bad_cursor"],
    [new NotFoundError("no decision with id x"), 404, "not_found"],
    [new UnknownTicketError("t-1"), 404, "not_found"],
    [new TicketClosedError("t-1"), 409, "conflict"],
    [Object.assign(new Error("Body is not valid JSON"), { statusCode: 400 }), 400, "bad_request"],
    [
      Object.assign(new Error("Request body is too large"), { statusCode: 413 }),
      413,
      "bad_request",
    ],
    [Object.assign(new Error("upstream down"), { statusCode: 503 }), 503, "internal_error"],
    [new Error("anything else"), 500, "internal_error"],
    ["not even an error", 500, "internal_error"],
  ])("maps %s to %i %s", (error, status, code) => {
    const mapped = toHttpError(error);
    expect(mapped.status).toBe(status);
    expect(mapped.body.error.code).toBe(code);
    expect(isValid("api-error", mapped.body)).toBe(true);
  });

  it("names the parameter of a refused query in the details", () => {
    const mapped = toHttpError(
      new BadRequestError("points is above 2000", "points", { max: 2000 }),
    );
    expect(mapped.body.error.details).toEqual({ parameter: "points", max: 2000 });
  });
});
