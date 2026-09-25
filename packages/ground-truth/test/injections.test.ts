// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The content of the downstream-leak definition, pinned so the limits of a replay stay visible
// (docs/simulation.md, "The nine injection types").
//
// A replay never changes the recorded cycle timing, so a network leak's later signatures — more
// frequent reloads, longer loaded runs, cut-out not reached, the low-pressure switch — cannot
// appear in one. The definition therefore expresses only what a replay can express consistently:
// the manual's earliest sign, a faster pressure decay while the unit is not loaded. It carries no
// oil offset, because the physical cause of one (the longer loaded runs) is exactly what a replay
// cannot produce, and without that cause it reads as a cooling fault.
//
// A ramp guarded by `not_loaded` starts when the unit stops compressing and keeps running through
// the whole idle period (`guard_entry`). Under `state_entry` it restarted when the motor stopped
// after its unloaded run-on, and the pressure stepped back up by about 2 bar with no compression.
// The same physics holds for every ramp under `not_loaded`, which are heavy demand's and the
// leak's.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { getInjection, loadInjections } from "../src/index.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const FAULTS_FILE = join(REPO_ROOT, "manual", "spec", "faults.yaml");

/** The three pressures a leak in the network drains between two loaded runs. */
const PRESSURES = ["line_pressure", "separator_discharge_pressure", "reservoir_pressure"] as const;

const catalogPresent = loadInjections() !== null;

/** The ramp rate a definition applies to `tag`, or undefined when it does not ramp it. */
function rampRate(injectionId: string, tag: string): number | undefined {
  const transform = getInjection(injectionId)?.transforms.find(
    (candidate) => candidate.tag === tag && candidate.op === "ramp",
  );
  return transform !== undefined && "rate_per_min" in transform
    ? transform.rate_per_min
    : undefined;
}

/** One signal move of a manual cause, as `manual/spec/faults.yaml` writes it. */
interface ManualMove {
  signal?: string;
  behaviour?: string;
  phase?: string;
  note?: string;
}

/** The signal moves the manual lists for one cause. */
function manualMoves(faultId: string): ManualMove[] {
  const document = parse(readFileSync(FAULTS_FILE, "utf8")) as {
    causes?: { fault_id: string; signal_moves?: ManualMove[] }[];
  };
  const cause = document.causes?.find((entry) => entry.fault_id === faultId);
  return cause?.signal_moves ?? [];
}

describe.runIf(catalogPresent)("air_leak_downstream", () => {
  const definition = getInjection("air_leak_downstream");

  it("stands for the manual's downstream leak, a defect", () => {
    expect(definition?.fault_id).toBe("downstream_air_leak");
    expect(definition?.benign).toBe(false);
  });

  it("keeps its three not-loaded pressure ramps, each anchored at the start of the idle period", () => {
    expect(definition?.transforms).toEqual(
      PRESSURES.map((tag) => ({
        tag,
        op: "ramp",
        when: "not_loaded",
        rate_per_min: -0.3,
        cap: 2.5,
        anchor: "guard_entry",
      })),
    );
  });

  it("carries no oil-temperature transform, and nothing that acts while loaded", () => {
    const transforms = definition?.transforms ?? [];
    expect(transforms.some((transform) => transform.tag === "oil_temperature")).toBe(false);
    expect(transforms.every((transform) => transform.when === "not_loaded")).toBe(true);
  });

  it("keeps its envelope, its duration and its magnitude bounds", () => {
    expect(definition?.envelope).toEqual({ ramp_in_min: 10, ramp_out_min: 10 });
    expect(definition?.default_duration_sim_min).toBe(240);
    expect(definition?.params).toEqual([{ name: "magnitude", default: 1, min: 0.25, max: 2 }]);
  });

  it("decays faster than heavy demand, which is what tells the two apart", () => {
    for (const tag of PRESSURES) {
      const leak = rampRate("air_leak_downstream", tag);
      const demand = rampRate("heavy_air_demand", tag);
      expect(leak).toBeDefined();
      expect(demand).toBeDefined();
      expect(leak ?? 0).toBeLessThan(demand ?? 0);
    }
  });

  it("says why the oil is left alone", () => {
    expect(definition?.description).toMatch(/not compressing/);
    expect(definition?.description).toMatch(/oil/);
    expect(definition?.description).not.toMatch(/warms the oil/);
  });

  it.runIf(existsSync(FAULTS_FILE))(
    "matches the manual: its first move is the idle decay, and it names no oil move",
    () => {
      const moves = manualMoves("downstream_air_leak");
      expect(moves[0]?.behaviour).toBe("unloaded_pressure_decay");
      expect(moves.some((move) => move.signal === "oil_temperature")).toBe(false);
    },
  );
});

