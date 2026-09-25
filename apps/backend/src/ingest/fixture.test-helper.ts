// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Decoded samples and batches the ingest unit tests build by hand.
 *
 * Nothing here is derived from the recording: the numbers are round and
 * chosen to make one behaviour visible at a time, which is what a unit test of
 * a ring buffer or a bucketing rule needs. The scenarios that have to look
 * like the machine live in `test/fixtures/synthetic/`.
 *
 * The file is named `*.test-helper.ts` rather than `*.test.ts` so Vitest does
 * not collect it as a suite of its own.
 */

import { SIGNALS, toIsoMs, type Signal, type TelemetrySamples } from "@fdp/contracts";

import { alarmBitsOf } from "./ring.ts";
import { signalKind, type DecodedSample } from "./types.ts";

/** A small registry: two measurements and one state, enough for every rule. */
export const TEST_SIGNALS: readonly Signal[] = [
  signalOf("line_pressure"),
  signalOf("dryer_purge_pressure"),
  signalOf("load_valve"),
];

/** Where every hand-built sample starts in data time. */
export const START_MS = Date.parse("2020-02-03T00:00:00.000Z");

/** Ten seconds, the sampling period of the recording. */
export const STEP_MS = 10_000;

export interface SampleOverrides {
  readonly seq?: number;
  readonly simTsMs?: number;
  readonly discontinuity?: boolean;
  readonly missing?: boolean;
  readonly values?: Readonly<Record<string, number>>;
  readonly alarms?: readonly string[];
}

/** One decoded sample; `index` places it on the ten-second grid. */
export function decodedSample(index: number, overrides: SampleOverrides = {}): DecodedSample {
  const simTsMs = overrides.simTsMs ?? START_MS + index * STEP_MS;
  const alarms = overrides.alarms ?? [];
  return {
    seq: overrides.seq ?? index + 1,
    simTsMs,
    simTs: toIsoMs(new Date(simTsMs)),
    discontinuity: overrides.discontinuity ?? false,
    missing: overrides.missing ?? false,
    values: { line_pressure: 9, dryer_purge_pressure: 0, load_valve: 0, ...overrides.values },
    alarms,
    alarmBits: alarmBitsOf(alarms),
  };
}

/** A run of decoded samples, `count` long, starting at `index`. */
export function decodedRun(
  count: number,
  valuesAt: (index: number) => Readonly<Record<string, number>> = () => ({}),
  from = 0,
): DecodedSample[] {
  return Array.from({ length: count }, (_unused, offset) =>
    decodedSample(from + offset, { values: valuesAt(from + offset) }),
  );
}

/** The batch a gateway would have published for these decoded samples. */
export function batchOf(
  samples: readonly DecodedSample[],
  options: { unitId?: string; wallTs?: string } = {},
): TelemetrySamples {
  const [first, ...rest] = samples.map((sample) => ({
    seq: sample.seq,
    sim_ts: sample.simTs,
    flags: { discontinuity: sample.discontinuity, missing: sample.missing },
    values: contractValues(sample),
    alarms: [...sample.alarms],
  }));
  if (first === undefined) throw new Error("a telemetry batch carries at least one sample");
  return {
    schema: "urn:fdp:schema:telemetry-samples:v1",
    unit_id: options.unitId ?? "cau-7",
    wall_ts: options.wallTs ?? "2026-09-21T08:00:00.000Z",
    samples: [first, ...rest],
  };
}

/** The same samples, cut into batches of at most twenty-five as the schema requires. */
export function batchesOf(
  samples: readonly DecodedSample[],
  options: { unitId?: string } = {},
): TelemetrySamples[] {
  const batches: TelemetrySamples[] = [];
  for (let start = 0; start < samples.length; start += 25) {
    batches.push(batchOf(samples.slice(start, start + 25), options));
  }
  return batches;
}

/** Digital tags travel as booleans on the wire; analog ones as numbers. */
function contractValues(sample: DecodedSample): Record<string, number | boolean> {
  const values: Record<string, number | boolean> = {};
  for (const [tag, value] of Object.entries(sample.values)) {
    values[tag] = isDigital(tag) ? value !== 0 : value;
  }
  return values;
}

function isDigital(tag: string): boolean {
  const signal = SIGNALS.find((entry) => entry.tag === tag);
  return signal !== undefined && signalKind(signal) === "digital";
}

/** One signal of the contracts registry, by tag; the tests only name real ones. */
function signalOf(tag: string): Signal {
  const signal = SIGNALS.find((entry) => entry.tag === tag);
  if (signal === undefined) throw new Error(`the register map declares no signal ${tag}`);
  return signal;
}
