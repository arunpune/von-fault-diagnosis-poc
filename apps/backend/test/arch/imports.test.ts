// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ground-truth isolation, mechanically.
 *
 * Four checks:
 *
 *   1. the package boundary — `@fdp/ground-truth` is not a dependency of this
 *      package, so pnpm's strict `node_modules` cannot resolve it either;
 *   2. the module boundary — no source file outside the three overlay files
 *      even mentions the words the overlay owns;
 *   3. the configuration boundary — the `Env` type carries no credential of the
 *      overlay, checked at compile time from a list of names and again
 *      at run time over a parsed value;
 *   4. the rules bite — a throw-away copy of `src` with one forbidden import
 *      added makes dependency-cruiser exit non-zero and name the rule.
 *
 * The fourth is the one that matters: the first three would keep passing if
 * somebody deleted every rule from `.dependency-cruiser.cjs`.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Env } from "../../src/config/env.ts";
import { loadEnv } from "../../src/config/env.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(PACKAGE_ROOT, "src");
const CONFIG = join(PACKAGE_ROOT, ".dependency-cruiser.cjs");
const DEPCRUISE = join(PACKAGE_ROOT, "node_modules", ".bin", "depcruise");

/** Git-ignored, and ignored by this package's ESLint configuration. */
const SCRATCH_ROOT = join(PACKAGE_ROOT, "tmp");

/**
 * The words that belong to the overlay, and the three files that may say them.
 * Written as fragments so this file can name them without
 * matching itself — it is not under `src`, but the intent stays readable.
 */
const OVERLAY_WORDS = ["gt" + "/", "ground" + "-truth", "gt" + "_rw", "backend" + "-ops"];

/** The only files of `src` allowed to carry those words. */
const OVERLAY_FILES = ["db/gt.ts", "mqtt/ops-client.ts"];
const OVERLAY_DIR = "overlay/";

/** Variable names the overlay reads and the diagnosis configuration must not. */
const OVERLAY_ENV_VARIABLES = [
  "PG_GT_PASSWORD",
  "DATABASE_URL_GT",
  "MQTT_BACKEND_OPS_PASSWORD",
] as const;

/** Property names that would mean a credential of the overlay reached {@link Env}. */
type ForbiddenEnvKey =
  "gtPassword" | "databaseUrlGt" | "mqttOpsPassword" | "mqttOpsUsername" | "overlay";

/** Compile-time: `Env` and {@link ForbiddenEnvKey} have no name in common. */
type EnvHasNoOverlayKey = Extract<keyof Env, ForbiddenEnvKey> extends never ? true : false;
const ENV_HAS_NO_OVERLAY_KEY: EnvHasNoOverlayKey = true;

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function manifest(): PackageManifest {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as PackageManifest;
}

/** Every `.ts` file under `src`, as a path relative to `src`. */
function sourceFiles(directory = SRC): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(relative(SRC, path));
  }
  return found.sort();
}

/** True for the three files that own the overlay vocabulary. */
function isOverlayFile(relativePath: string): boolean {
  const posix = relativePath.split("\\").join("/");
  return posix.startsWith(OVERLAY_DIR) || OVERLAY_FILES.includes(posix);
}

/** Run dependency-cruiser over `src` in `cwd`; return its exit code and output. */
function cruise(cwd: string): { code: number; output: string } {
  try {
    const output = execFileSync(DEPCRUISE, ["src", "--config", CONFIG], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/**
 * Copy `src` next to the package, add `extraSource` to one module and cruise it.
 *
 * The copy sits under the package directory so that Node's resolution still
 * finds `node_modules`, and the configuration pins its `tsConfig` and resolver
 * to the real package, so the run differs from the real one in exactly the
 * line the test added.
 */
function cruiseWithExtra(module: string, extraSource: string): { code: number; output: string } {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const scratch = mkdtempSync(join(SCRATCH_ROOT, "arch-"));
  try {
    cpSync(SRC, join(scratch, "src"), { recursive: true });
    appendFileSync(join(scratch, "src", module), `\n${extraSource}\n`);
    return cruise(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("package boundary", () => {
  it("declares no dependency on the ground-truth package", () => {
    const declared = manifest();
    for (const section of [
      declared.dependencies,
      declared.devDependencies,
      declared.peerDependencies,
      declared.optionalDependencies,
    ]) {
      for (const name of Object.keys(section ?? {})) {
        expect(name).not.toContain("ground");
      }
    }
  });
});

describe("module boundary", () => {
  it("keeps the overlay vocabulary inside the three files that own it", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (isOverlayFile(file)) continue;
      const text = readFileSync(join(SRC, file), "utf8");
      for (const word of OVERLAY_WORDS) {
        if (text.includes(word)) offenders.push(`${file}: ${word}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("looks at a source tree that is really there", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain("db/gt.ts");
  });
});

describe("configuration boundary", () => {
  it("has no overlay credential in the Env type", () => {
    expect(ENV_HAS_NO_OVERLAY_KEY).toBe(true);
  });

  it("drops the overlay variables even when they are in the environment", () => {
    const source: NodeJS.ProcessEnv = { PG_HOST: "postgres" };
    for (const name of OVERLAY_ENV_VARIABLES) source[name] = `value-of-${name}`;
    const env = loadEnv(source);
    const serialised = JSON.stringify(env);
    for (const name of OVERLAY_ENV_VARIABLES) {
      expect(serialised).not.toContain(`value-of-${name}`);
    }
  });

  it("reads process.env in the configuration modules alone", () => {
    const offenders = sourceFiles().filter((file) => {
      const posix = file.split("\\").join("/");
      if (posix.startsWith("config/") || posix === "overlay/config.ts") return false;
      return readFileSync(join(SRC, file), "utf8").includes("process.env");
    });
    expect(offenders).toEqual([]);
  });
});

describe("the boundary rules bite", () => {
  it("passes on the source tree as it stands", () => {
    expect(cruise(PACKAGE_ROOT).code).toBe(0);
  });

  it("refuses the overlay pool in a diagnosis module", () => {
    const result = cruiseWithExtra(
      "pipeline/index.ts",
      'import { createGtPool } from "../db/gt.ts";\nexport const forbidden = createGtPool;',
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("no-overlay-in-diagnosis");
  });

  it("refuses the ground-truth package anywhere", () => {
    const result = cruiseWithExtra(
      "pipeline/index.ts",
      'import * as forbidden from "@fdp/ground-truth";\nexport const used = forbidden;',
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("no-gt-anywhere");
  });

  it("refuses the broker driver in a diagnosis module", () => {
    const result = cruiseWithExtra(
      "pipeline/index.ts",
      'import forbidden from "mqtt";\nexport const used = typeof forbidden;',
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("diagnosis-no-raw-io");
  });

  it("refuses the database driver in a diagnosis module", () => {
    const result = cruiseWithExtra(
      "pipeline/index.ts",
      'import forbidden from "pg";\nexport const used = typeof forbidden;',
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("diagnosis-no-raw-io");
  });

  it("refuses a host inside the pipeline entry", () => {
    const result = cruiseWithExtra(
      "pipeline/index.ts",
      'import { apiError } from "../api/index.ts";\nexport const used = apiError;',
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("pipeline-pure");
  });
});
