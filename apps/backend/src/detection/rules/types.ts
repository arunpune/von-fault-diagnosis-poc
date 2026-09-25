// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a detection rule is.
 *
 * A rule is a pure function of one {@link FeatureFrame} plus the small context
 * the frame does not carry. It answers one question — "does this signature
 * hold right now?" — and says so in a sentence a technician can read. It owns
 * no state at all: the hold and clear timers, the registry order and the
 * disabled list live in `rules/index.ts`, so a rule file can be read, and
 * checked against the rule table, on its own.
 *
 * Two conventions the whole directory follows:
 *
 *   * a frame field that is `undefined` means "the window cannot answer yet",
 *     and a rule never fires on one — comparing `undefined` against a
 *     threshold would make an empty window look like a healthy machine;
 *   * a {@link RuleHit} carries its numbers in `value`, `threshold` and
 *     `unit`, and its `detail` is words only. The sentence travels to the
 *     ticket verbatim, so it states what was seen and never
 *     what it means.
 */

import type { SeverityLevel } from "@fdp/contracts";

import { duration } from "../buckets.ts";
import type { SignalRole } from "../signals.ts";
import type { FeatureFrame, Guards, RollingMedians, RuleHit } from "../types.ts";

export type { RuleHit } from "../types.ts";

/**
 * What a rule measured, for the `suspect-event` evidence item.
 *
 * The contract wants "a signal tag, a derived behaviour id or a cycle metric
 * name" there. A tag id belongs to the register map, so a rule names the
 * *role* it watched and {@link metricId} reads the id off the frame; anything
 * that is not a signal — a derived behaviour of the manual's signal registry,
 * a cycle metric of `cycles.ts` — is named outright.
 */
export type RuleMetric = { readonly signal: SignalRole } | { readonly name: string };

/** The metric id of one rule, resolved against the register map of a frame. */
export function metricId(metric: RuleMetric, frame: FeatureFrame): string {
  return "signal" in metric ? frame.signals[metric.signal].signal_id : metric.name;
}

/** What a rule reads beside the frame. */
export interface RuleContext {
  /** The medians the drift-prone thresholds scale with. */
  readonly rolling: RollingMedians;
  /** The four guards of `state.ts`; a rule is not evaluated while one holds. */
  readonly guards: Guards;
  /** Controller alarm codes active at {@link RuleContext.nowSimTs}. */
  readonly activeAlarms: readonly string[];
  /** The sim instant the frame describes. */
  readonly nowSimTs: string;
}

/**
 * One rule of the registry table.
 *
 * `hold_s` and `clear_s` are sim-time timers the registry runs: the hit
 * reaches the caller once the condition has held for `hold_s`, and it stops
 * being reported once the condition has been false for `clear_s`.
 *
 * `metric` names what the rule measured. The `suspect-event` evidence item is
 * built from it and from `detail`, which is
 * why it is registry data rather than something the builder has to guess.
 */
export interface Rule {
  readonly id: string;
  readonly symptom_key: string;
  readonly severity_hint: SeverityLevel;
  /** How long the condition must hold before the hit is reported, in sim seconds. */
  readonly hold_s: number;
  /** How long it must be false before the hit stops being reported, in sim seconds. */
  readonly clear_s: number;
  /** What the evidence item built from this rule is about. */
  readonly metric: RuleMetric;
  /**
   * The rule's condition, as a pure function.
   *
   * The returned hit's `since_sim_ts` is the frame's own instant; the registry
   * replaces it with the instant the condition first held, which is the only
   * place that knows.
   */
  evaluate(frame: FeatureFrame, context: RuleContext): RuleHit | null;
}

/** How long something has lasted, in the duration words of `buckets.ts`. */
export function durationWords(ms: number): string {
  return duration(ms).replaceAll("_", " ");
}

/** A hit of `rule` at the frame's instant; the registry dates it properly. */
export function hit(
  rule: Rule,
  frame: FeatureFrame,
  detail: string,
  measured: { value?: number; threshold?: number; unit?: string } = {},
): RuleHit {
  return {
    rule_id: rule.id,
    symptom_key: rule.symptom_key,
    severity_hint: rule.severity_hint,
    since_sim_ts: frame.sim_ts,
    detail,
    ...(measured.value === undefined ? {} : { value: measured.value }),
    ...(measured.threshold === undefined ? {} : { threshold: measured.threshold }),
    ...(measured.unit === undefined ? {} : { unit: measured.unit }),
  };
}
