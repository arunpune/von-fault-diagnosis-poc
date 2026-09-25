// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Machine state and the four guards.
 *
 * Two kinds of check meet here. The truth tables and the guard timings are
 * pure and run everywhere; the agreement and the guard sightings are measured
 * on the generated fixtures, which exist only where `make fixtures` has run
 * and which `FDP_REQUIRE_DATASET=1` insists on.
 *
 * No assertion below names a labelled failure window: the fixtures used
 * here are the first-month baseline, the frozen-logger block, a depot
 * depressurisation and synthetic frames.
 */

import { SIGNALS, type Sample } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { hasFixture, loadFixture } from "../../test/helpers/fixtures.ts";
import { runBatches, type Phase } from "../../test/fixtures/synthetic/index.ts";
import { resolveRoles } from "./signals.ts";
import {
  createGuardTracker,
  FROZEN_SAMPLES,
  GAP_MS,
  guardsPassed,
  machineMode,
  PARKED_TP3_BAR,
  RUNNING_CURRENT_A,
  WARMUP_SAMPLES,
} from "./state.ts";
import type { Guards } from "./types.ts";

const roles = resolveRoles(SIGNALS);

/** The analog values every guard test needs, with the state tags on top. */
function sampleOf(
  index: number,
  overrides: Partial<Record<string, number | boolean>> = {},
  flags: { discontinuity?: boolean } = {},
): Sample {
  return {
    seq: index + 1,
    sim_ts: new Date(Date.parse("2020-02-03T00:00:00.000Z") + index * 10_000).toISOString(),
    flags: { discontinuity: flags.discontinuity ?? false, missing: false },
    values: {
      discharge_pressure: -0.01,
      line_pressure: 9.1,
      separator_discharge_pressure: 9.09,
      dryer_purge_pressure: -0.018,
      reservoir_pressure: 9.1,
      oil_temperature: 56.6,
      motor_current: 0.038,
      intake_closed: true,
      load_valve: false,
      dryer_tower: true,
      regulator_contact: true,
      low_pressure_switch: false,
      purge_switch: true,
      oil_level_ok: true,
      flow_pulse: true,
      ambient_temperature: 12,
      ...overrides,
    },
    alarms: [],
  };
}

/** The current-only fallback: off < 1.0 A ≤ unloaded < 4.6 A ≤ loaded. */
function currentOnlyMode(sample: Sample): string {
  const current = sample.values.motor_current;
  if (typeof current !== "number") return "unknown";
  if (current < 1) return "off";
  if (current < 4.6) return "unloaded";
  return "loaded";
}

function samplesOf(name: Parameters<typeof loadFixture>[0]): Sample[] {
  return loadFixture(name).batches.flatMap((batch) => batch.samples);
}

describe("machineMode", () => {
  it("is loaded when the intake is open and the load solenoid is energised", () => {
    const sample = sampleOf(0, { intake_closed: false, load_valve: true, motor_current: 6 });
    expect(machineMode(sample, roles)).toBe("loaded");
  });

  it("is unloaded while the motor runs on with the machine not delivering", () => {
    const sample = sampleOf(0, { motor_current: RUNNING_CURRENT_A });
    expect(machineMode(sample, roles)).toBe("unloaded");
  });

  it("is off below the running current", () => {
    const sample = sampleOf(0, { motor_current: RUNNING_CURRENT_A - 0.001 });
    expect(machineMode(sample, roles)).toBe("off");
  });

  it("is loaded whatever the current says, because the valves decide", () => {
    const sample = sampleOf(0, { intake_closed: false, load_valve: true, motor_current: 0.03 });
    expect(machineMode(sample, roles)).toBe("loaded");
  });

  it("is unknown when the sample does not carry the tags the rule needs", () => {
    const noValves: Sample = { ...sampleOf(0), values: { motor_current: 6 } };
    expect(machineMode(noValves, roles)).toBe("unknown");
    const noCurrent: Sample = {
      ...sampleOf(0),
      values: { intake_closed: true, load_valve: false },
    };
    expect(machineMode(noCurrent, roles)).toBe("unknown");
  });
});

