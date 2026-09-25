// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `separator_not_venting` → `separator_pressure_abnormal`.
 *
 * The separator discharge port is vented close to atmospheric while the unit
 * delivers and stands at the line pressure once it stops delivering
 * (signals.yaml, `separator_discharge_pressure`), so after cut-out the reading
 * comes back **up** to the line within a few samples. When it takes more than
 * two minutes, or has not come back up at all, the reading has stayed below
 * the line while the unit idles: the side of the manual's separation that
 * faults.yaml gives a drain stuck open ("collapses instead of following the
 * line while the unit idles"), not the vessel held up that a blocked drain
 * shows under load. The rule's id is older than that reading and stays as it
 * is (it never reaches the model); the sentence says what the frames show,
 * in the direction the manual's bands give.
 *
 * The frame reports the elapsed time of a separator that has not come back yet
 * as a lower bound that keeps growing (`features.ts`), so a reading that never
 * comes back up makes this rule fire rather than leaving it silent for ever.
 * During the next loaded run the last closed cycle's time stands, which is why
 * the sentence names both a late return and none.
 */

import type { FeatureFrame } from "../types.ts";
import { hit, type Rule, type RuleHit } from "./types.ts";

/** Seconds after cut-out the separator is given to come back. */
export const H1_RETURN_S = 120;

export const separatorNotVenting: Rule = {
  id: "separator_not_venting",
  symptom_key: "separator_pressure_abnormal",
  severity_hint: "medium",
  hold_s: 0,
  clear_s: 0,
  metric: { signal: "h1" },

  evaluate(frame: FeatureFrame): RuleHit | null {
    const returnS = frame.h1_return_s;
    if (returnS === undefined || returnS <= H1_RETURN_S) return null;

    return hit(
      separatorNotVenting,
      frame,
      "After cut-out the separator discharge pressure was slow to come back up to the line " +
        "pressure, or has not come back up yet.",
      { value: returnS, threshold: H1_RETURN_S, unit: "s" },
    );
  },
};
