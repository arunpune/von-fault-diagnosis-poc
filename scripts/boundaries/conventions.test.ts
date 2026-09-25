// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Proves the `@fdp/source` export convention end to end on the clean fixture:
// Node and TypeScript both reach a workspace package's TypeScript source through the custom
// condition, and without the condition the `default` entry points at a dist/ build that a
// development checkout does not have.

import { afterAll, beforeAll, expect, it } from "vitest";

import {
  installFixture,
  removeFixture,
  repoBin,
  run,
  type FixtureWorkspace,
} from "./fixture-workspace.ts";

/** What tools/eval/src/index.ts prints once both of its imports resolve. */
const EXPECTED_LINE = "eval: pipeline -> detection(v1) + ground-truth";

const EVAL_ENTRY = "tools/eval/src/index.ts";

let workspace: FixtureWorkspace;

beforeAll(() => {
  workspace = installFixture("clean");
});

afterAll(() => {
  removeFixture(workspace);
});

it("runs the eval entry through the workspace symlinks with --conditions=@fdp/source", () => {
  const result = run(process.execPath, ["--conditions=@fdp/source", EVAL_ENTRY], workspace.root);

  expect(result.stdout.trim()).toBe(EXPECTED_LINE);
  expect(result.status).toBe(0);
});

it("type-checks the same graph, because tsconfig.base.json sets customConditions", () => {
  const result = run(repoBin("tsc"), ["--noEmit", "-p", "tsconfig.json"], workspace.root);

  expect(`${result.stdout}${result.stderr}`.trim()).toBe("");
  expect(result.status).toBe(0);
});

it("fails without the condition, because the default entry points at an unbuilt dist/", () => {
  const result = run(process.execPath, [EVAL_ENTRY], workspace.root);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("ERR_MODULE_NOT_FOUND");
});
