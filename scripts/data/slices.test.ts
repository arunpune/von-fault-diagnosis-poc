// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The MetroPT-3 slice contract: the repository commits the definition
// of every slice the other areas test with, never a row of the dataset.
//
// Four things are checked here. First, the committed definitions are sound on
// their own — unique names, ordered and disjoint segments, positive row counts,
// 64-hex hashes, and a `data/SHA256SUMS` line for each one, so init can verify
// a cut slice by basename. Second, whenever `make fixtures` has run, every cut
// file is compared with its definition down to the byte: the verbatim header,
// strictly increasing timestamps, the segment bounds, the row count and the
// SHA-256. A worktree without the dataset skips that part; `FDP_REQUIRE_DATASET`
// turns the absence into a failure. Third, the absent-source contract and the
// shell syntax of the fetch script. Fourth, that Git tracks no dataset
// row anywhere.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFINITIONS_PATH = join(REPO_ROOT, "data/fixtures/metropt3-slices.json");
const SUMS_PATH = join(REPO_ROOT, "data/SHA256SUMS");
const CUT_DIR = join(REPO_ROOT, "data/fixtures/metropt3");
const FETCH_SCRIPT = join(REPO_ROOT, "scripts/data/fetch-metropt3.sh");

const SCHEMA = "urn:fdp:fixture:metropt3-slices:v1";
const CUTTER = "scripts/data/cut-metropt-slices.py";
const SOURCE_FILE = "MetroPT3(AirCompressor).csv";
const ZIP_FILE = "metropt+3+dataset.zip";
const DOI = "10.24432/C5VW3R";

/**
 * The header of the MetroPT-3 CSV, copied into every slice unchanged
 * (docs/dataset.md; `DV_eletric` is the upstream misspelling). These are
 * column names, not data rows, so no MetroPT-3 data is committed.
 */
const HEADER =
  ",timestamp,TP2,TP3,H1,DV_pressure,Reservoirs,Oil_temperature,Motor_current,COMP," +
  "DV_eletric,Towers,MPG,LPS,Pressure_switch,Oil_level,Caudal_impulses";

/** The notice `make fixtures` prints when the dataset is not there. */
const SKIP_NOTICE = "MetroPT-3 source not found at";
const SKIP_HINT = "set METROPT_CSV_HOST or run make fetch-dataset";

/** The only two paths under data/fixtures that Git may track. */
const TRACKED_FIXTURE_PATHS = ["data/fixtures/README.md", "data/fixtures/metropt3-slices.json"];

const SHA256 = /^[0-9a-f]{64}$/;
const DATASET_CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const requireDataset = Boolean(process.env["FDP_REQUIRE_DATASET"]);

interface SegmentDefinition {
  readonly from: string;
  readonly to: string;
  readonly rows: number;
}

interface SliceDefinition {
  readonly name: string;
  readonly segments: readonly SegmentDefinition[];
  readonly rows: number;
  readonly sha256: string;
  readonly used_by: readonly string[];
}

interface SlicesDocument {
  readonly schema: string;
  readonly credit: string;
  readonly generated_by: string;
  readonly source: { readonly file: string; readonly sha256: string; readonly bytes: number };
  readonly slices: readonly SliceDefinition[];
}

interface Window {
  readonly from: number;
  readonly to: number;
}

const definitions = JSON.parse(readFileSync(DEFINITIONS_PATH, "utf8")) as SlicesDocument;

/** The bare file name `data/SHA256SUMS` lists for each hash. */
function readSums(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of readFileSync(SUMS_PATH, "utf8").split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("  ");
    if (separator <= 0) throw new Error(`data/SHA256SUMS: '${line}' is not '<sha256>  <name>'`);
    entries.set(line.slice(0, separator), line.slice(separator + 2));
  }
  return entries;
}

