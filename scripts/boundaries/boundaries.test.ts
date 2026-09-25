// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Proves that .dependency-cruiser.cjs enforces the allowed import edges
// (docs/architecture.md#import-boundaries): the clean fixture passes, and the violations
// fixture reports exactly the nine rules it was built to break.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  installFixture,
  removeFixture,
  repoBin,
  run,
  REPO_ROOT,
  type CommandResult,
  type FixtureName,
  type FixtureWorkspace,
} from "./fixture-workspace.ts";

/** One intentional import in scripts/boundaries/fixtures/violations per rule. */
const EXPECTED_RULES = [
  "contracts-pure",
  "eval-only-pipeline-entry",
  "frontend-contracts-types-only",
  "no-gt-in-backend",
  "no-gt-in-frontend",
  "no-gt-reachable-from-diagnosis",
  "no-overlay-in-diagnosis",
  "no-test-in-prod",
  "not-to-unresolvable",
];

interface Violation {
  readonly from: string;
  readonly to: string;
  readonly rule: { readonly name: string; readonly severity: string };
}

interface CruiseResult {
  readonly summary: {
    readonly violations: readonly Violation[];
    readonly error: number;
    readonly warn: number;
  };
}

function cruise(workspace: FixtureWorkspace, outputType: "json" | "err"): CommandResult {
  return run(
    repoBin("depcruise"),
    [
      "--config",
      `${REPO_ROOT}/.dependency-cruiser.cjs`,
      // The fixture's own tsconfig.json extends the base by a relative path; dependency-cruiser
      // resolves options.tsConfig.fileName against the working directory instead, so the copy
      // at the temporary root is named explicitly here.
      "--ts-config",
      `${workspace.tempRoot}/tsconfig.base.json`,
      "--output-type",
      outputType,
      "apps",
      "packages",
      "tools",
    ],
    workspace.root,
  );
}

function cruiseJson(workspace: FixtureWorkspace): CruiseResult {
  const result = cruise(workspace, "json");
  if (result.stdout === "") {
    throw new Error(`depcruise produced no JSON output: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as CruiseResult;
}

function ruleNames(result: CruiseResult): string[] {
  return [...new Set(result.summary.violations.map((violation) => violation.rule.name))].sort();
}

const workspaces = new Map<FixtureName, FixtureWorkspace>();

beforeAll(() => {
  for (const name of ["clean", "violations"] as const) {
    workspaces.set(name, installFixture(name));
  }
});

afterAll(() => {
  for (const workspace of workspaces.values()) {
    removeFixture(workspace);
  }
});

function fixture(name: FixtureName): FixtureWorkspace {
  const workspace = workspaces.get(name);
  if (workspace === undefined) {
    throw new Error(`fixture ${name} was not installed`);
  }
  return workspace;
}

describe("the clean fixture", () => {
  it("has no violation at all", () => {
    const result = cruiseJson(fixture("clean"));

    expect(result.summary.violations).toEqual([]);
    expect(result.summary.error).toBe(0);
    expect(result.summary.warn).toBe(0);
  });

  it("exits 0 with the err reporter, the one `pnpm run lint:boundaries` uses", () => {
    expect(cruise(fixture("clean"), "err").status).toBe(0);
  });
});

describe("the violations fixture", () => {
  it("reports exactly the rules it was built to break", () => {
    expect(ruleNames(cruiseJson(fixture("violations")))).toEqual(EXPECTED_RULES);
  });

  it("reports both unresolvable imports and the transitive ground-truth path", () => {
    const violations = cruiseJson(fixture("violations")).summary.violations;

    const unresolvable = violations
      .filter((violation) => violation.rule.name === "not-to-unresolvable")
      .map((violation) => violation.to)
      .sort();
    expect(unresolvable).toEqual(["@fdp/backend/src/detection/index.ts", "@fdp/ground-truth"]);

    const reachable = violations
      .filter((violation) => violation.rule.name === "no-gt-reachable-from-diagnosis")
      .map((violation) => violation.from)
      .sort();
    expect(reachable).toEqual([
      "apps/backend/src/detection/index.ts",
      "apps/backend/src/pipeline/index.ts",
    ]);
  });

  it("names every broken rule in the report and shows the reachable path", () => {
    const report = cruise(fixture("violations"), "err");

    expect(report.status).toBeGreaterThan(0);
    for (const rule of EXPECTED_RULES) {
      expect(report.stdout).toContain(rule);
    }
    // The reachable rule prints the whole chain, so a reader can fix the import without
    // reading .dependency-cruiser.cjs.
    expect(report.stdout).toContain(
      "apps/backend/src/pipeline/index.ts → packages/ground-truth/src/index.ts",
    );
    expect(report.stdout).toContain("apps/backend/src/detection/index.ts");
  });
});
