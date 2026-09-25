// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `discharge_differential_low` → `motor_current_low`.
 *
 * While the compressor delivers, the discharge side normally sits about a
 * third of a bar above the line (first-month median 0.322 bar). When that gap
 * collapses the element is making little of the difference it should, or the
 * check valve is not holding it — the same story the low motor current tells,
 * which is why the two share a symptom.
 */

import type { FeatureFrame } from "../types.ts";
import { hit, type Rule, type RuleHit } from "./types.ts";

/** The loaded discharge-to-line difference this rule fires under, in bar. */
export const DIFFERENTIAL_LOW_BAR = 0.1;

export const dischargeDifferentialLow: Rule = {
  id: "discharge_differential_low",
  symptom_key: "motor_current_low",
  severity_hint: "medium",
  hold_s: 60,
  clear_s: 60,
  metric: { name: "tp2_minus_tp3_loaded" },

  evaluate(frame: FeatureFrame): RuleHit | null {
    if (frame.mode !== "loaded") return null;
    const difference = frame.tp2_minus_tp3_loaded;
    if (difference === undefined || difference >= DIFFERENTIAL_LOW_BAR) return null;

    return hit(
      dischargeDifferentialLow,
      frame,
      "The discharge side is barely above the line while the compressor is loaded.",
      { value: difference, threshold: DIFFERENTIAL_LOW_BAR, unit: frame.signals.tp2.unit },
    );
  },
};