/** The instant a `2020-02-01T00:00:00Z` bound denotes. */
function bound(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${value} is not an ISO-8601 instant`);
  return parsed;
}

/** The instant of one cut row, read from its second field (the dataset clock). */
function rowInstant(row: string): number {
  const first = row.indexOf(",");
  const second = row.indexOf(",", first + 1);
  const stamp = first < 0 || second < 0 ? "" : row.slice(first + 1, second);
  expect(stamp, `'${row.slice(0, 48)}' is not an index followed by a timestamp`).toMatch(
    DATASET_CLOCK,
  );
  return bound(`${stamp.replace(" ", "T")}Z`);
}

function cutPath(name: string): string {
  return join(CUT_DIR, `${name}.csv`);
}

/** Run `make fixtures` against a source that is not there; report what happened. */
function makeFixturesWithoutSource(required: boolean): { status: number; output: string } {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    METROPT_CSV_HOST: join(CUT_DIR, "no-such-source.csv"),
  };
  if (required) {
    environment["FDP_REQUIRE_DATASET"] = "1";
  } else {
    delete environment["FDP_REQUIRE_DATASET"];
  }
  try {
    const output = execFileSync("make", ["fixtures"], {
      cwd: REPO_ROOT,
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

function isInstalled(tool: string): boolean {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function trackedUnder(path: string): string[] {
  const output = execFileSync("git", ["ls-files", "--", path], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return output.split("\n").filter((entry) => entry !== "");
}

describe("data/fixtures/metropt3-slices.json", () => {
  it("carries the schema, the source and the MetroPT-3 credit", () => {
    expect(definitions.schema).toBe(SCHEMA);
    expect(definitions.source.file).toBe(SOURCE_FILE);
    expect(definitions.source.sha256).toMatch(SHA256);
    expect(definitions.source.bytes).toBeGreaterThan(0);
    expect(definitions.credit).toContain(DOI);
    expect(definitions.generated_by).toBe(CUTTER);
  });

  it("names every slice exactly once", () => {
    const names = definitions.slices.map((slice) => slice.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("ci-slice");
  });

  for (const slice of definitions.slices) {
    it(`${slice.name} has ordered, disjoint segments and a positive row count`, () => {
      expect(slice.segments.length).toBeGreaterThan(0);
      expect(slice.rows).toBeGreaterThan(0);
      expect(slice.sha256).toMatch(SHA256);
      expect(slice.used_by.length).toBeGreaterThan(0);

      let previousEnd = Number.NEGATIVE_INFINITY;
      let total = 0;
      for (const segment of slice.segments) {
        const from = bound(segment.from);
        const to = bound(segment.to);
        expect(from, `${segment.from} must precede ${segment.to}`).toBeLessThan(to);
        expect(from, "the segments are ordered and do not overlap").toBeGreaterThanOrEqual(
          previousEnd,
        );
        expect(segment.rows).toBeGreaterThanOrEqual(0);
        previousEnd = to;
        total += segment.rows;
      }
      expect(total, "the segment rows add up to the slice's row count").toBe(slice.rows);
    });
  }

  it("has a data/SHA256SUMS line for the source, the zip and every slice", () => {
    const sums = readSums();
    expect(sums.get(definitions.source.sha256)).toBe(definitions.source.file);
    expect([...sums.values()]).toContain(ZIP_FILE);
    for (const slice of definitions.slices) {
      expect(sums.get(slice.sha256), `${slice.name} is not listed in data/SHA256SUMS`).toBe(
        `${slice.name}.csv`,
      );
    }
  });
});

describe("the cut slices under data/fixtures/metropt3", () => {
  for (const slice of definitions.slices) {
    const path = cutPath(slice.name);
    const present = existsSync(path);

    it.skipIf(!present && !requireDataset)(`${slice.name} is what its definition says`, () => {
      expect(present, `${path} is missing; run 'make fixtures' first`).toBe(true);

      const bytes = readFileSync(path);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(slice.sha256);

      const text = bytes.toString("latin1");
      expect(text.startsWith(`${HEADER}\r\n`), "the header is copied verbatim").toBe(true);

      const lines = text.split("\n");
      expect(lines.pop(), "the file ends with a line terminator").toBe("");
      const rows = lines.slice(1);
      expect(rows.length, "the row count matches the definition").toBe(slice.rows);

      const windows: Window[] = slice.segments.map((segment) => ({
        from: bound(segment.from),
        to: bound(segment.to),
      }));
      const counted = windows.map(() => 0);
      let previous = Number.NEGATIVE_INFINITY;
      let index = 0;

      for (const row of rows) {
        const moment = rowInstant(row);
        expect(moment, "the timestamps are strictly increasing").toBeGreaterThan(previous);
        previous = moment;

        let window = windows[index];
        while (window !== undefined && moment >= window.to) {
          index += 1;
          window = windows[index];
        }
        if (window === undefined) {
          throw new Error(`${slice.name}: a row lies after the last segment`);
        }
        expect(moment, `${slice.name}: a row lies outside its segment`).toBeGreaterThanOrEqual(
          window.from,
        );
        counted[index] = (counted[index] ?? 0) + 1;
      }

      expect(counted, "every segment contributes the rows the definition records").toEqual(
        slice.segments.map((segment) => segment.rows),
      );
    });
  }
});

describe("scripts/data/fetch-metropt3.sh", () => {
  it("is valid bash", () => {
    expect(() => execFileSync("bash", ["-n", FETCH_SCRIPT], { stdio: "pipe" })).not.toThrow();
  });

  it.skipIf(!isInstalled("shellcheck"))("passes shellcheck", () => {
    expect(() =>
      execFileSync("shellcheck", ["-s", "bash", FETCH_SCRIPT], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("prints its usage and exits 0 for --help", () => {
    const output = execFileSync("bash", [FETCH_SCRIPT, "--help"], { encoding: "utf8" });
    expect(output).toContain("Usage: scripts/data/fetch-metropt3.sh");
  });
});

describe("make fixtures without a dataset", () => {
  it("skips with exit 0 when FDP_REQUIRE_DATASET is unset", () => {
    const result = makeFixturesWithoutSource(false);
    expect(result.status).toBe(0);
    expect(result.output).toContain(SKIP_NOTICE);
    expect(result.output).toContain(SKIP_HINT);
  });

  it("fails with the same notice when FDP_REQUIRE_DATASET is set", () => {
    const result = makeFixturesWithoutSource(true);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(SKIP_NOTICE);
    expect(result.output).toContain(SKIP_HINT);
  });
});

describe("git tracks no MetroPT-3 row (MetroPT-3 by download only)", () => {
  it("tracks only the definitions and the README under data/fixtures", () => {
    expect(trackedUnder("data/fixtures").sort()).toEqual(TRACKED_FIXTURE_PATHS);
  });

  it("tracks nothing but the placeholder under data/metropt3", () => {
    expect(trackedUnder("data/metropt3")).toEqual(["data/metropt3/.gitkeep"]);
  });
});
