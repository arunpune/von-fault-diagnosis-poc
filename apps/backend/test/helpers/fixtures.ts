// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the telemetry fixtures live, and how a test reads one.
 *
 * No MetroPT-3 row is committed, so these files are built on the machine that
 * runs the tests: `make fixtures` cuts the slices `data/fixtures/` defines, and
 * `pnpm --filter @fdp/backend fixtures` turns six of them into the batches this
 * package replays. Everything below the repository's `data/` directory is
 * git-ignored.
 *
 * A test that needs one calls {@link loadFixture} and skips itself when the
 * file is not there; `test/global-setup.ts` turns that into a hard failure
 * under `FDP_REQUIRE_DATASET=1`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { TelemetrySamples } from "@fdp/contracts";

/** The repository root, from this file's place in `apps/backend/test/helpers`. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Where `make fixtures` writes the cut slices (data/fixtures/README.md). */
export const SLICE_DIR = join(REPO_ROOT, "data", "fixtures", "metropt3");

/** Where this package's generator writes the batches. */
export const BACKEND_FIXTURE_DIR = join(SLICE_DIR, "backend");

/** The six fixtures `pnpm --filter @fdp/backend fixtures` writes. */
export const BACKEND_FIXTURE_NAMES = [
  "baseline-feb",
  "unlabelled-may19",
  "summer-jul05",
  "frozen-jun22",
  "depot-apr30",
  "gap-jump",
] as const;

export type BackendFixtureName = (typeof BACKEND_FIXTURE_NAMES)[number];

/** The header every generated fixture carries, so a run can be traced to its source. */
export interface TelemetryFixture {
  /** SHA-256 of the cut slice the rows came from (`data/fixtures/metropt3-slices.json`). */
  readonly source_sha256: string;
  /** The slice name, or `synthetic:<name>` for the one fixture that is assembled. */
  readonly slice: string;
  readonly generated_by: string;
  /** True while the register map carries provisional tag ids. */
  readonly signals_provisional: boolean;
  readonly window: { readonly from_sim_ts: string; readonly to_sim_ts: string };
  readonly samples: number;
  readonly batches: readonly TelemetrySamples[];
}

/** The absolute path of one generated fixture. */
export function fixturePath(name: BackendFixtureName): string {
  return join(BACKEND_FIXTURE_DIR, `${name}.json`);
}

/** True when the fixture has been generated on this machine. */
export function hasFixture(name: BackendFixtureName): boolean {
  return existsSync(fixturePath(name));
}

/** Read one generated fixture; throws when it has not been generated. */
export function loadFixture(name: BackendFixtureName): TelemetryFixture {
  const path = fixturePath(name);
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing; run \`make fixtures\` and \`pnpm --filter @fdp/backend fixtures\``,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as TelemetryFixture;
}

/** The absolute path of one cut slice, whether or not it exists. */
export function slicePath(slice: string): string {
  return join(SLICE_DIR, `${slice}.csv`);
}
