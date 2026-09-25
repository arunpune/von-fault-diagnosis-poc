// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The whole 218 MB MetroPT-3 CSV, through the replay engine, once.
//
// The unit suites prove the loader's rules on a few hundred synthetic rows and
// on the cut slices. This one proves the two properties only the whole file
// can show: that nothing is buffered — 1,516,948 rows stream through a
// process that never grows a copy of them — and that the facts
// counted over the published file (docs/dataset.md) are the facts the
// loader reports, down to the 331 gaps wider than 60 s. A loader that silently
// dropped a row, rolled a date over or read the clock as local time would
// disagree with that table and fail here.
//
// MetroPT-3 reaches a machine by download only, so the test needs a path to it:
// `METROPT_CSV`, or the default location `make fetch-dataset` downloads into.
// Without one it skips with the command that produces it — unless
// `FDP_REQUIRE_DATASET=1` says the dataset was supposed to be there, which is
// what CI sets after its dataset-cache step. It runs through `test:integration`
// only, so `make test` stays offline.

import { statSync } from "node:fs";
import { join } from "node:path";

import { REGISTER_MAP } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { createReplaySource } from "../../src/replay/index.ts";
import type { RegisterMap } from "../../src/replay/types.ts";
import { GAP_THRESHOLD_MS, MAX_BATCH_SIZE } from "../../src/replay/types.ts";
import { REPO_ROOT, datasetRequired } from "../../src/slices.ts";

/** Where `scripts/data/fetch-metropt3.sh` puts the published file. */
const DEFAULT_CSV = join(REPO_ROOT, "data/metropt3/MetroPT3(AirCompressor).csv");

/** The variable that points the test at the file when it is somewhere else. */
const CSV_ENV = "METROPT_CSV";

/**
 * What was counted over the published file (docs/dataset.md).
 *
 * These are not tuning knobs: the loader must reproduce every one of them, and a
 * disagreement is either a loader bug or a different file.
 */
const PUBLISHED = {
  rows: 1_516_948,
  firstSimTs: "2020-02-01T00:00:00.000Z",
  lastSimTs: "2020-09-01T03:59:50.000Z",
  /** Steps wider than 60 s, the first sample not counted (it is flagged too). */
  gapsOver60s: 331,
} as const;

/** The rate the `full` evaluation profile needs the loader to sustain. */
const MIN_ROWS_PER_SECOND = 50_000;

function datasetPath(): string | undefined {
  const named = process.env[CSV_ENV];
  const candidate = named !== undefined && named !== "" ? named : DEFAULT_CSV;
  try {
    return statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

const path = datasetPath();
const required = datasetRequired();

describe("the full MetroPT-3 CSV", () => {
  it("is reachable, or the dataset was not required", () => {
    expect(
      path !== undefined || !required,
      `${CSV_ENV} points at no file and ${DEFAULT_CSV} is absent; run make fetch-dataset`,
    ).toBe(true);
    if (path === undefined) {
      console.info(
        `fullcsv: skipped, no MetroPT-3 CSV; set ${CSV_ENV} or run make fetch-dataset ` +
          `(set FDP_REQUIRE_DATASET=1 to make this a failure)`,
      );
    }
  });

  it.skipIf(path === undefined)("streams whole and reports the published facts", async () => {
    if (path === undefined) return;

    const source = createReplaySource({
      source: path,
      map: REGISTER_MAP as RegisterMap,
      wall: () => new Date(Date.UTC(2026, 8, 19, 12, 0, 0)),
    });

    const startedNs = process.hrtime.bigint();
    let samples = 0;
    let batches = 0;
    let previousSeq = 0;
    for await (const batch of source) {
      batches += 1;
      expect(batch.samples.length).toBeLessThanOrEqual(MAX_BATCH_SIZE);
      for (const sample of batch.samples) {
        previousSeq += 1;
        if (sample.seq !== previousSeq) {
          throw new Error(`seq ${sample.seq} follows ${previousSeq - 1}`);
        }
        samples += 1;
      }
    }
    const seconds = Number(process.hrtime.bigint() - startedNs) / 1e9;
    const rowsPerSecond = Math.round(samples / seconds);
    const { stats } = source;

    console.info(
      `fullcsv: ${stats.rows.toLocaleString("en-US")} rows in ${seconds.toFixed(1)} s ` +
        `= ${rowsPerSecond.toLocaleString("en-US")} rows/s, ` +
        `${stats.discontinuities} discontinuities in ${batches.toLocaleString("en-US")} batches`,
    );

    expect(samples).toBe(PUBLISHED.rows);
    expect(stats.rows).toBe(PUBLISHED.rows);
    expect(stats.samples).toBe(PUBLISHED.rows);
    expect(batches).toBe(Math.ceil(PUBLISHED.rows / MAX_BATCH_SIZE));
    expect(stats.firstSimTs).toBe(PUBLISHED.firstSimTs);
    expect(stats.lastSimTs).toBe(PUBLISHED.lastSimTs);
    // The first sample is flagged as well as every gap wider than the threshold.
    expect(stats.discontinuities - 1).toBe(PUBLISHED.gapsOver60s);
    expect(GAP_THRESHOLD_MS).toBe(60_000);
    expect(rowsPerSecond).toBeGreaterThanOrEqual(MIN_ROWS_PER_SECOND);
  });

  it.skipIf(path === undefined)("replays a window without reading past it", async () => {
    if (path === undefined) return;

    const from = new Date(Date.UTC(2020, 1, 1, 0, 0, 0));
    const to = new Date(Date.UTC(2020, 1, 1, 2, 0, 0));
    const source = createReplaySource({
      source: path,
      map: REGISTER_MAP as RegisterMap,
      wall: () => new Date(Date.UTC(2026, 8, 19, 12, 0, 0)),
      from,
      to,
    });

    const startedNs = process.hrtime.bigint();
    for await (const batch of source) void batch;
    const seconds = Number(process.hrtime.bigint() - startedNs) / 1e9;
    const { stats } = source;

    // The two hours the parity slice is cut from, and nothing after them.
    expect(stats.rows).toBe(727);
    expect(stats.firstSimTs).toBe("2020-02-01T00:00:00.000Z");
    expect(stats.lastSimTs).toBe("2020-02-01T01:59:55.000Z");
    // Two hours out of seven months: reading the whole file would take far longer.
    expect(seconds).toBeLessThan(5);
  });
});
