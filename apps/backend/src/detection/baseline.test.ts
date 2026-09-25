// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * What "normal" means.
 *
 * The first-month constants are transcribed from
 * `data/metropt3-first-month-stats.json`, which is committed — it
 * holds statistics, never rows — so this file reads it back and
 * compares, and a typo in a percentile fails here rather than shifting a word
 * on a ticket months later. The sensor accuracies are checked the same way
 * against the manual's `machine.yaml`, which only this test reads.
 *
 * The rolling baseline is pure arithmetic over closed cycles and needs no
 * dataset at all.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SIGNALS } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../../test/helpers/fixtures.ts";
import {
  ABSOLUTE_THRESHOLD,
  BASELINE_REF,
  createRollingBaseline,
  FIRST_MONTH_ANALOG_BANDS,
  FIRST_MONTH_CYCLE_BANDS,
  FIRST_MONTH_CYCLES_PER_HOUR,
  FIRST_MONTH_DIGITAL_SHARE,
  ROLLING_CAP_BASE,
  ROLLING_FACTOR,
  ROLLING_MIN_CYCLES,
  ROLLING_WINDOW_H,
  ruleThreshold,
  SENSOR_ACCURACY,
  type Band,
  type BandedMode,
  type MeasuredAnalogRole,
  type RollingMetric,
} from "./baseline.ts";
import { ANALOG_ROLES, resolveRoles, ROLE_COLUMNS, type DigitalRole } from "./signals.ts";
import type { Cycle } from "./types.ts";

interface StatBlock {
  readonly p1: number;
  readonly p5: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly mean: number;
  readonly max: number;
}

interface FirstMonthStats {
  readonly first_month: {
    readonly columns: Readonly<Record<string, Readonly<Record<BandedMode, StatBlock>>>>;
    readonly cycles: Readonly<Record<string, StatBlock>> & { readonly cycles_per_hour: number };
  };
}

const STATS = JSON.parse(
  readFileSync(join(REPO_ROOT, "data", "metropt3-first-month-stats.json"), "utf8"),
) as FirstMonthStats;

const MODES: readonly BandedMode[] = ["loaded", "unloaded", "off"];

/** The cycle metrics the statistics publish directly, and where they live. */
const CYCLE_SOURCES = {
  loaded_s: "loaded_s",
  unloaded_s: "unloaded_s",
  off_s: "off_s",
  nonloaded_s: "nonloaded_s",
  cutin_tp3: "cutin_tp3_bar",
  cutout_tp3: "cutout_tp3_bar",
  decay_bar_per_min: "drop_rate_nonloaded_bar_per_min",
  motor_current_loaded: "motor_current_loaded_A",
  tp2_minus_tp3_loaded: "tp2_minus_tp3_loaded_bar",
  dv_pressure_loaded: "dv_pressure_loaded_bar",
  towers_pulse_s: "towers0_per_cycle_s",
} as const;

/** One `sensors[]` entry of `manual/spec/machine.yaml`, as far as this file reads it. */
interface SensorSpec {
  readonly min: number;
  readonly max: number;
  readonly rangeUnit: string;
  readonly accuracy: number;
  readonly accuracyUnit: string;
}

/**
 * `sensors[]` of `machine.yaml`, keyed by signal. Each entry is one flow
 * mapping on its own line, so a line pattern reads them without a YAML parser
 * the backend neither has nor needs; an entry written any other way is simply
 * not found, and the coverage test below names it.
 */
function machineSensors(): ReadonlyMap<string, SensorSpec> {
  const text = readFileSync(join(REPO_ROOT, "manual", "spec", "machine.yaml"), "utf8");
  const entry =
    /^\s*- \{signal: (\w+),.*range: \{min: (-?[\d.]+), max: (-?[\d.]+), unit: (\w+)\}, accuracy: \{value: ([\d.]+), unit: (\w+)\}\}\s*$/gm;
  const sensors = new Map<string, SensorSpec>();
  for (const [, signal, min, max, rangeUnit, accuracy, accuracyUnit] of text.matchAll(entry)) {
    sensors.set(signal as string, {
      min: Number(min),
      max: Number(max),
      rangeUnit: rangeUnit as string,
      accuracy: Number(accuracy),
      accuracyUnit: accuracyUnit as string,
    });
  }
  return sensors;
}

