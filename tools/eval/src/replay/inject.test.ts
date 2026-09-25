// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The injection port (docs/simulation.md).
//
// The Docker parity test is the authority on whether this port and the Go
// engine agree, but it needs Docker, two image builds and a cut slice. What
// runs on every push is this file, and it pins the arithmetic the parity test
// would otherwise be the only witness of: each primitive at three envelope
// magnitudes with values computed by hand from the primitives' definitions, the
// trapezoid at its corners, the run bookkeeping of `duty_shift` on a pulse
// train, the anchors of a `state_entry` and a `guard_entry` ramp, the seeded
// noise, the composition order of two instances and the loader's refusals.
//
// The last block is the one that keeps the port honest about the real
// catalog: it loads `packages/ground-truth/data/injections.json` through
// `@fdp/ground-truth`, builds the engine against the generated register map
// and asserts the documented signature of four of the nine definitions on
// a synthetic loaded/not-loaded stream. The waveform is invented here, so the
// block needs neither Docker nor the dataset.

import { REGISTER_MAP } from "@fdp/contracts";
import { loadInjections } from "@fdp/ground-truth";
import { describe, expect, it } from "vitest";

import {
  InjectionCatalogError,
  type InjectionError,
  applyNoise,
  applyOffset,
  applyRamp,
  applyScale,
  createEnvelope,
  createInjectionEngine,
  envelopeAt,
  guardHolds,
} from "./inject.ts";
import type { InjectionDef, InjectionTransform, InjectionValues } from "./inject.ts";
import type { MachineState, RegisterMap } from "./types.ts";

const MINUTE = 60_000;
const SECOND = 1_000;
const START = Date.UTC(2020, 1, 1, 0, 0, 0);

/**
 * A small register map: three analog tags, two digital ones and the synthetic extra.
 *
 * `resolveLanes` numbers the extras after the analog signals, so the ambient lane is analog
 * lane 3 — the same position the generated map puts it in, and the same position the
 * simulator's own tag index resolves.
 */
const TEST_MAP: RegisterMap = {
  signals: [
    { tag: "oil_temperature", metropt_column: "Oil_temperature", group: "analog", scale: 100 },
    { tag: "motor_current", metropt_column: "Motor_current", group: "analog", scale: 100 },
    { tag: "line_pressure", metropt_column: "TP3", group: "analog", scale: 1000 },
    { tag: "dryer_tower", metropt_column: "Towers", group: "digital", scale: 1 },
    { tag: "purge_switch", metropt_column: "Pressure_switch", group: "digital", scale: 1 },
    { tag: "ambient_temperature", metropt_column: null, group: "extra", scale: 100 },
  ],
};

const LANE = { oil: 0, current: 1, pressure: 2, ambient: 3 } as const;
const BIT = { tower: 0, purge: 1 } as const;

/** A definition with the fields a test does not care about already filled in. */
function definition(
  injectionId: string,
  transforms: readonly InjectionTransform[],
  overrides: Partial<InjectionDef> = {},
): InjectionDef {
  return {
    injection_id: injectionId,
    fault_id: `${injectionId}_cause`,
    label: injectionId,
    benign: false,
    description: "A definition written for this test.",
    default_duration_sim_min: 60,
    envelope: { ramp_in_min: 0, ramp_out_min: 0 },
    params: [{ name: "magnitude", default: 1, min: 0.25, max: 2 }],
    transforms: [...transforms] as InjectionDef["transforms"],
    ...overrides,
  } as InjectionDef;
}

/** One transform, written with the shape of the catalog and checked by the loader. */
function transform(fields: Record<string, unknown>): InjectionTransform {
  return fields as unknown as InjectionTransform;
}

function values(analog: readonly number[], digital: readonly boolean[] = []): InjectionValues {
  return {
    analog: Float64Array.from(analog),
    digital: Uint8Array.from(digital.map((bit) => (bit ? 1 : 0))),
  };
}

describe("the primitives, as pure functions", () => {
  const magnitudes = [0, 0.5, 1];

  it("offset adds value·m", () => {
    expect(magnitudes.map((m) => applyOffset(50, 14, m))).toEqual([50, 57, 64]);
  });

  it("scale multiplies by 1 + (factor − 1)·m", () => {
    expect(magnitudes.map((m) => applyScale(5, 1.2, m))).toEqual([5, 5.5, 6]);
    // A factor below one moves the other way by the same rule.
    magnitudes
      .map((m) => applyScale(5, 0.86, m))
      .forEach((value, index) => {
        expect(value).toBeCloseTo([5, 4.65, 4.3][index] ?? 0, 10);
      });
  });

  it("ramp adds rate·minutes·m, clamped to ±cap", () => {
    expect(magnitudes.map((m) => applyRamp(8, -0.3, 2.5, m, 4))).toEqual([8, 7.4, 6.8]);
    // Twenty minutes at 0.3 bar/min is 6 bar, which the 2.5 bar cap cuts.
    expect(applyRamp(8, -0.3, 2.5, 1, 20)).toBe(5.5);
    expect(applyRamp(8, 0.3, 2.5, 1, 20)).toBe(10.5);
  });

  it("noise adds draw·sigma·m, so the deviation scales with sigma", () => {
    expect(magnitudes.map((m) => applyNoise(5, 0.12, m, 2))).toEqual([5, 5.12, 5.24]);
  });
});

