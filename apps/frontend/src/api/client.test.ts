// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { ApiError, CLIENT_ERROR_CODES, fetchJson, isApiError, sameOriginUrl } from "@/api/client";
import { apiError } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!isApiError(error)) {
    throw new Error(`expected an ApiError, got ${String(error)}`);
  }
  return error;
}

describe("fetchJson", () => {
  it("returns the parsed body of a 2xx answer", async () => {
    await expect(fetchJson<{ signals: unknown[] }>("/api/signals")).resolves.toMatchObject({
      signals: expect.any(Array) as unknown,
    });
  });

  it("sends a JSON body with its content type and asks for JSON back", async () => {
    let seen: { method: string; type: string | null; accept: string | null; body: unknown } | null =
      null;
    server.use(
      http.post("/api/echo", async ({ request }) => {
        seen = {
          method: request.method,
          type: request.headers.get("content-type"),
          accept: request.headers.get("accept"),
          body: await request.json(),
        };
        return HttpResponse.json({ ok: true });
      }),
    );

    await expect(fetchJson("/api/echo", { method: "POST", body: { args: {} } })).resolves.toEqual({
      ok: true,
    });
    expect(seen).toEqual({
      method: "POST",
      type: "application/json",
      accept: "application/json",
      body: { args: {} },
    });
  });

  it("turns an api-error body into an ApiError with its status, code and message", async () => {
    server.use(http.get("/api/boom", () => apiError(404, "not_found", "no ticket with id x")));

    const error = await rejection(fetchJson("/api/boom"));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: "not_found", message: "no ticket with id x" });
    expect(error.name).toBe("ApiError");
  });

  it("keeps the details of an api-error body", async () => {
    server.use(
      http.get("/api/boom", () =>
        HttpResponse.json(
          {
            error: { code: "bad_request", message: "to is required", details: { parameter: "to" } },
          },
          { status: 400 },
        ),
      ),
    );

    const error = await rejection(fetchJson("/api/boom"));
    expect(error.details).toEqual({ parameter: "to" });
  });

  it("names the HTTP status when the error body is not an api-error", async () => {
    server.use(
      http.get(
        "/api/boom",
        () => new HttpResponse("upstream timed out", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    const error = await rejection(fetchJson("/api/boom"));
    expect(error).toMatchObject({ status: 502, code: "http_502", message: "HTTP 502 Bad Gateway" });
  });

  it("names the HTTP status alone when there is no status text", async () => {
    server.use(
      http.get("/api/boom", () => new Response(JSON.stringify({ nope: true }), { status: 500 })),
    );

    const error = await rejection(fetchJson("/api/boom"));
    expect(error).toMatchObject({ status: 500, code: "http_500", message: "HTTP 500" });
  });

  it("returns the body of an accepted non-2xx status", async () => {
    server.use(
      http.get("/api/health", () => HttpResponse.json({ status: "degraded" }, { status: 503 })),
    );

    await expect(fetchJson("/api/health", { acceptStatuses: [503] })).resolves.toEqual({
      status: "degraded",
    });
  });

  it("refuses a 2xx body that is not JSON", async () => {
    server.use(http.get("/api/boom", () => new HttpResponse("<html>", { status: 200 })));

    const error = await rejection(fetchJson("/api/boom"));
    expect(error).toMatchObject({ status: 200, code: CLIENT_ERROR_CODES.badResponse });
  });

  it("reads an empty 2xx body as null", async () => {
    server.use(http.get("/api/empty", () => new HttpResponse(null, { status: 200 })));

    await expect(fetchJson("/api/empty")).resolves.toBeNull();
  });

  it("reports a request that got no answer as status 0", async () => {
    server.use(http.get("/api/boom", () => HttpResponse.error()));

    const error = await rejection(fetchJson("/api/boom"));
    expect(error).toMatchObject({ status: 0, code: CLIENT_ERROR_CODES.network });
    expect(error.message).toMatch(/^The backend could not be reached/);
  });

  it("rejects with the abort reason when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchJson("/api/status", { signal: controller.signal }),
    ).rejects.not.toBeInstanceOf(ApiError);
  });
});

describe("sameOriginUrl", () => {
  it("resolves an absolute path against the page's origin", () => {
    expect(sameOriginUrl("/api/status?x=1").href).toBe(`${window.location.origin}/api/status?x=1`);
  });

  it.each(["api/status", "https://example.test/api/status", "//example.test/api/status"])(
    "refuses %s, which is not a path on this origin",
    (path) => {
      expect(() => sameOriginUrl(path)).toThrow(TypeError);
    },
  );

  it("refuses a path that leaves the origin once resolved", () => {
    expect(() => sameOriginUrl("/\\example.test/api")).toThrow(/leaves the page's origin/);
  });
});
