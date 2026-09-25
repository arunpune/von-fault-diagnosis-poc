// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The fixture harness of `@fdp/contracts/testing`, reused by every other TypeScript package. Go
// tests read the same `schemas/v1` and `fixtures` directories from disk and Python tests read them
// through `CONTRACTS_DIR`, so the files — not this module — are the contract. This module needs a
// file system and is therefore never imported from `src/index.ts`.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The top-level key an invalid fixture may carry; it is stripped before validation. */
export const EXPECT_ERROR_KEY = "$expect_error";

function findPackageRoot(start: string): string {
  let directory = start;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, "schemas", "v1", "common.schema.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`@fdp/contracts: no package root with schemas/v1 above ${start}`);
}

/** Root of the installed `@fdp/contracts` package, whether it runs from `src/` or from `dist/`. */
export const contractsDir: string = findPackageRoot(import.meta.dirname);

/** Directory holding the hand-written v1 message schemas. */
export const schemasDir: string = join(contractsDir, "schemas", "v1");

/** Directory holding one fixture folder per schema. */
export const fixturesDir: string = join(contractsDir, "fixtures");

/** Absolute path of a schema file, whether or not it exists. */
export function schemaPath(name: string): string {
  return join(schemasDir, `${name}.schema.json`);
}

/** Every schema stem found in `schemas/v1`, sorted; includes `common`. */
export function listSchemaNames(): string[] {
  return readdirSync(schemasDir)
    .filter((file) => file.endsWith(".schema.json"))
    .map((file) => basename(file, ".schema.json"))
    .sort();
}

/** A fixture that must validate against its schema. */
export interface ValidFixture {
  /** File name inside the fixture folder, for example `valid-raised.json`. */
  readonly file: string;
  readonly data: unknown;
}

/** A fixture that must fail validation. */
export interface InvalidFixture extends ValidFixture {
  /** Substring that must appear in one of the reported issues, when the fixture declares one. */
  readonly expectError?: string;
}

/** The fixtures of one schema, split into the ones that must pass and the ones that must fail. */
export interface SchemaFixtures {
  readonly valid: ValidFixture[];
  readonly invalid: InvalidFixture[];
}

function readFixture(directory: string, file: string): { data: unknown; expectError?: string } {
  const parsed = JSON.parse(readFileSync(join(directory, file), "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { data: parsed };
  }
  const record = parsed as Record<string, unknown>;
  if (!(EXPECT_ERROR_KEY in record)) return { data: parsed };
  const { [EXPECT_ERROR_KEY]: expectError, ...data } = record;
  if (typeof expectError !== "string") {
    throw new Error(`${join(directory, file)}: ${EXPECT_ERROR_KEY} must be a string`);
  }
  return { data, expectError };
}

/**
 * The fixtures of one schema, read from `fixtures/<name>/`.
 *
 * `valid-*.json` must validate, `invalid-*.json` must not. A schema with no fixture folder
 * yields two empty lists; `test/schemas.test.ts` is what turns that into a failure.
 */
export function fixturesFor(name: string): SchemaFixtures {
  const directory = join(fixturesDir, name);
  if (!existsSync(directory)) return { valid: [], invalid: [] };
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const valid: ValidFixture[] = [];
  const invalid: InvalidFixture[] = [];
  for (const file of files) {
    const { data, expectError } = readFixture(directory, file);
    if (file.startsWith("valid-")) {
      valid.push({ file, data });
    } else if (file.startsWith("invalid-")) {
      invalid.push(expectError === undefined ? { file, data } : { file, data, expectError });
    } else {
      throw new Error(`${join(directory, file)}: fixture names start with valid- or invalid-`);
    }
  }
  return { valid, invalid };
}