describe("the envelope", () => {
  const envelope = createEnvelope(START, START + 60 * MINUTE, {
    ramp_in_min: 10,
    ramp_out_min: 20,
  });

  it("is zero outside its own half-open window", () => {
    expect(envelopeAt(envelope, START - 1)).toBe(0);
    expect(envelopeAt(envelope, START + 60 * MINUTE)).toBe(0);
    expect(envelopeAt(envelope, START + 60 * MINUTE + 1)).toBe(0);
  });

  it("rises over the ramp in, holds at one and falls over the ramp out", () => {
    expect(envelopeAt(envelope, START)).toBe(0);
    expect(envelopeAt(envelope, START + 5 * MINUTE)).toBe(0.5);
    expect(envelopeAt(envelope, START + 10 * MINUTE)).toBe(1);
    // The ramp out begins 20 minutes before the end, at minute 40.
    expect(envelopeAt(envelope, START + 40 * MINUTE)).toBe(1);
    expect(envelopeAt(envelope, START + 50 * MINUTE)).toBe(0.5);
    expect(envelopeAt(envelope, START + 55 * MINUTE)).toBe(0.25);
  });

  it("is already at one on the first row when there is no ramp in", () => {
    const abrupt = createEnvelope(START, START + 10 * MINUTE, {
      ramp_in_min: 0,
      ramp_out_min: 0,
    });
    expect(envelopeAt(abrupt, START)).toBe(1);
    expect(envelopeAt(abrupt, START + 10 * MINUTE - 1)).toBe(1);
  });

  it("turns into a triangle rather than a negative hold when the instance is short", () => {
    // 180 in and 60 out inside a 60-minute instance: both scale by 60/240.
    const squeezed = createEnvelope(START, START + 60 * MINUTE, {
      ramp_in_min: 180,
      ramp_out_min: 60,
    });
    expect(envelopeAt(squeezed, START + 45 * MINUTE)).toBe(1);
    expect(envelopeAt(squeezed, START + 22.5 * MINUTE)).toBe(0.5);
    expect(envelopeAt(squeezed, START + 52.5 * MINUTE)).toBe(0.5);
  });
});

describe("the state guard", () => {
  const states: MachineState[] = ["loaded", "unloaded", "off"];

  it("admits the states a guard may name", () => {
    expect(states.map((state) => guardHolds("any", state))).toEqual([true, true, true]);
    expect(states.map((state) => guardHolds("loaded", state))).toEqual([true, false, false]);
    expect(states.map((state) => guardHolds("not_loaded", state))).toEqual([false, true, true]);
    expect(states.map((state) => guardHolds("unloaded", state))).toEqual([false, true, false]);
    expect(states.map((state) => guardHolds("off", state))).toEqual([false, false, true]);
  });
});

describe("an instance", () => {
  it("carries the definition's fault id, benign flag and resolved parameters", () => {
    const engine = createInjectionEngine(
      [
        definition(
          "warm_oil",
          [transform({ tag: "oil_temperature", op: "offset", when: "any", value: 14 })],
          { benign: true, fault_id: "high_ambient_temperature" },
        ),
      ],
      TEST_MAP,
    );
    const info = engine.start({ injection_id: "warm_oil", atSimTsMs: START });

    expect(info).toEqual({
      instance_id: "inj-000001",
      injection_id: "warm_oil",
      fault_id: "high_ambient_temperature",
      benign: true,
      started_sim_ts: START,
      ends_sim_ts: START + 60 * MINUTE,
      params: { magnitude: 1, duration_sim_min: 60 },
    });
    expect(engine.active()).toEqual([info]);
  });

  it("numbers instances from inj-000001", () => {
    const engine = createInjectionEngine(
      [
        definition("a", [
          transform({ tag: "oil_temperature", op: "offset", when: "any", value: 1 }),
        ]),
      ],
      TEST_MAP,
    );
    const ids = [0, 1, 2].map(
      () => engine.start({ injection_id: "a", atSimTsMs: START }).instance_id,
    );
    expect(ids).toEqual(["inj-000001", "inj-000002", "inj-000003"]);
  });

  it("applies each primitive under the envelope it runs with", () => {
    const engine = createInjectionEngine(
      [
        definition(
          "everything",
          [
            transform({ tag: "oil_temperature", op: "offset", when: "any", value: 14 }),
            transform({ tag: "motor_current", op: "scale", when: "loaded", factor: 1.2 }),
            transform({
              tag: "line_pressure",
              op: "ramp",
              when: "any",
              rate_per_min: -0.3,
              cap: 2.5,
              anchor: "injection_start",
            }),
          ],
          { default_duration_sim_min: 20, envelope: { ramp_in_min: 10, ramp_out_min: 10 } },
        ),
      ],
      TEST_MAP,
    );
    engine.start({ injection_id: "everything", atSimTsMs: START });

    // m = 0 on the first row, 0.5 five minutes in, 1 at the top of the ramp.
    const read = (minutes: number): number[] => {
      const row = values([50, 5, 8]);
      engine.apply(row, "loaded", START + minutes * MINUTE);
      return [...row.analog];
    };
    expect(read(0)).toEqual([50, 5, 8]);
    expect(read(5)).toEqual([57, 5.5, 8 - 0.3 * 5 * 0.5]);
    // Ten minutes at 0.3 bar/min would be 3 bar; the 2.5 bar cap holds it back.
    expect(read(10)).toEqual([64, 6, 8 - 2.5]);
  });

  it("skips a transform whose guard the row's state does not admit", () => {
    const engine = createInjectionEngine(
      [
        definition("loaded_only", [
          transform({ tag: "motor_current", op: "scale", when: "loaded", factor: 1.2 }),
        ]),
      ],
      TEST_MAP,
    );
    engine.start({ injection_id: "loaded_only", atSimTsMs: START });

    const loaded = values([50, 5, 8]);
    engine.apply(loaded, "loaded", START);
    expect(loaded.analog[LANE.current]).toBeCloseTo(6, 10);

    const unloaded = values([50, 5, 8]);
    engine.apply(unloaded, "unloaded", START);
    expect(unloaded.analog[LANE.current]).toBe(5);
  });

  it("freezes a tag with stuck and reads an implausible value with dropout", () => {
    const engine = createInjectionEngine(
      [
        definition("instrument", [
          transform({ tag: "oil_temperature", op: "dropout", when: "any", value: 0 }),
          transform({ tag: "purge_switch", op: "stuck", when: "any", value: true }),
          transform({ tag: "dryer_tower", op: "dropout", when: "any" }),
        ]),
      ],
      TEST_MAP,
    );
    engine.start({ injection_id: "instrument", atSimTsMs: START });

    const row = values([61.5, 5, 8], [true, false]);
    engine.apply(row, "loaded", START);
    expect(row.analog[LANE.oil]).toBe(0);
    expect([...row.digital]).toEqual([0, 1]);
  });

  it("stops overlaying on the row its duration ends at, and expires there", () => {
    const engine = createInjectionEngine(
      [
        definition(
          "short",
          [transform({ tag: "oil_temperature", op: "offset", when: "any", value: 10 })],
          { default_duration_sim_min: 10 },
        ),
      ],
      TEST_MAP,
    );
    const info = engine.start({ injection_id: "short", atSimTsMs: START });

    const inside = values([50, 5, 8]);
    engine.apply(inside, "loaded", START + 9 * MINUTE);
    expect(inside.analog[LANE.oil]).toBe(60);
    expect(engine.expire(START + 9 * MINUTE)).toEqual([]);

    const after = values([50, 5, 8]);
    engine.apply(after, "loaded", START + 10 * MINUTE);
    expect(after.analog[LANE.oil]).toBe(50);
    expect(engine.expire(START + 10 * MINUTE)).toEqual([{ instance: info, reason: "expired" }]);
    expect(engine.active()).toEqual([]);
  });
});

