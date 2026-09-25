// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `fast_decay` → `low_line_pressure`.
 *
 * Between two loaded runs the line should hold its air. When it drains faster
 * than `max(0.25, 2 × rolling)` bar a minute on three cycles in a row, the
 * system is losing it somewhere downstream — the earliest thing the recording
 * shows before the machine stops keeping up (signature B, docs/dataset.md).
 *
 * The frame has already counted the consecutive fast cycles against the
 * rolling threshold (`features.ts`), so this rule reads the count
 * and repeats the threshold for the evidence.
 */

import { ruleThreshold } from "../baseline.ts";
import type { FeatureFrame } from "../types.ts";
import { hit, type Rule, type RuleContext, type RuleHit } from "./types.ts";

/** Consecutive cycles above the decay threshold before the rule fires. */
export const CONSECUTIVE_CYCLES = 3;

export const fastDecay: Rule = {
  id: "fast_decay",
  symptom_key: "low_line_pressure",
  severity_hint: "medium",
  hold_s: 0,
  clear_s: 0,
  metric: { name: "unloaded_pressure_decay" },

  evaluate(frame: FeatureFrame, context: RuleContext): RuleHit | null {
    if (frame.fast_decays_in_row < CONSECUTIVE_CYCLES) return null;
    const decay = frame.decay_median;
    if (decay === undefined) return null;

    return hit(
      fastDecay,
      frame,
      "Line pressure has fallen away faster than usual after cut-out on consecutive cycles.",
      {
        value: decay,
        threshold: ruleThreshold("decay_bar_per_min", context.rolling.decay_bar_per_min),
        unit: "bar/min",
      },
    );
  },
};
