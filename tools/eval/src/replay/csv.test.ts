// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The loader, against a CSV this file writes and against the real slices.
//
// Two sources, on purpose. The synthetic file carries the dataset's verbatim
// header and its shape but none of its rows, so every rule of the loader —
// header resolution, the missing-value rule, `invert`, the window, the gap
// flag, gzip — is proved on a machine that has never downloaded MetroPT-3 (no
// MetroPT-3 row is committed). The cut slices then prove the same loader on the
// real thing; they are absent on a laptop without the dataset, so those cases
// skip there and fail under `FDP_REQUIRE_DATASET=1`, which CI sets after its
// dataset-cache step.
//
// Nothing here names a tag id or a column index: a test that needs a
// particular lane asks the register map for it, exactly as the loader does.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

import { REGISTER_MAP } from "@fdp/contracts";
import { afterAll, describe, expect, it } from "vitest";

import {
  METROPT3_HEADER,
  METROPT3_LINE_TERMINATOR,
  PARITY_SLICE,
  datasetRequired,
  requireSlice,
  sliceDef,
  sliceIsCut,
} from "../slices.ts";
import { formatCsvTs, parseCsvTs } from "../time.ts";
import { HeaderError, RowError, parseRowTs, readRows, resolveLanes } from "./csv.ts";
import type { RegisterMap, ReplayRow } from "./types.ts";
import { GAP_THRESHOLD_MS } from "./types.ts";

const MAP: RegisterMap = REGISTER_MAP;
const LANES = resolveLanes(MAP);
const HEADER_COLUMNS = METROPT3_HEADER.split(",");
const SAMPLE_STEP_MS = 10_000;

const requireDataset = datasetRequired();
const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-replay-csv-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** One synthetic row, keyed by the dataset's own column names. */
type Fields = Record<string, string>;

/**
 * A deterministic synthetic row.
 *
 * The waveform is a coarse caricature of a compressor cycle — loaded for two samples out of
 * every eight — and carries no MetroPT-3 value: what the loader is tested on here is the
 * parsing, not the physics.
 */
function syntheticFields(index: number): Fields {
  const loaded = index % 8 < 2;
  const analog = (base: number, swing: number) => (base + swing * (index % 8)).toFixed(3);
  return {
    "": String(index * 10),
    timestamp: "",
    TP2: loaded ? analog(9.1, 0.2) : "-0.012000000000000004",
    TP3: analog(8.2, 0.25),
    H1: loaded ? "-0.014" : analog(8.2, 0.25),
    DV_pressure: "-0.018",
    Reservoirs: analog(8.2, 0.25),
    Oil_temperature: analog(53.6, 0.4),
    Motor_current: loaded ? "6.00" : index % 8 < 5 ? "3.77" : "0.04",
    COMP: loaded ? "0.0" : "1.0",
    DV_eletric: loaded ? "1.0" : "0.0",
    Towers: "1.0",
    MPG: loaded ? "0.0" : "1.0",
    LPS: "0.0",
    Pressure_switch: "1.0",
    Oil_level: "1.0",
    Caudal_impulses: "1.0",
  };
}

interface SyntheticOptions {
  readonly rows: number;
  /** Row index at which the clock jumps by `gapMs` instead of by one sample step. */
  readonly gapBefore?: number;
  readonly gapMs?: number;
  /** Rewrites the fields of one row, after the generator has filled them. */
  readonly corrupt?: (fields: Fields, index: number) => void;
  readonly header?: string;
  readonly startMs?: number;
}

/** A CSV with the dataset's verbatim header and synthetic rows, CRLF-terminated as the file is. */
function syntheticCsv(options: SyntheticOptions): string {
  const header = options.header ?? METROPT3_HEADER;
  const columns = header === METROPT3_HEADER ? HEADER_COLUMNS : header.split(",");
  const lines = [header];

  let instant = options.startMs ?? Date.UTC(2020, 1, 1, 0, 0, 0);
  for (let index = 0; index < options.rows; index += 1) {
    if (index > 0) {
      instant += index === options.gapBefore ? (options.gapMs ?? 0) : SAMPLE_STEP_MS;
    }
    const fields = syntheticFields(index);
    fields["timestamp"] = formatCsvTs(instant);
    options.corrupt?.(fields, index);
    lines.push(columns.map((name) => fields[name] ?? "").join(","));
  }
  return lines.join(METROPT3_LINE_TERMINATOR) + METROPT3_LINE_TERMINATOR;
}

/** Everything an async iterable yields. */
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const found: T[] = [];
  for await (const item of source) found.push(item);
  return found;
}