describe("a ramp anchored at state_entry", () => {
  const engine = createInjectionEngine(
    [
      definition("leak", [
        transform({
          tag: "line_pressure",
          op: "ramp",
          when: "not_loaded",
          rate_per_min: -0.3,
          cap: 2.5,
          anchor: "state_entry",
        }),
      ]),
    ],
    TEST_MAP,
  );

  it("restarts at every change of the machine state", () => {
    engine.start({ injection_id: "leak", atSimTsMs: START });

    const step = (minutes: number, state: MachineState): number => {
      const row = values([50, 5, 8]);
      engine.apply(row, state, START + minutes * MINUTE);
      return row.analog[LANE.pressure] ?? 0;
    };

    // The instance's first row counts as an entry, so nothing has elapsed yet.
    expect(step(0, "unloaded")).toBeCloseTo(8, 10);
    expect(step(2, "unloaded")).toBeCloseTo(8 - 0.6, 10);
    expect(step(4, "unloaded")).toBeCloseTo(8 - 1.2, 10);
    // A loaded run is not overlaid, and it re-anchors the ramp.
    expect(step(6, "loaded")).toBeCloseTo(8, 10);
    expect(step(8, "unloaded")).toBeCloseTo(8, 10);
    expect(step(10, "unloaded")).toBeCloseTo(8 - 0.6, 10);
  });

  it("counts from the instance start when the anchor is injection_start", () => {
    const fixed = createInjectionEngine(
      [
        definition("drift", [
          transform({
            tag: "line_pressure",
            op: "ramp",
            when: "not_loaded",
            rate_per_min: -0.3,
            cap: 2.5,
            anchor: "injection_start",
          }),
        ]),
      ],
      TEST_MAP,
    );
    fixed.start({ injection_id: "drift", atSimTsMs: START });

    const step = (minutes: number, state: MachineState): number => {
      const row = values([50, 5, 8]);
      fixed.apply(row, state, START + minutes * MINUTE);
      return row.analog[LANE.pressure] ?? 0;
    };
    step(0, "unloaded");
    step(4, "loaded");
    expect(step(6, "unloaded")).toBeCloseTo(8 - 1.8, 10);
  });
});

describe("a ramp anchored at guard_entry", () => {
  // The same rows and numbers as the Go engine's tests
  // (services/modbus/internal/injection/engine_test.go,
  // `TestRampAnchoredAtGuardEntryRunsThroughTheStatesInsideItsGuard`,
  // `TestGuardEntryIsTrackedPerTransform` and
  // `TestGuardEntryRunsThroughARestartInsideTheIdlePeriod`), on this file's 8 bar line.
  const ramp = (tag: string, when: string): InjectionTransform =>
    transform({ tag, op: "ramp", when, rate_per_min: -0.3, cap: 2.5, anchor: "guard_entry" });

  it("keeps running through the states inside its guard and restarts on the next entry", () => {
    const engine = createInjectionEngine(
      [definition("leak", [ramp("line_pressure", "not_loaded")])],
      TEST_MAP,
    );
    engine.start({ injection_id: "leak", atSimTsMs: START });

    const step = (minutes: number, state: MachineState): number => {
      const row = values([50, 5, 8]);
      engine.apply(row, state, START + minutes * MINUTE);
      return row.analog[LANE.pressure] ?? 0;
    };

    // One idle period: the motor stops after two unloaded minutes and the guard keeps holding,
    // so the pressure goes on falling instead of stepping back up at the stop.
    expect(step(0, "unloaded")).toBeCloseTo(8, 10);
    expect(step(2, "unloaded")).toBeCloseTo(8 - 0.6, 10);
    expect(step(3, "off")).toBeCloseTo(8 - 0.9, 10);
    expect(step(5, "off")).toBeCloseTo(8 - 1.5, 10);
    // A loaded run is not overlaid, and the next idle period is a new entry.
    expect(step(6, "loaded")).toBeCloseTo(8, 10);
    expect(step(7, "unloaded")).toBeCloseTo(8, 10);
    expect(step(9, "off")).toBeCloseTo(8 - 0.6, 10);
    // A long idle period is still capped.
    expect(step(30, "off")).toBeCloseTo(8 - 2.5, 10);
  });

  it("tracks each transform's own guard", () => {
    const map: RegisterMap = {
      signals: [
        ...TEST_MAP.signals.slice(0, 3),
        { tag: "reservoir_pressure", metropt_column: "Reservoirs", group: "analog", scale: 1000 },
        ...TEST_MAP.signals.slice(3),
      ],
    };
    const engine = createInjectionEngine(
      [
        definition("two_guards", [
          ramp("line_pressure", "not_loaded"),
          ramp("reservoir_pressure", "off"),
        ]),
      ],
      map,
    );
    engine.start({ injection_id: "two_guards", atSimTsMs: START });

    const states: MachineState[] = ["loaded", "unloaded", "unloaded", "off", "off", "off"];
    let row = values([50, 5, 8, 8]);
    states.forEach((state, minutes) => {
      row = values([50, 5, 8, 8]);
      engine.apply(row, state, START + minutes * MINUTE);
    });

    // Minute 5: four minutes into the idle period, two into the stop.
    expect(row.analog[2]).toBeCloseTo(8 - 1.2, 10);
    expect(row.analog[3]).toBeCloseTo(8 - 0.6, 10);
  });

  it("runs through a restart inside the idle period and re-enters from any not-loaded state", () => {
    // `TestGuardEntryRunsThroughARestartInsideTheIdlePeriod`: unloaded, off, unloaded, off is
    // still one idle period, and a loaded run followed straight by off starts a new one.
    const engine = createInjectionEngine(
      [definition("leak", [ramp("line_pressure", "not_loaded")])],
      TEST_MAP,
    );
    engine.start({ injection_id: "leak", atSimTsMs: START });

    const step = (minutes: number, state: MachineState): number => {
      const row = values([50, 5, 8]);
      engine.apply(row, state, START + minutes * MINUTE);
      return row.analog[LANE.pressure] ?? 0;
    };

    expect(step(0, "loaded")).toBeCloseTo(8, 10);
    expect(step(1, "unloaded")).toBeCloseTo(8, 10);
    expect(step(2, "off")).toBeCloseTo(8 - 0.3, 10);
    expect(step(3, "unloaded")).toBeCloseTo(8 - 0.6, 10);
    expect(step(4, "off")).toBeCloseTo(8 - 0.9, 10);
    expect(step(5, "loaded")).toBeCloseTo(8, 10);
    expect(step(6, "off")).toBeCloseTo(8, 10);
    expect(step(7, "unloaded")).toBeCloseTo(8 - 0.3, 10);
  });
});