/** A sensor's accuracy in its signal's own unit; a percentage is of the range span. */
function accuracyInSignalUnit(sensor: SensorSpec): number {
  if (sensor.accuracyUnit === "percent") return (sensor.accuracy / 100) * (sensor.max - sensor.min);
  expect(sensor.accuracyUnit).toBe(sensor.rangeUnit);
  return sensor.accuracy;
}

function expectBand(band: Band, source: StatBlock, what: string): void {
  expect(band.p1, `${what} p1`).toBeCloseTo(source.p1, 6);
  expect(band.p5, `${what} p5`).toBeCloseTo(source.p5, 6);
  expect(band.p50, `${what} p50`).toBeCloseTo(source.p50, 6);
  expect(band.p95, `${what} p95`).toBeCloseTo(source.p95, 6);
  expect(band.p99, `${what} p99`).toBeCloseTo(source.p99, 6);
}

/** A closed cycle carrying only the metrics the rolling baseline reads. */
function cycleOf(input: {
  endSimTsMs: number;
  loadedS: number;
  offS: number;
  periodS: number;
  decay?: number;
}): Cycle {
  return {
    cutin_sim_ts: new Date(input.endSimTsMs - input.periodS * 1000).toISOString(),
    cutin_sim_ts_ms: input.endSimTsMs - input.periodS * 1000,
    cutout_sim_ts: new Date(input.endSimTsMs - input.periodS * 1000 + 1000).toISOString(),
    cutout_sim_ts_ms: input.endSimTsMs - input.periodS * 1000 + 1000,
    end_sim_ts_ms: input.endSimTsMs,
    loaded_s: input.loadedS,
    unloaded_s: input.periodS - input.loadedS - input.offS,
    off_s: input.offS,
    nonloaded_s: input.periodS - input.loadedS,
    period_s: input.periodS,
    cutin_tp3: 8.05,
    cutout_tp3: 10.03,
    cut_out_reached: true,
    decay_bar_per_min: input.decay,
    rise_bar_per_min: 1.09,
    tp2_minus_tp3_loaded: 0.32,
    motor_current_loaded: 6,
    start_current_peak: 6.2,
    dv_pressure_loaded: -0.018,
    dv_pressure_loaded_max: -0.018,
    towers_pulse: true,
    h1_return_s: 0,
    oil_max: 56.6,
  };
}

/** `count` cycles one period apart, ending at `startMs` plus their periods. */
function series(
  count: number,
  options: { periodS: number; loadedS: number; decay: number },
): Cycle[] {
  const startMs = Date.parse("2020-02-03T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) =>
    cycleOf({
      endSimTsMs: startMs + (index + 1) * options.periodS * 1000,
      loadedS: options.loadedS,
      offS: options.periodS - options.loadedS - 407,
      periodS: options.periodS,
      decay: options.decay,
    }),
  );
}

