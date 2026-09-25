// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The idle decay of the last day by kind of hour.
 *
 * The history itself is exercised on hand-built cycles; the detector on
 * synthetic stretches written from the manual's reference cycle
 * (`test/fixtures/synthetic/quiet-hours.ts`): a network leak drains the line
 * fast in every hour, a plant drawing more air drains it fast only while it
 * works, and a healthy unit keeps the reference cycle all day. No labelled
 * window is replayed.
 */

import { SIGNALS, validate, type Sample } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { fixedClock } from "../clock.ts";
import {
  FAST_DECAY_BAR_PER_MIN,
  demandDecay,
  leakDecay,
  referenceDecay,
  samplesOf,
  stretchRows,
  type DayStretch,
} from "../../test/fixtures/synthetic/quiet-hours.ts";
import { NORMAL_DECAY_BAR_PER_MIN, runRows } from "../../test/fixtures/synthetic/waveform.ts";
import type { DecodedRow } from "../../test/fixtures/telemetry/rows.ts";
import { FIRST_MONTH_CYCLE_BANDS, FIRST_MONTH_CYCLES_BY_HOUR } from "./baseline.ts";
import { CYCLE_MEDIAN_CYCLES, createFeatureEngine, toContractObservation } from "./features.ts";
import { createDetector } from "./index.ts";
import {
  DAY_LOOKBACK_MS,
  HOURS_MIN_CYCLES,
  HOURS_RECENT_CYCLES,
  MAX_IDLE_S,
  QUIET_HOURS,
  createDecayByHours,
  hourClassOf,
  quietHoursOf,
} from "./quiet-hours.ts";
import { CONSECUTIVE_CYCLES } from "./rules/fast-decay.ts";
import { resolveRoles } from "./signals.ts";
import type { ByHours, Cycle, FeatureFrame, Observation } from "./types.ts";

const roles = resolveRoles(SIGNALS);
const HOUR_MS = 3_600_000;
const isQuiet = (hour: number): boolean => QUIET_HOURS.has(hour);

/** An hour of the data clock inside, and one outside, the unit's quiet hours. */
const A_QUIET_HOUR = Math.min(...QUIET_HOURS);
const A_BUSY_HOUR = [...Array(24).keys()].find((hour) => !QUIET_HOURS.has(hour)) as number;

/** 3 February 2020 at `hour` plus `minutes`, in the data clock. */
function at(hour: number, minutes = 0, dayOffset = 0): number {
  return Date.UTC(2020, 1, 3 + dayOffset, hour, minutes);
}

/**
 * One closed cycle whose idle phase is centred on `midMs`: the only fields the
 * history reads are the decay, the idle length and the three instants.
 */
function cycleCentredOn(midMs: number, decay: number | undefined, idleS = 1200): Cycle {
  const cutoutMs = midMs - (idleS * 1000) / 2;
  const endMs = midMs + (idleS * 1000) / 2;
  const cutinMs = cutoutMs - 109_000;
  return {
    cutin_sim_ts: new Date(cutinMs).toISOString(),
    cutin_sim_ts_ms: cutinMs,
    cutout_sim_ts: new Date(cutoutMs).toISOString(),
    cutout_sim_ts_ms: cutoutMs,
    end_sim_ts_ms: endMs,
    loaded_s: 109,
    unloaded_s: Math.min(407, idleS),
    off_s: Math.max(0, idleS - 407),
    nonloaded_s: idleS,
    period_s: 109 + idleS,
    cutin_tp3: 8.05,
    cutout_tp3: 10.03,
    cut_out_reached: true,
    decay_bar_per_min: decay,
    rise_bar_per_min: 1.09,
    tp2_minus_tp3_loaded: 0.32,
    motor_current_loaded: 6,
    start_current_peak: 7.2,
    dv_pressure_loaded: -0.018,
    dv_pressure_loaded_max: -0.016,
    towers_pulse: true,
    h1_return_s: 20,
    oil_max: 57,
  };
}

