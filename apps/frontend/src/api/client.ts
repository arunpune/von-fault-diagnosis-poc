// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The one place the UI talks HTTP. Paths are same-origin only — nginx in the container and the
// Vite proxy in development forward `/api` to the backend — so there is no configurable host, and
// a path that would leave the page's origin is refused before any request is made. A non-2xx
// answer becomes an `ApiError` carrying the `api-error` body's code and message, so a view can
// branch on `code` and show `message` without parsing anything itself.

import type { ApiErrorBody } from "@/api/types";

/** Codes the client assigns itself, for failures that never produced an `api-error` body. */
export const CLIENT_ERROR_CODES = {
  /** The request never got an answer: the backend is down or the network dropped. */
  network: "network_error",
  /** The answer was not the JSON the route promises. */
  badResponse: "bad_response",
} as const;

export class ApiError extends Error {
  override readonly name = "ApiError";
  /** The HTTP status, or 0 when no answer arrived. */
  readonly status: number;
  /** The `api-error` code, or a client code when the body carried none. */
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export interface FetchJsonInit {
  method?: "GET" | "POST";
  /** Serialised as JSON; a POST without one sends no body. */
  body?: unknown;
  signal?: AbortSignal;
  /** Non-2xx statuses whose body is still the answer (the 503 of `GET /api/health`). */
  acceptStatuses?: readonly number[];
}

/** Resolves a path against the page's origin and refuses anything that would leave it. */
export function sameOriginUrl(path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError(`API paths are absolute paths on this origin, got ${JSON.stringify(path)}`);
  }
  const origin = window.location.origin;
  const url = new URL(path, origin);
  if (url.origin !== origin) {
    throw new TypeError(`API path ${JSON.stringify(path)} leaves the page's origin`);
  }
  return url;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }
  const { error } = value;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorFrom(response: Response, body: unknown): ApiError {
  if (isErrorBody(body)) {
    const { code, message, details } = body.error;
    return new ApiError(response.status, code, message, details);
  }
  const reason = response.statusText === "" ? "" : ` ${response.statusText}`;
  return new ApiError(
    response.status,
    `http_${response.status}`,
    `HTTP ${response.status}${reason}`,
  );
}

async function send(url: URL, init: FetchJsonInit): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const hasBody = init.body !== undefined;
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }
  try {
    return await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: hasBody ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
      credentials: "same-origin",
    });
  } catch (error) {
    if (init.signal?.aborted === true) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(
      0,
      CLIENT_ERROR_CODES.network,
      `The backend could not be reached: ${message}`,
    );
  }
}

/**
 * Sends one request to a same-origin API path and returns the parsed JSON body.
 *
 * Throws `ApiError` for a non-2xx status (unless listed in `acceptStatuses`), for a request that
 * never got an answer (status 0) and for a body that is not JSON; an aborted request rejects with
 * the abort reason, as `fetch` does, so a cancelled query stays a cancellation.
 */
export async function fetchJson<T>(path: string, init: FetchJsonInit = {}): Promise<T> {
  const url = sameOriginUrl(path);
  const response = await send(url, init);
  const body = await readJson(response);
  const accepted = response.ok || (init.acceptStatuses?.includes(response.status) ?? false);
  if (!accepted) {
    throw errorFrom(response, body);
  }
  if (body === undefined) {
    throw new ApiError(
      response.status,
      CLIENT_ERROR_CODES.badResponse,
      `${url.pathname} answered with a body that is not JSON`,
    );
  }
  return body as T;
}
