// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What the pipeline under test receives: `telemetry-samples` batches and
// nothing else, so no ground truth reaches it.
//
// Three things are asserted here that no other suite can reach. The envelope
// is checked against the contracts schema rather than against a hand-written
// expectation, and with `EVAL_VALIDATE_ALL` set so every batch of every case
// goes through the validator, not only the first. The per-row order —
// classify, ambient, overlay, alarms, quantise — is recorded by hooks that
// write down what they saw, because that order is the whole of the parity with
// the simulator and a refactor that reshuffles it must fail here. And the
// discontinuity flags are compared against positions the test computes from
// the timestamps of the very rows it fed in, so the expectation cannot drift
// from the data.
//
// The rows are synthetic: these cases run on a machine that has never
// downloaded MetroPT-3, because no MetroPT-3 row is committed.

import { DEFAULT_UNIT_ID, REGISTER_MAP, assertValid } from "@fdp/contracts";
import type { Sample, TelemetrySamples } from "@fdp/contracts";
import { Readable } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";

import { isHeldoutSlice } from "../heldout.ts";
import {
  METROPT3_HEADER,
  METROPT3_LINE_TERMINATOR,
  PARITY_SLICE,
  SCENARIO_SLICES,
  datasetRequired,
  requireSlice,
  sliceDef,
  sliceIsCut,
  sliceNames,
} from "../slices.ts";
import { formatCsvTs } from "../time.ts";
import { AMBIENT_TOLERANCE_C, ambient } from "./ambient.ts";
import { readRows, resolveLanes } from "./csv.ts";
import { batches, createClassifier, createReplaySource, toSample } from "./index.ts";
import { quantise } from "./quantise.ts";
import type { MachineState, RegisterMap, ReplayHooks, ReplayRow } from "./types.ts";
import { GAP_THRESHOLD_MS, MAX_BATCH_SIZE, STATE_COLUMNS, VALIDATE_ALL_ENV } from "./types.ts";

const MAP: RegisterMap = REGISTER_MAP;
const LANES = resolveLanes(MAP);
const HEADER_COLUMNS = METROPT3_HEADER.split(",");
const SAMPLE_STEP_MS = 10_000;
const START_MS = Date.UTC(2020, 1, 1, 0, 0, 0);

/** A wall clock that does not move, so an envelope is reproducible. */
const WALL_MS = Date.UTC(2026, 8, 19, 12, 0, 0);
const wall = () => new Date(WALL_MS);

beforeAll(() => {
  // Every batch of every case, not only the first one of each source.
  process.env[VALIDATE_ALL_ENV] = "1";
  return () => {
    delete process.env[VALIDATE_ALL_ENV];
  };
});

/** How one synthetic row should read, in the dataset's own columns. */
interface RowSpec {
  readonly stepMs?: number;
  readonly loaded?: boolean;
  readonly motorCurrentA?: number;
  readonly oilTemperatureC?: number;
}

/** A synthetic CSV with the dataset's verbatim header and the rows `specs` describes. */
function syntheticCsv(specs: readonly RowSpec[]): string {
  const lines = [METROPT3_HEADER];
  let instant = START_MS;

  specs.forEach((spec, index) => {
    if (index > 0) instant += spec.stepMs ?? SAMPLE_STEP_MS;
    const loaded = spec.loaded ?? false;
    const fields: Record<string, string> = {
      "": String(index * 10),
      timestamp: formatCsvTs(instant),
      TP2: loaded ? "9.358" : "-0.012",
      TP3: "9.340",
      H1: loaded ? "-0.014" : "9.340",
      DV_pressure: "-0.018",
      Reservoirs: "9.340",
      Oil_temperature: String(spec.oilTemperatureC ?? 53.6),
      Motor_current: String(spec.motorCurrentA ?? (loaded ? 6 : 0.04)),
      [STATE_COLUMNS.intake]: loaded ? "0.0" : "1.0",
      [STATE_COLUMNS.loadValve]: loaded ? "1.0" : "0.0",
      Towers: "1.0",
      MPG: loaded ? "0.0" : "1.0",
      LPS: "0.0",
      Pressure_switch: "1.0",
      Oil_level: "1.0",
      Caudal_impulses: "1.0",
    };
    lines.push(HEADER_COLUMNS.map((name) => fields[name] ?? "").join(","));
  });
  return lines.join(METROPT3_LINE_TERMINATOR) + METROPT3_LINE_TERMINATOR;
}

