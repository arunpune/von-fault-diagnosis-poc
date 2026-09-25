// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Build the telemetry fixtures this package replays.
 *
 *     make fixtures                              # cuts the slices
 *     pnpm --filter @fdp/backend fixtures        # this script turns six into batches
 *
 * No MetroPT-3 row is committed anywhere, so the input is the cut slices under
 * `data/fixtures/metropt3/` and the output goes beside them, under
 * `backend/`, which is git-ignored just the same. Nothing derived from the
 * recording ever enters a commit.
 *
 * Six fixtures, and what each is for:
 *
 *   baseline-feb        a first-month morning: the detection negatives
 *   unlabelled-may19    a continuous-load episode that looks like signature A
 *                       but lies outside every scored window, so a test may use
 *                       it without encoding a labelled failure
 *   summer-jul05        a normal summer day: the seasonal-drift negative
 *   frozen-jun22        the frozen-logger guard
 *   depot-apr30         a depot depressurisation, motor off: the parked guard
 *   gap-jump            synthetic: a baseline hour, then the May episode with
 *                       `discontinuity` on the first sample after the jump
 *
 * Every batch is validated against `telemetry-samples` before it is written, so
 * a fixture that reaches disk is one the running backend would accept.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";

import { validate, type TelemetrySamples } from "@fdp/contracts";

import { sha256 } from "../../../src/ids.ts";
import {
  BACKEND_FIXTURE_DIR,
  slicePath,
  type BackendFixtureName,
  type TelemetryFixture,
} from "../../helpers/fixtures.ts";
import { readSlice, toBatches, toIso, type DecodedRow } from "./rows.ts";

/** The unit this proof of concept has (DEFAULT_UNIT_ID of the contracts). */
const UNIT_ID = "cau-7";

/** A fixed instant for `wall_ts`, so two runs produce identical bytes. */
const WALL_START = Date.parse("2026-09-21T00:00:00.000Z");

/** True while the register map carries provisional tag ids. */
const SIGNALS_PROVISIONAL = true;

const GENERATED_BY = "apps/backend/test/fixtures/telemetry/make-fixtures.ts";

interface SliceWindow {
  readonly slice: string;
  readonly from: string;
  readonly to: string;
}

interface FixtureSpec {
  readonly name: BackendFixtureName;
  readonly purpose: string;
  /** One window for a cut fixture, two for the synthetic jump. */
  readonly windows: readonly SliceWindow[];
}

/**
 * The windows, in the data clock, half-open like the slice definitions.
 *
 * `baseline-feb` is the first six hours of 3 February. `unlabelled-may19` is
 * the unlabelled continuous-load episode (2020-05-19 22:22 →
 * 2020-05-20 23:02) with an hour of lead-in, so a detection test sees the
 * onset. The other three take their slice whole: each is already a window
 * chosen for one guard.
 */
const SPECS: readonly FixtureSpec[] = [
  {
    name: "baseline-feb",
    purpose: "a first-month morning; zero events",
    windows: [
      { slice: "baseline-feb03", from: "2020-02-03T00:00:00Z", to: "2020-02-03T06:00:00Z" },
    ],
  },
  {
    name: "unlabelled-may19",
    purpose: "an unlabelled continuous-load episode, outside every scored window",
    windows: [
      { slice: "unlabelled-may19", from: "2020-05-19T21:00:00Z", to: "2020-05-20T23:30:00Z" },
    ],
  },
  {
    name: "summer-jul05",
    purpose: "a normal summer day; the seasonal-drift negative",
    windows: [{ slice: "summer-jul05", from: "2020-07-05T00:00:00Z", to: "2020-07-06T00:00:00Z" }],
  },
  {
    name: "frozen-jun22",
    purpose: "the frozen-logger guard; zero events",
    windows: [{ slice: "frozen-jun22", from: "2020-06-22T12:00:00Z", to: "2020-06-23T00:00:00Z" }],
  },
  {
    name: "depot-apr30",
    purpose: "a depot depressurisation with the motor off; the parked guard",
    windows: [{ slice: "depot-apr30", from: "2020-04-30T23:00:00Z", to: "2020-05-01T13:00:00Z" }],
  },
  {
    name: "gap-jump",
    purpose: "synthetic: a baseline hour, then the May episode across a discontinuity",
    windows: [
      { slice: "baseline-feb03", from: "2020-02-03T00:00:00Z", to: "2020-02-03T01:00:00Z" },
      { slice: "unlabelled-may19", from: "2020-05-19T22:00:00Z", to: "2020-05-20T00:00:00Z" },
    ],
  },
];

