// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The Docker-backed suites of @fdp/db-migrate.
//
// `fdpVitest()` merges arrays instead of replacing them, and its `exclude`
// holds `**/integration/**`, so this config takes the resolution conditions
// from it and states its own `test` block.
//
// Every file starts its own container with a random host port, so several
// worktrees can run this suite at the same time. The files run one after the
// other (`fileParallelism: false`) to keep the number of live containers at one.

import { defineConfig } from "vitest/config";

import { fdpVitest } from "../../vitest.base.ts";

const base = fdpVitest();

export default defineConfig({
  resolve: base.resolve,
  ssr: base.ssr,
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