describe("guardsPassed", () => {
  const clear: Guards = { discontinuity: false, frozen: false, parked: false, warmup: false };

  it("passes only when all four are down", () => {
    expect(guardsPassed(clear)).toBe(true);
    for (const key of ["discontinuity", "frozen", "parked", "warmup"] as const) {
      expect(guardsPassed({ ...clear, [key]: true }), key).toBe(false);
    }
  });
});

describe("the guard tracker", () => {
  it("holds warmup for the first samples of a segment", () => {
    const tracker = createGuardTracker(roles);
    for (let index = 0; index < WARMUP_SAMPLES - 1; index += 1) {
      const update = tracker.push(sampleOf(index), "off", index * 10_000);
      expect(update.guards.warmup, `sample ${String(index)}`).toBe(true);
    }
    const last = tracker.push(sampleOf(WARMUP_SAMPLES - 1), "off", (WARMUP_SAMPLES - 1) * 10_000);
    expect(last.guards.warmup).toBe(false);
  });

  it("raises discontinuity on the flag, on a long step and on time running backwards", () => {
    const tracker = createGuardTracker(roles);
    expect(tracker.push(sampleOf(0), "off", 0).guards.discontinuity).toBe(false);

    const flagged = tracker.push(sampleOf(1, {}, { discontinuity: true }), "off", 10_000);
    expect(flagged.guards.discontinuity).toBe(true);
    expect(flagged.reset).toBe("discontinuity");

    const stepped = tracker.push(sampleOf(2), "off", 10_000 + GAP_MS + 1);
    expect(stepped.guards.discontinuity).toBe(true);
    expect(stepped.reset).toBe("discontinuity");

    const backwards = tracker.push(sampleOf(3), "off", 1000);
    expect(backwards.guards.discontinuity).toBe(true);
  });

  it("freezes on the sixtieth identical tuple and resets when the logger moves again", () => {
    const tracker = createGuardTracker(roles);
    let update = tracker.push(sampleOf(0), "off", 0);
    for (let index = 1; index < FROZEN_SAMPLES - 1; index += 1) {
      update = tracker.push(sampleOf(index), "off", index * 10_000);
      expect(update.guards.frozen, `sample ${String(index)}`).toBe(false);
    }
    update = tracker.push(sampleOf(FROZEN_SAMPLES - 1), "off", (FROZEN_SAMPLES - 1) * 10_000);
    expect(update.guards.frozen).toBe(true);
    expect(update.reset).toBeUndefined();

    const moved = tracker.push(
      sampleOf(FROZEN_SAMPLES, { line_pressure: 9.2 }),
      "off",
      FROZEN_SAMPLES * 10_000,
    );
    expect(moved.guards.frozen).toBe(false);
    expect(moved.reset).toBe("frozen");
    expect(moved.guards.warmup).toBe(true);
  });

  it("does not freeze while one of the five values is missing", () => {
    const tracker = createGuardTracker(roles);
    for (let index = 0; index < FROZEN_SAMPLES * 2; index += 1) {
      const sample: Sample = { ...sampleOf(index), values: { intake_closed: true } };
      expect(tracker.push(sample, "unknown", index * 10_000).guards.frozen).toBe(false);
    }
  });

  it("parks the machine when the motor is off and the line is vented", () => {
    const tracker = createGuardTracker(roles);
    const vented = tracker.push(sampleOf(0, { line_pressure: PARKED_TP3_BAR - 0.1 }), "off", 0);
    expect(vented.guards.parked).toBe(true);

    const pressurised = tracker.push(sampleOf(1, { line_pressure: PARKED_TP3_BAR }), "off", 10_000);
    expect(pressurised.guards.parked).toBe(false);

    const running = tracker.push(
      sampleOf(2, { line_pressure: PARKED_TP3_BAR - 0.1, motor_current: 3.8 }),
      "unloaded",
      20_000,
    );
    expect(running.guards.parked).toBe(false);
  });

  it("starts a new warmup after an explicit reset", () => {
    const tracker = createGuardTracker(roles);
    for (let index = 0; index < WARMUP_SAMPLES + 5; index += 1) {
      tracker.push(sampleOf(index), "off", index * 10_000);
    }
    expect(tracker.samplesSinceReset()).toBe(WARMUP_SAMPLES + 5);
    tracker.reset("discontinuity");
    expect(tracker.samplesSinceReset()).toBe(0);
    const next = tracker.push(sampleOf(100), "off", 2_000_000);
    expect(next.guards.warmup).toBe(true);
  });
});