/** SHA-256 of a cut slice, the same number `data/fixtures/metropt3-slices.json` records. */
function sliceDigest(slice: string): string {
  return sha256(readFileSync(slicePath(slice)));
}

async function rowsOf(window: SliceWindow): Promise<DecodedRow[]> {
  const rows: DecodedRow[] = [];
  const bounds = { fromMs: Date.parse(window.from), toMs: Date.parse(window.to) };
  for await (const row of readSlice(slicePath(window.slice), bounds)) rows.push(row);
  return rows;
}

/** Build one fixture; throws with a readable reason when a slice has not been cut. */
async function buildFixture(spec: FixtureSpec): Promise<TelemetryFixture> {
  const parts: DecodedRow[][] = [];
  for (const window of spec.windows) parts.push(await rowsOf(window));

  for (const [index, rows] of parts.entries()) {
    if (rows.length === 0) {
      const window = spec.windows[index] as SliceWindow;
      throw new Error(
        `${window.slice} has no row in [${window.from}, ${window.to}); ` +
          "run `make fixtures` (and `make fetch-dataset` first)",
      );
    }
  }

  const synthetic = parts.length > 1;
  const rows = parts.flat();
  const batches: TelemetrySamples[] = synthetic
    ? joinAcrossJump(parts)
    : toBatches(rows, { unitId: UNIT_ID, wallStartMs: WALL_START });

  for (const [index, batch] of batches.entries()) {
    const result = validate("telemetry-samples", batch);
    if (!result.ok) {
      throw new Error(
        `${spec.name}: batch ${index} does not match telemetry-samples ` +
          `(${result.errors[0]?.text ?? "unknown"})`,
      );
    }
  }

  const digests = spec.windows.map((window) => sliceDigest(window.slice));
  const first = rows[0] as DecodedRow;
  const last = rows[rows.length - 1] as DecodedRow;

  return {
    // One source, one digest; the synthetic fixture hashes the digests of the
    // two slices it joins, so its provenance is still one comparable value.
    source_sha256: digests.length === 1 ? (digests[0] as string) : sha256(digests.join("\n")),
    slice: synthetic
      ? `synthetic:${spec.windows.map((window) => window.slice).join("+")}`
      : (spec.windows[0] as SliceWindow).slice,
    generated_by: GENERATED_BY,
    signals_provisional: SIGNALS_PROVISIONAL,
    window: { from_sim_ts: toIso(first.simTsMs), to_sim_ts: toIso(last.simTsMs) },
    samples: rows.length,
    batches,
  };
}

/**
 * The synthetic fixture: two windows in one stream, with the flag set on the
 * first sample of the second.
 *
 * The batches are numbered as one run, so `seq` never restarts — a restart is
 * what the gateway does, and this fixture is about a jump, not a restart.
 */
function joinAcrossJump(parts: readonly DecodedRow[][]): TelemetrySamples[] {
  const batches: TelemetrySamples[] = [];
  let seq = 1;
  for (const [index, rows] of parts.entries()) {
    const part = toBatches(rows, {
      unitId: UNIT_ID,
      wallStartMs: WALL_START,
      firstSeq: seq,
      discontinuityOnFirst: index > 0,
    });
    seq += rows.length;
    batches.push(...part);
  }
  // `wall_ts` restarts with each part above; renumber it over the whole run.
  return batches.map((batch, index) => ({
    ...batch,
    wall_ts: toIso(WALL_START + index * 250),
    poll: { poll_seq: index, read_ms: 4 },
  }));
}

async function main(): Promise<void> {
  mkdirSync(BACKEND_FIXTURE_DIR, { recursive: true });
  for (const spec of SPECS) {
    const fixture = await buildFixture(spec);
    const path = join(BACKEND_FIXTURE_DIR, `${spec.name}.json`);
    writeFileSync(path, `${JSON.stringify(fixture)}\n`, "utf8");
    process.stdout.write(
      `fixtures: ${spec.name}: ${fixture.samples} samples in ${fixture.batches.length} batches ` +
        `-> ${basename(BACKEND_FIXTURE_DIR)}/${spec.name}.json (${spec.purpose})\n`,
    );
  }
}

await main();
