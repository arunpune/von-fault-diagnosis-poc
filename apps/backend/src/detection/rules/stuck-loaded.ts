// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `stuck_loaded` → `continuous_load`.
 *
 * The compressor has been delivering for longer than ten minutes and the line
 * pressure is not climbing, so it is not going to reach cut-out: whatever it
 * makes is leaving the system somewhere. This is the acute face of both
 * leak signatures (docs/dataset.md), and the one rule that fires with no hold at
 * all — ten minutes of loaded running is already the hold.
 */

import type { FeatureFrame } from "../types.ts";
import { durationWords, hit, type Rule, type RuleHit } from "./types.ts";

/** A loaded run longer than this is no longer a normal top-up. */
export const LOADED_RUN_S = 600;

/** Below this rise the line is not being refilled, in bar per minute. */
export const TP3_SLOPE_BAR_PER_MIN = 0.1;

export const stuckLoaded: Rule = {
  id: "stuck_loaded",
  symptom_key: "continuous_load",
  severity_hint: "high",
  hold_s: 0,
  clear_s: 0,
  metric: { name: "loaded_run_duration" },

  evaluate(frame: FeatureFrame): RuleHit | null {
    if (frame.mode !== "loaded") return null;
    const runS = frame.loaded_run_s;
    const slope = frame.tp3_slope_bar_per_min;
    if (runS === undefined || slope === undefined) return null;
    if (runS <= LOADED_RUN_S || slope >= TP3_SLOPE_BAR_PER_MIN) return null;

    return hit(
      stuckLoaded,
      frame,
      `The unit has been loaded without reaching cut-out for ${durationWords(runS * 1000)}.`,
      { value: runS, threshold: LOADED_RUN_S, unit: "s" },
    );
  },
};