/** The lane of the analog signal a column feeds; `-1` when the map does not replay it. */
function analogLane(column: string): number {
  return LANES.analog.findIndex((signal) => signal.metropt_column === column);
}

/** Writes `text` as a plain `.csv` and as a `.csv.gz` in a fresh directory, and names both. */
function writeBothForms(text: string): { plain: string; gzip: string } {
  const directory = temporaryDirectory();
  const plain = join(directory, "slice.csv");
  const gzip = join(directory, "slice.csv.gz");
  writeFileSync(plain, text);
  writeFileSync(gzip, gzipSync(Buffer.from(text)));
  return { plain, gzip };
}

describe("resolveLanes", () => {
  it("puts the analog signals first and the synthetic extras last", () => {
    const analogCount = MAP.signals.filter((signal) => signal.group === "analog").length;
    const extras = MAP.signals.filter((signal) => signal.group === "extra");

    expect(LANES.analog).toHaveLength(analogCount + extras.length);
    expect(LANES.analog.slice(analogCount)).toEqual(extras);
    expect(LANES.ambientIndex).toBe(analogCount);
    expect(LANES.digital.every((signal) => signal.group === "digital")).toBe(true);
  });

  it("reports no ambient lane for a map with no extras", () => {
    const lanes = resolveLanes({ signals: MAP.signals.filter((s) => s.group !== "extra") });
    expect(lanes.ambientIndex).toBeNull();
  });
});

describe("parseRowTs", () => {
  it("agrees with the dataset clock of src/time.ts", () => {
    for (const text of ["2020-02-01 00:00:00", "2020-06-05 09:49:07", "2020-09-01 03:59:50"]) {
      expect(parseRowTs(text)).toBe(parseCsvTs(text));
    }
  });

  it("refuses a shape the dataset never writes", () => {
    expect(() => parseRowTs("2020-02-01T00:00:00")).toThrow(TypeError);
    expect(() => parseRowTs("2020-02-01 00:00")).toThrow(TypeError);
    expect(() => parseRowTs("2020-02-0x 00:00:00")).toThrow(TypeError);
  });

  it("refuses a date that names no instant instead of rolling it over", () => {
    expect(() => parseRowTs("2020-02-30 00:00:00")).toThrow(TypeError);
    expect(() => parseRowTs("2020-13-01 00:00:00")).toThrow(TypeError);
  });
});

describe("header resolution", () => {
  it("names the required timestamp column when the header has none", async () => {
    const header = HEADER_COLUMNS.filter((name) => name !== "timestamp").join(",");
    const text = syntheticCsv({ rows: 2, header });

    await expect(collect(readRows(Readable.from(text), MAP))).rejects.toThrow(
      /the required column "timestamp" is missing/,
    );
  });

  it("names a mapped column the header does not have, and the signal that wanted it", async () => {
    const dropped = LANES.analog.find((signal) => signal.metropt_column !== null);
    expect(dropped).toBeDefined();
    const header = HEADER_COLUMNS.filter((name) => name !== dropped?.metropt_column).join(",");
    const text = syntheticCsv({ rows: 2, header });

    const error = await collect(readRows(Readable.from(text), MAP)).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(HeaderError);
    expect((error as Error).message).toContain(String(dropped?.metropt_column));
    expect((error as Error).message).toContain(String(dropped?.tag));
  });

  it("refuses a header that names a column twice", async () => {
    const text = syntheticCsv({ rows: 2, header: `${METROPT3_HEADER},timestamp` });

    await expect(collect(readRows(Readable.from(text), MAP))).rejects.toThrow(
      /appears twice in the header/,
    );
  });

  it("refuses a source with no header line at all", async () => {
    await expect(collect(readRows(Readable.from(""), MAP))).rejects.toThrow(HeaderError);
  });

  it("ignores the dataset's unnamed index column", async () => {
    const rows = await collect(readRows(Readable.from(syntheticCsv({ rows: 3 })), MAP));
    expect(rows).toHaveLength(3);
  });
});

