// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The idle pressure decay of the last day, in the quiet hours and in the busy
 * ones.
 *
 * The manual separates a leak in the distribution network from a plant that
 * simply draws more air by when the loss happens, not by what it looks like:
 * a leak "runs day and night … the pressure falls at the same rate at night
 * and at the weekend, when no consumer is drawing air", while high demand's
 * "decay follows the production pattern and stops when the plant stops,
 * unlike a leak" (`manual/spec/faults.yaml`, `downstream_air_leak`,
 * `high_air_demand`, and the `low_line_pressure` condition). The check it
 * gives is to "compare the pressure decay of a quiet night with the reference
 * cycle". This module is that check, written for detection:
 *
 *   * **Quiet hours** are the unit's own. The hours of the day in which the
 *     unit loaded least in its first month — `FIRST_MONTH_CYCLES_BY_HOUR`,
 *     read the way every other first-month reference is — are the
 *     hours in which its consumers drew least air. No clock time is written
 *     here: {@link quietHoursOf} reads them off the table.
 *   * **The reference** is the reference cycle's decay band, the first-month
 *     `decay_bar_per_min` band that `unloaded_pressure_decay`'s own level is
 *     read against and that the manual prints as its reference cycle
 *     (`machine.yaml` `pressure_decay_unloaded_band`). A first-month band
 *     cannot drift with the fault it is meant to show.
 *   * **The evidence** is the median decay of the last cycles of each kind
 *     closed within the last day. When the decay turned faster than that band
 *     within the day — three cycles in a row above it, the count `fast_decay`
 *     takes — only the cycles since the first of them count, so the quiet
 *     hours answer the manual's question for the stretch in which the decay
 *     is fast: does it stay fast when the plant draws least air?
 *
 * A closed cycle is a measurement of the machine, taken inside one segment
 * (the cycle tracker never closes a cycle across a gap or a frozen block), so
 * the history survives the guards' resets and ages out by sim time instead:
 * the recording's gaps fall mostly at night, and a history a gap cleared would
 * lose exactly the quiet hours it is kept for.
 */

import { FIRST_MONTH_CYCLES_BY_HOUR } from "./baseline.ts";
import { cycleLevel } from "./buckets.ts";
import { median } from "./cycles.ts";
import type { ByHours, Cycle, Level } from "./types.ts";

/** Which part of the day a cycle's idle phase fell in. */
export type HourClass = "quiet" | "busy";

/** How far back the evidence reaches: one whole day, so it always holds a night. */
export const DAY_LOOKBACK_MS = 24 * 3_600_000;

/**
 * The fewest cycles of one kind a level is read from, and the length of the
 * run that marks the decay as turned fast: the three cycles in a row the
 * `fast_decay` rule takes before it calls a decay fast (`CONSECUTIVE_CYCLES`).
 */
export const HOURS_MIN_CYCLES = 3;

/**
 * How many of the latest cycles of one kind the median is taken over: the
 * five cycles of the frame's own decay median.
 */
export const HOURS_RECENT_CYCLES = 5;

/**
 * An idle phase longer than this is not a cycle: the first-month reference
 * band was computed only over shorter ones (`MAX_NONLOAD_S` of
 * `scripts/data/metropt3_stats.py`), so a longer one — a depot stand, a
 * weekend stop — is left out rather than compared with it.
 */
export const MAX_IDLE_S = 6 * 3600;

/**
 * The hours of the day whose first-month load count lies nearer the quietest
 * hour's than the typical hour's: below the midpoint between the lowest count
 * and the median one.
 *
 * The rule needs no clock time and no share tuned to one unit, and it finds
 * no quiet hours at all in a flat day. `countsByHour` is indexed by hour of the
 * data clock, 0 to 23.
 */
export function quietHoursOf(countsByHour: readonly number[]): ReadonlySet<number> {
  if (countsByHour.length !== 24) {
    throw new Error(`quietHoursOf: expected 24 hourly counts, got ${countsByHour.length}`);
  }
  const lowest = Math.min(...countsByHour);
  const typical = median(countsByHour) as number;
  if (!(typical > lowest)) return new Set<number>();
  const midpoint = (lowest + typical) / 2;
  const quiet = new Set<number>();
  countsByHour.forEach((count, hour) => {
    if (count < midpoint) quiet.add(hour);
  });
  return quiet;
}

