// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `flow_pulses_missing` → `no_flow_signal`.
 *
 * The flow meter stops pulsing while the compressor is delivering, which is a
 * fault of the instrument rather than of the machine. It is the one rule the
 * registry ships disabled (`RULES_DISABLED`, `rules/index.ts`): the recording
 * holds long stretches where the counter simply does not move, and none of
 * them is a compressor fault.
 */

import type { FeatureFrame } from "../types.ts";
import { hit, type Rule, type RuleHit } from "./types.ts";

/** How long the counter may stand still while loaded, in seconds. */
export const STUCK_S = 600;

export const flowPulsesMissing: Rule = {
  id: "flow_pulses_missing",
  symptom_key: "no_flow_signal",
  severity_hint: "low",
  hold_s: 600,
  clear_s: 600,
  metric: { signal: "caudal_impulses" },

  evaluate(frame: FeatureFrame): RuleHit | null {
    if (frame.mode !== "loaded") return null;
    if (frame.caudal_stuck_s <= STUCK_S) return null;

    return hit(
      flowPulsesMissing,
      frame,
      "The flow meter has sent no pulse while the compressor was delivering.",
      { value: frame.caudal_stuck_s, threshold: STUCK_S, unit: "s" },
    );
  },
};
