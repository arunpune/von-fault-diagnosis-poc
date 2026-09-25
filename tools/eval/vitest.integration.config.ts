// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The suites of @fdp/eval that need something the offline suite must not:
// Docker (`test/integration/**`, the sim + gateway parity run and the
// Postgres stack scorer), a whole harness run (`test/e2e/**`, the smoke
// profile, and `test/backends/**`, the cassette round trip) or a live model
// key (`test/live/**`).
//
// The live smoke tests run only in the `live` mode that the `test:live`
// launcher selects (`test/live/launch.ts`, `--mode live`). The default mode,
// which `make test-integration` uses, never includes `test/live/**`, so a key
// exported in a developer's shell cannot turn the integration gate into a
// paid call — the same split as @fdp/backend's.
//
// `fdpVitest()` merges arrays instead of replacing them, and its `exclude`
// holds `**/integration/**`, so this config takes the `@fdp/source` resolution
// conditions from it and states its own `test` block, exactly as
// `packages/db-migrate` does.
//
// One file at a time (`fileParallelism: false`): a parity run holds a broker
// and a simulator container, and two of them at once would fight over the
// Docker daemon of a developer machine that is already running the stack.
//
// `passWithNoTests` because a filter may select no file of a mode, and
// `make test-integration` (`pnpm -r run --if-present test:integration`) must
// stay green.

import { defineConfig } from "vitest/config";

import { fdpVitest } from "../../vitest.base.ts";

const base = fdpVitest();

/** A full-CSV profile or a container build is slow; 30 s would be a flake, not a finding. */
const TIMEOUT_MS = 600_000;

/** The Vite mode of `pnpm --filter @fdp/eval test:live`. */
const LIVE_MODE = "live";

export default defineConfig(({ mode }) => ({
  resolve: base.resolve,
  ssr: base.ssr,
  test: {
    environment: "node",
    include:
      mode === LIVE_MODE
        ? ["test/live/**/*.live.test.ts"]
        : ["test/integration/**/*.test.ts", "test/e2e/**/*.test.ts", "test/backends/**/*.test.ts"],
    fileParallelism: false,
    passWithNoTests: true,
    testTimeout: TIMEOUT_MS,
    hookTimeout: TIMEOUT_MS,
  },
}));
