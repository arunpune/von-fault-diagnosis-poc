// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Running the generator into a temporary directory reproduces the committed `src/generated/**` byte
// for byte, and two runs produce the same bytes. This is what `check-drift` proves in CI; here it
// fails fast, without a working tree to inspect.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { generate } from "../scripts/generate.ts";
import { contractsDir } from "../src/testing.ts";

const committedDir = join(contractsDir, "src", "generated");
const temporaryDirs: string[] = [];

function temporaryDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-contracts-generate-"));
  temporaryDirs.push(directory);
  return directory;
}

const firstRun = temporaryDir();
const written = await generate(firstRun);

afterAll(() => {
  for (const directory of temporaryDirs) rmSync(directory, { recursive: true, force: true });
});

describe("generate", () => {
  it("writes the five generated modules", () => {
    expect([...written].sort()).toEqual([
      "embedding.ts",
      "schemas.ts",
      "topics.ts",
      "types.ts",
      "validators.ts",
    ]);
  });

  it.each(written)("reproduces the committed %s byte for byte", (file) => {
    const generated = readFileSync(join(firstRun, file));
    const committed = readFileSync(join(committedDir, file));
    // Compare as text first: a mismatch then prints a readable diff instead of two buffers.
    expect(generated.toString("utf8")).toBe(committed.toString("utf8"));
    expect(generated.equals(committed)).toBe(true);
  });

  it("is byte-stable across two runs", async () => {
    const secondRun = temporaryDir();
    await generate(secondRun);
    for (const file of written) {
      expect(readFileSync(join(secondRun, file)).equals(readFileSync(join(firstRun, file)))).toBe(
        true,
      );
    }
  });

  it.each(written)("%s ends with a single newline and holds no CRLF", (file) => {
    const text = readFileSync(join(committedDir, file), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).not.toContain("\r");
  });

  it.each(written)("%s carries the DO NOT EDIT banner and the SPDX header", (file) => {
    const text = readFileSync(join(committedDir, file), "utf8");
    expect(text).toContain("DO NOT EDIT");
    // The tag below is the one the generated files carry, not this file's own.
    // REUSE-IgnoreStart
    expect(text).toContain("SPDX-License-Identifier: Apache-2.0");
    // REUSE-IgnoreEnd
  });
});
