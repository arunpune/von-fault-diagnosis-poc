// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Where the harness gets its MetroPT-3 rows, and why it never owns any.
//
// MetroPT-3 reaches a machine by download only, so no row of it is committed
// anywhere in this repository, `tools/eval/fixtures/slices/` included. What is
// committed is `data/fixtures/metropt3-slices.json` — the definition of every
// slice: its segments in the dataset clock, its row count and the SHA-256 of
// the cut file. `make fixtures` turns those definitions into CSV files under
// the gitignored `data/fixtures/metropt3/`, and this module is how the harness
// asks for one.
//
// Three questions, three functions. `sliceDef` answers "what is this slice
// supposed to be?" from the committed definitions alone and works in any
// checkout. `slicePath` answers "where would it be?" without touching the
// disk. `requireSlice` answers "give me the file" and fails with the command
// that produces it — which is what lets a test skip on a laptop without the
// dataset and fail in CI, where `FDP_REQUIRE_DATASET=1` is set after the
// dataset-cache step.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The one schema identifier the definitions document carries. */
export const SLICES_SCHEMA = "urn:fdp:fixture:metropt3-slices:v1";

/** The definitions document, relative to the repository root. */
export const SLICE_DEFINITIONS_FILE = "data/fixtures/metropt3-slices.json";

/** Where `make fixtures` cuts the slices; gitignored. */
export const SLICES_DIR_NAME = "data/fixtures/metropt3";

/** The variable that turns an absent slice from a skip into a failure. */
export const REQUIRE_DATASET_ENV = "FDP_REQUIRE_DATASET";

/**
 * The header line of the MetroPT-3 CSV, copied into every cut slice unchanged
 * (docs/dataset.md). `DV_eletric` is the upstream misspelling and is kept verbatim; the first
 * column is the unnamed integer index. These are column names, not data rows, so writing them
 * down commits no row of the dataset.
 */
export const METROPT3_HEADER =
  ",timestamp,TP2,TP3,H1,DV_pressure,Reservoirs,Oil_temperature,Motor_current,COMP," +
  "DV_eletric,Towers,MPG,LPS,Pressure_switch,Oil_level,Caudal_impulses";

/**
 * How the rows of the MetroPT-3 CSV end.
 *
 * The published file is CRLF-terminated and the cutter copies it byte for byte, so a cut
 * slice is too (`scripts/data/slices.test.ts` asserts `<header>\r\n`). The replay loader
 * reads the terminator from here rather than assuming a bare newline and carrying a stray
 * `\r` into the last column of every row.
 */
export const METROPT3_LINE_TERMINATOR = "\r\n";

/**
 * The slices the scenarios replay, in scenario order.
 *
 * The names are a contract with the slice definitions: a renamed or dropped definition must break
 * a test here rather than 16 scenario files later.
 */
export const SCENARIO_SLICES = [
  "f1-apr18",
  "f2-may30",
  "f3-jun05",
  "f4-jul15",
  "baseline-feb03",
  "depot-jul31",
  "summer-jul05",
  "frozen-jun22",
  "unlabelled-may19",
  "august-aug10",
  "f4b-jul17",
] as const;

/** The two-hour window the Docker parity test replays through the Go simulator. */
export const PARITY_SLICE = "parity-feb01";

/** One half-open `[from, to)` window of a slice, in the dataset clock. */
export interface SliceSegment {
  readonly from: string;
  readonly to: string;
  readonly rows: number;
}

/** What `data/fixtures/metropt3-slices.json` records about one slice. */
export interface SliceDefinition {
  readonly name: string;
  readonly segments: readonly SliceSegment[];
  readonly rows: number;
  readonly sha256: string;
  readonly used_by: readonly string[];
}

/** Thrown when a slice is defined but has not been cut on this machine. */
export class MissingSliceError extends Error {
  readonly slice: string;
  readonly path: string;

