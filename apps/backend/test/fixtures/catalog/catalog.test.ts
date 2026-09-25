// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The fixture catalog itself.
 *
 * The decision tests rest on this file, so it has to be provably the manual's
 * catalog in miniature rather than something invented beside it: every
 * `fault_id` and every `condition_id` comes from the manual's fixed registry
 * (`manual/spec/faults.yaml`), and every entry validates against
 * `catalog-entry.schema.json`. The retired draft ids (`air_leak_dryer_
 * purge`, `oil_cooler_fouling`, `F-NNN`, `C-NN`) must never reappear here,
 * because the evaluation harness joins its scenarios on these ids.
 */

import { describe, expect, it } from "vitest";

import { validate } from "@fdp/contracts";

import { catalogEntry, FIXTURE_CATALOG } from "./index.ts";

/** Every `fault_id` the manual's registry declares. */
const REGISTRY_FAULT_IDS: ReadonlySet<string> = new Set([
  "downstream_air_leak",
  "dryer_purge_leak",
  "purge_silencer_damaged",
  "tower_changeover_valve_fault",
  "dryer_controller_fault",
  "desiccant_exhausted",
  "purge_switch_fault",
  "high_air_demand",
  "high_ambient_temperature",
  "low_ambient_temperature",
  "intake_filter_clogged",
  "intake_valve_not_opening",
  "intake_valve_not_closing",
  "unloader_solenoid_fault",
  "regulator_contact_fault",
  "blowdown_valve_fault",
  "minimum_pressure_valve_fault",
  "separator_element_clogged",
  "separator_element_damaged",
  "scavenge_line_blocked",
  "oil_level_high",
  "oil_level_low",
  "wrong_oil_grade",
  "oil_filter_clogged",
  "oil_cooler_fouled",
  "cooling_fan_failure",
  "thermostatic_valve_stuck",
  "oil_temperature_sensor_fault",
  "airend_bearing_wear",
  "airend_element_wear",
  "supply_voltage_low_or_unbalanced",
  "motor_overload_relay_tripped",
  "emergency_stop_active",
  "line_pressure_transducer_fault",
  "reservoir_pressure_transducer_fault",
  "reservoir_isolation_valve_closed",
  "condensate_drain_stuck_open",
  "condensate_drain_blocked",
  "flow_sensor_fault",
]);

/** Every condition id and its title, from the same registry. */
const REGISTRY_CONDITIONS: Readonly<Record<string, string>> = {
  low_line_pressure: "Line pressure below setpoint",
  frequent_cycling: "Compressor starts and loads too often",
  continuous_load: "Compressor stays loaded and does not reach cut-out",
  purge_pressure_high: "Dryer purge pressure high, air escaping at the purge silencer",
  oil_temperature_high: "Oil temperature high",
  oil_temperature_low: "Oil temperature stays low, condensate in the oil",
  motor_current_high: "Motor current high",
  motor_current_low: "Motor current low under load, delivery low",
  discharge_pressure_high: "Discharge pressure high, safety valve blows",
  separator_pressure_abnormal: "Separator discharge pressure abnormal",
  water_in_air: "Condensate or moisture in the delivered air",
  oil_in_air: "Oil carry-over, high oil consumption",
  no_start: "Compressor does not start",
  no_unload: "Compressor does not unload at cut-out",
  reservoir_deviation: "Reservoir pressure differs from line pressure",
  dryer_changeover_fault: "Dryer towers do not change over",
  no_flow_signal: "Flow signal missing",
};

describe("the fixture catalog", () => {
  it("has enough causes to make a choice a choice", () => {
    expect(FIXTURE_CATALOG.length).toBeGreaterThanOrEqual(10);
  });

  it("validates entry by entry against catalog-entry", () => {
    for (const entry of FIXTURE_CATALOG) {
      const result = validate("catalog-entry", entry);
      expect(result.ok, `${entry.fault_id}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it("uses only fault ids from the manual's fixed registry", () => {
    for (const entry of FIXTURE_CATALOG) {
      expect(REGISTRY_FAULT_IDS.has(entry.fault_id), entry.fault_id).toBe(true);
    }
  });

  it("names every cause once", () => {
    const ids = FIXTURE_CATALOG.map((entry) => entry.fault_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only condition ids from the registry, with the registry's titles", () => {
    for (const entry of FIXTURE_CATALOG) {
      for (const condition of entry.conditions) {
        expect(condition.title, `${entry.fault_id} / ${condition.condition_id}`).toBe(
          REGISTRY_CONDITIONS[condition.condition_id],
        );
      }
    }
  });

  it("carries both benign causes the negative scenarios need", () => {
    const benign = FIXTURE_CATALOG.filter((entry) => entry.benign).map((entry) => entry.fault_id);
    expect(benign).toEqual(["high_air_demand", "high_ambient_temperature"]);
  });

  it("shares causes between conditions, as the catalog is meant to", () => {
    const shared = FIXTURE_CATALOG.filter((entry) => entry.conditions.length > 1);
    expect(shared.length).toBeGreaterThanOrEqual(5);
  });

  it("renders one sentence per expected movement", () => {
    for (const entry of FIXTURE_CATALOG) {
      expect(entry.signal_moves_text, entry.fault_id).toHaveLength(entry.signal_moves.length);
      for (const sentence of entry.signal_moves_text) {
        expect(sentence.length).toBeGreaterThan(0);
      }
    }
  });

  it("lists every alarm its conditions raise", () => {
    for (const entry of FIXTURE_CATALOG) {
      const fromConditions = new Set(
        entry.conditions.flatMap((condition) => condition.alarms ?? []),
      );
      expect(new Set(entry.related_alarms), entry.fault_id).toEqual(fromConditions);
    }
  });

  it("carries the two leak signatures and the tour's demo fault", () => {
    expect(catalogEntry("dryer_purge_leak").subsystem).toBe("dryer");
    expect(catalogEntry("downstream_air_leak").subsystem).toBe("distribution");
    expect(catalogEntry("oil_cooler_fouled").subsystem).toBe("cooling");
  });
});