/** `count` identical unloaded rows, one sample step apart. */
function plainRows(count: number): RowSpec[] {
  return Array.from({ length: count }, () => ({}));
}

/** Runs a replay over a synthetic CSV and keeps the batches and the counters. */
async function replay(
  specs: readonly RowSpec[],
  options: {
    batchSize?: number;
    unitId?: string;
    hooks?: ReplayHooks;
    gapThresholdMs?: number;
    alarms?: boolean;
    ambient?: boolean;
  } = {},
) {
  const source = createReplaySource({
    source: Readable.from(syntheticCsv(specs)),
    map: MAP,
    wall,
    // The CTRL-7 port is on by default; these cases are about the
    // envelope, the lanes and the flags, so they replay without a controller
    // and the two cases that are about it say so.
    alarms: false,
    ...options,
  });
  const collected: TelemetrySamples[] = [];
  for await (const batch of source) collected.push(batch);
  return { batches: collected, stats: source.stats, samples: collected.flatMap((b) => b.samples) };
}

/** The tag of the analog signal a dataset column feeds. */
function analogTag(column: string): string {
  return LANES.analog.find((signal) => signal.metropt_column === column)?.tag ?? "";
}

/** The tag of the synthetic ambient lane, which no dataset column feeds. */
const AMBIENT_TAG =
  LANES.ambientIndex === null ? "" : (LANES.analog[LANES.ambientIndex]?.tag ?? "");

/** How far each sample's ambient value sits from the model at its own instant. */
function ambientErrors(samples: readonly Sample[]): number[] {
  return samples.map((sample) => {
    const value = sample.values[AMBIENT_TAG];
    if (typeof value !== "number") return Infinity;
    return Math.abs(value - ambient(Date.parse(sample.sim_ts)));
  });
}

/** Every sample's ambient value, as published. */
function ambientValues(samples: readonly Sample[]): unknown[] {
  return samples.map((sample) => sample.values[AMBIENT_TAG]);
}

