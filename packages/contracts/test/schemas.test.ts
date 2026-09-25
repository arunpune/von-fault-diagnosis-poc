// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The fixture harness, rules 1 to 4 below. It is generic over `schemas/v1/*.schema.json` and
// `fixtures/<stem>/`, so a change that adds a schema adds the file and its fixtures and gets the
// whole harness for free — in TypeScript here, and over the same files in the Go and Python
// conformance tests.

import type { AnySchemaObject, ValidateFunction } from "ajv";
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SCHEMA_IDS, SCHEMA_NAMES, schemas } from "../src/generated/schemas.ts";
import { AJV_OPTIONS, validators } from "../src/generated/validators.ts";
import { CONTRACTS_VERSION } from "../src/index.ts";
import { contractsDir, fixturesFor, listSchemaNames, schemaPath } from "../src/testing.ts";
import { assertValid, isValid, validate } from "../src/validate.ts";

// ajv and ajv-formats ship CommonJS with a default export, which Node's ESM interop hands
// back as the module object itself. The casts restore the declared class and plugin types.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/** Schema names read from disk, so a file that was never generated still fails the harness. */
const names = listSchemaNames();

/** The hand-written sources, not the embedded copies: the files are the contract. */
const sources = new Map<string, AnySchemaObject>(
  names.map((name) => [
    name,
    JSON.parse(readFileSync(schemaPath(name), "utf8")) as AnySchemaObject,
  ]),
);

/** One Ajv instance built from the files, in exactly the mode the generated validators use. */
function buildAjv(): InstanceType<typeof Ajv2020> {
  const ajv = new Ajv2020({ ...AJV_OPTIONS });
  addFormats(ajv);
  for (const schema of sources.values()) ajv.addSchema(schema);
  return ajv;
}

const ajv = buildAjv();

function compiled(name: string): ValidateFunction {
  const validator = ajv.getSchema(`urn:fdp:schema:${name}:v1`);
  if (validator === undefined) throw new Error(`${name}: did not compile`);
  return validator;
}

/** The issue texts of the last failed validation, in the `<path> <message>` form. */
function issueTexts(validator: ValidateFunction): string[] {
  return (validator.errors ?? []).map(
    (error) => `${error.instancePath === "" ? "/" : error.instancePath} ${error.message ?? ""}`,
  );
}

/** True when the schema `allOf`-extends `common#/$defs/envelope` (rule 3). */
function extendsEnvelope(schema: AnySchemaObject): boolean {
  const allOf: unknown = schema.allOf;
  if (!Array.isArray(allOf)) return false;
  return allOf.some(
    (branch) =>
      typeof branch === "object" &&
      branch !== null &&
      (branch as { $ref?: unknown }).$ref === "urn:fdp:schema:common:v1#/$defs/envelope",
  );
}

describe("schema sources", () => {
  it("finds at least the common definitions and one message schema", () => {
    expect(names).toContain("common");
    expect(names.filter((name) => name !== "common").length).toBeGreaterThan(0);
  });

  it("embeds exactly the schemas on disk", () => {
    expect([...SCHEMA_NAMES]).toEqual(names);
    for (const name of names) {
      expect(schemas[name as keyof typeof schemas]).toEqual(sources.get(name));
    }
  });

  it("keeps CONTRACTS_VERSION equal to the package version", () => {
    const manifest = JSON.parse(readFileSync(join(contractsDir, "package.json"), "utf8")) as {
      version: string;
    };
    expect(CONTRACTS_VERSION).toBe(manifest.version);
  });
});

// Rule 1: every schema compiles in Ajv 2020 strict mode and declares its identity.
describe.each(names)("%s.schema.json", (name) => {
  const schema = sources.get(name) as AnySchemaObject;

  it("compiles in strict mode", () => {
    expect(() => compiled(name)).not.toThrow();
  });

  it("declares $schema, $id, title and description", () => {
    expect(schema.$schema).toBe(DRAFT_2020_12);
    expect(schema.$id).toBe(`urn:fdp:schema:${name}:v1`);
    expect(typeof schema.title).toBe("string");
    expect((schema.title as string).length).toBeGreaterThan(0);
    expect(typeof schema.description).toBe("string");
    expect((schema.description as string).length).toBeGreaterThan(0);
  });

  it("has a generated validator under the same name", () => {
    expect(SCHEMA_IDS[name as keyof typeof SCHEMA_IDS]).toBe(schema.$id);
    expect(typeof validators[name as keyof typeof validators]).toBe("function");
  });
});

// Rules 2 and 3: fixtures. `common` holds only `$defs` and is never a message, so it is exempt.
describe.each(names.filter((name) => name !== "common"))("fixtures of %s", (name) => {
  const schema = sources.get(name) as AnySchemaObject;
  const { valid, invalid } = fixturesFor(name);

  it("ships at least one valid and one invalid fixture", () => {
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.length).toBeGreaterThan(0);
  });

  it.each(valid)("$file validates", ({ data }) => {
    const validator = compiled(name);
    const ok = validator(data);
    expect(issueTexts(validator)).toEqual([]);
    expect(ok).toBe(true);
  });

  it.each(invalid)("$file is rejected", ({ data, expectError }) => {
    const validator = compiled(name);
    expect(validator(data)).toBe(false);
    const texts = issueTexts(validator);
    if (expectError !== undefined) {
      expect(texts.some((text) => text.includes(expectError))).toBe(true);
    }
  });

  it.runIf(extendsEnvelope(schema))("valid fixtures carry the schema id in `schema`", () => {
    for (const { file, data } of valid) {
      expect({ file, schema: (data as { schema?: unknown }).schema }).toEqual({
        file,
        schema: schema.$id,
      });
    }
  });
});

// Rule 4: static guards. Ground truth never leaks into a plant topic (ground-truth isolation,
// docs/architecture.md#ground-truth-isolation), and the guard is on the schema text so a nested or
// renamed field cannot slip through.
describe.each([
  { name: "status-sim", forbidden: ["inject", "fault", "preset", "instance"] },
  { name: "telemetry-samples", forbidden: ["inject", "fault_id", "injected", "instance"] },
])("$name static guard", ({ name, forbidden }) => {
  const file = schemaPath(name);

  it.runIf(existsSync(file))("mentions no ground-truth vocabulary", () => {
    const text = readFileSync(file, "utf8");
    for (const word of forbidden) expect(text).not.toContain(word);
  });
});

describe("validate helpers", () => {
  const name = "alert-system";
  const { valid, invalid } = fixturesFor(name);

  function fixture(file: string): unknown {
    const found = [...valid, ...invalid].find((candidate) => candidate.file === file);
    if (found === undefined) throw new Error(`missing fixture ${name}/${file}`);
    return found.data;
  }

  const good = fixture("valid-raised.json");
  const bad = fixture("invalid-bad-kind.json");

  it("returns the value for a valid message", () => {
    const result = validate(name, good);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe("telemetry_silent");
  });

  it("returns issues for an invalid message", () => {
    const result = validate(name, bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.text.length).toBeGreaterThan(0);
  });

  it("narrows with isValid and throws from assertValid", () => {
    expect(isValid(name, good)).toBe(true);
    expect(isValid(name, bad)).toBe(false);
    expect(assertValid(name, good)).toBe(good);
    expect(() => assertValid(name, bad)).toThrowError(/urn:fdp:schema:alert-system:v1/);
  });
});
