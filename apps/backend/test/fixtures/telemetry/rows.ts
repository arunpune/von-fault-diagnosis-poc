// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Turning cut MetroPT-3 rows into the batches the gateway publishes.
 *
 * The conversion is the gateway's, step for step: the tag id comes from the
 * register map by `metropt_column`, an analog column stays the SI number the
 * recording holds and a digital column becomes a boolean, the synthetic
 * ambient tag is added, `alarms` is empty (the controller model is the
 * simulator's job), `seq` counts from 1, and `flags.discontinuity` marks the
 * first sample after a step of more than 60 s. There is no `invert`: the tag
 * semantics of the manual already match the recorded polarity.
 *
 * Nothing here reads the 208 MB source. The rows arrive from the slices
 * `make fixtures` cut, and they are streamed: a slice is a day of samples and
 * a fixture of a whole day is several megabytes of JSON.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { SIGNALS, type TelemetrySamples } from "@fdp/contracts";

import { ambientC } from "./ambient.ts";

/** The tag the simulator adds to every row; the recording has no such column. */
export const AMBIENT_TAG = "ambient_temperature";

/** A step longer than this opens a new segment. */
export const GAP_THRESHOLD_MS = 60_000;

/** The schema's own cap on one batch (telemetry-samples.schema.json). */
export const SAMPLES_PER_BATCH = 25;

/** One decoded row, before it is cut into batches. */
export interface DecodedRow {
  readonly simTsMs: number;
  readonly values: Record<string, number | boolean>;
  readonly missing: boolean;
}

/** `metropt_column` → tag id and kind, from the register map. */
interface ColumnBinding {
  readonly column: string;
  readonly tag: string;
  readonly digital: boolean;
}

/** The columns the register map binds, in register order. */
export function columnBindings(): ColumnBinding[] {
  return SIGNALS.filter(
    (signal) => signal.metropt_column !== null && signal.metropt_column !== "",
  ).map((signal) => ({
    column: signal.metropt_column as string,
    tag: signal.tag,
    digital: signal.group === "digital",
  }));
}

/**
 * The dataset's timestamps are naive local-time strings that the authors
 * recorded in UTC (docs/dataset.md); `2020-02-01 00:00:00` is
 * therefore `2020-02-01T00:00:00.000Z`.
 */
export function parseSimTs(raw: string): number {
  const text = raw.trim();
  const ms = Date.parse(text.includes("T") ? text : `${text.replace(" ", "T")}Z`);
  if (Number.isNaN(ms))
    throw new Error(`a row carries a timestamp this reader cannot read: ${raw}`);
  return ms;
}

/** ISO-8601 UTC with milliseconds, the only instant format the contracts accept. */
export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Read one cut slice and yield its rows decoded, in file order.
 *
 * `from`/`to` are half-open in the data clock, like the slice definitions
 * themselves (`data/fixtures/README.md`).
 */
export async function* readSlice(
  path: string,
  window: { fromMs: number; toMs: number } | undefined = undefined,
): AsyncGenerator<DecodedRow> {
  const bindings = columnBindings();
  const reader = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let header: string[] | undefined;
  try {
    for await (const line of reader) {
      if (line.trim() === "") continue;
      const fields = line.split(",");
      if (header === undefined) {
        header = fields.map((name) => name.trim());
        continue;
      }
      const row = decodeRow(header, fields, bindings);
      if (window !== undefined && (row.simTsMs < window.fromMs || row.simTsMs >= window.toMs)) {
        continue;
      }
      yield row;
    }
  } finally {
    reader.close();
  }
  if (header === undefined) throw new Error(`${path} has no header line`);
}

function decodeRow(
  header: readonly string[],
  fields: readonly string[],
  bindings: readonly ColumnBinding[],
): DecodedRow {
  const at = (name: string): string | undefined => {
    const index = header.indexOf(name);
    return index < 0 ? undefined : fields[index];
  };

  const stamp = at("timestamp");
  if (stamp === undefined) throw new Error("a row has no timestamp column");
  const simTsMs = parseSimTs(stamp);

  const values: Record<string, number | boolean> = {};
  let missing = false;
  for (const binding of bindings) {
    const raw = at(binding.column);
    const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
    if (Number.isNaN(parsed)) {
      // The gateway keeps the previous value and raises the flag; a fixture has
      // no previous value to keep, so the tag is left out and the flag is set.
      missing = true;
      continue;
    }
    values[binding.tag] = binding.digital ? parsed !== 0 : parsed;
  }
  values[AMBIENT_TAG] = ambientC(simTsMs);

  return { simTsMs, values, missing };
}

/**
 * Cut decoded rows into `telemetry-samples` batches.
 *
 * `seq` starts at 1 and counts samples, not batches; `wall_ts` advances by a
 * fixed step from `wallStartMs`, so a generated fixture is byte-identical from
 * one run to the next.
 */
export function toBatches(
  rows: readonly DecodedRow[],
  options: {
    unitId: string;
    wallStartMs: number;
    wallStepMs?: number;
    firstSeq?: number;
    /** Forces the flag on the first sample, for the synthetic jump fixture. */
    discontinuityOnFirst?: boolean;
  },
): TelemetrySamples[] {
  const wallStepMs = options.wallStepMs ?? 250;
  const batches: TelemetrySamples[] = [];
  let seq = options.firstSeq ?? 1;
  let previousMs: number | undefined;
  let forceDiscontinuity = options.discontinuityOnFirst ?? false;

  for (let start = 0; start < rows.length; start += SAMPLES_PER_BATCH) {
    const slice = rows.slice(start, start + SAMPLES_PER_BATCH);
    const pollSeq = batches.length;
    const samples = slice.map((row) => {
      const stepped = previousMs !== undefined && row.simTsMs - previousMs > GAP_THRESHOLD_MS;
      const discontinuity = forceDiscontinuity || stepped;
      forceDiscontinuity = false;
      previousMs = row.simTsMs;
      return {
        seq: seq++,
        sim_ts: toIso(row.simTsMs),
        flags: { discontinuity, missing: row.missing },
        values: row.values,
        alarms: [],
      };
    });

    // The schema's `samples` is a non-empty list, and the type says so; taking
    // the head apart proves it here instead of asserting it away.
    const [first, ...rest] = samples;
    if (first === undefined) continue;

    batches.push({
      schema: "urn:fdp:schema:telemetry-samples:v1",
      unit_id: options.unitId,
      wall_ts: toIso(options.wallStartMs + pollSeq * wallStepMs),
      samples: [first, ...rest],
      poll: { poll_seq: pollSeq, read_ms: 4 },
    });
  }
  return batches;
}
