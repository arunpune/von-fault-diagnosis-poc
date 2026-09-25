// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The port against the real machine and the real gateway.
//
// The harness keeps a second implementation of the simulator's value path and
// pays for it with this test. It builds `services/modbus/Dockerfile` (both
// targets) and `infra/mosquitto/Dockerfile` from the repository root, starts
// the three containers on a network of their own, replays a cut slice at
// 3600×, injects through `plant/cau-7/control/cmd` exactly as the user
// interface does, records what the gateway published on
// `plant/cau-7/telemetry/samples` — and then replays the same rows through
// `src/replay/` and compares the two sample by sample.
//
// Five runs, five questions:
//
//   1. no injection: is the replay's CSV → `telemetry-samples` conversion
//      exactly what the Modbus path produces? Every tag must be equal, which
//      the shared int16 quantisation makes possible.
//   2. `oil_cooler_fouling`: is the overlay arithmetic the same? The injected
//      tag must land within one register step; everything else stays exact.
//   3. the F3 leak: does the CTRL-7 port raise the same controller
//      messages as the machine's own evaluator? The two hours of 1 February
//      are quiet on both sides, so "identical alarm lists" there compares two
//      empty lists; a day of stuck-loaded running raises W102, W103 and W104
//      on the machine, and every sample's list must match. Alarm parity is a
//      hard criterion: a difference is a finding for the simulator's
//      controller, never a tolerance.
//   4. `motor_overload`: is the *noise* the same in distribution? It cannot be
//      the same sample by sample — the two generators differ on purpose — so
//      the port replays the definition a second time with the `noise`
//      transform removed and the simulator's own noise is measured against
//      that noiseless run. Two independent draws would differ with deviation
//      σ·m·√2, which is why one side has to be silent for "within 10 % of
//      σ·m" to mean anything.
//   5. `air_leak_downstream`: are the ramps the same? The three pressures are
//      ramped only while the unit is not loaded, from the start of each idle
//      period, so this is the run that exercises `ramp`, the `not_loaded` guard
//      and the `guard_entry` anchor; they must land within one register step,
//      and the drain must carry on through every unloaded → off change the
//      slice holds (the guard-entry anchor; the slice has three). The oil,
//      which the definition no longer touches since the consistent leak
//      injection (2026-09-23), must read exactly what an un-injected replay
//      reads.
//
// The noise run uses a whole normal day (`summer-jul05`) rather than the
// two-hour parity slice: the `motor_overload` noise is guarded by `loaded`,
// and the parity slice holds 31 loaded samples in total — far too few for a
// 10 % bound on a standard deviation to be a measurement rather than a coin
// toss. The day carries about a thousand.
//
// It skips, never fails, when Docker is unavailable or the images cannot be
// built; a missing slice skips too, unless `FDP_REQUIRE_DATASET=1` says the
// dataset was supposed to be there. Every wall-clock bound inside the helper
// scales with `FDP_TIMING_SLACK`.

import { beforeAll, describe, expect, it } from "vitest";

import { AMBIENT_TOLERANCE_C } from "../../src/replay/ambient.ts";
import { createEnvelope, envelopeAt } from "../../src/replay/inject.ts";
import type { MachineState } from "../../src/replay/types.ts";
import { PARITY_SLICE, datasetRequired, requireSlice, sliceIsCut } from "../../src/slices.ts";
import type { InjectRequest, ParityImages } from "../helpers/sim-stack.ts";
import {
  budgetMs,
  buildParityImages,
  compareSamples,
  parityBlocker,
  recordParityRun,
  replayPort,
  seqIsContiguousFromOne,
  startSimStack,
} from "../helpers/sim-stack.ts";

/** One register step of an `oil_temperature` or `motor_current` reading (scale 100). */
const LSB = 0.01;

/** One register step of a pressure reading (scale 1000). */
const PRESSURE_LSB = 0.001;

/** The three pressures `air_leak_downstream` ramps while the unit is not loaded. */
const LEAK_PRESSURES = ["line_pressure", "separator_discharge_pressure", "reservoir_pressure"];

/** The slice the two exact runs replay: 2020-02-01 00:00 → 02:00, 727 rows. */
const EXACT_SLICE = PARITY_SLICE;

/** A whole normal day, for the run that needs many loaded samples (question 4 above). */
const NOISE_SLICE = "summer-jul05";

/**
 * The first 24 h of the F3 leak: the run that makes the alarm comparison a comparison.
 *
 * The unit goes stuck-loaded at 09:48 and stays there, so the machine's CTRL-7 evaluator
 * raises the continuous-load, purge-pressure and oil-temperature messages and holds them for
 * the rest of the day.
 */
