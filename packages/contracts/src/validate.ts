// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The validation boundary of the contracts package. `validate` never throws on invalid data;
// `assertValid` is the helper a producer or consumer uses when a malformed message must be rejected
// with a logged schema error.

import type { ErrorObject } from "ajv";

import { SCHEMA_IDS } from "./generated/schemas.ts";
import { validators } from "./generated/validators.ts";
import type { SchemaName } from "./generated/validators.ts";
import { schemaForTopic } from "./generated/topics.ts";
import type { SchemaTypeMap } from "./generated/types.ts";

export type { SchemaName } from "./generated/validators.ts";

/** The payload type of a message schema; `unknown` for `common`, which is never a message. */
export type SchemaType<N extends SchemaName> = N extends keyof SchemaTypeMap
  ? SchemaTypeMap[N]
  : unknown;

/** One validation failure, flattened out of Ajv's error object. */
export interface ValidationIssue {
  /** JSON Pointer to the offending value, `""` for the document itself. */
  readonly path: string;
  /** The keyword that failed, for example `enum` or `required`. */
  readonly keyword: string;
  /** Ajv's message, for example `must be equal to one of the allowed values`. */
  readonly message: string;
  /** `<path> <message>`, the form the fixture harness matches `$expect_error` against. */
  readonly text: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: ValidationIssue[] };

/** Thrown by `assertValid` when a message does not match its schema. */
export class SchemaValidationError extends Error {
  readonly schema: string;
  readonly issues: ValidationIssue[];

  constructor(schema: string, issues: ValidationIssue[]) {
    const first = issues[0];
    super(
      first === undefined
        ? `${schema}: invalid message`
        : `${schema}: invalid message (${first.text})`,
    );
    this.name = "SchemaValidationError";
    this.schema = schema;
    this.issues = issues;
  }
}

function issue(path: string, keyword: string, message: string): ValidationIssue {
  return { path, keyword, message, text: `${path === "" ? "/" : path} ${message}` };
}

function toIssues(errors: readonly ErrorObject[] | null | undefined): ValidationIssue[] {
  if (errors === null || errors === undefined) return [issue("", "unknown", "is invalid")];
  return errors.map((error) =>
    issue(error.instancePath, error.keyword, error.message ?? "is invalid"),
  );
}

/** Validates `data` against a schema; the result carries either the typed value or the issues. */
export function validate<N extends SchemaName>(
  name: N,
  data: unknown,
): ValidationResult<SchemaType<N>> {
  const validator = validators[name];
  if (validator(data)) return { ok: true, value: data as SchemaType<N> };
  return { ok: false, errors: toIssues(validator.errors) };
}

/** Validates `data` and returns it typed, or throws `SchemaValidationError`. */
export function assertValid<N extends SchemaName>(name: N, data: unknown): SchemaType<N> {
  const result = validate(name, data);
  if (result.ok) return result.value;
  throw new SchemaValidationError(SCHEMA_IDS[name], result.errors);
}

/** Type guard form of `validate`. */
export function isValid<N extends SchemaName>(name: N, data: unknown): data is SchemaType<N> {
  return validate(name, data).ok;
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

/**
 * Validates an MQTT payload against the schema its topic declares.
 *
 * The payload is typed `Uint8Array | string` rather than `Buffer | string` so that the browser
 * bundle of this package needs no Node types; a Node `Buffer` is a `Uint8Array` and is accepted.
 */
export function validateMqtt(
  topic: string,
  payload: Uint8Array | string,
): ValidationResult<unknown> {
  const name = schemaForTopic(topic);
  if (name === undefined) {
    return { ok: false, errors: [issue("", "topic", `no schema is declared for topic ${topic}`)] };
  }
  const text = typeof payload === "string" ? payload : utf8.decode(payload);
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [issue("", "json", `payload is not JSON: ${reason}`)] };
  }
  return validate(name, data);
}