describe("the first-month constants", () => {
  it("name the baseline every suspect event cites", () => {
    expect(BASELINE_REF).toBe("metropt3-first-month-2020-02");
  });

  it("repeat the per-state analog percentiles of the statistics file", () => {
    for (const [role, column] of Object.entries(ROLE_COLUMNS)) {
      const bands = FIRST_MONTH_ANALOG_BANDS[role as MeasuredAnalogRole];
      if (bands === undefined) continue;
      for (const mode of MODES) {
        expectBand(
          bands[mode],
          STATS.first_month.columns[column]?.[mode] as StatBlock,
          `${role}.${mode}`,
        );
      }
    }
  });

  it("covers every analog role the recording has a column for", () => {
    expect(Object.keys(FIRST_MONTH_ANALOG_BANDS).sort()).toEqual([
      "dv_pressure",
      "h1",
      "motor_current",
      "oil_temperature",
      "reservoirs",
      "tp2",
      "tp3",
    ]);
  });

  it("repeat the share each digital read true in, per state", () => {
    for (const [role, column] of Object.entries(ROLE_COLUMNS)) {
      const shares = FIRST_MONTH_DIGITAL_SHARE[role as DigitalRole];
      if (shares === undefined) continue;
      for (const mode of MODES) {
        const mean = STATS.first_month.columns[column]?.[mode]?.mean as number;
        expect(shares[mode], `${role}.${mode}`).toBeCloseTo(mean, 6);
      }
    }
  });

  it("repeat the per-cycle percentiles the statistics publish", () => {
    for (const [metric, key] of Object.entries(CYCLE_SOURCES)) {
      expectBand(
        FIRST_MONTH_CYCLE_BANDS[metric as keyof typeof CYCLE_SOURCES],
        STATS.first_month.cycles[key] as StatBlock,
        metric,
      );
    }
  });

  it("derive the three bands the statistics do not publish, in order", () => {
    for (const metric of ["rise_bar_per_min", "start_current_peak", "cycles_per_hour"] as const) {
      const band = FIRST_MONTH_CYCLE_BANDS[metric];
      expect(band.p1, metric).toBeLessThanOrEqual(band.p5);
      expect(band.p5, metric).toBeLessThanOrEqual(band.p50);
      expect(band.p50, metric).toBeLessThanOrEqual(band.p95);
      expect(band.p95, metric).toBeLessThanOrEqual(band.p99);
    }
    // The start peak's upper end is the first month's highest loaded current
    // and the manual's rating.
    expect(FIRST_MONTH_CYCLE_BANDS.start_current_peak.p95).toBeCloseTo(
      STATS.first_month.cycles.motor_current_loaded_A?.max as number,
      6,
    );
    expect(FIRST_MONTH_CYCLE_BANDS.start_current_peak.p99).toBe(9.5);
  });

  it("take the first month's own cycle rate from the statistics", () => {
    expect(FIRST_MONTH_CYCLES_PER_HOUR).toBeCloseTo(STATS.first_month.cycles.cycles_per_hour, 6);
  });
});

describe("the sensor accuracy", () => {
  const sensors = machineSensors();
  const roles = resolveRoles(SIGNALS);

  it("has one entry per analog role, and machine.yaml one sensor per analog signal", () => {
    expect(Object.keys(SENSOR_ACCURACY).sort()).toEqual([...ANALOG_ROLES].sort());
    expect([...sensors.keys()].sort()).toEqual(
      ANALOG_ROLES.map((role) => roles[role].signal_id).sort(),
    );
  });

  it("repeats machine.yaml in the unit of each signal", () => {
    for (const role of ANALOG_ROLES) {
      const sensor = sensors.get(roles[role].signal_id);
      if (sensor === undefined) throw new Error(`machine.yaml has no sensor for role ${role}`);
      expect(sensor.rangeUnit, role).toBe(roles[role].unit);
      expect(SENSOR_ACCURACY[role], role).toBeCloseTo(accuracyInSignalUnit(sensor), 9);
    }
  });

  it("resolves 85 mbar on every pressure, 1 °C on both temperatures and 0.4 A of current", () => {
    for (const role of ["tp2", "tp3", "h1", "dv_pressure", "reservoirs"] as const) {
      expect(SENSOR_ACCURACY[role], role).toBe(0.085);
    }
    expect(SENSOR_ACCURACY.oil_temperature).toBe(1);
    expect(SENSOR_ACCURACY.ambient_temperature).toBe(1);
    expect(SENSOR_ACCURACY.motor_current).toBe(0.4);
  });
});

describe("ruleThreshold", () => {
  it("is the absolute floor while there is no rolling median", () => {
    for (const metric of Object.keys(ABSOLUTE_THRESHOLD) as RollingMetric[]) {
      expect(ruleThreshold(metric, undefined), metric).toBe(ABSOLUTE_THRESHOLD[metric]);
    }
  });

  it("scales with the rolling median once that is the larger of the two", () => {
    expect(ruleThreshold("decay_bar_per_min", 0.2)).toBeCloseTo(0.4, 10);
    expect(ruleThreshold("decay_bar_per_min", 0.05)).toBe(0.25);
    expect(ruleThreshold("cycles_per_hour", 3.5)).toBeCloseTo(6.3, 10);
    expect(ruleThreshold("loaded_run_s", 150)).toBe(225);
  });

  it("uses the documented factors and floors of the rules", () => {
    expect(ABSOLUTE_THRESHOLD).toEqual({
      decay_bar_per_min: 0.25,
      cycles_per_hour: 5,
      loaded_run_s: 200,
      off_s: 250,
    });
    expect(ROLLING_FACTOR).toEqual({
      decay_bar_per_min: 2,
      cycles_per_hour: 1.8,
      loaded_run_s: 1.5,
      off_s: 1,
    });
  });
});