  constructor(slice: string, path: string) {
    super(
      `MetroPT-3 slice "${slice}" is not cut at ${path}; ` +
        "run `make fixtures` with the dataset in place (see data/fixtures/README.md)",
    );
    this.name = "MissingSliceError";
    this.slice = slice;
    this.path = path;
  }
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** How far up the tree the repository root is looked for before giving up. */
const MAX_DEPTH = 8;

function findRepoRoot(start: string): string {
  let directory = start;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (existsSync(join(directory, SLICE_DEFINITIONS_FILE))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`@fdp/eval: no ${SLICE_DEFINITIONS_FILE} above ${start}`);
}

/**
 * Absolute path of the repository root.
 *
 * It is found by walking up from this file until the committed definitions document is
 * there, so the harness resolves the same whether it runs from `tools/eval` or from the
 * workspace root.
 */
export const REPO_ROOT: string = findRepoRoot(import.meta.dirname);

/** Absolute path of the gitignored directory `make fixtures` cuts the slices into. */
export const SLICES_DIR: string = join(REPO_ROOT, SLICES_DIR_NAME);

function fail(message: string): never {
  throw new Error(`${join(REPO_ROOT, SLICE_DEFINITIONS_FILE)}: ${message}`);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function readSegments(value: unknown, name: string): SliceSegment[] {
  if (!Array.isArray(value) || value.length === 0) fail(`slice '${name}' has no segments`);
  return value.map((entry, index) => {
    const segment = asRecord(entry, `slice '${name}' segment ${index}`);
    const { from, to, rows } = segment;
    if (typeof from !== "string" || typeof to !== "string") {
      fail(`slice '${name}' segment ${index} has no from/to bounds`);
    }
    if (typeof rows !== "number" || !Number.isInteger(rows) || rows <= 0) {
      fail(`slice '${name}' segment ${index} has no positive row count`);
    }
    return { from, to, rows };
  });
}

function readDefinition(value: unknown, index: number): SliceDefinition {
  const slice = asRecord(value, `slice ${index}`);
  const { name, rows, sha256, used_by: usedBy } = slice;
  if (typeof name !== "string" || name === "") fail(`slice ${index} has no name`);
  if (typeof rows !== "number" || !Number.isInteger(rows) || rows <= 0) {
    fail(`slice '${name}' has no positive row count`);
  }
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    fail(`slice '${name}' has no sha256`);
  }
  if (!Array.isArray(usedBy) || usedBy.some((entry) => typeof entry !== "string")) {
    fail(`slice '${name}' has no used_by list`);
  }
  return {
    name,
    segments: readSegments(slice["segments"], name),
    rows,
    sha256,
    used_by: usedBy as string[],
  };
}

function readDefinitions(): ReadonlyMap<string, SliceDefinition> {
  const path = join(REPO_ROOT, SLICE_DEFINITIONS_FILE);
  const document = asRecord(JSON.parse(readFileSync(path, "utf8")), "the document");
  if (document["schema"] !== SLICES_SCHEMA) {
    fail(`schema is ${JSON.stringify(document["schema"])}, not ${SLICES_SCHEMA}`);
  }
  const slices = document["slices"];
  if (!Array.isArray(slices) || slices.length === 0) fail("no slices");

  const byName = new Map<string, SliceDefinition>();
  slices.forEach((entry, index) => {
    const definition = readDefinition(entry, index);
    if (byName.has(definition.name)) fail(`slice '${definition.name}' is defined twice`);
    byName.set(definition.name, definition);
  });
  return byName;
}

let definitions: ReadonlyMap<string, SliceDefinition> | undefined;

/** The definitions document, read and validated on the first call. */
export function sliceDefinitions(): ReadonlyMap<string, SliceDefinition> {
  definitions ??= readDefinitions();
  return definitions;
}

/** Every defined slice name, in document order. */
export function sliceNames(): readonly string[] {
  return [...sliceDefinitions().keys()];
}

/**
 * What the slice named `name` is supposed to contain.
 *
 * @throws Error when no such slice is defined, which is a typo in a scenario file or a
 * renamed definition, not a missing download.
 */
export function sliceDef(name: string): SliceDefinition {
  const definition = sliceDefinitions().get(name);
  if (definition === undefined) {
    throw new Error(
      `@fdp/eval: no MetroPT-3 slice named '${name}' in ${SLICE_DEFINITIONS_FILE}; ` +
        `defined: ${sliceNames().join(", ")}`,
    );
  }
  return definition;
}

/**
 * Where the slice named `name` would be cut, whether or not it is there.
 *
 * @throws Error when no such slice is defined: a path outside the definitions would name a
 * file no `make fixtures` ever writes.
 */
export function slicePath(name: string): string {
  return join(SLICES_DIR, `${sliceDef(name).name}.csv`);
}

/** True when the slice has been cut on this machine. */
export function sliceIsCut(name: string): boolean {
  return existsSync(slicePath(name));
}

/**
 * The path of a cut slice.
 *
 * @throws MissingSliceError when the slice is defined but not cut, with the command that
 * produces it. A caller that may run without the dataset catches it and skips, unless
 * `datasetRequired()` says the absence is a failure.
 */
export function requireSlice(name: string): string {
  const path = slicePath(name);
  if (!existsSync(path)) throw new MissingSliceError(name, path);
  return path;
}

/** True when an absent slice must fail rather than skip (`FDP_REQUIRE_DATASET`). */
export function datasetRequired(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env[REQUIRE_DATASET_ENV];
  return value !== undefined && value !== "" && value !== "0";
}
