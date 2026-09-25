// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The rule registry and its timers.
 *
 * {@link REGISTRY} is the rule table of docs/detection.md, in its order, and
 * that order is part of the contract: it breaks ties when two rules of equal
 * severity want to name the event's symptom, and it fixes the order of
 * `rule_ids` in the `suspect-event`.
 *
 * The rules themselves are pure. Everything that remembers lives here:
 *
 *   * the **hold** timer — a condition must hold for `hold_s` sim seconds
 *     before the hit reaches the caller, which is what keeps a contact that
 *     chatters out of the episode manager;
 *   * the **clear** timer — once firing, a rule keeps being reported until the
 *     condition has been false for `clear_s` sim seconds, so one sample of
 *     recovery does not end an episode;
 *   * the **guards** of `state.ts` — while one holds, nothing is evaluated and every
 *     timer is cleared. A machine that is parked, frozen, warming up or has
 *     just jumped in time has no rule state at all.
 *
 * Both timers run on the sim clock, never on the wall clock: the same replay
 * gives the same hits at the same instants whatever speed it is played at.
 *
 * `RULES_DISABLED` is read by `config/env.ts` and passed in; the registry
 * applies it by name and ships with `flow_pulses_missing` off
 * ({@link DEFAULT_RULES_DISABLED}).
 */

import { guardsPassed } from "../state.ts";
import type { AnalogRole } from "../signals.ts";
import type { FeatureFrame, RuleHit } from "../types.ts";
import { dischargeDifferentialLow } from "./discharge-differential-low.ts";
import { dryerTowerNotSwitching } from "./dryer-tower-not-switching.ts";
import { fastDecay } from "./fast-decay.ts";
import { flowPulsesMissing } from "./flow-pulses-missing.ts";
import { frequentCycling } from "./frequent-cycling.ts";
import { longLoadedRuns } from "./long-loaded-runs.ts";
import { lowOilLevel } from "./low-oil-level.ts";
import { lowPressureSwitch } from "./low-pressure-switch.ts";
import { motorCurrentHigh } from "./motor-current-high.ts";
import { motorCurrentLow } from "./motor-current-low.ts";
import { oilTemperatureHigh } from "./oil-temperature-high.ts";
import { oilTemperatureRising } from "./oil-temperature-rising.ts";
import { purgePressureHigh } from "./purge-pressure-high.ts";
import { reservoirPressureMismatch } from "./reservoir-pressure-mismatch.ts";
import { separatorNotVenting } from "./separator-not-venting.ts";
import { stuckLoaded } from "./stuck-loaded.ts";
import { metricId, type Rule, type RuleContext } from "./types.ts";

export type { Rule, RuleContext, RuleMetric } from "./types.ts";
export { durationWords, metricId } from "./types.ts";

/** The rules, in the order the rule table lists them. */
export const REGISTRY: readonly Rule[] = [
  stuckLoaded,
  purgePressureHigh,
  fastDecay,
  frequentCycling,
  longLoadedRuns,
  lowPressureSwitch,
  oilTemperatureHigh,
  oilTemperatureRising,
  motorCurrentHigh,
  motorCurrentLow,
  dischargeDifferentialLow,
  dryerTowerNotSwitching,
  separatorNotVenting,
  reservoirPressureMismatch,
  lowOilLevel,
  flowPulsesMissing,
];

/**
 * The rules `RULES_DISABLED` turns off when nothing else is configured
 * (the same default as `config/env.ts`).
 */
export const DEFAULT_RULES_DISABLED: readonly string[] = ["flow_pulses_missing"];

const BY_ID: ReadonlyMap<string, Rule> = new Map(REGISTRY.map((rule) => [rule.id, rule]));
const ORDER: ReadonlyMap<string, number> = new Map(REGISTRY.map((rule, index) => [rule.id, index]));

/** One rule by id, or undefined when no such rule exists. */
export function ruleById(id: string): Rule | undefined {
  return BY_ID.get(id);
}

/** Where a rule sits in the registry; unknown ids sort last. */
export function ruleOrder(id: string): number {
  return ORDER.get(id) ?? REGISTRY.length;
}

/** The registry minus the disabled ids, in registry order. */
export function enabledRules(disabled: readonly string[] = DEFAULT_RULES_DISABLED): Rule[] {
  const off = new Set(disabled);
  return REGISTRY.filter((rule) => !off.has(rule.id));
}

/** What the evidence item of one rule is about, on one frame. */
export function ruleMetric(ruleId: string, frame: FeatureFrame): string {
  const rule = BY_ID.get(ruleId);
  return rule === undefined ? ruleId : metricId(rule.metric, frame);
}

/**
 * The five analog values the `frozen` guard watches.
 *
 * They are named here because the registry applies the guard's own condition
 * one frame at a time; see {@link isStale}.
 */
export const FROZEN_TUPLE_ROLES: readonly AnalogRole[] = [
  "tp2",
  "tp3",
  "h1",
  "oil_temperature",
  "motor_current",
];

