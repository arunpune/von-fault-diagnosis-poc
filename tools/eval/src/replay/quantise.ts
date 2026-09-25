// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Analog values, as a Modbus reader would decode them.
//
// A value never reaches the pipeline as the CSV wrote it. The simulator scales
// it by the signal's `scale`, rounds it into an `int16` register and clamps it
// there; the gateway divides it back. Everything between those two steps is
// lost, and a harness that skipped them would score the pipeline on numbers no
// deployment ever produces — and would make the Docker parity test
// fail on rounding rather than on behaviour.
//
// So the round trip is not re-implemented here: `encodeAnalog` and
// `decodeAnalog` of `@fdp/contracts` are the same two functions the rest of
// the system uses, and this module is only the place that says when they run.
// They run last, after the overlays and the ambient lane have written SI units
// into the row, which is exactly where the simulator encodes.

import { decodeAnalog, encodeAnalog } from "@fdp/contracts";

import type { ReplayLanes, ReplayRow } from "./types.ts";

/**
 * One analog value, through the register codec and back.
 *
 * A non-finite value — the ambient lane before a hook fills it — encodes as register 0 and
 * therefore decodes as 0. That keeps a batch JSON-serialisable and schema-valid; it does not
 * set the row's `missing` flag, which the `telemetry-samples` schema reserves for a source
 * column that could not be parsed.
 */
export function quantise(value: number, field: { readonly scale: number }): number {
  return decodeAnalog(encodeAnalog(value, field.scale).register, field.scale);
}

/**
 * Quantises every analog lane of `row` in place and returns it.
 *
 * `lanes` is `resolveLanes(map)`, resolved once per replay rather than per row: the scale of
 * each lane is the only thing quantisation needs from the register map, and re-deriving the
 * lane order 1.5 million times would cost more than the encoding itself.
 */
export function quantiseRow(row: ReplayRow, lanes: ReplayLanes): ReplayRow {
  const { analog } = row;
  for (let lane = 0; lane < analog.length; lane += 1) {
    const signal = lanes.analog[lane];
    if (signal === undefined) continue;
    analog[lane] = quantise(analog[lane] ?? 0, signal);
  }
  return row;
}
