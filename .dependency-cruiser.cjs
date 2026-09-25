// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Import boundaries for the TypeScript workspace (docs/architecture.md#import-boundaries).
// One named rule per allowed edge between the workspaces, so a violation names the
// boundary it breaks. `.cjs` because the repository root is ESM.
//
// Run with `pnpm run lint:boundaries` (= `make boundaries`, TypeScript part).

/** Ground truth, as a resolved workspace path and as an unresolvable bare specifier. */
const GROUND_TRUTH = ["^packages/ground-truth/", "^@fdp/ground-truth"];

/** The diagnosis modules of the backend; `overlay` is deliberately absent. */
const DIAGNOSIS =
  "^apps/backend/src/(ingest|detection|retrieval|decision|gate|episodes|tickets|cost|heartbeat|pipeline)/";

/** Anything inside the workspace. */
const WORKSPACE = "^(apps|packages|tools)/";

module.exports = {
  forbidden: [
    {
      name: "not-to-unresolvable",
      comment:
        "Undeclared workspace dependencies and deep imports past a package's `exports` map do " +
        "not resolve under pnpm's strict node_modules; this turns them into errors. " +
        "The frontend's `@/` source alias is not one of them: Vite and `tsc -b` " +
        "resolve it, and this configuration reads one tsconfig, the workspace base, which does " +
        "not declare it. Every frontend file is still cruised, so the frontend rules below see " +
        "each of its imports of a workspace package.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true, pathNot: "^@/" },
    },
    {
      name: "no-gt-in-backend",
      comment:
        "The backend has no ground-truth code path, not even in overlay, which " +
        "gets its data from the broker and the gt schema (ground-truth isolation).",
      severity: "error",
      from: { path: "^apps/backend/" },
      to: { path: GROUND_TRUTH },
    },
    {
      name: "no-gt-in-frontend",
      comment: "The UI never sees which fault is present (ground-truth isolation).",
      severity: "error",
      from: { path: "^apps/frontend/" },
      to: { path: GROUND_TRUTH },
    },
    {
      name: "no-gt-reachable-from-diagnosis",
      comment:
        "Transitive guarantee: no chain of imports leads from a diagnosis module " +
        "to the ground-truth package or to the evaluation harness. Only overlay is exempt.",
      severity: "error",
      from: { path: "^apps/backend/src/", pathNot: "^apps/backend/src/overlay/" },
      to: { path: "^packages/ground-truth/|^tools/eval/", reachable: true },
    },
    {
      name: "no-overlay-in-diagnosis",
      comment:
        "The diagnosis modules never import the overlay recorder, the gt " +
        "schema helper or the ops MQTT client.",
      severity: "error",
      from: { path: DIAGNOSIS },
      to: { path: "^apps/backend/src/(overlay/|db/gt\\.ts$|mqtt/ops-client\\.ts$)" },
    },
    {
      name: "no-backend-in-frontend",
      comment: "The frontend talks to the backend over REST and WS, never by import.",
      severity: "error",
      from: { path: "^apps/frontend/" },
      to: { path: "^apps/backend/|^@fdp/backend" },
    },
    {
      name: "frontend-contracts-types-only",
      comment:
        "The frontend uses @fdp/contracts for types only, so nothing of the " +
        "contract package ends up in the browser bundle.",
      severity: "error",
      from: { path: "^apps/frontend/" },
      to: { path: "^packages/contracts/", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "frontend-only-contracts",
      comment: "@fdp/contracts is the frontend's only workspace dependency.",
      severity: "error",
      from: { path: "^apps/frontend/" },
      to: { path: WORKSPACE, pathNot: "^apps/frontend/|^packages/contracts/" },
    },
    {
      name: "backend-only-contracts",
      comment:
        "@fdp/contracts is the backend's only runtime workspace dependency " +
        "(@fdp/db-migrate is allowed from apps/backend/test/** only). Ground truth is left to " +
        "the two rules that name it, so each broken edge reports exactly one rule.",
      severity: "error",
      from: { path: "^apps/backend/src/" },
      to: {
        path: WORKSPACE,
        pathNot: "^apps/backend/|^packages/contracts/|^packages/ground-truth/",
      },
    },
    {
      name: "eval-only-pipeline-entry",
      comment:
        "The evaluation harness drives the backend through its exported " +
        "src/pipeline entry and nothing else.",
      severity: "error",
      from: { path: "^tools/eval/" },
      to: {
        path: "^apps/backend/|^@fdp/backend",
        pathNot: "^apps/backend/src/pipeline/index\\.ts$|^@fdp/backend/pipeline$",
      },
    },
    {
      name: "eval-allowed-imports",
      comment:
        "The evaluation harness imports contracts, ground truth, the migration " +
        "runner and the backend pipeline entry, and nothing else from the workspace.",
      severity: "error",
      from: { path: "^tools/eval/" },
      to: {
        path: WORKSPACE,
        pathNot:
          "^tools/eval/|^packages/(contracts|ground-truth|db-migrate)/|^apps/backend/src/pipeline/",
      },
    },
    {
      name: "contracts-pure",
      comment: "@fdp/contracts imports nothing from the workspace.",
      severity: "error",
      from: { path: "^packages/contracts/" },
      to: { path: WORKSPACE, pathNot: "^packages/contracts/" },
    },
    {
      name: "db-migrate-pure",
      comment: "@fdp/db-migrate imports nothing from the workspace.",
      severity: "error",
      from: { path: "^packages/db-migrate/" },
      to: { path: WORKSPACE, pathNot: "^packages/db-migrate/" },
    },
    {
      name: "ground-truth-only-contracts",
      comment: "@fdp/ground-truth imports @fdp/contracts and nothing else.",
      severity: "error",
      from: { path: "^packages/ground-truth/" },
      to: { path: WORKSPACE, pathNot: "^packages/(ground-truth|contracts)/" },
    },
    {
      name: "no-circular",
      comment: "A cycle between modules makes the boundary rules hard to read; warn on it.",
      severity: "warn",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-test-in-prod",
      comment:
        "Production code never imports tests or fixtures. The frontend's test harness lives in " +
        "apps/frontend/src/test (setup, render, msw handlers, fixtures) and is test " +
        "code itself, so its own imports are exempt; a production module importing it is not.",
      severity: "error",
      from: {
        path: "^(apps|packages|tools)/[^/]+/src/",
        pathNot: "(\\.test\\.tsx?$|^apps/frontend/src/test/)",
      },
      to: { path: "(\\.test\\.tsx?$|/test/|/fixtures/)" },
    },
  ],
  options: {
    // `exclude`, not `includeOnly`: an unresolvable import must stay visible so that
    // `not-to-unresolvable` can report it.
    exclude: { path: "(^|/)(node_modules|dist|coverage|build)/" },
    doNotFollow: { path: "node_modules" },
    // Marks `import type` dependencies as "type-only" for frontend-contracts-types-only.
    tsPreCompilationDeps: "specify",
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      // The `@fdp/source` export condition makes workspace packages resolve to their
      // TypeScript sources, so the rules above match real source paths.
      conditionNames: ["@fdp/source", "import", "types", "default"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
      mainFields: ["module", "main", "types"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
