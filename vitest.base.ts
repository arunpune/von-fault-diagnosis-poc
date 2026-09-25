// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Shared Vitest configuration for every workspace package.
//
// Packages import it by relative path — `import { fdpVitest } from "../../vitest.base.ts"` —
// because configuration files sit outside every import-boundary rule.
//
// The point of the helper is the `@fdp/source` export condition: with it, an import of
// `@fdp/contracts` resolves to `packages/contracts/src/index.ts` instead of a `dist/` build,
// so tests never need `tsc -b` first. `resolve.conditions` covers the browser-side module
// graph, `ssr.resolve.conditions` the server-side one and `ssr.resolve.externalConditions`
// the packages Vite externalises rather than transforms; all three need the same value.
//
// Integration tests are excluded here and run through each package's `test:integration`
// script with its own config, so `make test` stays offline and Docker-free.
//
// @fdp/contracts confirms the vitest side of the condition in a real package; the
// fixture tests under scripts/boundaries cover Node, tsc and dependency-cruiser.

import { defineConfig, mergeConfig, type ViteUserConfig as UserConfig } from "vitest/config";

const SOURCE_CONDITION = "@fdp/source";

function baseConfig(): UserConfig {
  return defineConfig({
    resolve: { conditions: [SOURCE_CONDITION] },
    ssr: {
      resolve: {
        conditions: [SOURCE_CONDITION],
        externalConditions: [SOURCE_CONDITION],
      },
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
      exclude: [
        "**/integration/**",
        "**/*.integration.test.ts",
        "**/node_modules/**",
        "**/dist/**",
      ],
      coverage: { provider: "v8" },
      testTimeout: 30_000,
    },
  });
}

/**
 * The shared Vitest configuration, with `overrides` merged on top of it.
 *
 * Arrays are concatenated and objects are merged deeply, so a package adds setup files or
 * coverage thresholds without restating the resolution conditions.
 */
export function fdpVitest(overrides?: UserConfig): UserConfig {
  const base = baseConfig();
  return overrides === undefined ? base : (mergeConfig(base, overrides) as UserConfig);
}
