// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-eval validate` end to end, in process, over the committed files.
//
// This is the test E1 stands on: the command is reached through the dispatcher,
// not imported directly, so a subcommand module that stops being loadable fails
// here rather than in CI; it is run over the real scenarios and the real ground
// truth, so a renamed slice or a dropped cause fails here too; and the report
// it writes is read back and checked, because E1 names that file by path.
//
// Nothing here touches the network, Docker or the dataset: the scenarios carry
// slice *names*, and resolving one needs only the committed definitions.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MINI_CATALOG_PATH } from "../src/catalog/reference.ts";
import { main } from "../src/cli.ts";
import { REPORT_LICENCE_HEADER, REPORT_NAME } from "../src/commands/validate.ts";
import { loadAll } from "../src/scenario/index.ts";

const directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-validate-"));
  directories.push(directory);
  return directory;
}

/** Runs one `fdp-eval` invocation and captures what it wrote. */
async function run(args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    out.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    err.push(String(chunk));
    return true;
  };
  try {
    const code = await main(args);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

let outDir: string;

beforeAll(() => {
  outDir = scratch();
});

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe("fdp-eval validate", () => {
  it("exits 0 over the committed scenarios and prints one line per scenario", async () => {
    const { code, out } = await run(["validate", "--out", outDir]);
    expect(code).toBe(0);

    const ids = loadAll().map((scenario) => scenario.id);
    for (const id of ids) expect(out).toContain(id);
    expect(out).toContain(`${String(ids.length)} of ${String(ids.length)} scenarios bound`);
  });

  it("writes the report E1 reads", async () => {
    const directory = scratch();
    const { code } = await run(["validate", "--catalog-only", "--out", directory]);
    expect(code).toBe(0);

    const report = readFileSync(join(directory, REPORT_NAME), "utf8");
    for (const line of REPORT_LICENCE_HEADER) expect(report).toContain(line);
    expect(report).toContain("# Reference catalog validation (E1)");
    expect(report).toContain("| Benign causes |");
    expect(report).toContain("## Fault ids used by ground truth");
    expect(report).toContain("## Direction words without a mapping");
    expect(report).not.toContain("**no**");
  });

  it("binds the shortened ranges of the smoke profile", async () => {
    const { code, out } = await run(["validate", "--profile", "smoke", "--out", scratch()]);
    expect(code).toBe(0);
    expect(out).toContain("2020-06-05T14:00:00.000Z");
  });

  it("fails and names the fault ids a catalog does not have", async () => {
    // The mini fixture holds six causes, so the injected faults ground truth refers to are
    // missing from it; pointing the command at it is how the cross-check is proved to bite.
    const { code, err } = await run([
      "validate",
      "--catalog-only",
      "--catalog",
      MINI_CATALOG_PATH,
      "--out",
      scratch(),
    ]);
    expect(code).toBe(1);
    expect(err).toContain("intake_valve_not_opening");
    expect(err).toContain("is not in the catalog");
  });

  it("still writes the report when the cross-check fails", async () => {
    const directory = scratch();
    await run(["validate", "--catalog-only", "--catalog", MINI_CATALOG_PATH, "--out", directory]);
    expect(readFileSync(join(directory, REPORT_NAME), "utf8")).toContain("**no**");
  });

  it("refuses an unknown profile and an unknown flag", async () => {
    expect((await run(["validate", "--profile", "quick"])).code).toBe(1);
    expect((await run(["validate", "--hurry"])).code).toBe(1);
  });

  it("accepts the -- separator pnpm inserts", async () => {
    // `pnpm --filter @fdp/eval run validate -- --catalog-only`, which is the documented form
    // and the one `make eval` would reach for.
    const { code } = await run(["validate", "--", "--catalog-only", "--out", scratch()]);
    expect(code).toBe(0);
  });

  it("prints its own help", async () => {
    const { code, out } = await run(["validate", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("--catalog-only");
  });
});
