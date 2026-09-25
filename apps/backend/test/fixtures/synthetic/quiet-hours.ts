// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stretches of load cycles whose idle decay follows the hour of the day.
 *
 * The manual tells the two causes of a fast idle decay apart by when it
 * happens (`manual/spec/faults.yaml`): a leak in the distribution network
 * "runs day and night … the pressure falls at the same rate at night and at
 * the weekend, when no consumer is drawing air", while a plant drawing more
 * air than the unit delivers has a decay that "follows the production pattern
 * and stops when the plant stops, unlike a leak". Three shapes follow from it,
 * on top of `waveform.ts`'s reference cycle:
 *
 *   * `referenceDecay` — the reference cycle all day: 0.069 bar/min, the
 *     first-month median, which `machine.yaml` prints as the reference
 *     operation's 0.07 bar/min (band 0.05–0.15);
 *   * `leakDecay` — the same fast decay in every hour;
 *   * `demandDecay` — the fast decay in the busy hours and the reference one in
 *     the quiet hours, which the caller names.
 *
 * "Fast" is 0.35 bar/min: well past the reference band's 0.15 and past the
 * `fast_decay` floor of 0.25 bar/min, so the rule fires on
 * it as it would on a real loss. No number here comes from a labelled window
 * or from `injections.json`.
 */

import type { Sample } from "@fdp/contracts";

import { toBatches, type DecodedRow } from "../telemetry/rows.ts";
import {
  BASELINE_CYCLE,
  NORMAL_DECAY_BAR_PER_MIN,
  cyclePhases,
  runRows,
  type Phase,
} from "./waveform.ts";

/** A decay well above the reference band and the fast-decay floor. */
export const FAST_DECAY_BAR_PER_MIN = 0.35;

/** The idle decay a stretch runs at in each hour of the data clock. */
export type DecayAt = (hourOfDay: number) => number;

/** The reference cycle all day. */
export const referenceDecay: DecayAt = () => NORMAL_DECAY_BAR_PER_MIN;

/** A network leak: the same loss in every hour, whether the plant draws air or not. */
export const leakDecay: DecayAt = () => FAST_DECAY_BAR_PER_MIN;

/** A plant drawing more air: fast while it works, the reference cycle while it is quiet. */
export function demandDecay(isQuiet: (hourOfDay: number) => boolean): DecayAt {
  return (hour) => (isQuiet(hour) ? NORMAL_DECAY_BAR_PER_MIN : FAST_DECAY_BAR_PER_MIN);
}

/** One stretch: where it starts, how long it runs and how fast the line drains. */
export interface DayStretch {
  readonly startSimTs: string;
  readonly hours: number;
  readonly decayAt: DecayAt;
}

/**
 * The phases of a stretch, one reference-shaped cycle after another, each
 * draining at the rate its cut-in hour asks for.
 */
export function stretchPhases(stretch: DayStretch): Phase[] {
  const startMs = Date.parse(stretch.startSimTs);
  const endS = stretch.hours * 3600;
  const phases: Phase[] = [];
  let elapsedS = 0;
  while (elapsedS < endS) {
    const hour = new Date(startMs + elapsedS * 1000).getUTCHours();
    const cycle = cyclePhases({ ...BASELINE_CYCLE, decayBarPerMin: stretch.decayAt(hour) });
    phases.push(...cycle);
    elapsedS += cycle.reduce((sum, phase) => sum + phase.seconds, 0);
  }
  return phases;
}

/** The rows of a stretch, as a gateway would have decoded them. */
export function stretchRows(stretch: DayStretch): DecodedRow[] {
  return runRows(stretchPhases(stretch), { startSimTs: stretch.startSimTs });
}

/** Rows as the samples a detector takes; a step over a minute is flagged as a gap. */
export function samplesOf(rows: readonly DecodedRow[]): Sample[] {
  return toBatches(rows, {
    unitId: "cau-7",
    wallStartMs: Date.parse("2026-09-21T00:00:00.000Z"),
  }).flatMap((batch) => batch.samples);
}
