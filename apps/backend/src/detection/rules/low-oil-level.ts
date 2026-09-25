// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `low_oil_level` → `oil_level_low`.
 *
 * The float contact says the separator tank is low while the machine is
 * running. Oil sloshes at every start and stop, so the five-minute hold is
 * what turns a contact that chatters into one that means something.
 *
 * The register map already applies the polarity of this tag, and `features.ts`
 * turns it into the run length the frame carries; detection never re-inverts
 * a digital.
 */

import type { FeatureFrame } from "../types.ts";
import { durationWords, hit, type Rule, type RuleHit } from "./types.ts";

/** How long the contact must stay closed while running, in seconds. */
export const LOW_FOR_S = 300;

export const lowOilLevel: Rule = {
  id: "low_oil_level",
  symptom_key: "oil_level_low",
  severity_hint: "medium",
  hold_s: LOW_FOR_S,
  clear_s: LOW_FOR_S,
  metric: { signal: "oil_level" },

  evaluate(frame: FeatureFrame): RuleHit | null {
    if (frame.mode === "off" || frame.mode === "unknown") return null;
    if (frame.oil_level_low_s <= 0) return null;

    return hit(
      lowOilLevel,
      frame,
      "The low oil level contact has been closed with the machine running for " +
        `${durationWords(frame.oil_level_low_s * 1000)}.`,
      { value: frame.oil_level_low_s, threshold: LOW_FOR_S, unit: "s" },
    );
  },
};
