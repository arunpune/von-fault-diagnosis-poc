// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `frequent_cycling` → `frequent_cycling`.
 *
 * Two ways of saying the same thing, and either is enough: the compressor
 * loads more often than `max(5, 1.8 × rolling)` times an hour over the last
 * two hours, or the motor barely stops between cycles — an off phase whose
 * median has fallen under 250 s. The second is what the recording shows as the
 * decay grows and the run-on timer stops expiring.
 */

import { ABSOLUTE_THRESHOLD, ruleThreshold } from "../baseline.ts";
import type { FeatureFrame } from "../types.ts";
import { hit, type Rule, type RuleContext, type RuleHit } from "./types.ts";

export const frequentCycling: Rule = {
  id: "frequent_cycling",
  symptom_key: "frequent_cycling",
  severity_hint: "medium",
  hold_s: 0,
  clear_s: 0,
  metric: { name: "load_cycle_rate" },

  evaluate(frame: FeatureFrame, context: RuleContext): RuleHit | null {
    const rate = frame.cycles_per_hour;
    const rateThreshold = ruleThreshold("cycles_per_hour", context.rolling.cycles_per_hour);
    if (rate !== undefined && rate > rateThreshold) {
      return hit(
        frequentCycling,
        frame,
        "The compressor is loading more often than this machine normally does.",
        { value: rate, threshold: rateThreshold, unit: "per_hour" },
      );
    }

    const offMedian = frame.off_median_s;
    if (offMedian !== undefined && offMedian < ABSOLUTE_THRESHOLD.off_s) {
      return hit(
        frequentCycling,
        frame,
        "The motor hardly stops between cycles: the off phase is shorter than usual.",
        { value: offMedian, threshold: ABSOLUTE_THRESHOLD.off_s, unit: "s" },
      );
    }

    return null;
  },
};
