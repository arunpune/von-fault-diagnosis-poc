// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The standing regression for the `@fdp/source` resolution condition, which lives in the first
// package that depends on @fdp/contracts. The contracts package cannot keep it in its own suite,
// because ESLint forbids a `@fdp/*` import anywhere under `packages/contracts/**`.
//
// The point is that development and tests never build: vitest resolves the bare specifier
// `@fdp/contracts` to `packages/contracts/src/index.ts`, so the suite runs on a checkout with
// no `dist/` at all. The identity assertion is what proves it — a `dist/` copy of the module
// would be equal but not the same object. The source module is loaded through a runtime
// specifier so that this package's `tsc -b` keeps every input under its own `rootDir`.

import { CONTRACTS_VERSION, SCHEMA_NAMES, schemas } from "@fdp/contracts";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const CONTRACTS_ROOT = resolve(import.meta.dirname, "..", "..", "contracts");

async function loadFromSourcePath(): Promise<{ schemas: unknown }> {
  const file = join(CONTRACTS_ROOT, "src", "generated", "schemas.ts");
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { schemas: unknown };
}

describe("@fdp/source resolution", () => {
  it("resolves the bare specifier to the module in packages/contracts/src", async () => {
    const fromPath = await loadFromSourcePath();
    expect(schemas).toBe(fromPath.schemas);
  });

  it("keeps the version of the package it resolved to", () => {
    const manifest = JSON.parse(readFileSync(join(CONTRACTS_ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    expect(CONTRACTS_VERSION).toBe(manifest.version);
  });

  it("carries the ground-truth schemas this package validates against", () => {
    for (const name of ["gt-failure-table", "gt-presets", "gt-injections", "gt-catalog"]) {
      expect(SCHEMA_NAMES as readonly string[]).toContain(name);
    }
  });
});
