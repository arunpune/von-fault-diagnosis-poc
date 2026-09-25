// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package-local ESLint 10 flat config for @fdp/backend (docs/architecture.md#import-boundaries).
//
// The repository root config lints the whole workspace; this one is what
// `pnpm --filter @fdp/backend lint` runs, and it adds the two boundaries that
// only make sense inside this package:
//
//   * `no-restricted-imports` mirrors the first two dependency-cruiser rules of
//     `.dependency-cruiser.cjs`, so the editor reports a forbidden edge before
//     the gate does. dependency-cruiser stays the gate.
//   * `no-restricted-properties` keeps `process.env` out of every module but
//     the two configuration readers: the diagnosis side must not be able
//     to pick up the overlay's credentials by reading the environment itself.
//     Tests are exempt — they set up their own fixtures and containers from the
//     environment, and they hold no production code path.
//
// The type checking runs as `tsc --noEmit`, so the typescript-eslint config
// used here is the non-type-aware variant, as at the repository root.

import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

/** Ground truth is never imported by the backend. */
const GROUND_TRUTH_GROUP = ["@fdp/ground-truth", "@fdp/ground-truth/*", "**/ground-truth/**"];
const GROUND_TRUTH_MESSAGE =
  "Ground truth never reaches diagnosis code (docs/architecture.md#ground-truth-isolation)";

/** The overlay module and its two privileged data paths. */
const OVERLAY_GROUP = [
  "**/overlay/**",
  "**/db/gt",
  "**/db/gt.ts",
  "**/mqtt/ops-client",
  "**/mqtt/ops-client.ts",
];
const OVERLAY_MESSAGE =
  "Diagnosis modules never import the overlay, its configuration or its privileged clients";

/** Raw broker and database drivers belong to the adapters, not to the pipeline. */
const RAW_IO_GROUP = ["mqtt", "mqtt/*", "pg", "pg/*"];
const RAW_IO_MESSAGE =
  "Diagnosis modules talk to injected ports; only src/mqtt/**, src/db/** and src/persistence/** " +
  "import the broker or database driver";

/** The diagnosis modules of this package. */
const DIAGNOSIS_MODULES =
  "src/{ingest,detection,retrieval,decision,gate,episodes,tickets,cost,heartbeat,pipeline,status}/**/*.ts";

/** The only two modules allowed to read `process.env`. */
const CONFIG_MODULES = ["src/config/**/*.ts", "src/overlay/config.ts"];

export default defineConfig([
  globalIgnores(["dist/", "coverage/", "tmp/", "node_modules/"]),

  {
    name: "fdp-backend/base",
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "smart"],
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: GROUND_TRUTH_GROUP, message: GROUND_TRUTH_MESSAGE }] },
      ],
    },
  },

  {
    name: "fdp-backend/no-process-env",
    files: ["src/**/*.ts"],
    ignores: CONFIG_MODULES,
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "The environment is parsed once in src/config/env.ts and, for the overlay, in " +
            "src/overlay/config.ts; take what you need from the typed value",
        },
      ],
    },
  },

  {
    name: "fdp-backend/boundaries-diagnosis",
    files: [DIAGNOSIS_MODULES],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: GROUND_TRUTH_GROUP, message: GROUND_TRUTH_MESSAGE },
            { group: OVERLAY_GROUP, message: OVERLAY_MESSAGE },
            { group: RAW_IO_GROUP, message: RAW_IO_MESSAGE },
          ],
        },
      ],
    },
  },
]);
