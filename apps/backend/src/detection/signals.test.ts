// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Signal roles bind detection to the register map.
 *
 * The point of the indirection is that the manual may rename any tag without
 * touching a line of `detection/`, and that a register map missing one of the
 * recording's columns fails at startup with that column's name rather than
 * producing silent holes hours later.
 */

import { SIGNALS, type Sample, type Signal } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import {
  analogValue,
  digitalValue,
  resolveRoles,
  ROLE_COLUMNS,
  SIGNAL_ROLES,
  type SignalRole,
} from "./signals.ts";

/** A register map with one signal replaced, for the failure cases. */
function withSignal(tag: string, patch: Partial<Signal>): Signal[] {
  return SIGNALS.map((signal) => (signal.tag === tag ? { ...signal, ...patch } : signal));
}

/** A sample carrying exactly the values it is given. */
function sampleWith(values: Record<string, number | boolean>): Sample {
  return {
    seq: 1,
    sim_ts: "2020-02-03T00:00:03.000Z",
    flags: { discontinuity: false, missing: false },
    values,
    alarms: [],
  };
}

describe("resolveRoles", () => {
  const roles = resolveRoles(SIGNALS);

  it("binds every signal role", () => {
    expect(Object.keys(roles).sort()).toEqual([...SIGNAL_ROLES].sort());
    expect(SIGNAL_ROLES).toHaveLength(16);
  });

  it("names each role after the register map's tag, never after the column", () => {
    expect(roles.tp3.signal_id).toBe("line_pressure");
    expect(roles.dv_electric.signal_id).toBe("load_valve");
    expect(roles.oil_level.signal_id).toBe("oil_level_ok");
    expect(roles.tp3.unit).toBe("bar");
    expect(roles.oil_temperature.kind).toBe("temperature");
    expect(roles.tp3.label).toBe("Line pressure");
  });

  it("reads the dataset's own misspelling of the load solenoid column", () => {
    expect(ROLE_COLUMNS.dv_electric).toBe("DV_eletric");
  });

  it("takes the ambient temperature from the one synthetic signal", () => {
    expect(roles.ambient_temperature.signal_id).toBe("ambient_temperature");
    expect(roles.ambient_temperature.analog).toBe(true);
    expect(ROLE_COLUMNS).not.toHaveProperty("ambient_temperature");
  });

  it("never re-inverts a digital: the register map already applied the polarity", () => {
    for (const role of SIGNAL_ROLES) expect(roles[role].invert, role).toBe(false);
  });

  it("agrees with the register map about which roles are numbers", () => {
    const analog: SignalRole[] = SIGNAL_ROLES.filter((role) => roles[role].analog);
    expect(analog).toEqual([
      "tp2",
      "tp3",
      "h1",
      "dv_pressure",
      "reservoirs",
      "oil_temperature",
      "motor_current",
      "ambient_temperature",
    ]);
  });

  it("throws naming the missing column and the role that wanted it", () => {
    const withoutLinePressure = SIGNALS.filter((signal) => signal.tag !== "line_pressure");
    expect(() => resolveRoles(withoutLinePressure)).toThrow(/"TP3"/);
    expect(() => resolveRoles(withoutLinePressure)).toThrow(/role tp3/);
  });

  it("throws when a column is declared but empty", () => {
    expect(() => resolveRoles(withSignal("motor_current", { metropt_column: "" }))).toThrow(
      /"Motor_current"/,
    );
  });

  it("throws when the register map disagrees about analog or digital", () => {
    expect(() => resolveRoles(withSignal("line_pressure", { group: "digital" }))).toThrow(
      /line_pressure \(role tp3\) digital/,
    );
    expect(() => resolveRoles(withSignal("low_pressure_switch", { group: "analog" }))).toThrow(
      /low_pressure_switch \(role lps\) analog/,
    );
  });

  it("throws unless exactly one synthetic signal carries the ambient temperature", () => {
    const none = SIGNALS.filter((signal) => signal.group !== "extra");
    expect(() => resolveRoles(none)).toThrow(/exactly one synthetic "extra" signal/);

    const ambient = SIGNALS.find((signal) => signal.group === "extra") as Signal;
    const two = [...SIGNALS, { ...ambient, tag: "ambient_temperature_2" }];
    expect(() => resolveRoles(two)).toThrow(/found 2/);
  });
});

describe("reading one sample", () => {
  const roles = resolveRoles(SIGNALS);

  it("returns the number of an analog role and nothing for a hole", () => {
    expect(analogValue(sampleWith({ line_pressure: 9.1 }), roles.tp3)).toBe(9.1);
    expect(analogValue(sampleWith({}), roles.tp3)).toBeUndefined();
    expect(analogValue(sampleWith({ line_pressure: true }), roles.tp3)).toBeUndefined();
    expect(analogValue(sampleWith({ line_pressure: Number.NaN }), roles.tp3)).toBeUndefined();
  });

  it("returns the boolean of a digital role as it was published", () => {
    expect(digitalValue(sampleWith({ oil_level_ok: false }), roles.oil_level)).toBe(false);
    expect(digitalValue(sampleWith({ oil_level_ok: true }), roles.oil_level)).toBe(true);
    expect(digitalValue(sampleWith({ oil_level_ok: 0 }), roles.oil_level)).toBeUndefined();
    expect(digitalValue(sampleWith({}), roles.oil_level)).toBeUndefined();
  });
});
