// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Identifiers and digests.
 *
 * Every row the backend writes carries a version 4 UUID, and every decision
 * carries the SHA-256 of the state the model saw, so a stored decision can be
 * matched with the input that produced it without keeping the input twice.
 *
 * {@link digestOf} sorts object keys before hashing, so two values that differ
 * only in property order hash the same. That is what makes `state_digest`
 * comparable between the runtime and `tools/eval`, which build the state in
 * different orders.
 */

import { createHash, randomUUID } from "node:crypto";

/** A version 4 UUID, from the platform's cryptographic generator. */
export function newId(): string {
  return randomUUID();
}

/** Lower-case hex SHA-256 of a string or of raw bytes. */
export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Lower-case hex SHA-256 of a JSON value, keys sorted at every depth.
 *
 * Arrays keep their order — it carries meaning — and `undefined` properties are
 * dropped the way `JSON.stringify` drops them.
 */
export function digestOf(value: unknown): string {
  return sha256(stableStringify(value));
}

/** `JSON.stringify` with object keys in sorted order at every depth. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) continue;
    sorted[key] = sortKeys(entry);
  }
  return sorted;
}
