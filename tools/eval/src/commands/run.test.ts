// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-eval run` at its edge: flags and environment in, the exit codes out.
// Every case here stops before a row is replayed;
// the whole run is the smoke E2E's (`test/e2e/smoke.test.ts`).

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT_ABORTED, EXIT_OK, EXIT_USAGE, main } from "../cli.ts";
import { run, usage } from "./run.ts";

/** A value no output may ever contain. */
const KEY = "ts-live-key-that-must-never-print";

interface Captured {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

async function capture(action: () => Promise<number>): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  const code = await action();
  return { stdout: out.join(""), stderr: err.join(""), code };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fdp-eval run", () => {
  it("prints its usage for --help and exits 0", async () => {
    const result = await capture(() => run(["--help"], {}));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toBe(usage());
    expect(result.stdout).toContain("--fail-on-gate");
  });

  it("ignores the -- that pnpm passes through", async () => {
    const result = await capture(() => run(["--", "--help"], {}));
    expect(result.code).toBe(EXIT_OK);
  });

  it("is reached through the dispatcher", async () => {
    const result = await capture(() => main(["run", "--help"], {}));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("usage: fdp-eval run");
  });

  it("exits 1 on a flag it does not know, naming it and never a key", async () => {
    const result = await capture(() => run(["--profil", "smoke"], { TYPESAFE_API_KEY: KEY }));
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("--profil");
    expect(result.stderr).not.toContain(KEY);
  });

  it("exits 1 on a bad variable, naming the variable", async () => {
    const result = await capture(() => run([], { EVAL_PROFILE: "nightly" }));
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("EVAL_PROFILE");
  });

  it("exits 1 on a scenario the profile does not replay", async () => {
    const result = await capture(() =>
      run(["--profile", "smoke", "--scenario", "f1_air_leak_apr18"], {}),
    );
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("not in the smoke profile");
  });

  it("exits 1 on more than one worker", async () => {
    const result = await capture(() => run(["--profile", "smoke", "--jobs", "4"], {}));
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("--jobs");
  });

  it("exits 3 when a scenario's rows are not on this machine", async () => {
    const result = await capture(() =>
      run(["--profile", "full", "--scenario", "metropt3_full"], {
        METROPT_CSV: "/nonexistent/MetroPT3.csv",
        TYPESAFE_API_KEY: KEY,
      }),
    );
    expect(result.code).toBe(EXIT_ABORTED);
    expect(result.stderr).toContain("METROPT_CSV");
    expect(result.stderr).not.toContain(KEY);
  });
});
