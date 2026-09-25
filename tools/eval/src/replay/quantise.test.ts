// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The register round trip, on the scales the register map actually uses.
//
// The point of these cases is not that `encodeAnalog` works — `@fdp/contracts`
// owns that — but that the harness puts every analog value through it and
// reproduces it exactly, which is what makes the Docker parity test compare
// behaviour rather than floating-point noise. So the expectations are written
// as the register a Modbus reader would hold and the value it would decode
// back, for each scale in the map, and the ambient lane's `NaN` is pinned too:
// it becomes 0, not a value a JSON batch cannot carry.

import { REGISTER_MAP, decodeAnalog, encodeAnalog } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { resolveLanes } from "./csv.ts";
import { quantise, quantiseRow } from "./quantise.ts";
import type { RegisterMap, ReplayRow } from "./types.ts";

const MAP: RegisterMap = REGISTER_MAP;
const LANES = resolveLanes(MAP);

/** The int16 range an encoded register is clamped into. */
const INT16_MIN = -32_768;
const INT16_MAX = 32_767;

/** Every scale the register map gives an analog lane, each once. */
const SCALES = [...new Set(LANES.analog.map((signal) => signal.scale))].sort((a, b) => a - b);

function row(values: readonly number[]): ReplayRow {
  return {
    simTsMs: Date.UTC(2020, 1, 1, 0, 0, 0),
    analog: Float64Array.from(values),
    digital: new Uint8Array(LANES.digital.length),
    missing: false,
  };
}

describe("quantise", () => {
  it("round-trips a pressure through its milli-bar register", () => {
    const field = { scale: 1000 };

    expect(encodeAnalog(9.358, field.scale).register).toBe(9358);
    expect(quantise(9.358, field)).toBe(9.358);
    expect(encodeAnalog(-0.012, field.scale).register).toBe(-12);
    expect(quantise(-0.012, field)).toBe(-0.012);
  });

  it("round-trips a temperature and a current through their centi-unit registers", () => {
    const field = { scale: 100 };

    expect(encodeAnalog(53.6, field.scale).register).toBe(5360);
    expect(quantise(53.6, field)).toBe(53.6);
    expect(encodeAnalog(6.0, field.scale).register).toBe(600);
    expect(quantise(6.0, field)).toBe(6);
  });

  it("loses exactly what a register loses, and nothing else", () => {
    const field = { scale: 1000 };

    // Half a step down rounds away; the value a register can hold survives.
    expect(quantise(9.3584, field)).toBe(9.358);
    expect(quantise(9.3586, field)).toBe(9.359);
  });

  it("clamps a value the register cannot hold", () => {
    const field = { scale: 1000 };

    expect(encodeAnalog(1e6, field.scale).register).toBe(INT16_MAX);
    expect(quantise(1e6, field)).toBe(INT16_MAX / field.scale);
    expect(encodeAnalog(-1e6, field.scale).register).toBe(INT16_MIN);
    expect(quantise(-1e6, field)).toBe(INT16_MIN / field.scale);
  });

  it("turns a non-finite value into 0, which a batch can carry", () => {
    const field = { scale: 100 };

    expect(quantise(Number.NaN, field)).toBe(0);
    expect(quantise(Number.POSITIVE_INFINITY, field)).toBe(0);
  });

  it("is exactly decodeAnalog(encodeAnalog(v)) on every scale the map uses", () => {
    expect(SCALES.length).toBeGreaterThan(1);
    for (const scale of SCALES) {
      for (const value of [0, 0.001, -0.012, 1.5, 53.6, -19.25, 312.5]) {
        expect(quantise(value, { scale }), `${value} at x${scale}`).toBe(
          decodeAnalog(encodeAnalog(value, scale).register, scale),
        );
      }
    }
  });
});

describe("quantiseRow", () => {
  it("quantises every analog lane in place, through that lane's own scale", () => {
    const raw = LANES.analog.map((_, lane) => 9.3584 + lane / 1000);
    const quantised = quantiseRow(row(raw), LANES);

    LANES.analog.forEach((signal, lane) => {
      expect(quantised.analog[lane], signal.tag).toBe(quantise(raw[lane] ?? 0, signal));
    });
  });

  it("turns the untouched ambient lane into 0 without flagging the row", () => {
    expect(LANES.ambientIndex).not.toBeNull();
    if (LANES.ambientIndex === null) return;

    const values = LANES.analog.map(() => 1);
    values[LANES.ambientIndex] = Number.NaN;
    const quantised = quantiseRow(row(values), LANES);

    expect(quantised.analog[LANES.ambientIndex]).toBe(0);
    expect(quantised.missing).toBe(false);
  });

  it("leaves the digital lanes alone", () => {
    const original = row(LANES.analog.map(() => 1));
    original.digital[0] = 1;

    expect(quantiseRow(original, LANES).digital[0]).toBe(1);
  });
});
