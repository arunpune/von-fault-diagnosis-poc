// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every failure of the REST surface, as one `api-error` body and a status
 * code (contracts `api-error`).
 *
 * The routes throw; the error handler of `index.ts` calls {@link toHttpError}
 * and answers. That keeps the mapping from a domain error to an HTTP status in
 * one table instead of in a `try` around every route:
 *
 * | thrown | status | `code` |
 * | --- | --- | --- |
 * | {@link BadRequestError} (a query or a body the route refused) | 400 | `bad_request` |
 * | `InvalidCursorError` (a `before` the API never issued) | 400 | `bad_cursor` |
 * | {@link NotFoundError}, `UnknownTicketError` | 404 | `not_found` |
 * | `TicketClosedError` (a second verdict) | 409 | `conflict` |
 * | a Fastify error with a 4xx status (a malformed JSON body, a body too large) | that status | `bad_request` |
 * | an error with a 5xx status of its own | that status | `internal_error` |
 * | anything else | 500 | `internal_error` |
 *
 * A 500 says only that the request failed: the message of an unexpected error
 * can carry a statement, a row or a path, and none of that belongs in a body a
 * browser shows (the handler logs it instead).
 */

import type { ApiError } from "@fdp/contracts";

import { InvalidCursorError } from "../persistence/cursor.ts";
import { TicketClosedError, UnknownTicketError } from "../tickets/index.ts";

/** A request the route refuses before doing anything: HTTP 400. */
export class BadRequestError extends Error {
  /** The query parameter or body field at fault, when there is one. */
  readonly parameter: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, parameter?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BadRequestError";
    this.parameter = parameter;
    this.details = details;
  }
}

/** The resource the path names does not exist: HTTP 404. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Build the `api-error` body for a code and a message. */
export function apiError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** What the error handler sends: the status and the body. */
export interface HttpError {
  readonly status: number;
  readonly body: ApiError;
}

/** A Fastify error, or anything else that carries an HTTP status of its own. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function badRequestDetails(error: BadRequestError): Record<string, unknown> | undefined {
  if (error.parameter === undefined) return error.details;
  return { parameter: error.parameter, ...error.details };
}

/** The status and the `api-error` body for anything a route threw. */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof BadRequestError) {
    return { status: 400, body: apiError("bad_request", error.message, badRequestDetails(error)) };
  }
  if (error instanceof InvalidCursorError) {
    return { status: 400, body: apiError("bad_cursor", error.message, { parameter: "before" }) };
  }
  if (error instanceof NotFoundError || error instanceof UnknownTicketError) {
    return { status: 404, body: apiError("not_found", error.message) };
  }
  if (error instanceof TicketClosedError) {
    return { status: 409, body: apiError("conflict", error.message) };
  }
  const status = statusOf(error);
  if (status !== undefined && status >= 400 && status < 500) {
    const message = error instanceof Error ? error.message : "the request was refused";
    return { status, body: apiError("bad_request", message) };
  }
  const serverStatus = status !== undefined && status >= 500 && status < 600 ? status : 500;
  return {
    status: serverStatus,
    body: apiError("internal_error", "the request failed on the server"),
  };
}