const ALARM_SLICE = "f3-jun05";

/** The deviation `motor_overload` declares for its `noise` transform, in amperes. */
const MOTOR_NOISE_SIGMA = 0.12;

/** The envelope `motor_overload` declares, in simulated minutes. */
const MOTOR_ENVELOPE = { ramp_in_min: 60, ramp_out_min: 30 };

/** How far the measured deviation of the simulator's noise may sit from the expected one. */
const NOISE_DEVIATION_TOLERANCE = 0.1;

/** The noise run's `|mean| < 0.01 A`, and the sampling floor below which it is not a measurement. */
const NOISE_MEAN_TOLERANCE_A = 0.01;
const NOISE_MEAN_STANDARD_ERRORS = 4;

/** Simulated seconds per wall-clock second. */
const REPLAY_SPEED = 3600;

const blocker = await parityBlocker();
const NEEDED_SLICES = [EXACT_SLICE, ALARM_SLICE, NOISE_SLICE] as const;
const slicesCut = NEEDED_SLICES.every((slice) => sliceIsCut(slice));
const sliceMessage =
  `the ${NEEDED_SLICES.join(", ")} slices are not cut; run \`make fixtures\` with the ` +
  "dataset in place (set FDP_REQUIRE_DATASET=1 to make this a failure)";
const runnable = blocker === undefined && slicesCut;

/** Every distinct alarm code a run published, sorted; the shape the two sides compare. */
function codesOf(samples: readonly { readonly alarms: readonly string[] }[]): string[] {
  const codes = new Set<string>();
  for (const sample of samples) for (const code of sample.alarms) codes.add(code);
  return [...codes].sort();
}

let images: ParityImages | undefined;

/** Records one run of the real stack over one slice. */
async function recorded(slice: string, injection?: InjectRequest) {
  if (images === undefined) throw new Error("@fdp/eval: the images were not built");
  const stack = await startSimStack({
    images,
    csvPath: requireSlice(slice),
    replaySpeed: REPLAY_SPEED,
  });
  try {
    const run = await recordParityRun(stack, injection);
    expect(run.samples.length, "the gateway published nothing").toBeGreaterThan(0);
    return run;
  } catch (error) {
    console.error(await stack.tail());
    throw error;
  } finally {
    await stack.stop();
  }
}

