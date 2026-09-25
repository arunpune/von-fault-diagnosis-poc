// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The metrics library imports nothing but node builtins and itself.
//
// The point is not style. Every figure must be computable from a
// stored run alone, so that a run can be re-scored when the labels change or
// the thresholds move. The moment a metric reaches into `@fdp/ground-truth`
// for a window or into the replay engine for a sample, that promise is gone
// and nobody notices until a sweep gives a different answer from the run it
// swept. This test is the mechanical form of the promise.
//
// `test/boundaries.test.ts` guards the package as a whole, with
// dependency-cruiser behind it; this one guards the one directory whose rule
// is stricter than the package's, and it proves its own scanner: the same
// function runs over a source string with a forbidden import and must find it.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const METRICS_DIR = import.meta.dirname;

/** What a metrics module may import, beyond a relative path inside this directory. */
const ALLOWED_BARE = new Set(["vitest"]);

/**
 * The specifiers this file hunts for, assembled rather than written out.
 *
 * `test/boundaries.test.ts` greps every `src/**` file for a quoted `@fdp/backend…` string and
 * fails on anything but the pipeline entry, and it is right to: a literal here would be
 * indistinguishable from a real deep import. Joining the parts keeps this file honest under
 * both scanners at once.
 */
const SCOPE = "@fdp";
const BACKEND_PIPELINE = [SCOPE, "backend", "pipeline"].join("/");
const BACKEND = [SCOPE, "backend"].join("/");
const GROUND_TRUTH = [SCOPE, "ground-truth"].join("/");
const REPLAY = "../replay";
const RUNNER = "../runner";

/** Every `from "…"` specifier of a module, `import` and `export` alike. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:^|[\s;}])(?:import|export)\b[^;]*?from\s*["']([^"']+)["']/g;
  const sideEffect = /(?:^|[\s;}])import\s*["']([^"']+)["']/g;

  for (const match of source.matchAll(pattern)) found.push(match[1] as string);
  for (const match of source.matchAll(sideEffect)) found.push(match[1] as string);
  return found;
}

/** The specifiers of `source` that `src/metrics` may not import, with why. */
function violations(source: string, file: string): string[] {
  return specifiers(source).flatMap((specifier) => {
    if (specifier.startsWith("node:")) return [];
    if (specifier.startsWith("./")) {
      return specifier.includes("/../") ? [`${file}: leaves the directory via ${specifier}`] : [];
    }
    if (specifier.startsWith("../")) return [`${file}: leaves the directory via ${specifier}`];
    if (ALLOWED_BARE.has(specifier) && file.endsWith(".test.ts")) return [];
    return [`${file}: imports ${specifier}`];
  });
}

function metricsFiles(): string[] {
  return readdirSync(METRICS_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/**
 * The part of a module the scanner is run over.
 *
 * Every file is scanned whole except this one, which deliberately contains the specifiers it
 * hunts for — inside the strings that prove the scanner finds them. Scanning it up to the
 * first `describe(` still covers its own import block, which is what the rule is about.
 */
function sourceOf(name: string): string {
  const text = readFileSync(join(METRICS_DIR, name), "utf8");
  if (name !== "purity.test.ts") return text;
  const body = text.indexOf("describe(");
  return body === -1 ? text : text.slice(0, body);
}

describe("src/metrics is a pure library", () => {
  it("has modules to check", () => {
    expect(metricsFiles().length).toBeGreaterThan(10);
  });

  it.each(metricsFiles())("%s imports nothing outside node builtins and this directory", (name) => {
    expect(violations(sourceOf(name), name)).toEqual([]);
  });

  it("names none of the modules it must not reach", () => {
    const forbidden = [BACKEND, GROUND_TRUTH, REPLAY, RUNNER];
    for (const name of metricsFiles()) {
      const source = sourceOf(name);
      for (const specifier of forbidden) {
        expect(specifiers(source), `${name} must not import ${specifier}`).not.toContain(specifier);
      }
    }
  });

  it("catches a deep import when there is one", () => {
    const broken = [
      `import { scoringWindows } from ${JSON.stringify(GROUND_TRUTH)};`,
      `import { readRows } from ${JSON.stringify(`${REPLAY}/csv.ts`)};`,
      `export { host } from ${JSON.stringify(`${RUNNER}/host.ts`)};`,
      `import ${JSON.stringify(BACKEND_PIPELINE)};`,
    ].join("\n");

    expect(violations(broken, "broken.ts")).toEqual([
      `broken.ts: imports ${GROUND_TRUTH}`,
      `broken.ts: leaves the directory via ${REPLAY}/csv.ts`,
      `broken.ts: leaves the directory via ${RUNNER}/host.ts`,
      `broken.ts: imports ${BACKEND_PIPELINE}`,
    ]);
  });

  it("accepts the imports a metrics module legitimately makes", () => {
    const fine = [
      'import { readFileSync } from "node:fs";',
      'import type { ScoringWindow } from "./types.ts";',
      'export { matchTickets } from "./match.ts";',
    ].join("\n");

    expect(violations(fine, "fine.ts")).toEqual([]);
  });

  it("allows vitest only in a test file", () => {
    const source = 'import { describe } from "vitest";';
    expect(violations(source, "match.test.ts")).toEqual([]);
    expect(violations(source, "match.ts")).toEqual(["match.ts: imports vitest"]);
  });
});
