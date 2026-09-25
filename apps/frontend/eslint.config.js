// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package-local ESLint 10 flat config for @fdp/frontend.
//
// ESLint 10 lints each file with the config nearest to it, so this file is what both
// `pnpm --filter @fdp/frontend lint` and the root `eslint .` apply under apps/frontend. It
// extends the root config — the workspace-wide TypeScript rules and Prettier compatibility —
// and adds what only this package needs, because the root blocks that name
// `apps/frontend/**` do not match paths seen from here:
//
//   * React: the hooks rules and the Vite fast-refresh rule, with browser globals.
//   * Imports (second guard; the root .dependency-cruiser.cjs is the first): nothing from the
//     labels package, the backend or the evaluation harness, spelled as globs on purpose so the
//     package's literal name never appears in this tree (scripts/check-gt-paths.sh);
//     `@fdp/contracts` for types only; lucide icons one module per icon, never the barrel.
//
// src/components/ui/ is shadcn CLI output and stays unlinted, as at the root.

import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

import rootConfig from "../../eslint.config.js";

/** Same message as the root config, so the editor and scripts/boundaries report alike. */
const GROUND_TRUTH_MESSAGE =
  "Ground truth never reaches diagnosis or UI code (docs/architecture.md#ground-truth-isolation)";

const ISOLATION_MESSAGE =
  "The UI reaches the backend over /api and /ws only; backend code and the evaluation harness " +
  "are never imported";

const TYPES_ONLY_MESSAGE = "@fdp/contracts is a type-only dependency of the UI: use `import type`";

const ICON_BARREL_MESSAGE =
  'Import each icon from "lucide-react/dist/esm/icons/<name>"; the barrel pulls every icon ' +
  "into the module graph";

export default defineConfig([
  ...rootConfig,

  globalIgnores(["dist/", "coverage/", "node_modules/", "src/components/ui/"]),

  {
    name: "fdp-frontend/react",
    files: ["**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },

  {
    name: "fdp-frontend/imports",
    files: ["**/*.{ts,tsx}"],
    rules: {
      // Everything forbidden outright, types included.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@fdp/ground-*", "**/packages/ground-*/**"], message: GROUND_TRUTH_MESSAGE },
            {
              group: ["@fdp/backend", "@fdp/backend/*", "**/tools/eval/**"],
              message: ISOLATION_MESSAGE,
            },
          ],
        },
      ],
      // Allowed as types only.
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@fdp/contracts", allowTypeImports: true, message: TYPES_ONLY_MESSAGE },
            { name: "lucide-react", allowTypeImports: true, message: ICON_BARREL_MESSAGE },
          ],
          patterns: [
            { group: ["@fdp/contracts/*"], allowTypeImports: true, message: TYPES_ONLY_MESSAGE },
          ],
        },
      ],
    },
  },

  {
    // The theme hook lives beside its provider so the generated sonner component can import
    // both from one module; fast refresh then reloads that one file in full.
    name: "fdp-frontend/theme-hook",
    files: ["src/components/theme/ThemeProvider.tsx"],
    rules: {
      "react-refresh/only-export-components": [
        "error",
        { allowConstantExport: true, allowExportNames: ["useTheme"] },
      ],
    },
  },
]);