describe("the rolling baseline", () => {
  const periodS = 1800;

  it("says nothing below twenty cycles", () => {
    const rolling = createRollingBaseline();
    for (const cycle of series(ROLLING_MIN_CYCLES - 1, { periodS, loadedS: 140, decay: 0.12 })) {
      rolling.add(cycle, false);
    }
    expect(rolling.size()).toBe(ROLLING_MIN_CYCLES - 1);
    expect(rolling.median("decay_bar_per_min")).toBeUndefined();
    expect(rolling.medians()).toEqual({
      decay_bar_per_min: undefined,
      cycles_per_hour: undefined,
      loaded_run_s: undefined,
      off_s: undefined,
    });
  });

  it("answers with the median of the window once it has enough", () => {
    const rolling = createRollingBaseline();
    for (const cycle of series(ROLLING_MIN_CYCLES, { periodS, loadedS: 140, decay: 0.12 })) {
      rolling.add(cycle, false);
    }
    expect(rolling.median("decay_bar_per_min")).toBeCloseTo(0.12, 10);
    expect(rolling.median("loaded_run_s")).toBe(140);
    expect(rolling.median("cycles_per_hour")).toBeCloseTo(2, 10);
    expect(rolling.median("off_s")).toBe(periodS - 140 - 407);
  });

  it("caps each metric at twice the first-month median", () => {
    const rolling = createRollingBaseline();
    // A leak that grows over days would otherwise lift its own threshold out
    // of reach.
    for (const cycle of series(30, { periodS: 300, loadedS: 280, decay: 3 })) {
      rolling.add(cycle, false);
    }
    expect(rolling.median("decay_bar_per_min")).toBe(2 * ROLLING_CAP_BASE.decay_bar_per_min);
    expect(rolling.median("loaded_run_s")).toBe(2 * ROLLING_CAP_BASE.loaded_run_s);
    expect(rolling.median("cycles_per_hour")).toBe(2 * ROLLING_CAP_BASE.cycles_per_hour);
  });

  it("drops the cycles closed inside an open episode", () => {
    const rolling = createRollingBaseline();
    const cycles = series(ROLLING_MIN_CYCLES * 2, { periodS, loadedS: 140, decay: 0.12 });
    for (const [index, cycle] of cycles.entries()) {
      rolling.add({ ...cycle, decay_bar_per_min: index % 2 === 0 ? 0.5 : 0.12 }, index % 2 === 0);
    }
    expect(rolling.size()).toBe(ROLLING_MIN_CYCLES);
    expect(rolling.median("decay_bar_per_min")).toBeCloseTo(0.12, 10);
  });

  it("forgets cycles older than the window", () => {
    const rolling = createRollingBaseline();
    for (const cycle of series(ROLLING_MIN_CYCLES + 5, { periodS, loadedS: 140, decay: 0.12 })) {
      rolling.add(cycle, false);
    }
    const kept = rolling.size();
    const far = ROLLING_WINDOW_H * 3_600_000 * 2;
    rolling.add(
      cycleOf({
        endSimTsMs: Date.parse("2020-02-03T00:00:00.000Z") + far,
        loadedS: 109,
        offS: 1329,
        periodS: 1845,
        decay: 0.07,
      }),
      false,
    );
    expect(kept).toBe(ROLLING_MIN_CYCLES + 5);
    expect(rolling.size()).toBe(1);
    expect(rolling.median("decay_bar_per_min")).toBeUndefined();
  });

  it("ignores a cycle that could not measure its decay", () => {
    const rolling = createRollingBaseline({ minCycles: 3 });
    for (const cycle of series(3, { periodS, loadedS: 140, decay: 0.12 })) {
      rolling.add({ ...cycle, decay_bar_per_min: undefined }, false);
    }
    expect(rolling.size()).toBe(3);
    expect(rolling.median("decay_bar_per_min")).toBeUndefined();
    expect(rolling.median("loaded_run_s")).toBe(140);
  });

  it("holds nothing after a reset", () => {
    const rolling = createRollingBaseline();
    for (const cycle of series(ROLLING_MIN_CYCLES, { periodS, loadedS: 140, decay: 0.12 })) {
      rolling.add(cycle, false);
    }
    rolling.reset();
    expect(rolling.size()).toBe(0);
    expect(rolling.median("loaded_run_s")).toBeUndefined();
  });
});