describe("duty_shift on a 60 s pulse train sampled every 10 s", () => {
  /** True for the first 60 s of every 120 s period, sampled every 10 s. */
  function pulseTrain(samples: number): boolean[] {
    return Array.from({ length: samples }, (_, index) => Math.floor(index / 6) % 2 === 0);
  }

  function run(extendS: number): { source: boolean[]; overlaid: boolean[] } {
    const engine = createInjectionEngine(
      [
        definition(
          "duty",
          [
            transform({
              tag: "dryer_tower",
              op: "duty_shift",
              when: "any",
              run_value: true,
              extend_s: extendS,
            }),
          ],
          { default_duration_sim_min: 60 },
        ),
      ],
      TEST_MAP,
    );
    engine.start({ injection_id: "duty", atSimTsMs: START });

    const source = pulseTrain(24);
    const overlaid = source.map((bit, index) => {
      const row = values([50, 5, 8], [bit, false]);
      engine.apply(row, "loaded", START + index * 10 * SECOND);
      return row.digital[BIT.tower] === 1;
    });
    return { source, overlaid };
  }

  it("extends every watched run by extend_s when it is positive", () => {
    const { source, overlaid } = run(30);
    // A positive extension only has to watch a run *end*, so even the run that
    // was already under way at the instance's first sample is stretched: three
    // more samples of it, then the source value again.
    expect(overlaid.slice(0, 6)).toEqual(source.slice(0, 6));
    expect(overlaid.slice(6, 9)).toEqual([true, true, true]);
    expect(overlaid.slice(9, 12)).toEqual([false, false, false]);
    expect(overlaid.slice(12, 18)).toEqual(source.slice(12, 18));
    expect(overlaid.slice(18, 21)).toEqual([true, true, true]);
    expect(overlaid.slice(21, 24)).toEqual([false, false, false]);
  });

  it("suppresses the first |extend_s| seconds of every watched run when it is negative", () => {
    const { source, overlaid } = run(-30);
    expect(overlaid.slice(0, 12)).toEqual(source.slice(0, 12));
    expect(overlaid.slice(12, 15)).toEqual([false, false, false]);
    expect(overlaid.slice(15, 18)).toEqual([true, true, true]);
    expect(overlaid.slice(18, 24)).toEqual(source.slice(18, 24));
  });

  it("makes a run shorter than |extend_s| vanish", () => {
    const engine = createInjectionEngine(
      [
        definition("purge", [
          transform({
            tag: "dryer_tower",
            op: "duty_shift",
            when: "any",
            run_value: false,
            extend_s: -60,
          }),
        ]),
      ],
      TEST_MAP,
    );
    engine.start({ injection_id: "purge", atSimTsMs: START });

    // A 30 s dip in a signal that is otherwise high: the purge pulse.
    const source = [true, true, false, false, false, true, true];
    const overlaid = source.map((bit, index) => {
      const row = values([50, 5, 8], [bit, false]);
      engine.apply(row, "loaded", START + index * 10 * SECOND);
      return row.digital[BIT.tower] === 1;
    });
    expect(overlaid).toEqual([true, true, true, true, true, true, true]);
  });
});

describe("the noise primitive", () => {
  function noiseEngine(sigma: number) {
    const engine = createInjectionEngine(
      [
        definition(
          "noisy",
          [transform({ tag: "motor_current", op: "noise", when: "any", sigma })],
          { default_duration_sim_min: 14_400 },
        ),
      ],
      TEST_MAP,
    );
    engine.start({ injection_id: "noisy", atSimTsMs: START });
    return engine;
  }

  function draws(sigma: number, count: number): number[] {
    const engine = noiseEngine(sigma);
    return Array.from({ length: count }, (_, index) => {
      const row = values([50, 5, 8]);
      engine.apply(row, "loaded", START + index * 10 * SECOND);
      return (row.analog[LANE.current] ?? 0) - 5;
    });
  }

  it("draws the same number for the same instance and instant, and a different one otherwise", () => {
    const first = draws(0.12, 3);
    const again = draws(0.12, 3);
    expect(again).toEqual(first);
    expect(new Set(first).size).toBe(3);
  });

  it("scales the deviation with sigma and keeps the mean at zero", () => {
    const count = 5000;
    for (const sigma of [0.12, 0.5]) {
      const sample = draws(sigma, count);
      const mean = sample.reduce((total, value) => total + value, 0) / count;
      const variance =
        sample.reduce((total, value) => total + (value - mean) ** 2, 0) / (count - 1);
      expect(Math.abs(mean)).toBeLessThan(0.05 * sigma);
      expect(Math.sqrt(variance)).toBeGreaterThan(0.95 * sigma);
      expect(Math.sqrt(variance)).toBeLessThan(1.05 * sigma);
    }
  });

  it("gives two noise transforms of one instance different draws", () => {
    const engine = createInjectionEngine(
      [
        definition("two_noises", [
          transform({ tag: "motor_current", op: "noise", when: "any", sigma: 0.2 }),
          transform({ tag: "oil_temperature", op: "noise", when: "any", sigma: 0.2 }),
        ]),
      ],
      TEST_MAP,
    );
    engine.start({ injection_id: "two_noises", atSimTsMs: START });

    const row = values([0, 0, 8]);
    engine.apply(row, "loaded", START);
    expect(row.analog[LANE.current]).not.toBe(row.analog[LANE.oil]);
  });
});

