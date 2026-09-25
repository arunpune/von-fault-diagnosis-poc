// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What produced a run, for the header of `run.json`: the number is not the
// story.
//
// A figure is only worth quoting next to the code, the labels and the runtime
// that produced it, so a report records the commit, the Node version, the
// backend's version, and the version and digests of the ground-truth data it
// was scored against — the last because a stored run is re-scored when the
// labels change, and a re-score must be able to tell that they did.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { VERSION as BACKEND_VERSION } from "@fdp/backend/pipeline";
import { DATA_DIR } from "@fdp/ground-truth";

import { REPO_ROOT } from "../slices.ts";

/** The failure table and the injection catalog, as `@fdp/ground-truth` ships them. */
const FAILURES_FILE = "metropt3-failures.json";
const INJECTIONS_FILE = "injections.json";

/** A full commit id. */
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** How long `git rev-parse` may take before the run records no commit rather than waiting. */
const GIT_TIMEOUT_MS = 5_000;

/** The ground-truth data a run was scored against. */
export interface GroundTruthProvenance {
  readonly package_version: string;
  readonly failures_sha256: string;
  /** `null` in a checkout whose injection catalog is not written yet. */
  readonly injections_sha256: string | null;
}

/** The provenance block of a report. */
export interface Provenance {
  readonly git_sha: string | null;
  readonly node: string;
  readonly backend_version: string;
  readonly ground_truth: GroundTruthProvenance;
}

/** The SHA-256 of a file's bytes, lowercase hex. */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The commit the working tree is at, or `null` when there is no Git, no repository or the
 * answer is not a commit id — a report from an exported tarball is still a report.
 */
export function gitSha(root: string = REPO_ROOT): string | null {
  try {
    const answer = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    return GIT_SHA_PATTERN.test(answer) ? answer : null;
  } catch {
    return null;
  }
}

/**
 * The version of `@fdp/ground-truth` and the digests of the two data files it serves.
 *
 * @throws Error when the package manifest or the failure table is missing, which is a broken
 * checkout rather than something a report can paper over.
 */
export function groundTruthProvenance(dataDir: string = DATA_DIR): GroundTruthProvenance {
  const manifest = JSON.parse(readFileSync(join(dirname(dataDir), "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string") {
    throw new Error(`${join(dirname(dataDir), "package.json")} carries no version`);
  }
  const injections = join(dataDir, INJECTIONS_FILE);
  return {
    package_version: manifest.version,
    failures_sha256: sha256File(join(dataDir, FAILURES_FILE)),
    injections_sha256: existsSync(injections) ? sha256File(injections) : null,
  };
}

/** Everything the report header says about what produced the run. */
export function collectProvenance(): Provenance {
  return {
    git_sha: gitSha(),
    node: process.version,
    backend_version: BACKEND_VERSION,
    ground_truth: groundTruthProvenance(),
  };
}