/** The unit's quiet hours, from its first month. */
export const QUIET_HOURS: ReadonlySet<number> = quietHoursOf(FIRST_MONTH_CYCLES_BY_HOUR);

/** Which part of the day an instant of the data clock falls in. */
export function hourClassOf(
  simTsMs: number,
  quietHours: ReadonlySet<number> = QUIET_HOURS,
): HourClass {
  return quietHours.has(new Date(simTsMs).getUTCHours()) ? "quiet" : "busy";
}

/** Whether a decay reads faster than the reference cycle allows. */
function isFast(level: Level): boolean {
  return level === "above_normal" || level === "far_above_normal";
}

/** One closed cycle, as the day history keeps it. */
interface Entry {
  /** When the cycle closed: what ages it out. */
  readonly endMs: number;
  readonly decay: number;
  /** Where its idle phase was centred. */
  readonly hourClass: HourClass;
  readonly fast: boolean;
}

/** The last day's idle decay, kept apart by hour class. */
export interface DecayByHours {
  /** Take one closed cycle; one without a decay or with an overlong idle phase is skipped. */
  add(cycle: Cycle): void;
  /**
   * The quiet-hours and busy-hours levels at `nowMs`, or undefined when
   * neither kind has {@link HOURS_MIN_CYCLES} cycles to read.
   */
  levels(nowMs: number): ByHours | undefined;
  /** Cycles held right now (after the last `levels` call pruned them). */
  size(): number;
  /** Forget everything: a new stream starts. */
  clear(): void;
}

export interface DecayByHoursOptions {
  /** The quiet hours; the unit's own by default. */
  readonly quietHours?: ReadonlySet<number>;
}

/** The day history of one stream of samples. */
export function createDecayByHours(options: DecayByHoursOptions = {}): DecayByHours {
  const quietHours = options.quietHours ?? QUIET_HOURS;
  let entries: Entry[] = [];

  /** Keep the cycles closed within the last day, and none from after `nowMs`. */
  function prune(nowMs: number): void {
    const oldest = nowMs - DAY_LOOKBACK_MS;
    entries = entries.filter((entry) => entry.endMs > oldest && entry.endMs <= nowMs);
  }

  /** Where the decay turned fast within the day: the first of three fast cycles in a row. */
  function onsetIndex(): number | undefined {
    let run = 0;
    for (let index = 0; index < entries.length; index += 1) {
      run = (entries[index] as Entry).fast ? run + 1 : 0;
      if (run === HOURS_MIN_CYCLES) return index - HOURS_MIN_CYCLES + 1;
    }
    return undefined;
  }

  function levelOf(kind: readonly Entry[]): Level | undefined {
    if (kind.length < HOURS_MIN_CYCLES) return undefined;
    const recent = kind.slice(-HOURS_RECENT_CYCLES).map((entry) => entry.decay);
    return cycleLevel("decay_bar_per_min", median(recent) as number);
  }

  return {
    add(cycle: Cycle): void {
      const decay = cycle.decay_bar_per_min;
      if (decay === undefined || cycle.nonloaded_s > MAX_IDLE_S) return;
      const idleMidMs = (cycle.cutout_sim_ts_ms + cycle.end_sim_ts_ms) / 2;
      entries.push({
        endMs: cycle.end_sim_ts_ms,
        decay,
        hourClass: hourClassOf(idleMidMs, quietHours),
        fast: isFast(cycleLevel("decay_bar_per_min", decay)),
      });
    },

    levels(nowMs: number): ByHours | undefined {
      prune(nowMs);
      const from = onsetIndex() ?? 0;
      const since = entries.slice(from);
      const quiet = levelOf(since.filter((entry) => entry.hourClass === "quiet"));
      const busy = levelOf(since.filter((entry) => entry.hourClass === "busy"));
      if (quiet === undefined && busy === undefined) return undefined;
      return { quiet, busy };
    },

    size(): number {
      return entries.length;
    },

    clear(): void {
      entries = [];
    },
  };
}