/**
 * True when the logger did not move between two frames.
 *
 * `state.ts` raises the `frozen` guard at the 60th identical sample, which at
 * the recording's ten-second period is about ten minutes after a logger
 * stalls. Rules with a shorter hold fire inside that window on values that are
 * merely stale: the recording's 22 June frozen-logger block holds a cut-in
 * transient in place, and a differential rule reads the frozen `TP2 < TP3` as a
 * compressor that stopped delivering, while the digital flicker of the same
 * block invents cut-ins that no pressure ever followed. The registry therefore
 * applies the guard's own condition at frame resolution — identical values for
 * the five signals it watches — and suppresses from the first repeated frame,
 * which is the guard's condition, only noticed sooner.
 *
 * Frames are at most a sim minute apart and every analog of the recording
 * carries three decimals, so two live frames do not match by accident; a
 * machine standing still with its line vented belongs to the `parked` guard.
 */
export function isStale(frame: FeatureFrame, previous: FeatureFrame | undefined): boolean {
  if (previous === undefined) return false;
  return FROZEN_TUPLE_ROLES.every(
    (role) => frame.signals[role].value === previous.signals[role].value,
  );
}

/**
 * The one method the registry needs from a logger.
 *
 * Declared structurally so `detection/` stays free of the logging library: a
 * pino logger satisfies it, and so does a two-line spy in a test.
 */
export interface RuleLog {
  debug(object: Record<string, unknown>, message: string): void;
}

export interface RuleEngineOptions {
  /** Rule ids to leave out; defaults to {@link DEFAULT_RULES_DISABLED}. */
  readonly rulesDisabled?: readonly string[];
  /** First fire and clear are logged at `debug` when a logger is given. */
  readonly logger?: RuleLog;
}

/** The rules of one stream of frames, with their timers. */
export interface RuleEngine {
  /**
   * Evaluate every enabled rule against one frame.
   *
   * Returns the hits that have passed their hold and not yet cleared, in
   * registry order. While a guard holds, nothing is evaluated, every timer is
   * cleared and the result is empty.
   */
  evaluate(frame: FeatureFrame, context: RuleContext): RuleHit[];
  /** What is firing right now, in registry order. */
  firing(): RuleHit[];
  /** The enabled rules, in registry order. */
  rules(): readonly Rule[];
  /** Forget every timer; a new segment starts with no rule state. */
  reset(): void;
}

/** What one rule's timers remember between frames. */
interface Timer {
  /** When the condition first held, in sim milliseconds. */
  sinceMs: number | undefined;
  /** When it stopped holding, while the clear timer runs. */
  falseSinceMs: number | undefined;
  /** The hit as last reported, dated from {@link Timer.sinceMs}. */
  hit: RuleHit | undefined;
  firing: boolean;
}

function freshTimer(): Timer {
  return { sinceMs: undefined, falseSinceMs: undefined, hit: undefined, firing: false };
}

/** The rule engine for one stream of frames. */
export function createRuleEngine(options: RuleEngineOptions = {}): RuleEngine {
  const rules = enabledRules(options.rulesDisabled ?? DEFAULT_RULES_DISABLED);
  const logger = options.logger;
  const timers = new Map<string, Timer>(rules.map((rule) => [rule.id, freshTimer()]));
  /** The frame before this one, for the staleness test of {@link isStale}. */
  let previous: FeatureFrame | undefined;

  function timerOf(rule: Rule): Timer {
    const existing = timers.get(rule.id);
    if (existing !== undefined) return existing;
    const created = freshTimer();
    timers.set(rule.id, created);
    return created;
  }

  function clearAll(): void {
    for (const rule of rules) timers.set(rule.id, freshTimer());
  }

  function held(rule: Rule, timer: Timer, raw: RuleHit, nowMs: number): void {
    timer.falseSinceMs = undefined;
    timer.sinceMs ??= nowMs;
    if (!timer.firing && nowMs - timer.sinceMs >= rule.hold_s * 1000) {
      timer.firing = true;
      logger?.debug(
        { rule_id: rule.id, sim_ts: new Date(timer.sinceMs).toISOString() },
        "rule fired",
      );
    }
    if (timer.firing) {
      timer.hit = { ...raw, since_sim_ts: new Date(timer.sinceMs).toISOString() };
    }
  }

  function lapsed(rule: Rule, timer: Timer, nowMs: number): void {
    if (!timer.firing) {
      timer.sinceMs = undefined;
      timer.hit = undefined;
      return;
    }
    timer.falseSinceMs ??= nowMs;
    if (nowMs - timer.falseSinceMs >= rule.clear_s * 1000) {
      timers.set(rule.id, freshTimer());
      logger?.debug({ rule_id: rule.id, sim_ts: new Date(nowMs).toISOString() }, "rule cleared");
    }
  }

  function hits(): RuleHit[] {
    const list: RuleHit[] = [];
    for (const rule of rules) {
      const timer = timers.get(rule.id);
      if (timer?.firing === true && timer.hit !== undefined) list.push(timer.hit);
    }
    return list;
  }

  return {
    evaluate(frame: FeatureFrame, context: RuleContext): RuleHit[] {
      const stale = isStale(frame, previous);
      previous = frame;
      if (stale || !guardsPassed(context.guards)) {
        clearAll();
        return [];
      }
      const nowMs = frame.sim_ts_ms;
      for (const rule of rules) {
        const timer = timerOf(rule);
        const raw = rule.evaluate(frame, context);
        if (raw === null) lapsed(rule, timer, nowMs);
        else held(rule, timer, raw, nowMs);
      }
      return hits();
    },

    firing(): RuleHit[] {
      return hits();
    },

    rules(): readonly Rule[] {
      return rules;
    },

    reset(): void {
      clearAll();
      previous = undefined;
    },
  };
}