describe.runIf(catalogPresent)("every ramp under not_loaded", () => {
  const ramps = (loadInjections()?.injections ?? []).flatMap((definition) =>
    definition.transforms
      .filter((transform) => transform.op === "ramp" && transform.when === "not_loaded")
      .map((transform) => ({ injection_id: definition.injection_id, transform })),
  );

  it("is heavy demand's or the leak's, on the three pressures", () => {
    expect(ramps.map(({ injection_id, transform }) => `${injection_id}:${transform.tag}`)).toEqual([
      ...PRESSURES.map((tag) => `heavy_air_demand:${tag}`),
      ...PRESSURES.map((tag) => `air_leak_downstream:${tag}`),
    ]);
  });

  it("runs through the whole idle period: anchored at the entry of its guard", () => {
    for (const { transform } of ramps) {
      expect("anchor" in transform ? transform.anchor : undefined).toBe("guard_entry");
    }
  });

  it("keeps the rate and the cap it had", () => {
    expect(
      ramps.map(({ injection_id, transform }) =>
        "rate_per_min" in transform
          ? [injection_id, transform.rate_per_min, transform.cap]
          : [injection_id],
      ),
    ).toEqual([
      ...PRESSURES.map(() => ["heavy_air_demand", -0.12, 1.2]),
      ...PRESSURES.map(() => ["air_leak_downstream", -0.3, 2.5]),
    ]);
  });
});

describe.runIf(catalogPresent)("heavy_air_demand", () => {
  // The same reasoning as for the leak: an oil offset would stand for the long loaded runs the
  // manual's `high_air_demand` blames the oil rise on, and a replay keeps the recording's cycle
  // timing, so it cannot produce them. The definition carries no oil offset.
  const definition = getInjection("heavy_air_demand");

  it("stands for the manual's high air demand, a benign cause", () => {
    expect(definition?.fault_id).toBe("high_air_demand");
    expect(definition?.benign).toBe(true);
  });

  it("carries no oil-temperature transform", () => {
    const transforms = definition?.transforms ?? [];
    expect(transforms.some((transform) => transform.tag === "oil_temperature")).toBe(false);
  });

  it("keeps its three not-loaded decays and its loaded current, and nothing else", () => {
    expect(definition?.transforms).toEqual([
      ...PRESSURES.map((tag) => ({
        tag,
        op: "ramp",
        when: "not_loaded",
        rate_per_min: -0.12,
        cap: 1.2,
        anchor: "guard_entry",
      })),
      { tag: "motor_current", op: "scale", when: "loaded", factor: 1.04 },
    ]);
  });

  it("keeps its envelope, its duration and its magnitude bounds", () => {
    expect(definition?.envelope).toEqual({ ramp_in_min: 20, ramp_out_min: 20 });
    expect(definition?.default_duration_sim_min).toBe(240);
    expect(definition?.params).toEqual([{ name: "magnitude", default: 1, min: 0.25, max: 2 }]);
  });

  it("says why the oil is left alone", () => {
    expect(definition?.description).toMatch(/oil/);
    expect(definition?.description).not.toMatch(/oil runs slightly warmer/);
    expect(definition?.description).toMatch(/not simulated/);
  });

  it.runIf(existsSync(FAULTS_FILE))(
    "matches the manual: its only oil move is a consequence of the long loaded runs",
    () => {
      const oil = manualMoves("high_air_demand").filter(
        (move) => move.signal === "oil_temperature",
      );
      expect(oil).toHaveLength(1);
      expect(oil[0]?.phase).toBe("loaded");
      expect(oil[0]?.note).toMatch(/long loaded runs/);
    },
  );
});
