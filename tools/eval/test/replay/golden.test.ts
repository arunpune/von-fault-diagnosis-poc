// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The port against a recorded run of the real stack.
//
// `test/integration/parity.test.ts` is the authority on whether the TypeScript
// replay and the Go simulator agree, but it needs Docker, three image builds
// and a minute of wall clock. This file is the fast half of the same question:
// it replays the `parity-feb01` slice through `src/replay/` and compares it
// with what the real gateway published the last time
// `scripts/refresh-parity-golden.ts` ran, sample by sample.
//
// Neither the slice nor the recording is in this repository. The slice is cut
// by `make fixtures` from the downloaded dataset and the recording is written
// by the refresh script next to it, because both carry MetroPT-3 values and no
// MetroPT-3 row is committed. So this file skips, with the command that
// produces what it is missing — unless `FDP_REQUIRE_GOLDEN=1` says a recording
// was supposed to be there, which only a job that has just run the refresh
// script sets. `FDP_REQUIRE_DATASET` cannot play that role: a golden recording
// is a product of a Docker run, not of the dataset cache, and the jobs that set
// it have no Docker step.
//
// What is compared, and why the two tolerances:
//
//   * `seq`, `sim_ts` and the flags are identical, and `seq` runs from 1;
//   * every tag the injection does not touch is *exactly* equal, which is what
//     the shared int16 quantisation buys;
//   * `oil_temperature` is within one register step (0.01 °C) in the injected
//     run: both sides compute `v + 14·m` in float64 and round it, and a value
//     that lands on a rounding boundary may tip either way — it does, on one
//     sample of 727;
//   * `ambient_temperature` is within 0.35 °C, the hash noise the simulator
//     adds to its ambient model and this port deliberately does not.

import { describe, expect, it } from "vitest";

import { PARITY_SLICE, sliceIsCut, requireSlice } from "../../src/slices.ts";
import { AMBIENT_TOLERANCE_C } from "../../src/replay/ambient.ts";
import type { ParityGolden } from "../helpers/sim-stack.ts";
import {
  compareSamples,
  goldenPath,
  goldenRequired,
  readGolden,
  replayPort,
  seqIsContiguousFromOne,
} from "../helpers/sim-stack.ts";

/** One register step of an `oil_temperature` reading: the tag's scale is 100. */
const OIL_TEMPERATURE_LSB_C = 0.01;

/** The two recordings `scripts/refresh-parity-golden.ts` writes. */
const RECORDINGS = ["clean", "oil-cooler"] as const;

/** How to read a recording that is not there: a sentence, and whether it is fatal. */
function absence(name: string): string {
  return (
    `the golden recording ${goldenPath(name)} has not been made on this machine; ` +
    "run `node --conditions=@fdp/source tools/eval/scripts/refresh-parity-golden.ts` " +
    "with Docker available (set FDP_REQUIRE_GOLDEN=1 to make this a failure)"
  );
}

const sliceCut = sliceIsCut(PARITY_SLICE);
const goldens = new Map<string, ParityGolden | undefined>(
  RECORDINGS.map((name) => [name, sliceCut ? readGolden(name) : undefined]),
);

describe("the golden parity recordings", () => {
  it("are present, or their absence is allowed", () => {
    const missing = RECORDINGS.filter((name) => goldens.get(name) === undefined);
    expect(
      missing.length === 0 || !goldenRequired(),
      missing.map((name) => absence(name)).join("\n"),
    ).toBe(true);
    if (missing.length > 0) {
      console.info(
        `golden: skipped, ${missing.length} recording(s) absent. ${absence(missing[0] ?? "")}`,
      );
    }
  });

  it.skipIf(goldens.get("clean") === undefined)("record what they were made from", () => {
    for (const name of RECORDINGS) {
      const golden = goldens.get(name);
      if (golden === undefined) continue;
      expect(golden.recorded.slice, `${name} replayed another slice`).toBe(PARITY_SLICE);
      expect(golden.recorded.sim_image_digest, `${name} has no sim image id`).not.toBe("");
      expect(golden.recorded.injections_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(golden.samples.length).toBeGreaterThan(0);
    }
  });

  it.skipIf(goldens.get("clean") === undefined)(
    "agree with the port on a replay without an injection, tag for tag",
    async () => {
      const golden = goldens.get("clean");
      if (golden === undefined) return;

      const samples = await replayPort({ csvPath: requireSlice(PARITY_SLICE) });
      expect(seqIsContiguousFromOne(samples)).toBeUndefined();
      const problems = compareSamples(golden.samples, samples, {
        within: { ambient_temperature: AMBIENT_TOLERANCE_C },
      });
      expect(problems, problems.join("\n")).toEqual([]);
    },
    120_000,
  );

  it.skipIf(goldens.get("oil-cooler") === undefined)(
    "agree with the port on a replay with oil_cooler_fouling, to one register step",
    async () => {
      const golden = goldens.get("oil-cooler");
      if (golden === undefined || golden.injection === null) return;

      const samples = await replayPort({
        csvPath: requireSlice(PARITY_SLICE),
        injection: {
          injection_id: golden.injection.injection_id,
          atSimTsMs: Date.parse(golden.injection.started_sim_ts),
          params: golden.injection.params,
        },
      });

      expect(seqIsContiguousFromOne(samples)).toBeUndefined();
      const problems = compareSamples(golden.samples, samples, {
        within: {
          ambient_temperature: AMBIENT_TOLERANCE_C,
          oil_temperature: OIL_TEMPERATURE_LSB_C,
        },
      });
      expect(problems, problems.join("\n")).toEqual([]);

      // The injection really did something: the oil temperature of the
      // recorded run is above the clean one for most of its hour.
      const clean = goldens.get("clean");
      if (clean === undefined) return;
      const raised = golden.samples.filter((sample, index) => {
        const before = clean.samples[index]?.values["oil_temperature"];
        const after = sample.values["oil_temperature"];
        return typeof before === "number" && typeof after === "number" && after - before > 1;
      });
      expect(raised.length).toBeGreaterThan(100);
    },
    120_000,
  );
});