describe("two instances", () => {
  it("compose in creation order, so the later one sees what the earlier one wrote", () => {
    const engine = createInjectionEngine(
      [
        definition("plus_one", [
          transform({ tag: "oil_temperature", op: "offset", when: "any", value: 1 }),
        ]),
        definition("times_two", [
          transform({ tag: "oil_temperature", op: "scale", when: "any", factor: 2 }),
        ]),
      ],
      TEST_MAP,
    );
    engine.start({ injection_id: "plus_one", atSimTsMs: START });
    engine.start({ injection_id: "times_two", atSimTsMs: START });

    const row = values([50, 5, 8]);
    engine.apply(row, "loaded", START);
    expect(row.analog[LANE.oil]).toBe((50 + 1) * 2);
  });

  it("expire independently, oldest first", () => {
    const engine = createInjectionEngine(
      [
        definition(
          "brief",
          [transform({ tag: "oil_temperature", op: "offset", when: "any", value: 1 })],
          { default_duration_sim_min: 10 },
        ),
        definition(
          "longer",
          [transform({ tag: "oil_temperature", op: "offset", when: "any", value: 2 })],
          { default_duration_sim_min: 30 },
        ),
      ],
      TEST_MAP,
    );
    const brief = engine.start({ injection_id: "brief", atSimTsMs: START });
    const longer = engine.start({ injection_id: "longer", atSimTsMs: START });

    expect(engine.expire(START + 10 * MINUTE)).toEqual([{ instance: brief, reason: "expired" }]);
    expect(engine.active()).toEqual([longer]);
    expect(engine.expire(START + 30 * MINUTE)).toEqual([{ instance: longer, reason: "expired" }]);
    expect(engine.active()).toEqual([]);
  });
});

describe("start", () => {
  const engine = createInjectionEngine(
    [
      definition("known", [
        transform({ tag: "oil_temperature", op: "offset", when: "any", value: 14 }),
      ]),
    ],
    TEST_MAP,
  );

  it("refuses an injection the catalog does not offer", () => {
    expect(() => engine.start({ injection_id: "absent", atSimTsMs: START })).toThrow(
      /no injection "absent" in the catalog/,
    );
    try {
      engine.start({ injection_id: "absent", atSimTsMs: START });
    } catch (error) {
      expect((error as InjectionError).code).toBe("unknown_injection");
    }
  });

  it("refuses a parameter the definition does not declare", () => {
    expect(() =>
      engine.start({ injection_id: "known", atSimTsMs: START, params: { strength: 2 } }),
    ).toThrow(/injection known: unknown parameter "strength"/);
  });

  it("refuses a magnitude outside the declared bounds", () => {
    expect(() =>
      engine.start({ injection_id: "known", atSimTsMs: START, params: { magnitude: 3 } }),
    ).toThrow(/magnitude is 3, outside 0.25..2/);
    expect(() =>
      engine.start({ injection_id: "known", atSimTsMs: START, params: { magnitude: 0.1 } }),
    ).toThrow(/magnitude is 0.1, outside 0.25..2/);
  });

  it("refuses a duration outside 1..14400 minutes, or one that is not whole", () => {
    expect(() =>
      engine.start({ injection_id: "known", atSimTsMs: START, params: { duration_sim_min: 0 } }),
    ).toThrow(/duration_sim_min is 0, outside 1..14400/);
    expect(() =>
      engine.start({
        injection_id: "known",
        atSimTsMs: START,
        params: { duration_sim_min: 20_000 },
      }),
    ).toThrow(/duration_sim_min is 20000, outside 1..14400/);
    expect(() =>
      engine.start({ injection_id: "known", atSimTsMs: START, params: { duration_sim_min: 1.5 } }),
    ).toThrow(/duration_sim_min is 1.5, not a whole number of minutes/);
  });

  it("refuses a parameter that is not a finite number", () => {
    expect(() =>
      engine.start({ injection_id: "known", atSimTsMs: START, params: { magnitude: Number.NaN } }),
    ).toThrow(/magnitude is not a finite number/);
  });

  it("scales the whole overlay by the magnitude it was given", () => {
    const half = createInjectionEngine(
      [
        definition("known", [
          transform({ tag: "oil_temperature", op: "offset", when: "any", value: 14 }),
        ]),
      ],
      TEST_MAP,
    );
    half.start({ injection_id: "known", atSimTsMs: START, params: { magnitude: 0.5 } });
    const row = values([50, 5, 8]);
    half.apply(row, "loaded", START);
    expect(row.analog[LANE.oil]).toBe(57);
  });
});

