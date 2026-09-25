// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `low_pressure_switch` → `low_line_pressure`.
 *
 * The switch closes when the line falls through its setpoint. With the motor
 * running that means demand has beaten supply and the plant is about to lose
 * air, which is why this is the one `critical` hint in the registry.
 *
 * A depot depressurisation closes the same contact with the motor stopped, so
 * the state test excludes `off` and the `parked` guard removes the
 * rest before the rule is ever evaluated.
 */

import type { FeatureFrame } from "../types.ts";
import { durationWords, hit, type Rule, type RuleHit } from "./types.ts";

export const lowPressureSwitch: Rule = {
  id: "low_pressure_switch",
  symptom_key: "low_line_pressure",
  severity_hint: "critical",
  hold_s: 60,
  clear_s: 60,
  metric: { signal: "lps" },

  evaluate(frame: FeatureFrame): RuleHit | null {
    if (frame.mode === "off" || frame.mode === "unknown") return null;
    if (frame.lps_active_s <= 0) return null;

    const line = frame.signals.tp3;
    return hit(
      lowPressureSwitch,
      frame,
      "The low-pressure switch has been closed with the motor running for " +
        `${durationWords(frame.lps_active_s * 1000)}.`,
      { value: line.value, unit: line.unit },
    );
  },
};
