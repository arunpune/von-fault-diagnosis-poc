// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Machine state and the four guards (docs/detection.md#machine-state).
 *
 * The state rule is the recording's own: the two intake digitals say whether
 * the compressor delivers, and the motor current separates the run-on from a
 * stopped machine. It agrees with a current-only reading on 99.46 % of the
 * whole file, which is what `state.test.ts` re-measures on a fixture.
 *
 * The guards exist because the recording is not a clean signal: it has 331
 * gaps over a minute, nine blocks where the logger repeated the same values
 * for hours, and depot stops where the line is vented with the motor off. Each
 * of the three would otherwise look like a fault; the fourth guard, `warmup`,
 * keeps a rule from firing on a window that has just been cleared.
 */

import type { MachineMode, Sample } from "@fdp/contracts";

import { analogValue, digitalValue, type SignalRoles } from "./signals.ts";
import type { Guards, ResetReason } from "./types.ts";

/** The motor counts as running at or above this current. */
export const RUNNING_CURRENT_A = 1.0;

/** A step longer than this is a gap, whatever the flags say. */
export const GAP_MS = 60_000;

/** The logger is frozen once the five analog values repeat this often. */
export const FROZEN_SAMPLES = 60;

/** The line counts as vented below this pressure. */
export const PARKED_TP3_BAR = 2.0;

/** Rules stay silent for this many samples after a reset. */
export const WARMUP_SAMPLES = 30;

/**
 * The machine state of one sample.
 *
 * `unknown` is for a sample that does not carry the tags the rule needs; the
 * caller keeps the state it had rather than inventing one.
 */
export function machineMode(sample: Sample, roles: SignalRoles): MachineMode {
  const intakeClosed = digitalValue(sample, roles.comp);
  const loadValve = digitalValue(sample, roles.dv_electric);
  if (intakeClosed === undefined || loadValve === undefined) return "unknown";
  if (!intakeClosed && loadValve) return "loaded";

  const current = analogValue(sample, roles.motor_current);
  if (current === undefined) return "unknown";
  return current >= RUNNING_CURRENT_A ? "unloaded" : "off";
}

/** True when no guard suppresses the rules. */
export function guardsPassed(guards: Guards): boolean {
  return !guards.discontinuity && !guards.frozen && !guards.parked && !guards.warmup;
}

/** What one sample did to the guards. */
export interface GuardUpdate {
  readonly guards: Guards;
  /**
   * Set when the windows must be cleared before this sample is used:
   * `discontinuity` on the sample after a jump, `frozen` on the first sample
   * after the logger started moving again.
   */
  readonly reset: ResetReason | undefined;
}

/** The per-sample guard state of one stream. */
export interface GuardTracker {
  /** Fold one sample in, in sim order. */
  push(sample: Sample, mode: MachineMode, simTsMs: number): GuardUpdate;
  /** Clear the counters; `warmup` holds again for {@link WARMUP_SAMPLES} samples. */
  reset(reason: ResetReason): void;
  /** Samples seen since the last reset. */
  samplesSinceReset(): number;
}

/** The five analog values the frozen guard watches. */
function frozenTuple(sample: Sample, roles: SignalRoles): string | undefined {
  const values = [
    analogValue(sample, roles.tp2),
    analogValue(sample, roles.tp3),
    analogValue(sample, roles.h1),
    analogValue(sample, roles.oil_temperature),
    analogValue(sample, roles.motor_current),
  ];
  if (values.some((value) => value === undefined)) return undefined;
  return values.join("|");
}

/** A guard tracker for one stream of samples. */
export function createGuardTracker(roles: SignalRoles): GuardTracker {
  let lastSimTsMs: number | undefined;
  let lastTuple: string | undefined;
  let repeats = 0;
  let frozen = false;
  let samples = 0;

  function clear(): void {
    lastTuple = undefined;
    repeats = 0;
    frozen = false;
    samples = 0;
  }

  return {
    push(sample: Sample, mode: MachineMode, simTsMs: number): GuardUpdate {
      const stepped =
        lastSimTsMs !== undefined && (simTsMs - lastSimTsMs > GAP_MS || simTsMs < lastSimTsMs);
      const discontinuity = sample.flags.discontinuity || stepped;
      let reset: ResetReason | undefined;

      if (discontinuity) {
        clear();
        reset = "discontinuity";
      }

      const tuple = frozenTuple(sample, roles);
      if (tuple !== undefined && tuple === lastTuple) repeats += 1;
      else repeats = 1;
      lastTuple = tuple;

      const wasFrozen = frozen;
      frozen = repeats >= FROZEN_SAMPLES;
      if (wasFrozen && !frozen && reset === undefined) {
        // The logger moved again: the windows behind this sample hold 60 or
        // more repeated values, so they are cleared and `warmup` holds while
        // the new ones fill. The tuple bookkeeping above is already the new
        // segment's and stays.
        samples = 0;
        reset = "frozen";
      }

      samples += 1;
      lastSimTsMs = simTsMs;

      const tp3 = analogValue(sample, roles.tp3);
      const parked = mode === "off" && tp3 !== undefined && tp3 < PARKED_TP3_BAR;

      return {
        guards: { discontinuity, frozen, parked, warmup: samples < WARMUP_SAMPLES },
        reset,
      };
    },

    reset(_reason: ResetReason): void {
      clear();
    },

    samplesSinceReset(): number {
      return samples;
    },
  };
}
