// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The root Vitest project: repository-level tests under scripts/, not package tests —
// those run through `pnpm -r run test`.
//
// The boundary tests install two miniature pnpm workspaces in a temporary directory and
// run the real depcruise, tsc, node and ESLint binaries over them, so they need a forked
// process per file and a generous timeout. The fixtures themselves are excluded: they
// contain a `gate.test.ts` that exists only to be imported by production code.
//
// `*.integration.test.ts` is excluded here the way `vitest.base.ts` excludes it for the
// packages, so `make test` needs no Docker; `vitest.integration.config.ts` runs those.

import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts"],
    exclude: [...defaultExclude, "**/*.integration.test.ts", "scripts/boundaries/fixtures/**"],
    pool: "forks",
    testTimeout: 120_000,
  },
});