describe("parity with the Go simulator and gateway", () => {
  beforeAll(async () => {
    if (!runnable) return;
    images = await buildParityImages();
  }, budgetMs(900_000));

  it("can run, or its absence is allowed", () => {
    expect(slicesCut || !datasetRequired(), sliceMessage).toBe(true);
    if (blocker !== undefined) console.info(`parity: skipped, ${blocker}`);
    else if (!slicesCut) console.info(`parity: skipped, ${sliceMessage}`);
  });

  it.skipIf(!runnable)(
    "publishes exactly what the port produces when nothing is injected",
    async () => {
      const run = await recorded(EXACT_SLICE);
      const port = await replayPort({ csvPath: requireSlice(EXACT_SLICE) });

      expect(seqIsContiguousFromOne(run.samples)).toBeUndefined();
      expect(port.length).toBe(run.samples.length);
      const problems = compareSamples(run.samples, port, {
        within: { ambient_temperature: AMBIENT_TOLERANCE_C },
      });
      expect(problems, problems.join("\n")).toEqual([]);
      // `compareSamples` compares the lists sample by sample; this says what
      // the two hours held, which on a quiet February morning is nothing.
      expect(codesOf(port)).toEqual(codesOf(run.samples));
    },
    budgetMs(600_000),
  );

  it.skipIf(!runnable)(
    "applies oil_cooler_fouling to within one register step",
    async () => {
      const injection: InjectRequest = {
        injection_id: "oil_cooler_fouling",
        params: { magnitude: 1, duration_sim_min: 60 },
      };
      const run = await recorded(EXACT_SLICE, injection);

      // The machine was paused on the first row, so the instance starts there.
      expect(run.instanceId, "the simulator started no instance").toBeDefined();
      expect(run.startedSimTsMs).toBe(Date.parse(run.samples[0]?.sim_ts ?? ""));

      const port = await replayPort({
        csvPath: requireSlice(EXACT_SLICE),
        injection: {
          injection_id: injection.injection_id,
          atSimTsMs: run.startedSimTsMs ?? 0,
          params: injection.params,
        },
      });

      expect(seqIsContiguousFromOne(run.samples)).toBeUndefined();
      expect(port.length).toBe(run.samples.length);
      const problems = compareSamples(run.samples, port, {
        within: { ambient_temperature: AMBIENT_TOLERANCE_C, oil_temperature: LSB },
      });
      expect(problems, problems.join("\n")).toEqual([]);
      expect(codesOf(port)).toEqual(codesOf(run.samples));

      // The overlay is visible: the oil temperature rises through the hour.
      const first = run.samples[0]?.values["oil_temperature"];
      const peak = Math.max(
        ...run.samples.map((sample) => Number(sample.values["oil_temperature"] ?? 0)),
      );
      expect(typeof first === "number" && peak - first).toBeGreaterThan(5);
    },
    budgetMs(600_000),
  );

  it.skipIf(!runnable)(
    "applies air_leak_downstream's not-loaded ramps to within one register step, oil untouched",
    async () => {
      const injection: InjectRequest = {
        injection_id: "air_leak_downstream",
        params: { magnitude: 1, duration_sim_min: 120 },
      };
      const run = await recorded(EXACT_SLICE, injection);
      expect(run.instanceId, "the simulator started no instance").toBeDefined();
      expect(run.startedSimTsMs).toBe(Date.parse(run.samples[0]?.sim_ts ?? ""));

      const csvPath = requireSlice(EXACT_SLICE);
      const port = await replayPort({
        csvPath,
        injection: {
          injection_id: injection.injection_id,
          atSimTsMs: run.startedSimTsMs ?? 0,
          params: injection.params,
        },
      });

      expect(seqIsContiguousFromOne(run.samples)).toBeUndefined();
      expect(port.length).toBe(run.samples.length);
      const within: Record<string, number> = { ambient_temperature: AMBIENT_TOLERANCE_C };
      for (const tag of LEAK_PRESSURES) within[tag] = PRESSURE_LSB;
      const problems = compareSamples(run.samples, port, { within });
      expect(problems, problems.join("\n")).toEqual([]);
      expect(codesOf(port)).toEqual(codesOf(run.samples));

      // Against an un-injected replay of the same rows: the line drains while the unit is
      // not loaded, and the oil — both sides' — reads exactly what it would have read.
      const clean = await replayPort({ csvPath });
      expect(clean.length).toBe(run.samples.length);
      const drops = clean.map(
        (sample, index) =>
          Number(sample.values["line_pressure"]) -
          Number(run.samples[index]?.values["line_pressure"]),
      );
      expect(Math.max(...drops), "the line never drained faster than usual").toBeGreaterThan(1);

      // The ramps are anchored at the entry of their `not_loaded` guard: when the motor stops
      // after its unloaded run-on, the drain carries on rather than starting again from
      // nothing. The parity slice holds three such stops, and at each one the simulator's line
      // must still sit well below the un-injected one.
      const stateOf = (values: Readonly<Record<string, unknown>>): MachineState => {
        if (values["intake_closed"] === false && values["load_valve"] === true) return "loaded";
        return Number(values["motor_current"]) >= 1 ? "unloaded" : "off";
      };
      const states = clean.map((sample) => stateOf(sample.values));
      const stops = states.flatMap((state, index) =>
        index > 0 && state === "off" && states[index - 1] === "unloaded" ? [index] : [],
      );
      expect(stops.length, "the slice holds no unloaded to off change").toBeGreaterThan(0);
      for (const index of stops) {
        const before = drops[index - 1] ?? 0;
        expect(before, `the line had not drained before the stop at ${index}`).toBeGreaterThan(0.1);
        expect(
          drops[index] ?? 0,
          `the drain restarted when the motor stopped at ${clean[index]?.sim_ts ?? index}`,
        ).toBeGreaterThan(before / 2);
      }

      const oilMoved = clean.filter(
        (sample, index) =>
          sample.values["oil_temperature"] !== run.samples[index]?.values["oil_temperature"] ||
          sample.values["oil_temperature"] !== port[index]?.values["oil_temperature"],
      );
      expect(oilMoved, "the leak moved the oil temperature").toEqual([]);
    },
    budgetMs(600_000),
  );

  it.skipIf(!runnable)(
    "raises the machine's own controller messages, sample for sample, over the F3 leak",
    async () => {
      const run = await recorded(ALARM_SLICE);
      const port = await replayPort({ csvPath: requireSlice(ALARM_SLICE) });

      expect(seqIsContiguousFromOne(run.samples)).toBeUndefined();
      expect(port.length).toBe(run.samples.length);

      const theirs = codesOf(run.samples);
      const mine = codesOf(port);
      console.info(
        `parity: over ${ALARM_SLICE} the machine raised ${theirs.join(", ") || "nothing"} and ` +
          `the port raised ${mine.join(", ") || "nothing"}`,
      );
      // Without this the assertion below would be satisfied by two empty
      // lists, which is exactly what the quiet slices already prove.
      expect(
        theirs.length,
        "the machine raised no controller message at all over the F3 leak",
      ).toBeGreaterThan(0);
      expect(mine).toEqual(theirs);

      const problems = compareSamples(run.samples, port, {
        within: { ambient_temperature: AMBIENT_TOLERANCE_C },
      });
      expect(problems, problems.join("\n")).toEqual([]);
    },
    budgetMs(900_000),
  );

  it.skipIf(!runnable)(
    "matches motor_overload's noise in mean and deviation over a day of cycling",
    async () => {
      const duration = 1_440;
      const injection: InjectRequest = {
        injection_id: "motor_overload",
        params: { magnitude: 1, duration_sim_min: duration },
      };
      const run = await recorded(NOISE_SLICE, injection);
      const started = run.startedSimTsMs ?? 0;
      expect(run.instanceId, "the simulator started no instance").toBeDefined();

      const csvPath = requireSlice(NOISE_SLICE);
      // One port run without the `noise` transform, so what is left of the
      // difference is the simulator's noise and nothing else.
      const noiseless = await replayPort({
        csvPath,
        injection: {
          injection_id: injection.injection_id,
          atSimTsMs: started,
          params: injection.params,
        },
        dropOps: ["noise"],
      });
      expect(noiseless.length).toBe(run.samples.length);

      // Everything but the noisy tag still has to agree, alarms aside: the
      // port's copy of the injection has no `noise` transform, so its
      // `motor_current` is a different current and any message written over
      // that tag would differ with it. The F3 run above is where the alarm
      // lists are compared.
      const problems = compareSamples(run.samples, noiseless, {
        within: { ambient_temperature: AMBIENT_TOLERANCE_C, oil_temperature: LSB },
        ignore: ["motor_current"],
        alarms: "ignore",
      });
      expect(problems, problems.join("\n")).toEqual([]);

      // The noise applies while the unit is loaded, under the instance's own
      // envelope; the expectation is the root mean square of σ·m over exactly
      // the samples it was applied to.
      const envelope = createEnvelope(started, started + duration * 60_000, MOTOR_ENVELOPE);
      const differences: number[] = [];
      const deviations: number[] = [];
      noiseless.forEach((sample, index) => {
        const loaded =
          sample.values["intake_closed"] === false && sample.values["load_valve"] === true;
        if (!loaded) return;
        const m = envelopeAt(envelope, Date.parse(sample.sim_ts)) * injection.params.magnitude;
        if (m <= 0) return;
        const theirs = run.samples[index]?.values["motor_current"];
        const mine = sample.values["motor_current"];
        if (typeof theirs !== "number" || typeof mine !== "number") return;
        differences.push(theirs - mine);
        deviations.push(MOTOR_NOISE_SIGMA * m);
      });

      const count = differences.length;
      expect(count, "too few loaded samples to measure a deviation").toBeGreaterThan(300);

      const mean = differences.reduce((total, value) => total + value, 0) / count;
      const variance =
        differences.reduce((total, value) => total + (value - mean) ** 2, 0) / (count - 1);
      const measured = Math.sqrt(variance);
      const expectedDeviation = Math.sqrt(
        deviations.reduce((total, value) => total + value * value, 0) / count,
      );

      console.info(
        `parity: motor_overload noise over ${count} loaded samples — mean ` +
          `${mean.toFixed(5)} A, deviation ${measured.toFixed(5)} A, expected ` +
          `${expectedDeviation.toFixed(5)} A (${((measured / expectedDeviation - 1) * 100).toFixed(1)} %)`,
      );

      // A mean of zero is measured, not observed: with `count` samples its own
      // deviation is `measured / sqrt(count)`, so the bound is the larger of
      // the noise run's 0.01 A and four of those standard errors.
      const meanBound = Math.max(
        NOISE_MEAN_TOLERANCE_A,
        (NOISE_MEAN_STANDARD_ERRORS * measured) / Math.sqrt(count),
      );
      expect(
        Math.abs(mean),
        `the difference has mean ${mean.toFixed(5)} A over ${count} loaded samples`,
      ).toBeLessThan(meanBound);
      expect(
        Math.abs(measured / expectedDeviation - 1),
        `the difference has deviation ${measured.toFixed(5)} A, expected ` +
          `${expectedDeviation.toFixed(5)} A over ${count} loaded samples`,
      ).toBeLessThan(NOISE_DEVIATION_TOLERANCE);
    },
    budgetMs(900_000),
  );
});
