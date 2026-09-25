// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `motor_current_low` → `motor_current_low`.
 *
 * The motor draws less than the first month's loaded band while it is
 * supposed to be delivering: it is not compressing as much air as it should,
 * which is the weak half of signature A.
 *
 * The first thirty seconds of a run are excluded because the current is still
 * settling from the start peak, and the sixty-second median would otherwise
 * read low on a perfectly healthy cut-in.
 */

import type { FeatureFrame } from "../types.ts";
import { hit, type Rule, type RuleHit } from "./types.ts";

/** Loaded current below this is outside the first-month band, in A. */
export const MOTOR_CURRENT_LOW_A = 5.2;

/** The settling time at the start of a loaded run, in seconds. */
export const SETTLE_S = 30;

export const motorCurrentLow: Rule = {
  id: "motor_current_low",
  symptom_key: "motor_current_low",
  severity_hint: "medium",
  hold_s: 60,
  clear_s: 60,
  metric: { signal: "motor_current" },

  evaluate(frame: FeatureFrame): RuleHit | null {
    if (frame.mode !== "loaded") return null;
    const runS = frame.loaded_run_s;
    if (runS === undefined || runS <= SETTLE_S) return null;
    const current = frame.motor_current_loaded_a;
    if (current === undefined || current >= MOTOR_CURRENT_LOW_A) return null;

    return hit(
      motorCurrentLow,
      frame,
      "Motor current under load is below the band this machine normally draws.",
      {
        value: current,
        threshold: MOTOR_CURRENT_LOW_A,
        unit: frame.signals.motor_current.unit,
      },
    );
  },
};
