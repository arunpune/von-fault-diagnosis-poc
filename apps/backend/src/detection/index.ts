// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `detection/`: samples in, suspect events out.
 *
 * The detector is the composition of the five modules of this directory —
 * roles, state and guards, cycles, the feature frame, the rules — and the one
 * place that decides when detection has something to say. It holds no clock of
 * its own beyond the sim clock of the samples, no database and no broker: the
 * runtime and `tools/eval` drive the same object and get the same events.
 *
 * When an event is raised:
 *
 *   * rules are evaluated on every frame, which the feature engine recomputes
 *     on a state change and on every sim minute;
 *   * a `SuspectEvent` is built the first time a `symptom_key` starts firing.
 *     Re-decisions while it keeps firing are the episode manager's, which
 *     reads {@link Detector.firing} and calls {@link Detector.buildEvent}
 *     every `DECISION_INTERVAL_SIM_MIN`;
 *   * the message is validated before it leaves. A message that does not match
 *     its schema is logged and dropped rather than thrown, so one malformed
 *     frame cannot stop a replay — tests assert validity directly instead.
 */

import {
  DEFAULT_UNIT_ID,
  toIsoMs,
  validate,
  type Sample,
  type Signal,
  SIGNALS,
} from "@fdp/contracts";

import { systemClock, type WallClock } from "../clock.ts";
import { newId } from "../ids.ts";
import { createFeatureEngine, observations, type FeatureEngine } from "./features.ts";
import { createRuleEngine, type RuleEngine, type RuleLog } from "./rules/index.ts";
import { buildSuspectEvent, type SuspectEventMessage } from "./suspect.ts";
import { resolveRoles, type SignalRoles } from "./signals.ts";
import type { FeatureFrame, Guards, Observation, ResetReason, RuleHit } from "./types.ts";

export * from "./types.ts";
export { bucketString, parseBucket } from "./buckets.ts";
export { BASELINE_REF } from "./baseline.ts";
export { observations, toContractObservation, bucketStringOf } from "./features.ts";
export { resolveRoles } from "./signals.ts";
export { guardsPassed } from "./state.ts";
export {
  DEFAULT_RULES_DISABLED,
  REGISTRY,
  createRuleEngine,
  enabledRules,
  ruleById,
  ruleMetric,
  ruleOrder,
} from "./rules/index.ts";
export type { Rule, RuleContext, RuleEngine, RuleLog } from "./rules/index.ts";
export { MAX_OBSERVATIONS, SUSPECT_EVENT_SCHEMA, buildSuspectEvent } from "./suspect.ts";
export type { RuleFired, SuspectContext, SuspectEventMessage } from "./suspect.ts";

/** What one sample produced. */
export interface DetectionOutput {
  /** One event when a `symptom_key` starts firing; empty otherwise. */
  readonly events: SuspectEventMessage[];
  /** Every rule firing after this sample, in registry order. */
  readonly firing: RuleHit[];
  /** Set when this sample recomputed the frame. */
  readonly frame: FeatureFrame | undefined;
  readonly guards: Guards;
}

/** The two levels the detector writes. */
export interface DetectionLog extends RuleLog {
  warn(object: Record<string, unknown>, message: string): void;
}

/** The detection half of the pipeline, for one stream of samples. */
export interface Detector {
  /** Fold one sample in; samples arrive in sim order. */
  push(sample: Sample): DetectionOutput;
  /** Every rule firing now, in registry order, for re-decisions. */
  firing(): RuleHit[];
  /** The most recent feature frame, or undefined before the first one. */
  frame(): FeatureFrame | undefined;
  /**
   * The message a re-decision sends: what {@link Detector.push} would
   * have emitted for the rules firing now, with a fresh `event_id`.
   *
   * Undefined when nothing is firing or when the message does not validate.
   */
  buildEvent(): SuspectEventMessage | undefined;
  /** Clear every window and every rule timer. */
  reset(reason: ResetReason): void;
}

export interface DetectorOptions {
  /** The resolved register map; built from {@link DetectorOptions.signals} when omitted. */
  readonly roles?: SignalRoles;
  /** The register map to resolve; the contracts' own `SIGNALS` by default. */
  readonly signals?: readonly Signal[];
  /** Rule ids to leave out; {@link DEFAULT_RULES_DISABLED} when omitted. */
  readonly rulesDisabled?: readonly string[];
  /** The unit the envelope names; `cau-7` by default. */
  readonly unitId?: string;
  /** Wall time for the envelope; a test passes `fixedClock`. */
  readonly wall?: WallClock;
  /** The event id generator; a test passes a counter for a stable message. */
  readonly newEventId?: () => string;
  /** Whether an episode is open, so its cycles stay out of the baseline. */
  readonly insideEpisode?: () => boolean;
  readonly logger?: DetectionLog;
}

/** The detector for one stream of samples. */
export function createDetector(options: DetectorOptions = {}): Detector {
  const roles: SignalRoles = options.roles ?? resolveRoles(options.signals ?? SIGNALS);
  const unitId = options.unitId ?? DEFAULT_UNIT_ID;
  const wall = options.wall ?? systemClock;
  const nextEventId = options.newEventId ?? newId;
  const logger = options.logger;

  const engine: FeatureEngine = createFeatureEngine({
    roles,
    insideEpisode: options.insideEpisode,
  });
  const rules: RuleEngine = createRuleEngine({
    rulesDisabled: options.rulesDisabled,
    logger,
  });

  /** The symptom keys that were firing after the previous frame. */
  let firingKeys = new Set<string>();

  function build(hits: readonly RuleHit[], frame: FeatureFrame): SuspectEventMessage | undefined {
    if (hits.length === 0) return undefined;
    const list: Observation[] = observations(frame, roles);
    const event = buildSuspectEvent(hits, frame, list, {
      unitId,
      wallTs: toIsoMs(wall.now()),
      eventId: nextEventId(),
    });

    const result = validate("suspect-event", event);
    if (result.ok) return event;
    logger?.warn(
      {
        sim_ts: frame.sim_ts,
        symptom_key: event.symptom_key,
        issues: result.errors.map((issue) => issue.text),
      },
      "suspect event does not match its schema; dropped",
    );
    return undefined;
  }

  return {
    push(sample: Sample): DetectionOutput {
      const update = engine.push(sample);
      if (update.reset !== undefined) {
        rules.reset();
        firingKeys = new Set<string>();
      }

      const frame = update.frame;
      if (frame === undefined) {
        return { events: [], firing: rules.firing(), frame: undefined, guards: update.guards };
      }

      const hits = rules.evaluate(frame, {
        rolling: frame.rolling,
        guards: frame.guards,
        activeAlarms: frame.active_alarms,
        nowSimTs: frame.sim_ts,
      });

      const keys = new Set(hits.map((hit) => hit.symptom_key));
      const started = [...keys].some((key) => !firingKeys.has(key));
      firingKeys = keys;

      const events: SuspectEventMessage[] = [];
      if (started) {
        const event = build(hits, frame);
        if (event !== undefined) events.push(event);
      }
      return { events, firing: hits, frame, guards: update.guards };
    },

    firing(): RuleHit[] {
      return rules.firing();
    },

    frame(): FeatureFrame | undefined {
      return engine.frame();
    },

    buildEvent(): SuspectEventMessage | undefined {
      const frame = engine.frame();
      if (frame === undefined) return undefined;
      return build(rules.firing(), frame);
    },

    reset(reason: ResetReason): void {
      engine.reset(reason);
      rules.reset();
      firingKeys = new Set<string>();
    },
  };
}
