// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The slice contract from the harness side.
//
// `data/fixtures/metropt3-slices.json` belongs to the data scripts and
// `data/SHA256SUMS` checks the cut bytes there (`scripts/data/slices.test.ts`),
// so nothing of that is repeated here. What this suite asserts is the half the
// harness owns: that every slice the scenarios name is still defined — a rename
// upstream must break here, not in sixteen scenario files — and that a cut file
// is the dataset's own CSV, header included.
//
// No MetroPT-3 row is committed, so the file half of that runs only where
// `make fixtures` has run. Absence is a skip on a laptop and a failure under
// `FDP_REQUIRE_DATASET=1`, which CI sets once it has restored the dataset.

import { closeSync, openSync, readSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  METROPT3_HEADER,
  METROPT3_LINE_TERMINATOR,
  MissingSliceError,
  PARITY_SLICE,
  REPO_ROOT,
  SCENARIO_SLICES,
  SLICES_DIR,
  datasetRequired,
  requireSlice,
  sliceDef,
  sliceIsCut,
  sliceNames,
  slicePath,
} from "../src/slices.ts";
import { parseCsvTs } from "../src/time.ts";

/** Every slice this package asks `make fixtures` for. */
const USED_SLICES = [...SCENARIO_SLICES, PARITY_SLICE];

/** Enough bytes for the header line and the first data row of any slice. */
const PREFIX_BYTES = 512;

const requireDataset = datasetRequired();

/**
 * The first `count` lines of a file, without reading the rest of it.
 *
 * The dataset is CRLF-terminated, so the split is on the terminator itself: splitting on
 * `\n` would leave a `\r` on the end of every line and make the header comparison fail for
 * a reason that has nothing to do with the columns.
 */
function readFirstLines(path: string, count: number): string[] {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(PREFIX_BYTES);
    const read = readSync(handle, buffer, 0, PREFIX_BYTES, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    return text.split(METROPT3_LINE_TERMINATOR).slice(0, count);
  } finally {
    closeSync(handle);
  }
}

/** The instant of one cut row, read from its second field (the dataset clock). */
function rowInstant(row: string): number {
  const first = row.indexOf(",");
  const second = row.indexOf(",", first + 1);
  if (first < 0 || second < 0) {
    throw new Error(`'${row.slice(0, 48)}' is not an index followed by a timestamp`);
  }
  return parseCsvTs(row.slice(first + 1, second));
}

describe("slice definitions", () => {
  it("defines every slice the scenarios and the parity test replay", () => {
    const defined = new Set(sliceNames());
    expect(USED_SLICES.filter((name) => !defined.has(name))).toEqual([]);
  });

  it("gives each of them at least one segment and a positive row count", () => {
    for (const name of USED_SLICES) {
      const definition = sliceDef(name);
      expect(definition.name, name).toBe(name);
      expect(definition.segments.length, name).toBeGreaterThan(0);
      expect(definition.rows, name).toBeGreaterThan(0);
    }
  });

  it("refuses a name it does not define", () => {
    expect(() => sliceDef("no-such-slice")).toThrow(/no MetroPT-3 slice named 'no-such-slice'/);
    expect(() => slicePath("no-such-slice")).toThrow(/no MetroPT-3 slice named/);
  });

  it("resolves a slice inside the gitignored cut directory", () => {
    expect(SLICES_DIR).toBe(`${REPO_ROOT}/data/fixtures/metropt3`);
    expect(slicePath(PARITY_SLICE)).toBe(`${SLICES_DIR}/${PARITY_SLICE}.csv`);
  });
});

describe("requireSlice", () => {
  it("names the command that produces an absent slice", () => {
    const path = `${SLICES_DIR}/${PARITY_SLICE}.csv`;
    const error = new MissingSliceError(PARITY_SLICE, path);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(PARITY_SLICE);
    expect(error.message).toContain("make fixtures");
    expect(error.slice).toBe(PARITY_SLICE);
    expect(error.path).toBe(path);
  });

  it("returns a cut slice, and throws for one that is not cut", () => {
    if (sliceIsCut(PARITY_SLICE)) {
      expect(requireSlice(PARITY_SLICE)).toBe(slicePath(PARITY_SLICE));
    } else {
      // FDP_REQUIRE_DATASET=1 promises the slices are cut, so absence is a failure there.
      expect(requireDataset, `${PARITY_SLICE} is not cut; run make fixtures`).toBe(false);
      expect(() => requireSlice(PARITY_SLICE)).toThrow(MissingSliceError);
    }
  });
});

describe("cut slices", () => {
  for (const name of USED_SLICES) {
    const cut = sliceIsCut(name);

    it.skipIf(!cut && !requireDataset)(`${name} is the dataset's own CSV`, () => {
      const path = requireSlice(name);
      const [header, firstRow] = readFirstLines(path, 2);
      expect(header, `${name}: header`).toBe(METROPT3_HEADER);
      expect(typeof firstRow, `${name}: first data row`).toBe("string");

      const [segment] = sliceDef(name).segments;
      expect(segment, `${name}: first segment`).toBeDefined();
      if (segment === undefined || firstRow === undefined) return;

      const instant = rowInstant(firstRow);
      const where = `${name}: first row inside [${segment.from}, ${segment.to})`;
      expect(instant, where).toBeGreaterThanOrEqual(Date.parse(segment.from));
      expect(instant, where).toBeLessThan(Date.parse(segment.to));
    });
  }
});