describe("the catalog loader", () => {
  const offset = transform({ tag: "oil_temperature", op: "offset", when: "any", value: 1 });

  function build(def: InjectionDef): () => unknown {
    return () => createInjectionEngine([def], TEST_MAP);
  }

  it("names the injection and the field of every refusal", () => {
    expect(
      build(
        definition("no_tag", [transform({ tag: "nope", op: "offset", when: "any", value: 1 })]),
      ),
    ).toThrow(
      /injection "no_tag": transforms\[0\]: tag "nope" is not a signal of the register map/,
    );
    expect(
      build(
        definition("wrong_kind", [
          transform({ tag: "dryer_tower", op: "offset", when: "any", value: 1 }),
        ]),
      ),
    ).toThrow(
      /injection "wrong_kind": transforms\[0\]: op "offset" reads a number but "dryer_tower" is a digital tag/,
    );
    expect(
      build(
        definition("duty_on_analog", [
          transform({
            tag: "oil_temperature",
            op: "duty_shift",
            when: "any",
            run_value: true,
            extend_s: 30,
          }),
        ]),
      ),
    ).toThrow(/transforms\[0\]: op "duty_shift" reads a two-level signal but "oil_temperature"/);
    expect(
      build(
        definition("bad_guard", [
          transform({ tag: "oil_temperature", op: "offset", when: "sometimes", value: 1 }),
        ]),
      ),
    ).toThrow(/injection "bad_guard": transforms\[0\]: when "sometimes" is not a state guard/);
    expect(
      build(definition("bad_op", [transform({ tag: "oil_temperature", op: "bend", when: "any" })])),
    ).toThrow(/injection "bad_op": transforms\[0\]: op "bend" is not one of the seven primitives/);
  });

  it("refuses ramps that do not fit the default duration", () => {
    expect(
      build(
        definition("too_long", [offset], {
          default_duration_sim_min: 60,
          envelope: { ramp_in_min: 40, ramp_out_min: 40 },
        }),
      ),
    ).toThrow(
      /injection "too_long": envelope ramp_in_min 40 plus ramp_out_min 40 exceeds default_duration_sim_min 60/,
    );
  });

  it("refuses a definition without a magnitude parameter, or with impossible bounds", () => {
    expect(
      build(
        definition("no_magnitude", [offset], {
          params: [{ name: "strength", default: 1, min: 0, max: 2 }],
        }),
      ),
    ).toThrow(/injection "no_magnitude": params declares no "magnitude"/);
    expect(
      build(
        definition("bad_bounds", [offset], {
          params: [{ name: "magnitude", default: 3, min: 0.25, max: 2 }],
        }),
      ),
    ).toThrow(/injection "bad_bounds": params\[0\] \(magnitude\): default 3 is outside 0.25..2/);
  });

  it("refuses the per-primitive fields the simulator's loader refuses", () => {
    expect(
      build(
        definition("zero_factor", [
          transform({ tag: "oil_temperature", op: "scale", when: "any", factor: 0 }),
        ]),
      ),
    ).toThrow(/scale needs a positive factor, not 0/);
    expect(
      build(
        definition("flat_ramp", [
          transform({
            tag: "oil_temperature",
            op: "ramp",
            when: "any",
            rate_per_min: 0,
            cap: 1,
            anchor: "injection_start",
          }),
        ]),
      ),
    ).toThrow(/ramp needs a non-zero rate_per_min/);
    expect(
      build(
        definition("bool_on_analog", [
          transform({ tag: "oil_temperature", op: "stuck", when: "any", value: true }),
        ]),
      ),
    ).toThrow(/value is a boolean but "oil_temperature" is an analog tag/);
    expect(
      build(
        definition("number_on_digital", [
          transform({ tag: "dryer_tower", op: "stuck", when: "any", value: 1 }),
        ]),
      ),
    ).toThrow(/value is a number but "dryer_tower" is a digital tag/);
    expect(
      build(
        definition("no_shift", [
          transform({
            tag: "dryer_tower",
            op: "duty_shift",
            when: "any",
            run_value: true,
            extend_s: 0,
          }),
        ]),
      ),
    ).toThrow(/duty_shift needs a non-zero extend_s/);
  });

  it("refuses a duplicate injection_id", () => {
    expect(() =>
      createInjectionEngine(
        [definition("twice", [offset]), definition("twice", [offset])],
        TEST_MAP,
      ),
    ).toThrow(InjectionCatalogError);
  });
});