describe("readRows", () => {
  it("reads the dataset clock as UTC, in file order", async () => {
    const rows = await collect(readRows(Readable.from(syntheticCsv({ rows: 4 })), MAP));

    expect(rows.map((row) => row.simTsMs)).toEqual([
      Date.UTC(2020, 1, 1, 0, 0, 0),
      Date.UTC(2020, 1, 1, 0, 0, 10),
      Date.UTC(2020, 1, 1, 0, 0, 20),
      Date.UTC(2020, 1, 1, 0, 0, 30),
    ]);
  });

  it("parses analog values into the analog lanes and leaves the extras NaN", async () => {
    const [row] = await collect(readRows(Readable.from(syntheticCsv({ rows: 1 })), MAP));
    expect(row).toBeDefined();
    if (row === undefined || LANES.ambientIndex === null) return;

    const oilLane = analogLane("Oil_temperature");
    expect(row.analog[oilLane]).toBe(53.6);
    expect(row.analog[LANES.ambientIndex]).toBeNaN();
    expect(row.missing).toBe(false);
  });

  it("reads a digital column as value != 0", async () => {
    const rows = await collect(readRows(Readable.from(syntheticCsv({ rows: 4 })), MAP));
    const lane = LANES.digital.findIndex((signal) => signal.metropt_column === "DV_eletric");

    // The synthetic waveform is loaded for the first two rows of every eight.
    expect(rows.map((row) => row.digital[lane])).toEqual([1, 1, 0, 0]);
  });

  it("applies invert when the map declares it", async () => {
    const [first] = LANES.digital;
    expect(first).toBeDefined();
    if (first === undefined) return;

    const inverted: RegisterMap = {
      signals: MAP.signals.map((signal) =>
        signal.tag === first.tag ? { ...signal, invert: true } : signal,
      ),
    };
    const text = syntheticCsv({ rows: 4 });
    const plain = await collect(readRows(Readable.from(text), MAP));
    const flipped = await collect(readRows(Readable.from(text), inverted));
    const lane = resolveLanes(inverted).digital.findIndex((signal) => signal.tag === first.tag);

    expect(flipped.map((row) => row.digital[lane])).toEqual(
      plain.map((row) => (row.digital[lane] === 1 ? 0 : 1)),
    );
  });

  it("keeps the previous value and flags the row when a field carries no value", async () => {
    // The second analog lane of the map is the line-pressure column, TP3.
    const column = LANES.analog[1]?.metropt_column;
    expect(column).toBeTypeOf("string");
    if (typeof column !== "string") return;

    const text = syntheticCsv({
      rows: 4,
      corrupt: (fields, index) => {
        if (index === 1) fields[column] = "NaN";
        if (index === 2) fields[column] = "";
        if (index === 3) fields[column] = "not-a-number";
      },
    });
    const rows = await collect(readRows(Readable.from(text), MAP));
    const lane = analogLane(column);
    const held = rows[0]?.analog[lane];

    expect(rows.map((row) => row.missing)).toEqual([false, true, true, true]);
    expect(rows.map((row) => row.analog[lane])).toEqual([held, held, held, held]);
  });

  it("flags a row that stops short of a bound column", async () => {
    const text = syntheticCsv({ rows: 2 })
      .split(METROPT3_LINE_TERMINATOR)
      .map((line, index) => (index === 2 ? line.split(",").slice(0, 3).join(",") : line))
      .join(METROPT3_LINE_TERMINATOR);
    const rows = await collect(readRows(Readable.from(text), MAP));

    expect(rows.map((row) => row.missing)).toEqual([false, true]);
  });

  it("refuses a row whose timestamp does not move the clock forward", async () => {
    const text = syntheticCsv({
      rows: 3,
      corrupt: (fields, index) => {
        if (index === 2) fields["timestamp"] = "2020-02-01 00:00:00";
      },
    });

    await expect(collect(readRows(Readable.from(text), MAP))).rejects.toThrow(RowError);
  });

  it("refuses a row whose timestamp is not the dataset's width", async () => {
    const text = syntheticCsv({
      rows: 2,
      corrupt: (fields, index) => {
        if (index === 1) fields["timestamp"] = "2020-02-01 00:00";
      },
    });

    await expect(collect(readRows(Readable.from(text), MAP))).rejects.toThrow(RowError);
  });

  it("reads only the rows inside [from, to)", async () => {
    const text = syntheticCsv({ rows: 10 });
    const start = Date.UTC(2020, 1, 1, 0, 0, 0);
    const rows = await collect(
      readRows(Readable.from(text), MAP, {
        from: new Date(start + 2 * SAMPLE_STEP_MS),
        to: new Date(start + 5 * SAMPLE_STEP_MS),
      }),
    );

    expect(rows.map((row) => row.simTsMs)).toEqual([
      start + 2 * SAMPLE_STEP_MS,
      start + 3 * SAMPLE_STEP_MS,
      start + 4 * SAMPLE_STEP_MS,
    ]);
  });

  it("rounds a sub-second bound up to the dataset's own second", async () => {
    const text = syntheticCsv({ rows: 4 });
    const start = Date.UTC(2020, 1, 1, 0, 0, 0);
    const rows = await collect(
      readRows(Readable.from(text), MAP, { to: new Date(start + SAMPLE_STEP_MS + 500) }),
    );

    expect(rows.map((row) => row.simTsMs)).toEqual([start, start + SAMPLE_STEP_MS]);
  });

  it("gives a gzip source and a plain one identical rows", async () => {
    const { plain, gzip } = writeBothForms(
      syntheticCsv({ rows: 40, gapBefore: 12, gapMs: 3600_000 }),
    );

    const fromPlain = await collect(readRows(plain, MAP));
    const fromGzip = await collect(readRows(gzip, MAP));

    expect(fromGzip).toHaveLength(40);
    expect(fromGzip).toEqual(fromPlain);
  });

  it("reports a gzip source that cannot be read rather than hanging", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "broken.csv.gz");
    writeFileSync(path, "this is not gzip");

    await expect(collect(readRows(path, MAP))).rejects.toThrow();
  });

  it("reports a path that is not there rather than hanging", async () => {
    const missing = join(temporaryDirectory(), "absent.csv");

    await expect(collect(readRows(missing, MAP))).rejects.toThrow(/ENOENT/);
  });
});

