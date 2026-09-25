// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Contract checks for the fake backend's own tests: every body and frame the fake produces is
// validated against the JSON Schemas of @fdp/contracts, read from the package's schema files as
// data and compiled with the package's Ajv options (the same approach as
// src/test/msw/fixtures.test.ts). The UI imports the contracts package for types only, so its
// validators are never loaded here either.

import { readdirSync, readFileSync } from "node:fs";

import Ajv2020, { type AnySchemaObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const SCHEMA_DIR = new URL("../../node_modules/@fdp/contracts/schemas/v1/", import.meta.url);

/** The options of `@fdp/contracts`'s own validators (`AJV_OPTIONS`). */
const ajv = new Ajv2020({ strict: true, allErrors: false, allowUnionTypes: true });
addFormats(ajv);
for (const file of readdirSync(SCHEMA_DIR).filter((name) => name.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(readFileSync(new URL(file, SCHEMA_DIR), "utf8")) as AnySchemaObject);
}

/** What the named contract schema finds wrong with `document`; empty when it is valid. */
export function contractIssues(schema: string, document: unknown): string[] {
  const validate = ajv.getSchema(`urn:fdp:schema:${schema}:v1`);
  if (validate === undefined) {
    throw new Error(`no contract schema named ${schema}`);
  }
  return validate(document) ? [] : (validate.errors ?? []).map((error) => ajv.errorsText([error]));
}

/** A frame in the `ws-server-message` envelope, for checking a payload the way the hub sends it. */
export function asFrame(type: string, payload: unknown): Record<string, unknown> {
  return {
    schema: "urn:fdp:schema:ws-server-message:v1",
    unit_id: "cau-7",
    wall_ts: "2026-09-23T00:00:00.000Z",
    type,
    payload,
  };
}