describe("the real catalog", () => {
  const catalog = loadInjections();
  const defs = catalog?.injections ?? [];
  const map = REGISTER_MAP as RegisterMap;

  it("is present", () => {
    expect(defs.length).toBeGreaterThan(0);
  });

  it("loads against the generated register map", () => {
    expect(() => createInjectionEngine(defs, map)).not.toThrow();
  });

  it("offers the nine documented injections", () => {
    expect(defs.map((def) => def.injection_id).sort()).toEqual(
      [
        "air_leak_downstream",
        "dryer_tower_switching_failure",
        "heavy_air_demand",
        "high_ambient_temperature",
        "intake_valve_sticking",
        "motor_overload",
        "oil_temperature_sensor_fault",
        "separator_drain_blocked",
      ]
        .concat(["oil_cooler_fouling"])
        .sort(),
    );
  });

  /**
   * One synthetic minute-long stream: the unit alternates between loaded and unloaded runs, the
   * dryer purges for 30 s after every cut-in, and every analog tag sits on a plausible
   * first-month value. None of it comes from the recording, so this block runs offline.
   */
  function stream(
    samples: number,
  ): { state: MachineState; simTsMs: number; row: InjectionValues }[] {
    const lanes = map.signals.filter((signal) => signal.group !== "digital").map(() => 0);
    const digitals = map.signals.filter((signal) => signal.group === "digital").map(() => false);
    const index = (tag: string): number =>
      map.signals.filter((signal) => signal.group !== "digital").findIndex((s) => s.tag === tag);
    const bit = (tag: string): number =>
      map.signals.filter((signal) => signal.group === "digital").findIndex((s) => s.tag === tag);

    return Array.from({ length: samples }, (_, step) => {
      const loaded = Math.floor(step / 6) % 2 === 0;
      const analog = [...lanes];
      analog[index("discharge_pressure")] = loaded ? 9.2 : 0.1;
      analog[index("line_pressure")] = loaded ? 8.9 : 8.4;
      analog[index("separator_discharge_pressure")] = loaded ? 8.8 : 8.4;
      analog[index("dryer_purge_pressure")] = loaded ? 0.02 : 0;
      analog[index("reservoir_pressure")] = loaded ? 8.9 : 8.4;
      analog[index("oil_temperature")] = 61.5;
      analog[index("motor_current")] = loaded ? 5.8 : 4.2;
      analog[index("ambient_temperature")] = 9;

      const digital = [...digitals];
      digital[bit("intake_closed")] = !loaded;
      digital[bit("load_valve")] = loaded;
      // The purge pulse: the tower contact dips for the first 30 s of a loaded run.
      digital[bit("dryer_tower")] = !(loaded && step % 12 < 3);
      digital[bit("purge_switch")] = false;
      digital[bit("oil_level_ok")] = true;

      return {
        state: (loaded ? "loaded" : "unloaded") satisfies MachineState as MachineState,
        simTsMs: START + step * 10 * SECOND,
        row: values(analog, digital),
      };
    });
  }

  function overlay(injectionId: string, samples: number, magnitude = 1) {
    const engine = createInjectionEngine(defs, map);
    engine.start({ injection_id: injectionId, atSimTsMs: START, params: { magnitude } });
    const rows = stream(samples);
    const before = rows.map(({ row }) => ({
      analog: Float64Array.from(row.analog),
      digital: Uint8Array.from(row.digital),
    }));
    for (const { row, state, simTsMs } of rows) engine.apply(row, state, simTsMs);
    return { rows, before };
  }

  const analogLane = (tag: string): number =>
    map.signals.filter((signal) => signal.group !== "digital").findIndex((s) => s.tag === tag);
  const digitalBit = (tag: string): number =>
    map.signals.filter((signal) => signal.group === "digital").findIndex((s) => s.tag === tag);

  it("oil_cooler_fouling raises the oil temperature by 14 °C at the hold", () => {
    // 600 minutes with 180 in and 60 out: the hold runs from minute 180.
    const samples = 6 * 60 * 4; // four hours at one sample per 10 s
    const { rows, before } = overlay("oil_cooler_fouling", samples);
    const lane = analogLane("oil_temperature");
    const at = (minutes: number): number =>
      (rows[minutes * 6]?.row.analog[lane] ?? 0) - (before[minutes * 6]?.analog[lane] ?? 0);

    expect(at(0)).toBeCloseTo(0, 6);
    expect(at(90)).toBeCloseTo(7, 6);
    expect(at(180)).toBeCloseTo(14, 6);
    expect(at(210)).toBeCloseTo(14, 6);
  });

  it("air_leak_downstream decays the three pressures while not loaded and never moves the oil", () => {
    // The consistent leak injection: the definition keeps only the idle decay, the manual's
    // earliest sign of a network leak, and drops the oil offset a replay cannot explain.
    // The two rows read are the ones the Go definitions test reads
    // (services/modbus/internal/injection/definitions_test.go, `holdFrames`): ramp_in + 3
    // minutes (loaded) and ramp_in + 4 minutes (fifty seconds into an unloaded run), on the
    // same one-minute alternation, so the two implementations are held to the same numbers.
    const definition = defs.find((def) => def.injection_id === "air_leak_downstream");
    const rampIn = definition?.envelope.ramp_in_min ?? 0;
    const minutes = rampIn + 4;
    const { rows, before } = overlay("air_leak_downstream", minutes * 6);
    const delta = (step: number, tag: string): number =>
      (rows[step]?.row.analog[analogLane(tag)] ?? Number.NaN) -
      (before[step]?.analog[analogLane(tag)] ?? Number.NaN);

    const atLoaded = (rampIn + 3) * 6 - 1;
    const atNotLoaded = (rampIn + 4) * 6 - 1;
    expect(rows[atLoaded]?.state).toBe("loaded");
    expect(rows[atNotLoaded]?.state).toBe("unloaded");

    // −0.30 bar/min anchored at the state entry, fifty seconds in: −0.25 bar.
    for (const tag of ["line_pressure", "separator_discharge_pressure", "reservoir_pressure"]) {
      expect(delta(atNotLoaded, tag)).toBeCloseTo((-0.3 * 50) / 60, 9);
      expect(delta(atLoaded, tag)).toBe(0);
    }
    // No oil and no current move in any state, on any row of the run.
    for (const [step] of rows.entries()) {
      expect(delta(step, "oil_temperature")).toBe(0);
      expect(delta(step, "motor_current")).toBe(0);
    }
    expect(definition?.transforms.map((transform) => transform.tag)).toEqual([
      "line_pressure",
      "separator_discharge_pressure",
      "reservoir_pressure",
    ]);
  });

  it("heavy_air_demand decays the pressures while not loaded, loads the motor, never warms the oil", () => {
    // The oil offset stood for the long loaded runs a replay cannot produce, so it has been gone
    // since 2026-09-24; the decay and the loaded current stay. The rows are the Go definitions
    // test's, as for the leak above.
    const definition = defs.find((def) => def.injection_id === "heavy_air_demand");
    const rampIn = definition?.envelope.ramp_in_min ?? 0;
    const { rows, before } = overlay("heavy_air_demand", (rampIn + 4) * 6);
    const delta = (step: number, tag: string): number =>
      (rows[step]?.row.analog[analogLane(tag)] ?? Number.NaN) -
      (before[step]?.analog[analogLane(tag)] ?? Number.NaN);

    const atLoaded = (rampIn + 3) * 6 - 1;
    const atNotLoaded = (rampIn + 4) * 6 - 1;
    expect(rows[atLoaded]?.state).toBe("loaded");
    expect(rows[atNotLoaded]?.state).toBe("unloaded");

    // −0.12 bar/min from the start of the idle period, fifty seconds in: −0.10 bar.
    for (const tag of ["line_pressure", "separator_discharge_pressure", "reservoir_pressure"]) {
      expect(delta(atNotLoaded, tag)).toBeCloseTo((-0.12 * 50) / 60, 9);
      expect(delta(atLoaded, tag)).toBe(0);
    }
    expect(delta(atLoaded, "motor_current")).toBeCloseTo(5.8 * 0.04, 9);
    expect(delta(atNotLoaded, "motor_current")).toBe(0);
    for (const [step] of rows.entries()) expect(delta(step, "oil_temperature")).toBe(0);
    expect(definition?.transforms.map((transform) => transform.tag)).toEqual([
      "line_pressure",
      "separator_discharge_pressure",
      "reservoir_pressure",
      "motor_current",
    ]);
  });

  it("runs every not-loaded ramp through the whole idle period, unloaded and off alike", () => {
    // A ramp guarded by `not_loaded` counts from the start of the idle period, so the stop
    // after the unloaded run-on does not step the pressure back up. The rows and numbers are
    // the Go definitions test's (`TestEveryNotLoadedRampRunsThroughTheWholeIdlePeriod`): loaded
    // through the ramp in, then two unloaded and three off minutes, then a loaded one, six rows
    // a minute.
    const ramps = defs.flatMap((def) =>
      def.transforms
        .filter((transform) => transform.op === "ramp" && transform.when === "not_loaded")
        .map((transform) => ({ def, transform })),
    );
    expect(ramps.map(({ def, transform }) => `${def.injection_id}:${transform.tag}`)).toEqual(
      ["heavy_air_demand", "air_leak_downstream"].flatMap((id) =>
        ["line_pressure", "separator_discharge_pressure", "reservoir_pressure"].map(
          (tag) => `${id}:${tag}`,
        ),
      ),
    );

    for (const { def, transform } of ramps) {
      if (transform.op !== "ramp") continue;
      const rampIn = def.envelope.ramp_in_min;
      const schedule: MachineState[] = [
        ...Array.from({ length: rampIn }, (): MachineState => "loaded"),
        "unloaded",
        "unloaded",
        "off",
        "off",
        "off",
        "loaded",
      ];
      const engine = createInjectionEngine(defs, map);
      engine.start({ injection_id: def.injection_id, atSimTsMs: START });
      const lane = analogLane(transform.tag);
      const base = 8.4;
      const deltas = Array.from({ length: schedule.length * 6 }, (_, step) => {
        const analog = new Array<number>(map.signals.length).fill(0);
        analog[lane] = base;
        const row = values(analog, []);
        engine.apply(row, schedule[Math.floor(step / 6)] ?? "loaded", START + step * 10 * SECOND);
        return (row.analog[lane] ?? Number.NaN) - base;
      });
      const drift = (seconds: number): number =>
        Math.max(-transform.cap, Math.min(transform.cap, (transform.rate_per_min * seconds) / 60));
      const idle = rampIn * 6;
      const name = `${def.injection_id} ${transform.tag}`;

      expect(transform.anchor, name).toBe("guard_entry");
      expect(deltas[idle + 11], `${name}: the last unloaded row`).toBeCloseTo(drift(110), 9);
      expect(deltas[idle + 12], `${name}: the stop does not restart the ramp`).toBeCloseTo(
        drift(120),
        9,
      );
      expect(deltas[idle + 29], `${name}: the last off row`).toBeCloseTo(drift(290), 9);
      expect(deltas[idle + 30], `${name}: nothing while loaded`).toBe(0);
    }
  });

  it("intake_valve_sticking lowers the discharge pressure by 0.22 bar, only while loaded", () => {
    // 180 minutes with 30 in and 30 out: the hold runs from minute 30.
    const samples = 6 * 60 * 2;
    const { rows, before } = overlay("intake_valve_sticking", samples);
    const lane = analogLane("discharge_pressure");
    const current = analogLane("motor_current");

    const loaded = rows
      .map((entry, step) => ({ entry, step }))
      .filter(({ entry, step }) => entry.state === "loaded" && step > 6 * 40);
    const unloaded = rows
      .map((entry, step) => ({ entry, step }))
      .filter(({ entry, step }) => entry.state === "unloaded" && step > 6 * 40);

    for (const { entry, step } of loaded.slice(0, 20)) {
      expect((entry.row.analog[lane] ?? 0) - (before[step]?.analog[lane] ?? 0)).toBeCloseTo(
        -0.22,
        6,
      );
      // The loaded current drops by 14 %, which is what separates this from an overload.
      expect(entry.row.analog[current] ?? 0).toBeCloseTo(5.8 * 0.86, 6);
    }
    for (const { entry, step } of unloaded.slice(0, 20)) {
      expect(entry.row.analog[lane]).toBe(before[step]?.analog[lane]);
    }
  });

  it("dryer_tower_switching_failure removes the purge pulse", () => {
    const samples = 120;
    const { rows, before } = overlay("dryer_tower_switching_failure", samples);
    const bit = digitalBit("dryer_tower");
    const purge = digitalBit("purge_switch");

    // The recording dips the tower contact; after the overlay it never does again.
    expect(before.some((row) => row.digital[bit] === 0)).toBe(true);
    const afterFirstWatchedRun = rows.slice(12);
    expect(afterFirstWatchedRun.every(({ row }) => row.digital[bit] === 1)).toBe(true);
    expect(rows.every(({ row }) => row.digital[purge] === 1)).toBe(true);
  });

  it("motor_overload raises the loaded current by 20 % plus noise", () => {
    // 240 minutes with 60 in and 30 out: the hold runs from minute 60.
    const samples = 6 * 60 * 2;
    const { rows } = overlay("motor_overload", samples);
    const lane = analogLane("motor_current");

    const held = rows
      .map((entry, step) => ({ entry, step }))
      .filter(({ entry, step }) => entry.state === "loaded" && step >= 6 * 70 && step < 6 * 110)
      .map(({ entry }) => entry.row.analog[lane] ?? 0);

    expect(held.length).toBeGreaterThan(50);
    const mean = held.reduce((total, value) => total + value, 0) / held.length;
    expect(mean).toBeCloseTo(5.8 * 1.2, 1);
    // The noise is there: no two samples read the same current.
    expect(new Set(held).size).toBe(held.length);
  });

  it("high_ambient_temperature adds to the synthetic ambient lane rather than replacing it", () => {
    const samples = 6 * 60 * 3;
    const { rows, before } = overlay("high_ambient_temperature", samples);
    const lane = analogLane("ambient_temperature");
    const oil = analogLane("oil_temperature");

    const held = 6 * 130; // 720 minutes with 120 in: the hold starts at minute 120.
    expect((rows[held]?.row.analog[lane] ?? 0) - (before[held]?.analog[lane] ?? 0)).toBeCloseTo(
      14,
      6,
    );
    expect((rows[held]?.row.analog[oil] ?? 0) - (before[held]?.analog[oil] ?? 0)).toBeCloseTo(7, 6);
  });
});