/** `count` cycles of one decay, one every `spacingMin` minutes from `fromMs`. */
function cycles(fromMs: number, count: number, decay: number, spacingMin = 30): Cycle[] {
  return Array.from({ length: count }, (_, index) =>
    cycleCentredOn(fromMs + index * spacingMin * 60_000, decay),
  );
}

const REFERENCE = NORMAL_DECAY_BAR_PER_MIN;
const FAST = FAST_DECAY_BAR_PER_MIN;

describe("the unit's quiet hours", () => {
  it("are the hours whose first-month load count lies below the midpoint of the quietest and the typical hour", () => {
    const counts = FIRST_MONTH_CYCLES_BY_HOUR;
    const sorted = [...counts].sort((left, right) => left - right);
    const typical = ((sorted[11] as number) + (sorted[12] as number)) / 2;
    const midpoint = ((sorted[0] as number) + typical) / 2;
    const expected = counts.flatMap((count, hour) => (count < midpoint ? [hour] : []));
    expect([...QUIET_HOURS].sort((left, right) => left - right)).toEqual(expected);
  });

  it("come out of the first month as the five hours from midnight, in the data clock", () => {
    // A reading of the table, not an input: nothing in the code names an hour.
    expect([...QUIET_HOURS].sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4]);
  });

  it("each saw fewer first-month loads than any busy hour", () => {
    const quiet = FIRST_MONTH_CYCLES_BY_HOUR.filter((_, hour) => QUIET_HOURS.has(hour));
    const busy = FIRST_MONTH_CYCLES_BY_HOUR.filter((_, hour) => !QUIET_HOURS.has(hour));
    expect(Math.max(...quiet)).toBeLessThan(Math.min(...busy));
  });

  it("counts the table the constant was transcribed from", () => {
    expect(FIRST_MONTH_CYCLES_BY_HOUR).toHaveLength(24);
    // first_month.cycles.cycles of the statistics JSON.
    expect(FIRST_MONTH_CYCLES_BY_HOUR.reduce((sum, count) => sum + count, 0)).toBe(1165);
  });

  it("are none at all in a day without a quiet stretch", () => {
    expect(quietHoursOf(Array(24).fill(40)).size).toBe(0);
  });

  it("follow the table, whichever hours are the quiet ones", () => {
    const counts = Array(24).fill(50);
    counts[13] = 10;
    counts[14] = 12;
    expect([...quietHoursOf(counts)].sort((left, right) => left - right)).toEqual([13, 14]);
  });

  it("refuse a table that is not one count per hour", () => {
    expect(() => quietHoursOf([1, 2, 3])).toThrow(/24 hourly counts/);
  });

  it("are read on the data clock the replay keeps", () => {
    expect(hourClassOf(at(A_QUIET_HOUR, 30))).toBe("quiet");
    expect(hourClassOf(at(A_BUSY_HOUR, 30))).toBe("busy");
  });
});

describe("the constants borrow detection's own counts", () => {
  it("reads a level from as few cycles as fast_decay calls a decay fast on", () => {
    expect(HOURS_MIN_CYCLES).toBe(CONSECUTIVE_CYCLES);
  });

  it("takes its median over as many cycles as the frame's own decay median", () => {
    expect(HOURS_RECENT_CYCLES).toBe(CYCLE_MEDIAN_CYCLES);
  });

  it("calls fast what the reference cycle's band calls above normal", () => {
    const history = createDecayByHours();
    const justAbove = FIRST_MONTH_CYCLE_BANDS.decay_bar_per_min.p95 + 0.001;
    for (const cycle of cycles(at(A_BUSY_HOUR), 3, justAbove)) history.add(cycle);
    expect(history.levels(at(A_BUSY_HOUR, 0, 1) - 1)?.busy).toBe("above_normal");
  });
});