/** The row indexes whose step from the previous row is a discontinuity, the first included. */
function expectedDiscontinuities(rows: readonly ReplayRow[], thresholdMs: number): number[] {
  const found: number[] = [];
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    if (previous === undefined || row.simTsMs - previous.simTsMs > thresholdMs) found.push(index);
  });
  return found;
}

describe("gaps", () => {
  it("leaves the loader to report the steps and flags nothing itself", async () => {
    const text = syntheticCsv({ rows: 20, gapBefore: 7, gapMs: GAP_THRESHOLD_MS + 10_000 });
    const rows = await collect(readRows(Readable.from(text), MAP));

    expect(expectedDiscontinuities(rows, GAP_THRESHOLD_MS)).toEqual([0, 7]);
  });

  it("does not count a step of exactly the threshold", async () => {
    const text = syntheticCsv({ rows: 6, gapBefore: 3, gapMs: GAP_THRESHOLD_MS });
    const rows = await collect(readRows(Readable.from(text), MAP));

    expect(expectedDiscontinuities(rows, GAP_THRESHOLD_MS)).toEqual([0]);
  });
});

describe("the cut slices", () => {
  const cut = sliceIsCut(PARITY_SLICE);

  it.skipIf(!cut && !requireDataset)("reads the row count the definitions record", async () => {
    const definition = sliceDef(PARITY_SLICE);
    const rows = await collect(readRows(requireSlice(PARITY_SLICE), MAP));

    expect(rows).toHaveLength(definition.rows);
    expect(rows.every((row) => row.missing === false)).toBe(true);
  });

  it.skipIf(!cut && !requireDataset)("stays inside the window the definitions record", async () => {
    const [segment] = sliceDef(PARITY_SLICE).segments;
    expect(segment).toBeDefined();
    if (segment === undefined) return;

    const rows = await collect(readRows(requireSlice(PARITY_SLICE), MAP));
    const first = rows.at(0)?.simTsMs ?? 0;
    const last = rows.at(-1)?.simTsMs ?? 0;

    expect(first).toBeGreaterThanOrEqual(Date.parse(segment.from));
    expect(last).toBeLessThan(Date.parse(segment.to));
  });

  it.skipIf(!cut && !requireDataset)("filters a sub-window of it", async () => {
    const [segment] = sliceDef(PARITY_SLICE).segments;
    expect(segment).toBeDefined();
    if (segment === undefined) return;

    const path = requireSlice(PARITY_SLICE);
    const middle = new Date((Date.parse(segment.from) + Date.parse(segment.to)) / 2);
    const all = await collect(readRows(path, MAP));
    const tail = await collect(readRows(path, MAP, { from: middle }));

    expect(tail.map((row) => row.simTsMs)).toEqual(
      all.map((row) => row.simTsMs).filter((simTsMs) => simTsMs >= middle.getTime()),
    );
  });

  it.skipIf(!cut && !requireDataset)("reads a gzip copy of it identically", async () => {
    const path = requireSlice(PARITY_SLICE);
    const plain = await collect(readRows(path, MAP));

    const directory = temporaryDirectory();
    const gzip = join(directory, `${PARITY_SLICE}.csv.gz`);
    writeFileSync(gzip, gzipSync(readFileSync(path)));

    expect(await collect(readRows(gzip, MAP))).toEqual(plain);
  });
});
