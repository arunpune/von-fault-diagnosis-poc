// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `oil_temperature_high` → `oil_temperature_high`.
 *
 * The test is on the *minimum* of the last half hour, not on the latest
 * reading: a single hot sample at the end of a long run is ordinary, and what
 * matters is that the oil never came back down. Hot oil has benign causes — a
 * hot day, a busy shift — so the hint stays `medium` and the condition is a
 * co-symptom more often than a fault of its own.
 */

import type { FeatureFrame } from "../types.ts";
import { hit, type Rule, type RuleHit } from "./types.ts";

/** The half-hour minimum above which the oil is called hot, in °C. */
export const OIL_MIN_HIGH_C = 75;

export const oilTemperatureHigh: Rule = {
  id: "oil_temperature_high",
  symptom_key: "oil_temperature_high",
  severity_hint: "medium",
  hold_s: 1800,
  clear_s: 1800,
  metric: { signal: "oil_temperature" },

  evaluate(frame: FeatureFrame): RuleHit | null {
    const minimum = frame.oil_30min_min_c;
    if (minimum === undefined || minimum <= OIL_MIN_HIGH_C) return null;

    return hit(
      oilTemperatureHigh,
      frame,
      "Oil temperature has stayed above its high-temperature limit for the whole of the last half hour.",
      {
        value: minimum,
        threshold: OIL_MIN_HIGH_C,
        unit: frame.signals.oil_temperature.unit,
      },
    );
  },
};