describe("the day history", () => {
  it("has nothing to say before any cycle closed", () => {
    expect(createDecayByHours().levels(at(12))).toBeUndefined();
  });

  it("needs three cycles of a kind before it reads that kind", () => {
    const history = createDecayByHours();
    for (const cycle of cycles(at(A_QUIET_HOUR), 2, REFERENCE)) history.add(cycle);
    expect(history.levels(at(A_QUIET_HOUR, 59))).toBeUndefined();

    history.add(cycleCentredOn(at(A_QUIET_HOUR, 50), REFERENCE));
    expect(history.levels(at(A_QUIET_HOUR + 1, 30))).toEqual({ quiet: "normal", busy: undefined });
  });

  it("reads each kind against the reference cycle's band, apart from the other", () => {
    const history = createDecayByHours();
    const slow = FIRST_MONTH_CYCLE_BANDS.decay_bar_per_min.p1 - 0.01;
    for (const cycle of cycles(at(A_QUIET_HOUR), 3, REFERENCE)) history.add(cycle);
    for (const cycle of cycles(at(A_BUSY_HOUR), 3, slow)) history.add(cycle);
    expect(history.levels(at(23))).toEqual({ quiet: "normal", busy: "far_below_normal" });
  });

  it("takes the median of the latest five of a kind", () => {
    const history = createDecayByHours();
    // One slow early cycle, then five at the reference: the median forgets it.
    history.add(cycleCentredOn(at(A_BUSY_HOUR), 0.01));
    for (const cycle of cycles(at(A_BUSY_HOUR, 30), 5, REFERENCE)) history.add(cycle);
    expect(history.levels(at(23))?.busy).toBe("normal");
  });

  it("reads a leak: fast in the busy hours and fast again in the quiet hours after them", () => {
    const history = createDecayByHours();
    for (const cycle of cycles(at(18), 8, FAST)) history.add(cycle);
    for (const cycle of cycles(at(0, 0, 1), 6, FAST)) history.add(cycle);
    expect(history.levels(at(4, 0, 1))).toEqual({
      quiet: "far_above_normal",
      busy: "far_above_normal",
    });
  });

  it("reads a demand: fast in the busy hours, back to the reference when the plant is quiet", () => {
    const history = createDecayByHours();
    for (const cycle of cycles(at(18), 8, FAST)) history.add(cycle);
    for (const cycle of cycles(at(0, 0, 1), 6, REFERENCE)) history.add(cycle);
    expect(history.levels(at(4, 0, 1))).toEqual({ quiet: "normal", busy: "far_above_normal" });
  });

  it("counts only the quiet hours after the decay turned fast: a night before it says nothing", () => {
    const history = createDecayByHours();
    for (const cycle of cycles(at(0), 6, REFERENCE)) history.add(cycle);
    for (const cycle of cycles(at(8), 6, REFERENCE)) history.add(cycle);
    for (const cycle of cycles(at(12), 4, FAST)) history.add(cycle);
    // The night was normal, but it came before the loss began: it cannot
    // tell a leak from a plant drawing more air.
    expect(history.levels(at(14))).toEqual({ quiet: undefined, busy: "far_above_normal" });
  });

  it("does not take a lone fast cycle for the moment the decay turned fast", () => {
    const history = createDecayByHours();
    for (const cycle of cycles(at(0), 4, REFERENCE)) history.add(cycle);
    history.add(cycleCentredOn(at(9), FAST));
    for (const cycle of cycles(at(10), 3, REFERENCE)) history.add(cycle);
    for (const cycle of cycles(at(13), 2, FAST)) history.add(cycle);
    expect(history.levels(at(15))).toEqual({ quiet: "normal", busy: "normal" });
  });

  it("forgets a cycle a day after it closed", () => {
    const history = createDecayByHours();
    const batch = cycles(at(A_QUIET_HOUR), 3, REFERENCE);
    for (const cycle of batch) history.add(cycle);
    const firstEnd = (batch[0] as Cycle).end_sim_ts_ms;
    expect(history.levels(firstEnd + DAY_LOOKBACK_MS - 1)?.quiet).toBe("normal");
    // A day after the first one closed, two are left: too few to read.
    expect(history.levels(firstEnd + DAY_LOOKBACK_MS)).toBeUndefined();
    expect(history.size()).toBe(2);
  });

  it("drops the cycles from after the present when the clock goes back", () => {
    const history = createDecayByHours();
    for (const cycle of cycles(at(A_QUIET_HOUR, 0, 2), 3, FAST)) history.add(cycle);
    expect(history.levels(at(A_QUIET_HOUR, 0, 1))).toBeUndefined();
    expect(history.size()).toBe(0);
  });

  it("skips a cycle without a decay and one idle for longer than the reference ever was", () => {
    const history = createDecayByHours();
    history.add(cycleCentredOn(at(A_QUIET_HOUR), undefined));
    history.add(cycleCentredOn(at(A_QUIET_HOUR, 30), REFERENCE, MAX_IDLE_S + 10));
    expect(history.size()).toBe(0);
  });

  it("files a cycle under the hour its idle phase was centred in", () => {
    const history = createDecayByHours();
    const lastQuiet = Math.max(...QUIET_HOURS);
    // Cut out in the last quiet hour, but idle mostly in the first busy one.
    for (let index = 0; index < 3; index += 1) {
      history.add(cycleCentredOn(at(lastQuiet + 1, 15 + index * 10), REFERENCE, 2400));
    }
    expect(history.levels(at(lastQuiet + 2))).toEqual({ quiet: undefined, busy: "normal" });
  });

  it("forgets everything when a new stream starts", () => {
    const history = createDecayByHours();
    for (const cycle of cycles(at(A_QUIET_HOUR), 3, REFERENCE)) history.add(cycle);
    history.clear();
    expect(history.levels(at(A_QUIET_HOUR + 2))).toBeUndefined();
  });

  it("follows the quiet hours it is given", () => {
    const history = createDecayByHours({ quietHours: new Set([A_BUSY_HOUR]) });
    for (const cycle of cycles(at(A_BUSY_HOUR, 10), 3, REFERENCE, 10)) history.add(cycle);
    expect(history.levels(at(A_BUSY_HOUR + 2))).toEqual({ quiet: "normal", busy: undefined });
  });
});

