// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@fdp/backend/pipeline` as a package entry.
 *
 * `tools/eval` may import this package through one specifier only, and it
 * runs from source: `node --conditions=@fdp/source`, no build. So the checks
 * here run where a host would — in a child Node process, not through Vitest's
 * resolver — and ask three things of the `exports` map:
 *
 *   * the entry resolves through the `@fdp/source` condition with no `dist/`
 *     at all, and exports what the evaluation harness composes with;
 *   * after `pnpm --filter @fdp/backend build`, the default condition lands on
 *     the emitted `dist/pipeline/index.js`, and that file loads and exports
 *     the same names;
 *   * the package root is not an entry: `import("@fdp/backend")` rejects.
 *
 * The child runs from this package's directory, where Node resolves the
 * package's own name through self-reference — the same `exports` map a
 * workspace link would read.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, expectTypeOf, it } from "vitest";

import * as entry from "./index.ts";
import type {
  DecisionBackend,
  LlmProvider,
  Pipeline,
  PipelineOutput,
  PipelinePorts,
} from "./index.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST_ENTRY = join(PACKAGE_ROOT, "dist", "pipeline", "index.js");

/** The `@fdp/source` resolution condition, as `tools/eval` passes it. */
const SOURCE_CONDITION = "--conditions=@fdp/source";

/** The factories and values the evaluation harness composes with. */
const HOST_FACTORIES = [
  "createPipeline",
  "createCatalogRetriever",
  "createRulesBackend",
  "createVonBackend",
  "createLlmBackend",
  "createAnthropicProvider",
  "selectBackend",
  "buildState",
  "gate",
  "Secret",
] as const;

interface PackageManifest {
  version: string;
  exports: Record<string, Record<string, string>>;
}

function manifest(): PackageManifest {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as PackageManifest;
}

/**
 * Run an ES module snippet in a fresh Node process from the package root.
 *
 * The child gets only the flags named here, never the test runner's resolver;
 * its stderr (Node's type-stripping notice among it) is kept for the failure
 * message only.
 */
function runNode(flags: readonly string[], source: string): string {
  try {
    return execFileSync(process.execPath, [...flags, "--input-type=module", "--eval", source], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error: unknown) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new Error(`node ${flags.join(" ")} failed:\n${stderr}`, { cause: error });
  }
}

/** The sorted export names of `specifier`, as a child process imports it. */
function exportNames(flags: readonly string[], specifier: string): string[] {
  const output = runNode(
    flags,
    `const m = await import(${JSON.stringify(specifier)});` +
      "process.stdout.write(JSON.stringify(Object.keys(m).sort()));",
  );
  return JSON.parse(output) as string[];
}

/** The error code of importing `specifier`, or `resolved` when it loads. */
function importOutcome(flags: readonly string[], specifier: string): string {
  return runNode(
    flags,
    `try { await import(${JSON.stringify(specifier)}); process.stdout.write("resolved"); }` +
      " catch (error) { process.stdout.write(String(error.code)); }",
  );
}

describe("the package entry", () => {
  it("reports the version of the package it belongs to", () => {
    expect(entry.VERSION).toBe(manifest().version);
  });

  it("is the only entry the package exports, source condition first", () => {
    const { exports } = manifest();
    expect(Object.keys(exports)).toEqual(["./pipeline"]);
    expect(Object.keys(exports["./pipeline"] ?? {})).toEqual(["@fdp/source", "types", "default"]);
    expect(exports["./pipeline"]).toEqual({
      "@fdp/source": "./src/pipeline/index.ts",
      types: "./dist/pipeline/index.d.ts",
      default: "./dist/pipeline/index.js",
    });
  });

  it("exports every factory the evaluation harness composes with", () => {
    for (const name of HOST_FACTORIES) expect(typeof entry[name]).toBe("function");
  });

  it("exports the types a host is written against", () => {
    expectTypeOf<LlmProvider>().toHaveProperty("complete");
    expectTypeOf<LlmProvider>().toHaveProperty("model");
    expectTypeOf(entry.createPipeline).parameter(0).toEqualTypeOf<PipelinePorts>();
    expectTypeOf(entry.createPipeline).returns.toEqualTypeOf<Pipeline>();
    expectTypeOf(entry.createRulesBackend).returns.toEqualTypeOf<DecisionBackend>();
    expectTypeOf<PipelineOutput["type"]>().toEqualTypeOf<
      "suspect" | "decision" | "episode" | "ticket" | "alarm"
    >();
  });

  it("builds the rules twin with the registry's severity hints", () => {
    expect(entry.RULE_SEVERITY_HINTS).toMatchObject({
      stuck_loaded: "high",
      purge_pressure_high: "high",
      low_pressure_switch: "critical",
      oil_temperature_rising: "low",
    });
    expect(entry.createRulesBackend()).toMatchObject({ name: "rules", model: "rules-v1" });
  });
});

describe("resolution in a plain Node process", () => {
  it("resolves @fdp/backend/pipeline through @fdp/source without a build", () => {
    const names = exportNames([SOURCE_CONDITION], "@fdp/backend/pipeline");
    expect(names).toEqual(Object.keys(entry).sort());
    expect(names).toEqual(expect.arrayContaining([...HOST_FACTORIES]));
  });

  it("refuses the package root, with and without the source condition", () => {
    expect(importOutcome([SOURCE_CONDITION], "@fdp/backend")).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
    expect(importOutcome([], "@fdp/backend")).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });

  it.skipIf(!existsSync(DIST_ENTRY))(
    "resolves @fdp/backend/pipeline to the build in dist/ after pnpm build",
    () => {
      const resolved = runNode(
        [],
        'process.stdout.write(import.meta.resolve("@fdp/backend/pipeline"));',
      );
      expect(resolved).toBe(pathToFileURL(DIST_ENTRY).href);
      expect(existsSync(join(PACKAGE_ROOT, "dist", "pipeline", "index.d.ts"))).toBe(true);

      // The emitted entry loads and exports what the source does. Workspace
      // dependencies still come from their sources, so this proves the build
      // of this package and nothing about theirs.
      const built = exportNames([SOURCE_CONDITION], pathToFileURL(DIST_ENTRY).href);
      expect(built, "dist/ is stale: run pnpm --filter @fdp/backend build").toEqual(
        Object.keys(entry).sort(),
      );
    },
  );
});
