// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-eval record` at its edge: its usage, the one line it prints without a
// key, and the plan it prints and refuses on without `--confirm-live`. No case
// here calls an API: the stand-in key is paired with a base URL on a closed
// local port, and the refusal is asserted before any handle could be built.

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { EXIT_OK, EXIT_USAGE, main } from "../cli.ts";
import { loadAll } from "../scenario/index.ts";
import { datasetRequired, sliceIsCut } from "../slices.ts";
import { TUNING_SCENARIOS } from "../tuning.ts";
import { run, usage } from "./record.ts";

/** A stand-in key no output may contain. */
const KEY = "tsk-record-test-5e1d";

/** Nothing listens on the discard port, so a call that should never happen cannot succeed. */
const CLOSED_URL = "http://127.0.0.1:9";

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("fdp-eval record", () => {
  it("prints its usage for --help without needing a key", async () => {
    const result = await capture(() => run(["--", "--help"], {}));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toBe(usage());
    expect(result.stdout).toContain("--confirm-live");
  });

  it("is reached through the dispatcher", async () => {
    const result = await capture(() => main(["record", "--help"], {}));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("usage: fdp-eval record");
  });

  it("exits 1 without the key, naming the variable and printing nothing else", async () => {
    for (const env of [{}, { TYPESAFE_API_KEY: "" }]) {
      const result = await capture(() => run(["--profile", "core"], env));
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "fdp-eval record: TYPESAFE_API_KEY is not set; recording calls the live Von API\n",
      );
    }
  });

  it("refuses a run that does not name von", async () => {
    const result = await capture(() =>
      run(["--backends", "rules"], { TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: CLOSED_URL }),
    );
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("--backends");
    expect(result.stderr).not.toContain(KEY);
  });

  // The tuning list, whose recording the Von thresholds pre-registration waits on
  // (tools/eval/records/von-thresholds-preregistration.md, "Prerequisites"): its plan path only.
  const tuningSlices = [
    ...new Set(
      loadAll()
        .filter((scenario) => TUNING_SCENARIOS.includes(scenario.id))
        .flatMap((scenario) => (scenario.source.kind === "slice" ? [scenario.source.name] : [])),
    ),
  ];
  const tuningCut = tuningSlices.every((name) => sliceIsCut(name));

  it("warns when the tuning list would be recorded at a Von pair the sweep does not replay", async () => {
    // --jobs 2 stops the run before anything is loaded or planned, after the warning.
    const result = await capture(() =>
      run(["--tuning", "--jobs", "2"], {
        TYPESAFE_API_KEY: KEY,
        TYPESAFE_BASE_URL: CLOSED_URL,
        VON_GATE_TICKET_MIN_CONFIDENCE: "0.9",
      }),
    );
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain(
      "the tuning list is recorded at a Von pair the pre-registered sweep does not replay",
    );
    expect(result.stderr).toContain('von_gate="0.65 / 0.9"');
    expect(result.stderr).not.toContain(KEY);
    // Since Von's default pair is the choice (0.65 / 0.85), nothing set warns too.
    const plain = await capture(() =>
      run(["--tuning", "--jobs", "2"], { TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: CLOSED_URL }),
    );
    expect(plain.stderr).toContain("pre-registered sweep does not replay");
    expect(plain.stderr).toContain('von_gate="0.65 / 0.85"');
    // The pair the sweep replays, set explicitly, does not.
    const incumbent = await capture(() =>
      run(["--tuning", "--jobs", "2"], {
        TYPESAFE_API_KEY: KEY,
        TYPESAFE_BASE_URL: CLOSED_URL,
        VON_GATE_REVIEW_MIN_CONFIDENCE: "0.6",
      }),
    );
    expect(incumbent.stderr).not.toContain("pre-registered sweep does not replay");
  });

  it("warns when the tuning list would be recorded at a GATE_PERSIST_SIM_MIN the sweep does not replay", async () => {
    // The pre-registration's amendment of 2026-09-24: the sweep replays one recording at N = 0
    // and one at N = 1. --jobs 2 stops the run before anything is loaded or planned.
    const at = (persist: string) =>
      capture(() =>
        run(["--tuning", "--jobs", "2"], {
          TYPESAFE_API_KEY: KEY,
          TYPESAFE_BASE_URL: CLOSED_URL,
          GATE_PERSIST_SIM_MIN: persist,
        }),
      );
    const two = await at("2");
    expect(two.code).toBe(EXIT_USAGE);
    expect(two.stderr).toContain(
      "the tuning list is recorded at a GATE_PERSIST_SIM_MIN the pre-registered sweep does not replay",
    );
    expect(two.stderr).toContain("persist_sim_min=2");
    expect(two.stderr).not.toContain(KEY);
    for (const persist of ["0", "1"]) {
      expect((await at(persist)).stderr).not.toContain("GATE_PERSIST_SIM_MIN the pre-registered");
    }
  });

  it("has the tuning list's slices, or their absence is allowed", () => {
    expect(tuningSlices.length).toBeGreaterThan(0);
    expect(tuningCut || !datasetRequired(), "a tuning slice is not cut; run make fixtures").toBe(
      true,
    );
  });

  it.skipIf(!tuningCut)(
    "plans the tuning list with --tuning, then refuses without --confirm-live and writes nothing",
    async () => {
      const out = mkdtempSync(join(tmpdir(), "fdp-record-tuning-"));
      directories.push(out);
      const result = await capture(() =>
        run(["--", "--tuning", "--out", out], {
          TYPESAFE_API_KEY: KEY,
          TYPESAFE_BASE_URL: CLOSED_URL,
        }),
      );
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("warn live plan");
      expect(result.stderr).toMatch(
        /fdp-eval record: --confirm-live: this run calls a live API \(von \(von-1\.13\.0\): \d+ planned call\(s\)/,
      );
      // The plan is the mock replay of exactly the ten tuning scenarios, never a profile.
      expect(result.stderr).toContain(
        `estimated from a mock replay of ${TUNING_SCENARIOS.length} scenario(s)`,
      );
      expect(result.stderr).toContain("nothing was called");
      expect(result.stderr).not.toContain(KEY);
      expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
    },
    120_000,
  );

  it.skipIf(!tuningCut)(
    "plans the tuning list at the GATE_PERSIST_SIM_MIN it is given, N = 0 and N = 1 each their own",
    async () => {
      // The pre-registration's amendment of 2026-09-24 records the tuning list once per N. The
      // plan is the mock replay the recording will make, at the run's own N: at N = 1 an
      // episode's first decision waits for its evidence to persist, so the states it asks about,
      // and the tokens they cost, are not those of N = 0. Nothing is called and nothing written.
      const planAt = async (persist: string) => {
        const out = mkdtempSync(join(tmpdir(), "fdp-record-tuning-n-"));
        directories.push(out);
        const result = await capture(() =>
          run(["--", "--tuning", "--out", out], {
            TYPESAFE_API_KEY: KEY,
            TYPESAFE_BASE_URL: CLOSED_URL,
            GATE_PERSIST_SIM_MIN: persist,
          }),
        );
        expect(result.code).toBe(EXIT_USAGE);
        expect(result.stderr).toContain(`persist_sim_min=${persist}`);
        expect(result.stderr).toContain(`at GATE_PERSIST_SIM_MIN ${persist})`);
        expect(result.stderr).toContain("nothing was called");
        expect(result.stderr).not.toContain(KEY);
        expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
        const tokens = /≈ (\d+) input and \d+ output tokens/.exec(result.stderr)?.[1];
        expect(tokens).toBeDefined();
        return Number(tokens);
      };
      const zero = await planAt("0");
      const one = await planAt("1");
      expect(zero).not.toBe(one);
    },
    240_000,
  );

  const cut = sliceIsCut("f3-jun05");

  it("has the F3 slice, or its absence is allowed", () => {
    expect(cut || !datasetRequired(), "the f3-jun05 slice is not cut; run make fixtures").toBe(
      true,
    );
  });

  it.skipIf(!cut)(
    "prints the planned calls and cost, then refuses without --confirm-live and writes nothing",
    async () => {
      const out = mkdtempSync(join(tmpdir(), "fdp-record-"));
      directories.push(out);
      const result = await capture(() =>
        run(["--profile", "smoke", "--scenario", "f3_air_leak_jun05", "--out", out], {
          TYPESAFE_API_KEY: KEY,
          TYPESAFE_BASE_URL: CLOSED_URL,
        }),
      );
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("warn live plan");
      expect(result.stderr).toMatch(
        /fdp-eval record: --confirm-live: this run calls a live API \(von \(von-1\.13\.0\): \d+ planned call\(s\)/,
      );
      expect(result.stderr).toContain("nothing was called");
      expect(result.stderr).not.toContain(KEY);
      expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
    },
  );
});
