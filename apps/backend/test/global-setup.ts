// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * What every suite of this package needs before the first test file runs.
 *
 * Two jobs:
 *
 *   * pin the process time zone, so a test that formats an instant reads the
 *     same string on a laptop and in CI;
 *   * decide once what a missing dataset means. No MetroPT-3 row is committed,
 *     so the fixtures under `data/fixtures/metropt3/backend/` exist only where
 *     `make fixtures` and `pnpm --filter @fdp/backend fixtures` have run. Tests
 *     that read them skip when they are absent; setting `FDP_REQUIRE_DATASET=1`
 *     turns that skip into a failure here, before a single test has run, so the
 *     message says what to do rather than showing a list of skips.
 */

import { existsSync } from "node:fs";
import process from "node:process";

import { BACKEND_FIXTURE_DIR, BACKEND_FIXTURE_NAMES, fixturePath } from "./helpers/fixtures.ts";

export default function setup(): void {
  process.env.TZ = "UTC";

  const missing = BACKEND_FIXTURE_NAMES.filter((name) => !existsSync(fixturePath(name)));
  if (missing.length === 0) return;

  const message =
    `the telemetry fixtures are missing from ${BACKEND_FIXTURE_DIR} (${missing.join(", ")}); ` +
    "run `make fixtures` and then `pnpm --filter @fdp/backend fixtures`";
  if (process.env.FDP_REQUIRE_DATASET === "1") throw new Error(message);
  process.stdout.write(`backend tests: ${message}; the tests that read them will skip\n`);
}
