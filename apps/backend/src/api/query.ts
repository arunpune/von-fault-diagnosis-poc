// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a query string, one parameter at a time.
 *
 * No query string has a contract of its own — the `api-*` schemas describe
 * bodies — so each route reads its parameters through these helpers, and a
 * value that does not parse is a {@link BadRequestError} naming the parameter
 * rather than a value silently replaced by a default. An absent parameter is
 * `undefined`; the route decides what that means.
 *
 * Fastify hands a repeated parameter over as an array. Every parameter here is
 * single-valued, so a repeat is refused the same way a malformed value is.
 */

import { parseIsoMs } from "@fdp/contracts";

import { BadRequestError } from "./errors.ts";

/** A query string as Fastify parses it. */
export type Query = Readonly<Record<string, unknown>>;

/** The identifier grammar of the contracts (`common#/$defs/identifier`). */
const IDENTIFIER = /^[a-z][a-z0-9_]{1,39}$/;

/** A decimal integer without sign or leading zeros. */
const POSITIVE_INTEGER = /^[1-9]\d{0,9}$/;

/** The one string value of a parameter, or `undefined` when it is absent or empty. */
export function textParam(query: Query, name: string): string | undefined {
  const value = query[name];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new BadRequestError(`${name} is given more than once`, name);
  return value;
}

/** A positive integer, at most `max` when a maximum is given. */
export function positiveIntParam(query: Query, name: string, max?: number): number | undefined {
  const value = textParam(query, name);
  if (value === undefined) return undefined;
  const parsed = POSITIVE_INTEGER.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new BadRequestError(`${name} is not a positive integer`, name);
  }
  if (max !== undefined && parsed > max) {
    throw new BadRequestError(`${name} is above ${max}`, name, { max });
  }
  return parsed;
}

/** An `iso_ts` instant (`2020-06-05T09:49:00.000Z`), as epoch milliseconds. */
export function instantParam(query: Query, name: string): number | undefined {
  const value = textParam(query, name);
  if (value === undefined) return undefined;
  try {
    return parseIsoMs(value).getTime();
  } catch {
    throw new BadRequestError(
      `${name} is not an iso_ts instant such as 2020-06-05T09:49:00.000Z`,
      name,
    );
  }
}

/** An `iso_ts` instant, kept as the string the client sent. */
export function isoParam(query: Query, name: string): string | undefined {
  const value = textParam(query, name);
  if (value !== undefined) instantParam(query, name);
  return value;
}

/** `true` or `false`, spelled out. */
export function booleanParam(query: Query, name: string): boolean | undefined {
  const value = textParam(query, name);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new BadRequestError(`${name} is neither true nor false`, name);
}

/** One word out of a closed list. */
export function enumParam<T extends string>(
  query: Query,
  name: string,
  values: readonly T[],
): T | undefined {
  const value = textParam(query, name);
  if (value === undefined) return undefined;
  if (!(values as readonly string[]).includes(value)) {
    throw new BadRequestError(`${name} must be one of ${values.join(", ")}`, name, {
      allowed: [...values],
    });
  }
  return value as T;
}

/** One contract identifier (`fault_id`, `symptom_key`, a tag id). */
export function identifierParam(query: Query, name: string): string | undefined {
  const value = textParam(query, name);
  if (value !== undefined && !IDENTIFIER.test(value)) {
    throw new BadRequestError(`${name} is not an identifier`, name);
  }
  return value;
}

/** A comma-separated list of contract identifiers, blanks dropped. */
export function identifierListParam(query: Query, name: string): string[] | undefined {
  const value = textParam(query, name);
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  const malformed = items.find((item) => !IDENTIFIER.test(item));
  if (malformed !== undefined) {
    throw new BadRequestError(`${name} holds ${malformed}, which is not an identifier`, name);
  }
  return items;
}
