// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The name of one Jev request.
//
// A cassette is found again by the digest of what was asked: the sha256 of
// the canonical JSON of `{ model, state, questions }`. Two sides compute it —
// the recorder, from the request object the backend handed the SDK, and the
// cassette server, from the body that arrived on the wire — so the canonical
// form has to be the one both agree on whatever order the keys were built or
// parsed in: keys sorted, no whitespace, and every value printed exactly as
// `JSON.stringify` prints it. That last rule is what makes the two sides
// meet: the SDK serialises the request with `JSON.stringify`, so a value it
// drops (`undefined`, a function) or rewrites (`NaN` → `null`, a `Date`
// through `toJSON`) is dropped or rewritten here too, and the recorder hashes
// the very bytes the server will parse.
//
// Nothing else goes into the digest: no header, no key, no scenario id. The
// same question about the same state is the same cassette.

import { createHash } from "node:crypto";

/** What a Jev request is named by: the three members of `POST /v1/systemone`'s body. */
export interface DigestedRequest {
  readonly model: string;
  readonly state: unknown;
  readonly questions: unknown;
}

/** A value `JSON.stringify` leaves out of an object and writes as `null` inside an array. */
function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/** The value `JSON.stringify` would serialise in place of `value`, after any `toJSON`. */
function jsonValueOf(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && "toJSON" in value) {
    const toJSON = (value as { toJSON: unknown }).toJSON;
    if (typeof toJSON === "function") return (toJSON as (key: string) => unknown).call(value, key);
  }
  return value;
}

function canonical(raw: unknown, key: string, path: Set<object>): string {
  const value = jsonValueOf(raw, key);
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "string":
      return JSON.stringify(value);
    case "bigint":
      throw new TypeError("canonicalJson: a bigint has no JSON form");
    case "object":
      return canonicalObject(value, path);
    default:
      throw new TypeError(`canonicalJson: a ${typeof value} has no JSON form`);
  }
}

function canonicalObject(value: object, path: Set<object>): string {
  if (path.has(value)) throw new TypeError("canonicalJson: the value is circular");
  path.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item: unknown, index) =>
        isOmitted(item) ? "null" : canonical(item, String(index), path),
      );
      return `[${items.join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .filter((name) => !isOmitted(jsonValueOf(record[name], name)))
      .map((name) => `${JSON.stringify(name)}:${canonical(record[name], name, path)}`);
    return `{${members.join(",")}}`;
  } finally {
    path.delete(value);
  }
}

/**
 * The canonical JSON text of `value`: object keys sorted by code unit, no whitespace, and every
 * value printed as `JSON.stringify` prints it.
 *
 * @throws TypeError when `value` has no JSON form at all (`undefined`, a function), holds a
 * bigint, or is circular.
 */
export function canonicalJson(value: unknown): string {
  if (isOmitted(jsonValueOf(value, ""))) {
    throw new TypeError("canonicalJson: the value has no JSON form");
  }
  return canonical(value, "", new Set<object>());
}

/** The sha256 of a text, as 64 lowercase hex digits. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The digest a cassette is filed under: sha256 hex of the canonical JSON of
 * `{ model, state, questions }`. Anything else the request object carries is ignored.
 */
export function requestDigest(request: DigestedRequest): string {
  const { model, state, questions } = request;
  return sha256Hex(canonicalJson({ model, state, questions }));
}
