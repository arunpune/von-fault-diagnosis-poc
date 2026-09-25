// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Proves the ESLint mirror of the import boundaries (block 4 of eslint.config.js).
// dependency-cruiser stays the gate; these rules give the same feedback in the editor, so
// they are checked against virtual file paths with the real repository configuration.

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./fixture-workspace.ts";

const RULE = "no-restricted-imports";

const GROUND_TRUTH_AND_OVERLAY = `import { GROUND_TRUTH_LABEL } from "@fdp/ground-truth";
import { OVERLAY_RECORDER } from "../overlay/recorder.ts";

export const probe = \`\${GROUND_TRUTH_LABEL}:\${OVERLAY_RECORDER}\`;
`;

const WORKSPACE_IMPORT = `import { MIGRATION_TABLE } from "@fdp/db-migrate";

export const probe = MIGRATION_TABLE;
`;

const eslint = new ESLint({ cwd: REPO_ROOT });

async function restrictedImportMessages(source: string, filePath: string): Promise<string[]> {
  const results = await eslint.lintText(source, { filePath });
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.ruleId === RULE)
    .map((message) => message.message);
}

describe("a diagnosis module of the backend", () => {
  it("may import neither ground truth nor the overlay", async () => {
    const messages = await restrictedImportMessages(
      GROUND_TRUTH_AND_OVERLAY,
      "apps/backend/src/detection/probe.ts",
    );

    expect(messages).toHaveLength(2);
    expect(messages.some((message) => message.includes("Ground truth never reaches"))).toBe(true);
    expect(messages.some((message) => message.includes("never import the overlay"))).toBe(true);
  });
});

describe("the overlay module of the backend", () => {
  it("may import the overlay but still never ground truth", async () => {
    const messages = await restrictedImportMessages(
      GROUND_TRUTH_AND_OVERLAY,
      "apps/backend/src/overlay/probe.ts",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Ground truth never reaches");
  });
});

describe("the frontend", () => {
  it("may not import ground truth either", async () => {
    const messages = await restrictedImportMessages(
      GROUND_TRUTH_AND_OVERLAY,
      "apps/frontend/src/probe.tsx",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Ground truth never reaches");
  });
});

describe("the contract package", () => {
  it("may import nothing from the workspace", async () => {
    const messages = await restrictedImportMessages(
      WORKSPACE_IMPORT,
      "packages/contracts/src/probe.ts",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("imports nothing from the workspace");
  });

  it("leaves the same import alone in a package that is allowed to make it", async () => {
    const messages = await restrictedImportMessages(WORKSPACE_IMPORT, "tools/eval/src/probe.ts");

    expect(messages).toEqual([]);
  });
});