/** The decay behaviour of the frame at the end of a stream. */
function lastDecayByHours(samples: readonly Sample[]): {
  frame: FeatureFrame;
  byHours: ByHours | undefined;
} {
  const engine = createFeatureEngine({ roles });
  let frame: FeatureFrame | undefined;
  for (const sample of samples) frame = engine.push(sample).frame ?? frame;
  if (frame === undefined) throw new Error("no frame");
  return { frame, byHours: frame.behaviours.unloaded_pressure_decay.by_hours };
}

/** A stretch from 18:00 on 3 February, fourteen hours long: an evening, a night and a morning. */
function evening(decayAt: DayStretch["decayAt"], hours = 14): DecodedRow[] {
  return stretchRows({ startSimTs: "2020-02-03T18:00:00.000Z", hours, decayAt });
}

describe("detection over synthetic stretches written from the manual", () => {
  it("reads a leak as faster than usual in the busy hours and in the quiet ones", () => {
    expect(lastDecayByHours(samplesOf(evening(leakDecay))).byHours).toEqual({
      quiet: "far_above_normal",
      busy: "far_above_normal",
    });
  });

  it("reads a plant drawing more air as faster only in the busy hours", () => {
    expect(lastDecayByHours(samplesOf(evening(demandDecay(isQuiet)))).byHours).toEqual({
      quiet: "normal",
      busy: "far_above_normal",
    });
  });

  it("reads a healthy unit as usual in both", () => {
    expect(lastDecayByHours(samplesOf(evening(referenceDecay))).byHours).toEqual({
      quiet: "normal",
      busy: "normal",
    });
  });

  it("has seen no quiet hour yet on the evening a leak starts", () => {
    const { byHours } = lastDecayByHours(samplesOf(evening(leakDecay, 5)));
    expect(byHours).toEqual({ quiet: undefined, busy: "far_above_normal" });
  });

  it("carries the evidence on the decay observation of the suspect event, and nowhere else", () => {
    let next = 0;
    const detector = createDetector({
      roles,
      wall: fixedClock("2026-09-21T00:00:00.000Z"),
      newEventId: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    });
    for (const sample of samplesOf(evening(leakDecay))) detector.push(sample);
    const event = detector.buildEvent();
    expect(event).toBeDefined();
    expect(validate("suspect-event", event).ok).toBe(true);
    const withHours = event?.observations.filter((observation) => observation.by_hours) ?? [];
    expect(withHours.map((observation) => observation.signal)).toEqual(["unloaded_pressure_decay"]);
    expect(withHours[0]?.by_hours).toEqual({ quiet: "far_above", busy: "far_above" });
  });

  it("writes a kind of hour it has not seen as unknown on the wire", () => {
    const observation: Observation = {
      signal_id: "unloaded_pressure_decay",
      label: "Pressure decay while not delivering",
      level: "far_above_normal",
      trend: "flat",
      since: "about_an_hour",
      stat: "slope",
      value: FAST,
      unit: "bar/min",
      window_s: 340,
      mode: "unloaded",
      by_hours: { quiet: undefined, busy: "far_above_normal" },
    };
    expect(toContractObservation(observation).by_hours).toEqual({
      quiet: "unknown",
      busy: "far_above",
    });
    const without: Observation = { ...observation, by_hours: undefined };
    expect(toContractObservation(without)).not.toHaveProperty("by_hours");
  });
});

