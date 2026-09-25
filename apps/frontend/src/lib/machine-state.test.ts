// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SignalDef } from "@/api/types";
import {
  deriveState,
  digitalLevel,
  isInvertedDigital,
  MACHINE_STATE,
  resolveStateColumns,
  type StateColumns,
  type StateInputs,
} from "@/lib/machine-state";
import { fixtures } from "@/test/msw/fixtures";

// The tag ids of signals.json: COMP is `intake_closed`, DV_eletric `load_valve`.
const COLUMNS: StateColumns = {
  comp: "intake_closed",
  dvElectric: "load_valve",
  motorCurrent: "motor_current",
};

function row(comp: StateInputs[string], dv: StateInputs[string], current: StateInputs[string]) {
  return { intake_closed: comp, load_valve: dv, motor_current: current };
}

// A normal cycle (cut-in, loaded run, cut-out, run-on, off) and the rows between two of its
// phases, when COMP and DV_eletric change one sample apart.
describe("deriveState", () => {
  it.each([
    ["loaded run: COMP 0, DV 1 at 6.0 A", row(false, true, 6.0), MACHINE_STATE.loaded],
    ["start peak under load at 8.3 A", row(false, true, 8.3), MACHINE_STATE.loaded],
    ["run-on after cut-out at 3.77 A", row(true, false, 3.77), MACHINE_STATE.unloaded],
    ["off at 0.038 A", row(true, false, 0.038), MACHINE_STATE.off],
    [
      "cut-in, COMP already 0 but DV still 0, at 6.0 A",
      row(false, false, 6.0),
      MACHINE_STATE.unloaded,
    ],
    ["cut-in from off, DV not yet 1, at 0.04 A", row(false, false, 0.04), MACHINE_STATE.off],
    [
      "cut-out, DV still 1 but COMP back to 1, at 5.9 A",
      row(true, true, 5.9),
      MACHINE_STATE.unloaded,
    ],
    ["exactly the running threshold, 1.0 A", row(true, false, 1.0), MACHINE_STATE.unloaded],
    ["just under the running threshold, 0.99 A", row(true, false, 0.99), MACHINE_STATE.off],
    [
      "digitals as 0/1 numbers, as the chart feed carries them",
      row(0, 1, 6.0),
      MACHINE_STATE.loaded,
    ],
    ["a duty cycle above one half counts as 1", row(0.2, 0.8, 6.0), MACHINE_STATE.loaded],
  ])("%s", (_name, values, expected) => {
    expect(deriveState(values, COLUMNS)).toBe(expected);
  });

  it.each([
    ["COMP missing", { load_valve: true, motor_current: 6.0 }],
    ["DV_eletric missing", { intake_closed: false, motor_current: 6.0 }],
    ["Motor_current missing", { intake_closed: false, load_valve: true }],
    ["Motor_current NaN (a missing sample)", row(false, true, Number.NaN)],
    ["Motor_current null (a break)", row(false, true, null)],
    ["Motor_current given as a boolean", row(false, true, true)],
    ["a digital given as NaN", row(Number.NaN, true, 6.0)],
  ])("is unknown with %s", (_name, values) => {
    expect(deriveState(values, COLUMNS)).toBe(MACHINE_STATE.unknown);
  });

  it("inverts a digital the registry marks inverted before evaluating", () => {
    const inverted: StateColumns = { ...COLUMNS, inverted: new Set(["intake_closed"]) };

    expect(deriveState(row(true, true, 6.0), inverted)).toBe(MACHINE_STATE.loaded);
    expect(deriveState(row(false, true, 6.0), inverted)).toBe(MACHINE_STATE.unloaded);
    expect(deriveState(row(0, 1, 0.03), inverted)).toBe(MACHINE_STATE.off);
  });
});

describe("digitalLevel", () => {
  it("reads booleans, 0/1 numbers and duty cycles, and nothing else", () => {
    expect([true, false, 1, 0, 0.5, 0.49].map(digitalLevel)).toEqual([1, 0, 1, 0, 1, 0]);
    expect([null, undefined, Number.NaN, Infinity].map(digitalLevel)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("resolveStateColumns", () => {
  it("finds the three inputs in the registry by recording column", () => {
    expect(resolveStateColumns(fixtures.signals.signals)).toEqual({
      ...COLUMNS,
      inverted: new Set(),
    });
  });

  it("is null when the registry lacks one of the inputs", () => {
    const signals = fixtures.signals.signals.filter(
      (signal) => signal.metropt_column !== "DV_eletric",
    );

    expect(resolveStateColumns(signals)).toBeNull();
  });

  it("collects the inputs whose registry entry says digital_polarity: inverted", () => {
    // The contract has no polarity field yet, so the registry entry carries it as an extra.
    const invert = (signal: SignalDef): SignalDef => {
      const polarised = { ...signal, digital_polarity: "inverted" };
      return polarised;
    };
    const signals = fixtures.signals.signals.map((signal) =>
      signal.metropt_column === "COMP" ? invert(signal) : signal,
    );

    expect(resolveStateColumns(signals)?.inverted).toEqual(new Set(["intake_closed"]));
    expect(signals.filter(isInvertedDigital).map((signal) => signal.signal_id)).toEqual([
      "intake_closed",
    ]);
  });
});
