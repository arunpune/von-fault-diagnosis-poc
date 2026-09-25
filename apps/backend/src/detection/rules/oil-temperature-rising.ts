// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `oil_temperature_rising` → `oil_temperature_high`.
 *
 * A cooler that is slowly fouling shows as a climb of more than 4 °C an hour
 * held for two hours, *while the load pattern stays normal*: oil that heats up
 * because the machine is working harder is not a cooling fault, so the cycle
 * rate has to sit inside its first-month band for this to mean anything.
 *
 * It is the quietest rule in the registry — hint `low` — because it fires long
 * before anything is wrong enough to stop for.
 */

import type { FeatureFrame } from "../types.ts";
import { hit, type Rule, type RuleHit } from "./types.ts";

/** The climb above which the oil is warming on its own, in °C per hour. */
export const OIL_TREND_C_PER_H = 4;

export const oilTemperatureRising: Rule = {
  id: "oil_temperature_rising",
  symptom_key: "oil_temperature_high",
  severity_hint: "low",
  hold_s: 7200,
  clear_s: 7200,
  metric: { signal: "oil_temperature" },

  evaluate(frame: FeatureFrame): RuleHit | null {
    const trend = frame.oil_trend_c_per_h;
    if (trend === undefined || trend <= OIL_TREND_C_PER_H) return null;
    // "with `cycles_per_hour` in band": the derived behaviour carries the
    // first-month band of the rate, so `normal` is exactly that test.
    if (frame.behaviours.load_cycle_rate.level !== "normal") return null;

    return hit(
      oilTemperatureRising,
      frame,
      "Oil temperature has been climbing steadily while the load pattern stayed normal.",
      { value: trend, threshold: OIL_TREND_C_PER_H, unit: "C/h" },
    );
  },
};