/** Shift every row from `fromMs` on by `shiftMs`, keeping the ten-second step inside. */
function shiftFrom(rows: readonly DecodedRow[], fromMs: number, shiftMs: number): DecodedRow[] {
  return rows.map((row) =>
    row.simTsMs < fromMs ? row : { ...row, simTsMs: row.simTsMs + shiftMs },
  );
}

describe("the guards' resets", () => {
  it("keep the day history across a gap in the logging, while the windows start again", () => {
    // A leak all evening and night, then a ten-minute hole in the logging in
    // the last quiet hour: the next cycle after it still reads the night.
    const rows = shiftFrom(evening(leakDecay), at(4, 30, 1), 10 * 60_000);
    const engine = createFeatureEngine({ roles });
    let reset = false;
    let firstAfter: ByHours | undefined;
    for (const sample of samplesOf(rows)) {
      const update = engine.push(sample);
      if (update.reset === "discontinuity") reset = true;
      const decay = update.frame?.behaviours.unloaded_pressure_decay;
      if (reset && firstAfter === undefined && decay?.value !== undefined)
        firstAfter = decay.by_hours;
    }
    expect(reset).toBe(true);
    expect(firstAfter).toEqual({ quiet: "far_above_normal", busy: "far_above_normal" });
  });

  it("forget it when the clock jumps back to a day the history knows nothing about", () => {
    const rows = evening(leakDecay);
    const cut = at(5, 0, 1);
    const back = shiftFrom(rows, cut, -2 * 24 * HOUR_MS);
    const { byHours } = lastDecayByHours(samplesOf(back));
    // Two days back and three hours of evening cycles: no quiet hour seen.
    expect(byHours?.quiet).toBeUndefined();
  });

  it("keep it through a stalled logger, which adds no cycle of its own", () => {
    const rows = evening(demandDecay(isQuiet));
    const stallAt = rows.findIndex((row) => row.simTsMs >= at(3, 0, 1));
    const stalled = rows[stallAt] as DecodedRow;
    // Seventy repeats of one row, ten seconds apart: the frozen guard trips at
    // sixty, and the logger moves again when the stream resumes after them.
    const frozen: DecodedRow[] = Array.from({ length: 70 }, (_, index) => ({
      ...stalled,
      simTsMs: stalled.simTsMs + index * 10_000,
    }));
    const tail = rows.slice(stallAt + 1).map((row) => ({ ...row, simTsMs: row.simTsMs + 700_000 }));
    const stream = [...rows.slice(0, stallAt), ...frozen, ...tail];

    const engine = createFeatureEngine({ roles });
    let before: ByHours | undefined;
    let unfrozen = false;
    let after: ByHours | undefined;
    for (const sample of samplesOf(stream)) {
      const update = engine.push(sample);
      const frame = update.frame;
      if (update.reset === "frozen") {
        unfrozen = true;
        // The cycle tracker starts again; the day history does not.
        expect(engine.cycles()).toHaveLength(0);
      }
      if (frame === undefined) continue;
      if (!unfrozen && !frame.guards.frozen)
        before = frame.behaviours.unloaded_pressure_decay.by_hours;
      if (unfrozen) after = frame.behaviours.unloaded_pressure_decay.by_hours;
    }
    expect(unfrozen).toBe(true);
    expect(before).toEqual({ quiet: "normal", busy: "far_above_normal" });
    expect(after).toEqual(before);
  });

  it("still carry the day when a late leak keeps the unit loaded after a gap and no cycle closes", () => {
    // A leak all evening and night, a ten-minute hole in the logging, then the
    // unit loads and cannot keep up: the line sinks through the switch.
    const night = evening(leakDecay, 11);
    const resumeMs = (night[night.length - 1] as DecodedRow).simTsMs + 10 * 60_000;
    const late = runRows([{ mode: "loaded", seconds: 900, fromBar: 8.05, toBar: 6.4 }], {
      startSimTs: new Date(resumeMs).toISOString(),
    });
    let next = 0;
    const detector = createDetector({
      roles,
      wall: fixedClock("2026-09-21T00:00:00.000Z"),
      newEventId: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    });
    const after = [];
    for (const sample of samplesOf([...night, ...late])) {
      const output = detector.push(sample);
      if (Date.parse(sample.sim_ts) >= resumeMs) after.push(...output.events);
    }
    const event = after[after.length - 1];
    expect(event?.symptom_key).toBe("low_line_pressure");
    expect(validate("suspect-event", event).ok).toBe(true);

    // The newest decay is unknown, and the row says so; the day it read before
    // the gap travels beside it, last, with no ticket sentence of its own.
    const decay = event?.observations.find(
      (observation) => observation.signal === "unloaded_pressure_decay",
    );
    expect(decay).toEqual({
      signal: "unloaded_pressure_decay",
      level: "unknown",
      trend: "unknown",
      by_hours: { quiet: "far_above", busy: "far_above" },
    });
    expect(event?.observations[event.observations.length - 1]).toBe(decay);
    expect(event?.evidence.map((item) => item.metric)).not.toContain("unloaded_pressure_decay");
  });

  it("clear it on a caller's reset, which starts a new stream", () => {
    const engine = createFeatureEngine({ roles });
    for (const sample of samplesOf(evening(leakDecay))) engine.push(sample);
    engine.reset("startup");
    // The next stream carries on from where the leak's night ended, so only
    // the reset can have emptied the history.
    const morning = stretchRows({
      startSimTs: "2020-02-04T09:00:00.000Z",
      hours: 3,
      decayAt: referenceDecay,
    });
    let byHours: ByHours | undefined;
    for (const sample of samplesOf(morning)) {
      byHours = engine.push(sample).frame?.behaviours.unloaded_pressure_decay.by_hours ?? byHours;
    }
    expect(byHours).toEqual({ quiet: undefined, busy: "normal" });
  });
});
