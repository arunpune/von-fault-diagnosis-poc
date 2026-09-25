// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `reservoir_pressure_mismatch` → `reservoir_deviation`.
 *
 * The reservoir gauge and the line gauge read the same air and normally track
 * each other to within a couple of millibar. A difference of more than
 * 0.3 bar held for five minutes is one of the two instruments drifting, or a
 * valve between them that should be open.
 */

import type { FeatureFrame } from "../types.ts";
import { hit, type Rule, type RuleHit } from "./types.ts";

/** The difference the two gauges are allowed, in bar. */
export const MISMATCH_BAR = 0.3;

export const reservoirPressureMismatch: Rule = {
  id: "reservoir_pressure_mismatch",
  symptom_key: "reservoir_deviation",
  severity_hint: "low",
  hold_s: 300,
  clear_s: 300,
  metric: { signal: "reservoirs" },

  evaluate(frame: FeatureFrame): RuleHit | null {
    const difference = frame.reservoirs_minus_tp3;
    if (difference === undefined || Math.abs(difference) <= MISMATCH_BAR) return null;

    return hit(
      reservoirPressureMismatch,
      frame,
      "The reservoir gauge and the line gauge disagree by more than they normally do.",
      { value: difference, threshold: MISMATCH_BAR, unit: frame.signals.reservoirs.unit },
    );
  },
};
