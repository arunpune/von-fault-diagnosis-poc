// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `motor_current_high` → `motor_current_high`.
 *
 * The motor draws more than the first month ever asked of it while delivering:
 * something is dragging, or the machine is pushing against a restriction. The
 * frame's value is a sixty-second median of loaded samples only, so a start
 * peak cannot trip it.
 */

import type { FeatureFrame } from "../types.ts";
import { hit, type Rule, type RuleHit } from "./types.ts";

/** Loaded current above this is outside the first-month band, in A. */
export const MOTOR_CURRENT_HIGH_A = 6.5;

export const motorCurrentHigh: Rule = {
  id: "motor_current_high",
  symptom_key: "motor_current_high",
  severity_hint: "medium",
  hold_s: 60,
  clear_s: 60,
  metric: { signal: "motor_current" },

  evaluate(frame: FeatureFrame): RuleHit | null {
    if (frame.mode !== "loaded") return null;
    const current = frame.motor_current_loaded_a;
    if (current === undefined || current <= MOTOR_CURRENT_HIGH_A) return null;

    return hit(
      motorCurrentHigh,
      frame,
      "Motor current under load is above the band this machine normally draws.",
      {
        value: current,
        threshold: MOTOR_CURRENT_HIGH_A,
        unit: frame.signals.motor_current.unit,
      },
    );
  },
};
