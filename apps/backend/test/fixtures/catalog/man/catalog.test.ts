// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The manual-catalog fixture is the manual's catalog.
 *
 * Whether it still equals the reference catalog is the drift test's question
 * (`tools/eval/test/man-fixture-drift.test.ts`), because only the harness may
 * read that document. This file checks what the backend can see on its own:
 * the 39 causes are there once each, in the manual's registry ids, every one of them
 * validates, and the helpers the calibration reads list what the manual files.
 */

import { describe, expect, it } from "vitest";

import { validate } from "@fdp/contracts";

import { asCandidates, benignCauses, causesUnder, MAN_CATALOG, manEntry } from "./index.ts";

/** The condition ids of the manual's registry. */
const REGISTRY_CONDITION_IDS = [
  "low_line_pressure",
  "frequent_cycling",
  "continuous_load",
  "purge_pressure_high",
  "oil_temperature_high",
  "oil_temperature_low",
  "motor_current_high",
  "motor_current_low",
  "discharge_pressure_high",
  "separator_pressure_abnormal",
  "water_in_air",
  "oil_in_air",
  "no_start",
  "no_unload",
  "reservoir_deviation",
  "dryer_changeover_fault",
  "no_flow_signal",
];

describe("the manual-catalog fixture", () => {
  it("holds the manual's 39 causes, each once", () => {
    const ids = MAN_CATALOG.map((entry) => entry.fault_id);
    expect(ids).toHaveLength(39);
    expect(new Set(ids).size).toBe(39);
  });

  it("validates entry by entry against catalog-entry", () => {
    for (const entry of MAN_CATALOG) {
      const result = validate("catalog-entry", entry);
      expect(result.ok, `${entry.fault_id}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it("files every cause under at least one of the registry's conditions", () => {
    for (const entry of MAN_CATALOG) {
      expect(entry.conditions.length, entry.fault_id).toBeGreaterThan(0);
      for (const condition of entry.conditions) {
        expect(REGISTRY_CONDITION_IDS, entry.fault_id).toContain(condition.condition_id);
      }
    }
  });

  it("carries the three benign causes of the manual", () => {
    expect(benignCauses().map((entry) => entry.fault_id)).toEqual([
      "high_air_demand",
      "high_ambient_temperature",
      "low_ambient_temperature",
    ]);
  });

  it("carries the causes the shared fixture leaves out", () => {
    for (const faultId of [
      "cooling_fan_failure",
      "intake_valve_not_opening",
      "thermostatic_valve_stuck",
    ]) {
      expect(manEntry(faultId).fault_id).toBe(faultId);
    }
  });

  it("lists the causes the manual files under a condition", () => {
    expect(causesUnder("oil_temperature_high").map((entry) => entry.fault_id)).toEqual([
      "high_air_demand",
      "high_ambient_temperature",
      "oil_level_low",
      "wrong_oil_grade",
      "oil_filter_clogged",
      "oil_cooler_fouled",
      "cooling_fan_failure",
      "thermostatic_valve_stuck",
      "oil_temperature_sensor_fault",
    ]);
    expect(causesUnder("no_such_condition")).toEqual([]);
  });

  it("turns entries into candidates without touching the entry", () => {
    const [first] = asCandidates([manEntry("oil_cooler_fouled")]);
    expect(first).toMatchObject(manEntry("oil_cooler_fouled"));
    expect(first?.retrieval.rrf).toBeCloseTo(1 / 61, 10);
  });

  it("throws on a cause the manual does not have", () => {
    expect(() => manEntry("oil_cooler_fouling")).toThrow(/no cause oil_cooler_fouling/);
  });
});
