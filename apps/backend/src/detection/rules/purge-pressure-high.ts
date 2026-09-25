// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `purge_pressure_high` → `purge_pressure_high`.
 *
 * The dryer purge line should sit at atmosphere while the compressor is
 * loaded. When it holds pressure instead, air is going out through the purge
 * side, and the recording shows it days before the machine stops keeping up
 * (signature A, docs/dataset.md).
 *
 * Six consecutive loaded samples is a minute of it at the recording's ten
 * second period, which is what separates a real leak from the single sample a
 * changeover produces.
 */

import { DV_PRESSURE_HIGH_BAR } from "../features.ts";
import type { FeatureFrame } from "../types.ts";
import { hit, type Rule, type RuleHit } from "./types.ts";

/** Consecutive loaded samples above the band before the rule fires. */
export const CONSECUTIVE_SAMPLES = 6;

export const purgePressureHigh: Rule = {
  id: "purge_pressure_high",
  symptom_key: "purge_pressure_high",
  severity_hint: "high",
  hold_s: 0,
  clear_s: 0,
  metric: { signal: "dv_pressure" },

  evaluate(frame: FeatureFrame): RuleHit | null {
    if (frame.mode !== "loaded") return null;
    if (frame.dv_pressure_loaded_consecutive_gt < CONSECUTIVE_SAMPLES) return null;

    const purge = frame.signals.dv_pressure;
    return hit(
      purgePressureHigh,
      frame,
      "Dryer purge pressure stays up while the compressor is loaded " +
        "instead of falling back to the vented level.",
      { value: purge.value, threshold: DV_PRESSURE_HIGH_BAR, unit: purge.unit },
    );
  },
};
