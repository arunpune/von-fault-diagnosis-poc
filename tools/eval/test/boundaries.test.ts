// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Ground-truth isolation from the eval side
// (docs/architecture.md#ground-truth-isolation).
//
// The primary guard is the root dependency-cruiser configuration, whose
// `eval-only-pipeline-entry` and `eval-allowed-imports` rules say that the
// harness may reach `@fdp/contracts`, `@fdp/ground-truth`, `@fdp/db-migrate`
// and the backend's single `./pipeline` export, and nothing else in the
// workspace. This file is the local mirror: it runs that configuration over
// `tools/eval` and, independently of it, reads `package.json` and greps the
// sources, so a broken boundary is a failing unit test in this package rather
// than a lint job somebody has to remember to run.
//
// The grep is proved rather than trusted: the same scanner runs over a
// temporary copy of `src/` with one deep import added, and must report it.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The workspace packages `tools/eval/package.json` may list.
 *
 * `@fdp/db-migrate` is named for later — the stack-mode tests add the migration helper — so
 * the allow-list outlives the three entries the package carries today.
 */
const ALLOWED_WORKSPACE_DEPENDENCIES = [
  "@fdp/backend",
  "@fdp/contracts",
  "@fdp/db-migrate",
  "@fdp/ground-truth",
];

/** The three the package lists now, and must keep listing; the backend drives the in-process run. */
const REQUIRED_WORKSPACE_DEPENDENCIES = ["@fdp/backend", "@fdp/contracts", "@fdp/ground-truth"];

/** The backend's only export: the harness drives the pipeline and nothing else. */
const BACKEND_ENTRY = "@fdp/backend/pipeline";

/** Every quoted `@fdp/backend…` specifier, whichever import form carries it. */
const BACKEND_SPECIFIER = /["'](@fdp\/backend(?:\/[^"']*)?)["']/g;

/** Directories of hand-written source this package ships; `scripts/` arrives with later tasks. */
const SOURCE_DIRECTORIES = ["src", "scripts"];

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

interface Reference {
  readonly file: string;
  readonly specifier: string;
}

function typeScriptFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    found.push(join(entry.parentPath, entry.name));
  }
  return found.sort();
}

/** Every `@fdp/backend…` specifier under `<base>/{src,scripts}`, with the file it sits in. */
function backendReferences(base: string): Reference[] {
  const found: Reference[] = [];
  for (const directory of SOURCE_DIRECTORIES) {
    for (const file of typeScriptFiles(join(base, directory))) {
      for (const match of readFileSync(file, "utf8").matchAll(BACKEND_SPECIFIER)) {
        found.push({ file: relative(base, file), specifier: match[1] ?? "" });
      }
    }
  }
  return found;
}

/** The references that are not the one allowed entry point. */
function deepBackendImports(base: string): Reference[] {
  return backendReferences(base).filter(({ specifier }) => specifier !== BACKEND_ENTRY);
}

function workspaceDependencies(packageJsonPath: string): string[] {
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
  const names = new Set<string>();
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = manifest[section];
    if (typeof entries !== "object" || entries === null) continue;
    for (const name of Object.keys(entries)) {
      if (name.startsWith("@fdp/")) names.add(name);
    }
  }
  return [...names].sort();
}

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

describe("package.json", () => {
  const listed = workspaceDependencies(join(PACKAGE_DIR, "package.json"));

  it("lists no workspace package outside the allow-list", () => {
    expect(listed.filter((name) => !ALLOWED_WORKSPACE_DEPENDENCIES.includes(name))).toEqual([]);
  });

  it("lists the backend, contracts and ground truth", () => {
    expect(listed).toEqual(expect.arrayContaining(REQUIRED_WORKSPACE_DEPENDENCIES));
  });
});

describe("backend imports", () => {
  it("reaches the backend only through its pipeline entry", () => {
    expect(deepBackendImports(PACKAGE_DIR)).toEqual([]);
  });

  it("would report a deep import", () => {
    const copy = mkdtempSync(join(tmpdir(), "fdp-eval-boundaries-"));
    temporaryDirectories.push(copy);
    cpSync(join(PACKAGE_DIR, "src"), join(copy, "src"), { recursive: true });
    writeFileSync(
      join(copy, "src", "deep-import.ts"),
      'import { createPipeline } from "@fdp/backend/src/pipeline/index.ts";\n',
      "utf8",
    );

    expect(deepBackendImports(copy)).toEqual([
      { file: join("src", "deep-import.ts"), specifier: "@fdp/backend/src/pipeline/index.ts" },
    ]);
  });

  it("accepts the entry point itself", () => {
    const copy = mkdtempSync(join(tmpdir(), "fdp-eval-boundaries-"));
    temporaryDirectories.push(copy);
    cpSync(join(PACKAGE_DIR, "src"), join(copy, "src"), { recursive: true });
    writeFileSync(
      join(copy, "src", "entry-import.ts"),
      `import { createPipeline } from "${BACKEND_ENTRY}";\n`,
      "utf8",
    );

    const references = backendReferences(copy);
    expect(references).toContainEqual({
      file: join("src", "entry-import.ts"),
      specifier: BACKEND_ENTRY,
    });
    expect(references.every(({ specifier }) => specifier === BACKEND_ENTRY)).toBe(true);
    expect(deepBackendImports(copy)).toEqual([]);
  });
});

describe("dependency-cruiser", () => {
  const binary = join(REPO_ROOT, "node_modules/.bin/depcruise");
  const config = join(REPO_ROOT, ".dependency-cruiser.cjs");
  const installed = existsSync(binary) && existsSync(config);

  it.skipIf(!installed)(
    "reports no violation for tools/eval",
    () => {
      let output: string;
      try {
        output = execFileSync(
          binary,
          ["tools/eval", "--config", ".dependency-cruiser.cjs", "--output-type", "err"],
          { cwd: REPO_ROOT, encoding: "utf8" },
        );
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string };
        throw new Error(`depcruise failed:\n${failed.stdout ?? ""}${failed.stderr ?? ""}`, {
          cause: error,
        });
      }
      expect(output).toContain("no dependency violations found");
    },
    180_000,
  );
});
