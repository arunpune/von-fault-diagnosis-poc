// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// ESLint 10 flat config for the whole pnpm workspace.
// The type checking is done by `tsc --noEmit` (`pnpm run typecheck`), so every
// typescript-eslint config here is the non-type-aware variant: that keeps
// `ESLint#lintText` on virtual file paths working, which is what the boundary
// tests in scripts/boundaries/eslint-boundaries.test.ts rely on.

import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Ground truth is never imported by diagnosis or UI code
 * (docs/architecture.md#ground-truth-isolation).
 */
const GROUND_TRUTH_GROUP = ["@fdp/ground-truth", "@fdp/ground-truth/*"];
const GROUND_TRUTH_MESSAGE =
  "Ground truth never reaches diagnosis or UI code (docs/architecture.md#ground-truth-isolation)";

/** The overlay module and its two data paths stay out of the diagnosis modules. */
const OVERLAY_GROUP = [
  "**/overlay/**",
  "**/db/gt",
  "**/db/gt.ts",
  "**/mqtt/ops-client",
  "**/mqtt/ops-client.ts",
];
const OVERLAY_MESSAGE =
  "Diagnosis modules never import the overlay, the gt schema or the ops MQTT client";

/** The diagnosis modules of apps/backend/src. */
const DIAGNOSIS_MODULES =
  "apps/backend/src/{ingest,detection,retrieval,decision,gate,episodes,tickets,cost,heartbeat,pipeline}/**/*.ts";

export default defineConfig([
  // 1. Never linted: third-party, generated and build output, plus the boundary
  //    fixtures, which are deliberately broken miniature workspaces.
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    "**/coverage/",
    "**/build/",
    "**/generated/",
    "scripts/boundaries/fixtures/",
    "**/.venv/",
    "reports/",
    "**/playwright-report/",
    "**/test-results/",
    "apps/frontend/src/components/ui/",
    // Gitignored local tool state. ESLint does not read .gitignore, and such a
    // folder may hold a whole checkout of this repository.
    "**/.claude/",
  ]),

  // 2. Every hand-written source file in the workspace.
  {
    name: "fdp/base",
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    extends: [js.configs.recommended, tseslint.configs.recommended, tseslint.configs.stylistic],
    // `tsconfigRootDir` is pinned to this file's directory so the parser never
    // auto-detects a rival root. Without it, a second tsconfig.json anywhere
    // below the repository makes every file fail with "multiple candidate
    // TSConfigRootDirs are present", which would make the lint gate depend on
    // what happens to sit on disk rather than on what is committed.
    languageOptions: {
      globals: globals.node,
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "smart"],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message: "Enums are not erasable; use a union of literals or an `as const` object",
        },
      ],
    },
  },

  // 3. The React single-page app.
  {
    name: "fdp/frontend",
    files: ["apps/frontend/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },

  // 4. Import boundaries, mirroring dependency-cruiser for editor feedback
  //    (docs/architecture.md#import-boundaries). dependency-cruiser stays the gate.
  {
    name: "fdp/boundaries-ground-truth",
    files: ["apps/backend/**/*.ts", "apps/frontend/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: GROUND_TRUTH_GROUP, message: GROUND_TRUTH_MESSAGE }] },
      ],
    },
  },
  {
    name: "fdp/boundaries-diagnosis",
    files: [DIAGNOSIS_MODULES],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: GROUND_TRUTH_GROUP, message: GROUND_TRUTH_MESSAGE },
            { group: OVERLAY_GROUP, message: OVERLAY_MESSAGE },
          ],
        },
      ],
    },
  },
  {
    name: "fdp/boundaries-pure-packages",
    files: ["packages/contracts/**/*.ts", "packages/db-migrate/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@fdp/*"],
              message: "This package imports nothing from the workspace",
            },
          ],
        },
      ],
    },
  },

  // 5. Formatting belongs to Prettier; this must stay last.
  { name: "fdp/prettier", ...prettier },
]);