describe("createReplaySource", () => {
  it("publishes the gateway's own envelope", async () => {
    const { batches: collected } = await replay(plainRows(3));
    const [batch] = collected;

    expect(batch).toBeDefined();
    if (batch === undefined) return;
    expect(batch.schema).toBe("urn:fdp:schema:telemetry-samples:v1");
    expect(batch.unit_id).toBe(DEFAULT_UNIT_ID);
    expect(batch.wall_ts).toBe("2026-09-19T12:00:00.000Z");
    expect(batch.poll).toEqual({ poll_seq: 1, read_ms: 0 });
    expect(() => assertValid("telemetry-samples", batch)).not.toThrow();
  });

  it("numbers the samples from 1 and stamps the dataset clock", async () => {
    const { samples } = await replay(plainRows(4));

    expect(samples.map((sample) => sample.seq)).toEqual([1, 2, 3, 4]);
    expect(samples.map((sample) => sample.sim_ts)).toEqual([
      "2020-02-01T00:00:00.000Z",
      "2020-02-01T00:00:10.000Z",
      "2020-02-01T00:00:20.000Z",
      "2020-02-01T00:00:30.000Z",
    ]);
  });

  it("keys every value by a tag id of the register map, ambient included", async () => {
    const { samples } = await replay(plainRows(1));
    const [sample] = samples;

    expect(sample).toBeDefined();
    if (sample === undefined) return;
    expect(Object.keys(sample.values).sort()).toEqual(
      [...LANES.analog, ...LANES.digital].map((signal) => signal.tag).sort(),
    );
    for (const signal of LANES.analog) expect(typeof sample.values[signal.tag]).toBe("number");
    for (const signal of LANES.digital) expect(typeof sample.values[signal.tag]).toBe("boolean");
  });

  it("publishes quantised values, not the ones the CSV wrote", async () => {
    const { samples } = await replay([{ oilTemperatureC: 53.605 }]);
    const tag = analogTag("Oil_temperature");
    const signal = LANES.analog.find((entry) => entry.tag === tag);

    expect(signal).toBeDefined();
    if (signal === undefined) return;
    expect(samples[0]?.values[tag]).toBe(quantise(53.605, signal));
    expect(samples[0]?.values[tag]).not.toBe(53.605);
  });

  it("fills no ambient lane of its own, and leaves it schema-valid", async () => {
    const { samples } = await replay(plainRows(1));
    const ambient = LANES.ambientIndex === null ? undefined : LANES.analog[LANES.ambientIndex];

    expect(ambient).toBeDefined();
    if (ambient === undefined) return;
    expect(samples[0]?.values[ambient.tag]).toBe(0);
  });

  it("cuts the stream into batches of at most 25", async () => {
    const { batches: collected, stats } = await replay(plainRows(63));

    expect(collected.map((batch) => batch.samples.length)).toEqual([25, 25, 13]);
    expect(collected.map((batch) => batch.poll?.poll_seq)).toEqual([1, 2, 3]);
    expect(stats.batches).toBe(3);
    expect(stats.samples).toBe(63);
  });

  it("honours a smaller batch size and refuses one the schema would not carry", async () => {
    const { batches: collected } = await replay(plainRows(7), { batchSize: 3 });

    expect(collected.map((batch) => batch.samples.length)).toEqual([3, 3, 1]);
    await expect(replay(plainRows(1), { batchSize: MAX_BATCH_SIZE + 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(replay(plainRows(1), { batchSize: 0 })).rejects.toThrow(RangeError);
  });

  it("publishes for the unit it is given", async () => {
    const { batches: collected } = await replay(plainRows(1), { unitId: "cau-9" });
    expect(collected[0]?.unit_id).toBe("cau-9");
  });

  it("counts what it replayed", async () => {
    const { stats } = await replay(plainRows(5));

    expect(stats.rows).toBe(5);
    expect(stats.samples).toBe(5);
    expect(stats.firstSimTs).toBe("2020-02-01T00:00:00.000Z");
    expect(stats.lastSimTs).toBe("2020-02-01T00:00:40.000Z");
  });

  it("refuses a second iteration rather than counting the same rows twice", async () => {
    const source = createReplaySource({
      source: Readable.from(syntheticCsv(plainRows(2))),
      map: MAP,
      wall,
    });
    for await (const _batch of source) void _batch;

    expect(() => source[Symbol.asyncIterator]()).toThrow(/iterated once/);
  });
});

describe("discontinuity flags", () => {
  it("flags the first sample and every step wider than the threshold", async () => {
    const specs: RowSpec[] = [
      {},
      {},
      { stepMs: GAP_THRESHOLD_MS + 10_000 },
      {},
      { stepMs: 6 * 3600_000 },
      {},
    ];
    const { samples, stats } = await replay(specs);

    // The expectation is computed from the very steps the CSV was written with.
    const expected = specs.map(
      (spec, index) => index === 0 || (spec.stepMs ?? SAMPLE_STEP_MS) > GAP_THRESHOLD_MS,
    );
    expect(samples.map((sample) => sample.flags.discontinuity)).toEqual(expected);
    expect(stats.discontinuities).toBe(expected.filter(Boolean).length);
  });

  it("does not flag a step of exactly the threshold", async () => {
    const { samples } = await replay([{}, { stepMs: GAP_THRESHOLD_MS }]);
    expect(samples.map((sample) => sample.flags.discontinuity)).toEqual([true, false]);
  });

  it("uses the threshold it is given", async () => {
    const { samples } = await replay([{}, { stepMs: 30_000 }], { gapThresholdMs: 20_000 });
    expect(samples.map((sample) => sample.flags.discontinuity)).toEqual([true, true]);
  });
});

describe("the default classifier", () => {
  it("applies the machine-state rule", async () => {
    const seen: MachineState[] = [];
    const specs: RowSpec[] = [
      { loaded: true },
      { motorCurrentA: 3.77 },
      { motorCurrentA: 0.04 },
      { motorCurrentA: 1 },
      { motorCurrentA: 0.999 },
    ];
    await replay(specs, {
      hooks: {
        classify: (row) => {
          const state = createClassifier(LANES)(row);
          seen.push(state);
          return state;
        },
      },
    });

    expect(seen).toEqual(["loaded", "unloaded", "off", "unloaded", "off"]);
  });

  it("refuses a map that replays none of the three columns it needs", () => {
    const stripped = resolveLanes({
      signals: MAP.signals.filter((signal) => signal.group !== "digital"),
    });
    expect(() => createClassifier(stripped)).toThrow(/machine-state rule cannot be applied/);
  });
});

describe("hooks", () => {
  it("runs classify, ambient, overlay and alarms in the simulator's order", async () => {
    const order: string[] = [];
    const tag = analogTag("Oil_temperature");
    const lane = LANES.analog.findIndex((signal) => signal.tag === tag);
    const ambientLane = LANES.ambientIndex ?? 0;
    const ambientTag = LANES.analog[ambientLane]?.tag ?? "";

    const hooks: ReplayHooks = {
      classify: (row: ReplayRow) => {
        // The untouched row: the overlay below has not run for this row yet.
        order.push(`classify:${row.analog[lane]}`);
        return "loaded";
      },
      overlay: (row, state) => {
        order.push(`overlay:${state}`);
        row.analog[lane] = 61.005;
      },
      ambient: (simTsMs) => {
        order.push(`ambient:${simTsMs}`);
        return 12.345;
      },
      alarms: (row, state, _simTsMs, discontinuity) => {
        // Quantisation has *not* run yet: the controller reads the overlaid
        // value, as `emit` does before `EncodeSlot`.
        order.push(`alarms:${row.analog[lane]}:${state}:${discontinuity}`);
        return ["W102"];
      },
    };
    const { samples } = await replay([{ oilTemperatureC: 53.6 }], { hooks });

    // The ambient lane is filled before the overlays, because the
    // `high_ambient_temperature` injection adds to the synthetic value rather
    // than being overwritten by it.
    expect(order).toEqual([
      "classify:53.6",
      `ambient:${START_MS}`,
      "overlay:loaded",
      "alarms:61.005:loaded:true",
    ]);
    expect(samples[0]?.values[tag]).toBe(61.01);
    expect(samples[0]?.values[ambientTag]).toBe(12.35);
    expect(samples[0]?.alarms).toEqual(["W102"]);
  });

  it("leaves the alarm list empty when the CTRL-7 port is switched off", async () => {
    const { samples } = await replay(plainRows(2), { alarms: false });
    expect(samples.map((sample) => sample.alarms)).toEqual([[], []]);
  });

  it("stamps the codes of the manual's registry when nothing is asked for", async () => {
    // Two rows of a normal February morning raise nothing, which is the point:
    // the port is on by default and quiet by default.
    const { samples } = await replay(plainRows(2), { alarms: undefined });
    expect(samples.map((sample) => sample.alarms)).toEqual([[], []]);
  });
});

describe("the synthetic ambient lane", () => {
  // A recording schedules no injection, so these are the replays the ambient default leaves at
  // 0 °C and the evaluation host asks to fill. One row an hour for a day walks the diurnal term
  // through its whole swing, so a lane that ignored the instant would miss the model.
  const aDayHourly: RowSpec[] = Array.from({ length: 24 }, (_row, hour) =>
    hour === 0 ? {} : { stepMs: 3_600_000 },
  );

  it("carries ambient(t) on every sample of a replay without injections when asked", async () => {
    const { samples } = await replay(aDayHourly, { ambient: true });

    expect(samples).toHaveLength(aDayHourly.length);
    expect(Math.max(...ambientErrors(samples))).toBeLessThanOrEqual(AMBIENT_TOLERANCE_C);
    expect(new Set(ambientValues(samples)).size).toBeGreaterThan(1);
  });

  it("leaves it at 0 °C without the option or with it off, as before", async () => {
    const unasked = await replay(aDayHourly);
    const off = await replay(aDayHourly, { ambient: false });

    expect(ambientValues(unasked.samples)).toEqual(aDayHourly.map(() => 0));
    expect(ambientValues(off.samples)).toEqual(aDayHourly.map(() => 0));
  });

  it("gives an explicit hooks.ambient precedence over the option", async () => {
    const { samples } = await replay(plainRows(2), {
      ambient: true,
      hooks: { ambient: () => 12.345 },
    });
    expect(ambientValues(samples)).toEqual([12.35, 12.35]);
  });

  const SUMMER_SLICE = "summer-jul05";
  it.skipIf(!sliceIsCut(SUMMER_SLICE) && !datasetRequired())(
    `fills it on every sample of the ${SUMMER_SLICE} recording, which otherwise reads 0 °C`,
    async () => {
      const path = requireSlice(SUMMER_SLICE);
      const collect = async (options: { readonly ambient?: boolean }): Promise<Sample[]> => {
        const source = createReplaySource({
          source: path,
          map: MAP,
          wall,
          alarms: false,
          ...options,
        });
        const samples: Sample[] = [];
        for await (const batch of source) samples.push(...batch.samples);
        // A recording: no injection engine, so nothing but the option fills the lane.
        expect(source.injections).toBeUndefined();
        return samples;
      };

      const filled = await collect({ ambient: true });
      expect(filled).toHaveLength(sliceDef(SUMMER_SLICE).rows);
      expect(Math.max(...ambientErrors(filled))).toBeLessThanOrEqual(AMBIENT_TOLERANCE_C);

      const unasked = await collect({});
      expect(unasked).toHaveLength(filled.length);
      expect(ambientValues(unasked).every((value) => value === 0)).toBe(true);
    },
  );
});

describe("missing values", () => {
  it("flags the sample and keeps the previous value", async () => {
    const tag = analogTag("TP3");
    const lines = syntheticCsv(plainRows(3)).split(METROPT3_LINE_TERMINATOR);
    const column = HEADER_COLUMNS.indexOf("TP3");
    const broken = lines.map((line, index) => {
      if (index !== 2) return line;
      const fields = line.split(",");
      fields[column] = "NaN";
      return fields.join(",");
    });

    const source = createReplaySource({
      source: Readable.from(broken.join(METROPT3_LINE_TERMINATOR)),
      map: MAP,
      wall,
    });
    const samples: Sample[] = [];
    for await (const batch of source) samples.push(...batch.samples);

    expect(samples.map((sample) => sample.flags.missing)).toEqual([false, true, false]);
    expect(samples[1]?.values[tag]).toBe(samples[0]?.values[tag]);
  });
});

describe("a cut slice", () => {
  const cut = sliceIsCut(PARITY_SLICE);

  it.skipIf(!cut && !datasetRequired())(
    "replays whole, in schema-valid batches of 25 with the last one short",
    async () => {
      const definition = sliceDef(PARITY_SLICE);
      const path = requireSlice(PARITY_SLICE);
      const source = createReplaySource({ source: path, map: MAP, wall });

      const sizes: number[] = [];
      const samples: Sample[] = [];
      for await (const batch of source) {
        assertValid("telemetry-samples", batch);
        sizes.push(batch.samples.length);
        samples.push(...batch.samples);
      }

      expect(samples).toHaveLength(definition.rows);
      expect(sizes.slice(0, -1).every((size) => size === MAX_BATCH_SIZE)).toBe(true);
      expect(sizes.at(-1)).toBe(definition.rows % MAX_BATCH_SIZE || MAX_BATCH_SIZE);
      expect(samples.map((sample) => sample.seq)).toEqual(
        samples.map((_sample, index) => index + 1),
      );
      expect(source.stats.samples).toBe(definition.rows);
    },
  );

  it.skipIf(!cut && !datasetRequired())(
    "flags the discontinuities the slice's own timestamps imply",
    async () => {
      const path = requireSlice(PARITY_SLICE);

      // The expectation is read off the rows themselves, not copied from a table.
      const expected: boolean[] = [];
      let previous: number | undefined;
      for await (const row of readRows(path, MAP)) {
        expected.push(previous === undefined || row.simTsMs - previous > GAP_THRESHOLD_MS);
        previous = row.simTsMs;
      }

      const source = createReplaySource({ source: path, map: MAP, wall });
      const flags: boolean[] = [];
      for await (const batch of source) {
        for (const sample of batch.samples) flags.push(sample.flags.discontinuity);
      }

      expect(flags).toEqual(expected);
      expect(source.stats.discontinuities).toBe(expected.filter(Boolean).length);
    },
  );
});

describe("every defined slice", () => {
  // Every slice `make fixtures` cuts, not only the scenarios': the multi-segment
  // ones collapse a hole of weeks into a single step, so a loader that flagged a
  // discontinuity by row position rather than by the clock would pass on the
  // two-hour parity window and fail here. Reading the definitions rather than a
  // list of names also means a new slice is covered without a change
  // here. Each case reads the slice twice — once for the expectation, once for
  // the batches — so nothing is copied from a table that could drift.
  //
  // The held-out slices are the one exception: nothing replays them before the held-out set's
  // one final run (tools/eval/records/heldout-seal.md). Their bytes, rows and timestamps are
  // checked without a replay by `make fixtures --verify` and scripts/data/slices.test.ts.
  expect(sliceNames()).toEqual(expect.arrayContaining([...SCENARIO_SLICES, PARITY_SLICE]));
  const replayable = sliceNames().filter((name) => !isHeldoutSlice(name));

  it("leaves every held-out slice to the held-out set's one run", () => {
    expect(replayable.some(isHeldoutSlice)).toBe(false);
  });

  for (const name of replayable) {
    const cut = sliceIsCut(name);

    it.skipIf(!cut && !datasetRequired())(`${name}: batches, flags and counts`, async () => {
      const definition = sliceDef(name);
      const path = requireSlice(name);

      const expected: boolean[] = [];
      let previous: number | undefined;
      for await (const row of readRows(path, MAP)) {
        expected.push(previous === undefined || row.simTsMs - previous > GAP_THRESHOLD_MS);
        previous = row.simTsMs;
      }

      const source = createReplaySource({ source: path, map: MAP, wall });
      const flags: boolean[] = [];
      const sizes: number[] = [];
      for await (const batch of source) {
        assertValid("telemetry-samples", batch);
        sizes.push(batch.samples.length);
        for (const sample of batch.samples) flags.push(sample.flags.discontinuity);
      }

      expect(flags, name).toEqual(expected);
      expect(source.stats.samples, name).toBe(definition.rows);
      expect(source.stats.discontinuities, name).toBe(expected.filter(Boolean).length);
      // One flagged sample per segment boundary, plus the first sample itself.
      expect(source.stats.discontinuities, name).toBeGreaterThanOrEqual(definition.segments.length);
      expect(
        sizes.every((size) => size <= MAX_BATCH_SIZE),
        name,
      ).toBe(true);
      expect(
        sizes.slice(0, -1).every((size) => size === MAX_BATCH_SIZE),
        name,
      ).toBe(true);
    });
  }
});

describe("batches", () => {
  /** A sample stream that ends at once, for the empty-input case. */
  const noSamples = (): AsyncIterator<Sample> => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  });

  async function* twoSamples(): AsyncIterable<Sample> {
    for (const seq of [1, 2]) {
      yield toSample(
        {
          simTsMs: START_MS + seq * SAMPLE_STEP_MS,
          analog: new Float64Array(LANES.analog.length),
          digital: new Uint8Array(LANES.digital.length),
          missing: false,
        },
        seq,
        { discontinuity: seq === 1 },
        { lanes: LANES, alarms: [] },
      );
    }
  }

  it("wraps any sample stream, not only one the loader produced", async () => {
    const collected: TelemetrySamples[] = [];
    for await (const batch of batches(twoSamples(), { wall, batchSize: 1 })) collected.push(batch);

    expect(collected).toHaveLength(2);
    expect(collected.map((batch) => batch.poll?.poll_seq)).toEqual([1, 2]);
    for (const batch of collected)
      expect(() => assertValid("telemetry-samples", batch)).not.toThrow();
  });

  it("yields nothing for an empty stream", async () => {
    const empty: AsyncIterable<Sample> = { [Symbol.asyncIterator]: () => noSamples() };
    const collected: TelemetrySamples[] = [];
    for await (const batch of batches(empty, { wall })) collected.push(batch);

    expect(collected).toEqual([]);
  });
});
