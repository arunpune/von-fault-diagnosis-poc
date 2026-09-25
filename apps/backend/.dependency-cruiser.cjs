// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Import boundaries inside @fdp/backend (docs/architecture.md#import-boundaries).
//
// The repository-root `.dependency-cruiser.cjs` guards the edges between packages;
// this file guards the edges between the modules of this one. It is what
// `pnpm --filter @fdp/backend lint` runs, as `depcruise src --config .dependency-cruiser.cjs`.
//
// Paths are relative to the directory the cruise runs from, so every rule anchors on
// `^src/`. `test/arch/imports.test.ts` copies `src` into a throw-away directory, adds one
// forbidden import and re-runs this configuration there, which is why `tsConfig` and the
// resolver are pinned to this file's directory rather than to the working directory.
//
// `.cjs` because this package is ESM.

const { join } = require("node:path");

/** The diagnosis modules: everything that reasons about the machine. */
const DIAGNOSIS =
  "^src/(ingest|detection|retrieval|decision|gate|episodes|tickets|cost|heartbeat|pipeline|status)/";

/** The overlay and the two privileged data paths only it may use. */
const OVERLAY = "^src/(overlay/|db/gt\\.ts$|mqtt/ops-client\\.ts$)";

/** Ground truth, as a workspace path and as a bare specifier, plus the evaluation harness. */
const GROUND_TRUTH = "(^|/)ground-truth(/|$)|^@fdp/ground-truth|(^|/)tools/eval/";

/**
 * The broker and database drivers, wherever the package manager put them.
 *
 * pnpm resolves them under `.pnpm/<name>@<version>/node_modules/<name>/`, a hoisting
 * layout under `node_modules/<name>/`; both end in the same two segments. The pattern
 * carries no quantifier on purpose — dependency-cruiser refuses a rule whose regular
 * expression could backtrack.
 */
const RAW_IO_DRIVERS = "/node_modules/mqtt/|/node_modules/pg/";

/** The adapters that are allowed to speak to the broker and the database directly. */
const IO_ADAPTERS = "^src/(mqtt/|db/|persistence/)";

module.exports = {
  forbidden: [
    {
      name: "not-to-unresolvable",
      comment:
        "Undeclared dependencies and deep imports past a package's `exports` map do not " +
        "resolve under pnpm's strict node_modules; this turns them into errors.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-gt-anywhere",
      comment:
        "Ground truth never reaches diagnosis code: no module of this package, overlay " +
        "included, imports the ground-truth package or the evaluation harness. The overlay " +
        "gets its data from the broker and from its own schema, never from a shared module.",
      severity: "error",
      from: { path: "^src/" },
      to: { path: GROUND_TRUTH },
    },
    {
      name: "no-overlay-in-diagnosis",
      comment:
        "The diagnosis modules never import the overlay, its configuration, its database " +
        "pool or its broker client.",
      severity: "error",
      from: { path: DIAGNOSIS },
      to: { path: OVERLAY },
    },
    {
      name: "gt-pool-only-in-overlay-repo",
      comment:
        "`overlay/repo.ts` is the only importer of the privileged pool, so every statement " +
        "that touches the overlay schema is in one file. The pool's own unit test is " +
        "excluded; `no-test-in-prod` keeps it out of production code.",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/overlay/repo\\.ts$|\\.test\\.ts$" },
      to: { path: "^src/db/gt\\.ts$" },
    },
    {
      name: "overlay-read-routes-stay-read-only",
      comment:
        "`overlay/routes-read.ts` is the read-only overlay endpoint. It may query the " +
        "repository, and it may not reach the recorder or the control passthrough — a GET " +
        "route never writes and never moves the replay.",
      severity: "error",
      from: { path: "^src/overlay/routes-read\\.ts$" },
      to: { path: "^src/overlay/(recorder|simctl|routes-sim|index)\\.ts$" },
    },
    {
      name: "overlay-config-stays-in-the-overlay",
      comment:
        "`overlay/config.ts` is the only reader of the two privileged credentials, so " +
        "nothing outside `src/overlay/` imports it; the composition root goes through " +
        "`overlay/index.ts`.",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/overlay/" },
      to: { path: "^src/overlay/config\\.ts$" },
    },
    {
      name: "diagnosis-no-raw-io",
      comment:
        "The diagnosis modules talk to injected ports. Only the adapters under " +
        "src/mqtt/, src/db/ and src/persistence/ import the broker or the database driver.",
      severity: "error",
      from: { path: DIAGNOSIS },
      to: { path: RAW_IO_DRIVERS },
    },
    {
      name: "io-drivers-only-in-adapters",
      comment:
        "The same rule seen from the driver's side: nothing outside the adapters and " +
        "the composition root imports the broker or the database driver.",
      severity: "error",
      from: { path: "^src/", pathNot: `${IO_ADAPTERS}|^src/index\\.ts$` },
      to: { path: RAW_IO_DRIVERS },
    },
    {
      name: "pipeline-pure",
      comment:
        "src/pipeline is the entry tools/eval composes, so it holds no host. " +
        "It reaches the database, the broker, the HTTP server and the overlay through the " +
        "ports its caller injects.",
      severity: "error",
      from: { path: "^src/pipeline/" },
      to: { path: "^src/(db|mqtt|api|ws|overlay|runtime)/" },
    },
    {
      name: "no-test-in-prod",
      comment: "Production code never imports tests or fixtures.",
      severity: "error",
      from: { path: "^src/", pathNot: "\\.test\\.ts$" },
      to: { path: "(\\.test\\.ts$|^test/|/fixtures/)" },
    },
    {
      name: "no-circular",
      comment: "A cycle between modules makes the boundary rules hard to read; warn on it.",
      severity: "warn",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    // `exclude`, not `includeOnly`: an unresolvable import must stay visible so that
    // `not-to-unresolvable` can report it, and the resolved path of a dependency must
    // stay visible so that `diagnosis-no-raw-io` sees the driver it landed on.
    //
    // The pattern is anchored at the working directory on purpose. An unanchored
    // `build/` would also hide `node_modules/mqtt/build/index.js`, which is where the
    // broker driver's entry point lives, and the rule that names it would never fire.
    // `doNotFollow` already stops the cruise at the first module of a package.
    exclude: { path: "^(dist|coverage|build)/" },
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: "specify",
    tsConfig: { fileName: join(__dirname, "tsconfig.json") },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      // The `@fdp/source` condition makes workspace packages resolve to their
      // TypeScript sources, so the rules above match real source paths.
      conditionNames: ["@fdp/source", "import", "types", "default"],
      extensions: [".ts", ".js", ".mjs", ".cjs", ".json"],
      mainFields: ["module", "main", "types"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
