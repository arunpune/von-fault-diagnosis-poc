// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Every id this package names has to exist somewhere else: a cause in the manual's fixed registry
// and a tag in the generated register map. The registry is repeated here so the test fails even
// before the manual's files exist; once `manual/spec/faults.yaml` is on disk, the same ids are
// checked against it.

import { SIGNALS } from "@fdp/contracts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { loadFailureTable, loadInjections } from "../src/index.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const FAULTS_FILE = join(REPO_ROOT, "manual", "spec", "faults.yaml");

/** The thirty-nine causes of the fixed registry. */
const REGISTRY: readonly string[] = [
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
];

const table = loadFailureTable();
const injections = loadInjections();

/** Every cause this package references, from both data files. */
function referencedFaultIds(): string[] {
  const ids = new Set<string>();
  for (const failure of table.failures) {
    ids.add(failure.fault_id);
    for (const accepted of failure.accepted_fault_ids) ids.add(accepted);
  }
  for (const episode of table.unlabelled_episodes) ids.add(episode.fault_id_hint);
  for (const injection of injections?.injections ?? []) ids.add(injection.fault_id);
  return [...ids].sort();
}

/** Every `fault_id` declared under a `causes` key of the manual's catalog, at any depth. */
function faultIdsOf(document: unknown): Set<string> {
  const ids = new Set<string>();
  const walk = (node: unknown, underCauses: boolean): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, underCauses);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (underCauses && typeof record.fault_id === "string") ids.add(record.fault_id);
    for (const [key, value] of Object.entries(record)) {
      walk(value, underCauses || key === "causes");
    }
  };
  walk(document, false);
  return ids;
}

describe("fault ids", () => {
  it("references only causes of the fixed registry", () => {
    const registry = new Set(REGISTRY);
    const unknown = referencedFaultIds().filter((id) => !registry.has(id));
    expect(unknown).toEqual([]);
  });

  it.runIf(existsSync(FAULTS_FILE))("references only causes the manual defines", () => {
    const declared = faultIdsOf(parse(readFileSync(FAULTS_FILE, "utf8")) as unknown);
    expect(declared.size).toBeGreaterThan(0);
    const missing = referencedFaultIds().filter((id) => !declared.has(id));
    expect(missing).toEqual([]);
  });

  it.runIf(existsSync(FAULTS_FILE))("keeps the registry copied here equal to the manual's", () => {
    const declared = faultIdsOf(parse(readFileSync(FAULTS_FILE, "utf8")) as unknown);
    expect([...declared].sort()).toEqual([...REGISTRY].sort());
  });
});

describe("injection catalog", () => {
  it.runIf(injections === null)("is absent until the simulator's catalog is written", () => {
    expect(injections).toBeNull();
  });

  it.runIf(injections !== null)("declares unique injection ids", () => {
    const ids = (injections?.injections ?? []).map((injection) => injection.injection_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.runIf(injections !== null)("names one magnitude parameter per definition", () => {
    for (const injection of injections?.injections ?? []) {
      const names = injection.params.map((param) => param.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain("magnitude");
    }
  });

  it.runIf(injections !== null && SIGNALS.length > 0)("overlays only signals of the map", () => {
    const tags = new Set(SIGNALS.map((signal) => signal.tag));
    const unknown = new Set<string>();
    for (const injection of injections?.injections ?? []) {
      for (const transform of injection.transforms) {
        if (!tags.has(transform.tag)) unknown.add(transform.tag);
      }
    }
    expect([...unknown]).toEqual([]);
  });

  it.runIf(injections !== null && SIGNALS.length === 0)(
    "cannot be checked against the register map yet",
    () => {
      // The contracts generator writes `SIGNALS`; until then it is empty and the tag check above is
      // skipped rather than silently passing on an empty set.
      expect(SIGNALS).toHaveLength(0);
    },
  );
});