describe("the parked guard on a synthetic depot stop", () => {
  // The `depot-apr30` fixture slice holds the refill after such a stop, not
  // the vented stop itself (29 rows at 1–3 bar with the motor loaded), so the
  // guard's own case is generated here from the first-month numbers, like
  // every signature the unlabelled fixture slices do not show.
  const vented: Phase[] = [{ mode: "off", seconds: 3600, fromBar: 1.8, decayBarPerMin: 0.02 }];

  it("holds for the whole stop and lets no rule run", () => {
    const tracker = createGuardTracker(roles);
    const samples = runBatches(vented).flatMap((batch) => batch.samples);
    expect(samples.length).toBeGreaterThan(300);

    for (const sample of samples) {
      const simTsMs = Date.parse(sample.sim_ts);
      const mode = machineMode(sample, roles);
      expect(mode).toBe("off");
      const update = tracker.push(sample, mode, simTsMs);
      expect(update.guards.parked).toBe(true);
      expect(guardsPassed(update.guards)).toBe(false);
    }
  });
});

describe.skipIf(!hasFixture("baseline-feb"))("the first-month baseline fixture", () => {
  const samples = samplesOf("baseline-feb");

  it("agrees with the current-only fallback on at least 99 % of samples", () => {
    const agreed = samples.filter(
      (sample) => machineMode(sample, roles) === currentOnlyMode(sample),
    ).length;
    expect(agreed / samples.length).toBeGreaterThanOrEqual(0.99);
  });

  it("never freezes, never parks and never jumps", () => {
    const tracker = createGuardTracker(roles);
    for (const sample of samples) {
      const update = tracker.push(sample, machineMode(sample, roles), Date.parse(sample.sim_ts));
      expect(update.guards.frozen).toBe(false);
      expect(update.guards.parked).toBe(false);
      expect(update.guards.discontinuity).toBe(false);
    }
  });

  it("stops suppressing rules once the warmup is over", () => {
    const tracker = createGuardTracker(roles);
    const passed = samples.filter((sample) =>
      guardsPassed(
        tracker.push(sample, machineMode(sample, roles), Date.parse(sample.sim_ts)).guards,
      ),
    ).length;
    expect(passed).toBe(samples.length - WARMUP_SAMPLES + 1);
  });
});

describe.skipIf(!hasFixture("frozen-jun22"))("the frozen-logger fixture", () => {
  it("raises the frozen guard and suppresses the rules while the logger repeats itself", () => {
    const samples = samplesOf("frozen-jun22");
    const tracker = createGuardTracker(roles);
    let frozen = 0;
    for (const sample of samples) {
      const update = tracker.push(sample, machineMode(sample, roles), Date.parse(sample.sim_ts));
      if (update.guards.frozen) {
        frozen += 1;
        expect(guardsPassed(update.guards)).toBe(false);
      }
    }
    expect(frozen).toBeGreaterThan(FROZEN_SAMPLES);
  });
});

describe.skipIf(!hasFixture("depot-apr30"))("the depot depressurisation fixture", () => {
  const samples = samplesOf("depot-apr30");

  it("raises the discontinuity guard exactly once, across the logging gap", () => {
    const tracker = createGuardTracker(roles);
    const jumps = samples.filter(
      (sample) =>
        tracker.push(sample, machineMode(sample, roles), Date.parse(sample.sim_ts)).guards
          .discontinuity,
    );
    expect(jumps).toHaveLength(1);
    expect(jumps[0]?.sim_ts).toBe("2020-05-01T12:33:38.000Z");
  });

  it("is a refill from an empty line with the low-pressure switch closed", () => {
    const pressures = samples.map((sample) => sample.values.line_pressure as number);
    expect(Math.min(...pressures)).toBeLessThan(PARKED_TP3_BAR);
    expect(Math.max(...pressures)).toBeLessThan(9);
    expect(samples.filter((sample) => sample.values.low_pressure_switch === true).length).toBe(55);
  });
});
