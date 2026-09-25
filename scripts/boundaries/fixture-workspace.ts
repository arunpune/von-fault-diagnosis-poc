// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Helpers shared by the boundary tests.
//
// Each test copies one of the two fixture workspaces to a temporary directory and installs
// it. The copy keeps the fixture's depth below the temporary root and puts the repository's
// tsconfig.base.json at that root, so the fixture's `"extends": "../../../../tsconfig.base.json"`
// keeps pointing at the real base configuration.
//
// The temporary root is resolved with `realpathSync` because on macOS `os.tmpdir()` returns
// the /var symlink while pnpm and enhanced-resolve report /private/var: without it, every
// resolved module path would start with "../../.." and no boundary rule would match.

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root (this file lives in scripts/boundaries/). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Path of the fixture directory relative to the repository root. */
const FIXTURE_DIR = join("scripts", "boundaries", "fixtures");

export type FixtureName = "clean" | "violations";

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FixtureWorkspace {
  /** The temporary directory holding the copy of tsconfig.base.json. */
  readonly tempRoot: string;
  /** The installed copy of the fixture workspace; every command runs here. */
  readonly root: string;
}

/** Runs a command and returns its exit status and output instead of throwing. */
export function run(command: string, args: readonly string[], cwd: string): CommandResult {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    // NO_COLOR keeps the reporters' output free of escape sequences so tests can match it.
    // FORCE_COLOR="0" goes with it because dependency-cruiser colours through node:util's
    // styleText, whose shouldColorize() answers FORCE_COLOR before it looks at NO_COLOR or
    // at the stream: a parent that sets FORCE_COLOR (vitest does in its workers) would
    // otherwise wrap every path of the err report in bold and no assertion would match.
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Absolute path of one of the repository's installed CLI binaries. */
export function repoBin(name: string): string {
  return join(REPO_ROOT, "node_modules", ".bin", name);
}

/**
 * Copies a fixture workspace to a fresh temporary directory and installs it.
 *
 * Every dependency is a `workspace:*` link, so the install needs no registry; `--offline`
 * is tried first and `--prefer-offline` is the fallback for a store that pnpm refuses to
 * use in fully offline mode.
 */
export function installFixture(name: FixtureName): FixtureWorkspace {
  const tempRoot = mkdtempSync(join(realpathSync(tmpdir()), "fdp-boundaries-"));
  const root = join(tempRoot, FIXTURE_DIR, name);

  mkdirSync(dirname(root), { recursive: true });
  cpSync(join(REPO_ROOT, FIXTURE_DIR, name), root, { recursive: true });
  copyFileSync(join(REPO_ROOT, "tsconfig.base.json"), join(tempRoot, "tsconfig.base.json"));

  const offline = run("pnpm", ["install", "--offline", "--ignore-scripts"], root);
  if (offline.status !== 0) {
    const preferOffline = run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], root);
    if (preferOffline.status !== 0) {
      throw new Error(
        `pnpm install failed in ${root}\n--offline:\n${offline.stderr}\n` +
          `--prefer-offline:\n${preferOffline.stderr}`,
      );
    }
  }

  return { tempRoot, root };
}

/** Removes a workspace created by {@link installFixture}. */
export function removeFixture(workspace: FixtureWorkspace): void {
  rmSync(workspace.tempRoot, { recursive: true, force: true });
}
