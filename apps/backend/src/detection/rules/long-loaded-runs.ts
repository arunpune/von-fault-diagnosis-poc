// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `long_loaded_runs` → `frequent_cycling`.
 *
 * The same picture as `frequent_cycling` seen from the other side: each run
 * still reaches cut-out, but it takes longer than `max(200, 1.5 × rolling)`
 * seconds to get there, in at least three of the last five cycles. The frame
 * counts them against the rolling threshold (`features.ts`).
 */

import { ruleThreshold } from "../baseline.ts";
import type { FeatureFrame } from "../types.ts";
import { hit, type Rule, type RuleContext, type RuleHit } from "./types.ts";

/** Long runs among the last five cycles before the rule fires. */
export const LONG_RUNS_IN_LAST_FIVE = 3;

export const longLoadedRuns: Rule = {
  id: "long_loaded_runs",
  symptom_key: "frequent_cycling",
  severity_hint: "medium",
  hold_s: 0,
  clear_s: 0,
  metric: { name: "loaded_run_duration" },

  evaluate(frame: FeatureFrame, context: RuleContext): RuleHit | null {
    if (frame.long_runs_in_last5 < LONG_RUNS_IN_LAST_FIVE) return null;
    const medianS = frame.loaded_run_median_s;
    if (medianS === undefined) return null;

    return hit(
      longLoadedRuns,
      frame,
      "The loaded runs of the last few cycles are longer than this machine normally needs.",
      {
        value: medianS,
        threshold: ruleThreshold("loaded_run_s", context.rolling.loaded_run_s),
        unit: "s",
      },
    );
  },
};
