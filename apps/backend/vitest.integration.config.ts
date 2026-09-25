// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The Docker-backed suites of @fdp/backend (docs/development.md#integration-tests).
//
// `fdpVitest()` excludes `**/integration/**`, so this config states its own
// `test` block and takes only the resolution conditions from it.
//
// The live smoke runs only in the `live` mode that the `test:live` script
// selects (`--mode live`). The default mode, which `make test-integration`
// uses, never includes `test/live/**`, so a key exported in a developer's
// shell cannot turn the integration gate into a paid call.
//
// Every file starts its own containers on random host ports, so several
// worktrees can run the suite at the same time; `fileParallelism: false` keeps
// the number of live containers at one file's worth.

import { defineConfig } from "vitest/config";

import { fdpVitest } from "../../vitest.base.ts";

const base = fdpVitest();

/** The Vite mode of `pnpm --filter @fdp/backend test:live`. */
const LIVE_MODE = "live";

export default defineConfig(({ mode }) => ({
  resolve: base.resolve,
  ssr: base.ssr,
  test: {
    environment: "node",
    include:
      mode === LIVE_MODE ? ["test/live/**/*.live.test.ts"] : ["test/integration/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
}));
