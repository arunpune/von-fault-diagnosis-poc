// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `dryer_tower_not_switching` → `dryer_changeover_fault`.
 *
 * A healthy dryer pulses its towers over shortly after every cut-in — the
 * first month shows the pulse in all but a handful of cycles (`towers_pulse_s`
 * p5 is already 40 s). Three cycles in a row without one means the changeover
 * is not happening; the air keeps flowing, which is why the hint is `low`, but
 * the drying stops.
 */

import type { FeatureFrame } from "../types.ts";
import { hit, type Rule, type RuleHit } from "./types.ts";

/** Cycles without a changeover pulse before the rule fires. */
export const MISSING_CYCLES = 3;

export const dryerTowerNotSwitching: Rule = {
  id: "dryer_tower_not_switching",
  symptom_key: "dryer_changeover_fault",
  severity_hint: "low",
  hold_s: 0,
  clear_s: 0,
  metric: { signal: "towers" },

  evaluate(frame: FeatureFrame): RuleHit | null {
    if (frame.towers_pulse_missing_cycles < MISSING_CYCLES) return null;

    return hit(
      dryerTowerNotSwitching,
      frame,
      "The dryer has not pulsed its towers over at the start of the last few load cycles.",
      { value: frame.towers_pulse_missing_cycles, threshold: MISSING_CYCLES, unit: "cycles" },
    );
  },
};
