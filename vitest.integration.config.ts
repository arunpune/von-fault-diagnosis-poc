// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The root Vitest project for repository-level integration tests: the files
// under `scripts/` that need Docker.
//
// `vitest.config.ts` and `vitest.base.ts` exclude `*.integration.test.ts`, so
// `make test` stays offline and Docker-free; this config is the only way to run
// them, through `pnpm run test:integration` and `make test-integration`.
//
// `include` and `exclude` are set after `fdpVitest` rather than passed into it:
// `mergeConfig` concatenates arrays, so an override would add to the base's
// exclude list instead of replacing it, and the integration files would still
// be filtered out.

import { defaultExclude, defineConfig } from "vitest/config";
import { fdpVitest } from "./vitest.base.ts";

// Building an image and starting containers is slow, and a broker test that
// times out at 30 s would be a flake, not a finding.
const base = fdpVitest({ test: { testTimeout: 120_000, pool: "forks" } });

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["scripts/**/*.integration.test.ts"],
    exclude: [...defaultExclude, "scripts/boundaries/fixtures/**"],
  },
});
