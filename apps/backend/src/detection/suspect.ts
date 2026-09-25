// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `suspect-event` message.
 *
 * This is the boundary of detection. Everything upstream of it works in
 * numbers; everything downstream — retrieval, the decision backend, the
 * ticket, the UI — reads the words this file writes. Nothing that is not in
 * the message can influence a decision, which is what makes a replayed run and
 * a live run comparable.
 *
 * What the schema asks for, and where each field comes from:
 *
 * | field | source |
 * | --- | --- |
 * | `symptom_key` | the highest-severity hit, ties by registry order |
 * | `rule_ids`, `rules_fired` | the hits sharing that symptom, in registry order |
 * | `co_symptoms` | the symptoms of the other hits |
 * | `evidence` | one sentence per hit and per non-normal observation |
 * | `observations` | every signal role and derived behaviour, moving ones first; day-only behaviours last |
 * | `machine_state`, `window`, `ambient`, `active_alarms` | the frame |
 * | `baseline_ref` | `baseline.ts`, the first month of the recording |
 *
 * `rules_fired` and `baseline_ref` are not in the schema's required list but
 * travel all the same (`additionalProperties: true`); `rule_ids` and
 * `evidence` are required and a message without them cannot validate.
 */

import type {
  EvidenceItem,
  Observation as ContractObservation,
  SeverityLevel,
  SuspectEvent,
} from "@fdp/contracts";

import { BASELINE_REF } from "./baseline.ts";
import { toContractByHours, toContractObservation } from "./features.ts";
import { durationWords, ruleMetric, ruleOrder } from "./rules/index.ts";
import { BEHAVIOUR_IDS, type FeatureFrame, type Observation, type RuleHit } from "./types.ts";

/** The schema id every message of this kind carries. */
export const SUSPECT_EVENT_SCHEMA = "urn:fdp:schema:suspect-event:v1";

/**
 * How many observations one message carries at most: the
 * sixteen signal roles and the six derived behaviours fit with room to spare.
 */
export const MAX_OBSERVATIONS = 24;

/** One firing rule, as the additive `rules_fired` array carries it. */
export interface RuleFired {
  readonly rule_id: string;
  readonly since_sim_ts: string;
  /** The sentence the ticket repeats verbatim. */
  readonly detail: string;
  readonly value?: number;
  readonly threshold?: number;
  readonly unit?: string;
}

/**
 * The message as detection builds it: the contract plus the two additive
 * top-level fields, `rules_fired` and `baseline_ref`.
 *
 * The envelope keeps `additionalProperties: true`, so both travel and both
 * validate; typing them here means a consumer that wants the per-rule numbers
 * does not have to cast to reach them.
 */
export type SuspectEventMessage = SuspectEvent & {
  readonly rules_fired: readonly RuleFired[];
  readonly baseline_ref: string;
};

/** Severity from quietest to loudest; the primary hit is the loudest one. */
const SEVERITY_RANK: Readonly<Record<SeverityLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * What the builder cannot read off the frame.
 *
 * The envelope is the caller's: `unit_id` is the unit being replayed and
 * `wall_ts` comes from the wall clock, which detection does not own (the sim
 * clock is the only clock inside `detection/`).
 */
export interface SuspectContext {
  readonly unitId: string;
  /** Wall time of the envelope, from the caller's {@link WallClock}. */
  readonly wallTs: string;
  /** The event's own id; a version 4 UUID from `ids.ts` in the runtime. */
  readonly eventId: string;
  /** Controller alarm codes active now; the frame's own list when omitted. */
  readonly activeAlarms?: readonly string[];
  /** Which baseline the words were read against; the first month by default. */
  readonly baselineRef?: string;
}

/** `far_above_normal` → `far above normal`. */
function words(value: string): string {
  return value.replaceAll("_", " ");
}

/** Whether an observation moved: out of its band, or not flat inside it. */
function isNonNormal(observation: Observation): boolean {
  return observation.level !== "normal" || observation.trend !== "flat";
}

const BEHAVIOUR_SET: ReadonlySet<string> = new Set<string>(BEHAVIOUR_IDS);

/**
 * The observations the message carries: all of them, capped.
 *
 * Detection does not know the candidates, so it cannot tell which still signal
 * a cause expects to stay put; it sends every one and the decision state
 * narrows them. Without the still ones a "stays
 * normal" or "stays off" expectation could never be judged. The derived
 * behaviours and the signals that moved come first, in the order `list` gives
 * them, and the still signals follow in the same order, so the cap can only
 * ever drop a still one.
 */
function carriedObservations(list: readonly Observation[]): Observation[] {
  const leading = list.filter(
    (observation) => BEHAVIOUR_SET.has(observation.signal_id) || isNonNormal(observation),
  );
  const still = list.filter(
    (observation) => !BEHAVIOUR_SET.has(observation.signal_id) && !isNonNormal(observation),
  );
  return [...leading, ...still].slice(0, MAX_OBSERVATIONS);
}

/**
 * The behaviours the frame cannot value now but whose last day it still reads
 * by kind of hour (`quiet-hours.ts`).
 *
 * After a gap in the logging the cycle tracker starts again, and while the
 * unit stays loaded no cycle closes, so the behaviour has no newest value and
 * `observations()` leaves it out. The cycles of the day before the gap still
 * stand, though, and a late leak that keeps the unit loaded is exactly where
 * the manual's quiet-hours test matters. Such a behaviour travels with level
 * and trend `unknown` — the newest value is unknown, and the matcher and the
 * query skip an unknown row — and `by_hours` alone says what the day showed.
 * It goes last, so it can never push a valued observation past the cap.
 */
function dayOnlyObservations(frame: FeatureFrame): ContractObservation[] {
  return BEHAVIOUR_IDS.flatMap((id) => {
    const behaviour = frame.behaviours[id];
    const byHours = behaviour.by_hours;
    if (byHours === undefined || behaviour.value !== undefined) return [];
    return [
      { signal: id, level: "unknown", trend: "unknown", by_hours: toContractByHours(byHours) },
    ];
  });
}

/** Highest severity first, then registry order. */
function byPriority(left: RuleHit, right: RuleHit): number {
  const severity = SEVERITY_RANK[right.severity_hint] - SEVERITY_RANK[left.severity_hint];
  if (severity !== 0) return severity;
  return ruleOrder(left.rule_id) - ruleOrder(right.rule_id);
}

/** One rule hit as the sentence and numbers the ticket repeats. */
function ruleEvidence(hit: RuleHit, frame: FeatureFrame): EvidenceItem {
  const sinceMs = Date.parse(hit.since_sim_ts);
  const heldMs = Number.isNaN(sinceMs) ? 0 : Math.max(0, frame.sim_ts_ms - sinceMs);
  return {
    metric: ruleMetric(hit.rule_id, frame),
    observation: hit.detail,
    ...(hit.value === undefined ? {} : { value: hit.value }),
    ...(hit.unit === undefined ? {} : { unit: hit.unit }),
    ...(hit.threshold === undefined ? {} : { baseline: hit.threshold }),
    duration: durationWords(heldMs),
  };
}

/**
 * One observation as an evidence sentence.
 *
 * The wording is the one `tickets/render.ts` repeats:
 * `"<label> <level words>, <trend words> for <since words>"`.
 */
function observationEvidence(observation: Observation): EvidenceItem {
  return {
    metric: observation.signal_id,
    observation:
      `${observation.label} ${words(observation.level)}, ` +
      `${words(observation.trend)} for ${words(observation.since)}.`,
    value: observation.value,
    unit: observation.unit,
    duration: words(observation.since),
  };
}

/**
 * Build the `suspect-event` for one frame.
 *
 * `hits` are the rules firing now — every one of them, not only the ones under
 * the primary symptom, because the others become `co_symptoms` and retrieval
 * scores against them. `list` is `observations(frame, roles)` in full, in
 * registry order; the ordering and the cap happen here so that every
 * caller makes them the same way.
 *
 * Throws when `hits` is empty: a suspect event with no rule behind it could
 * not validate (`rule_ids` has `minItems: 1`) and would mean detection raised
 * an event it cannot explain.
 */
export function buildSuspectEvent(
  hits: readonly RuleHit[],
  frame: FeatureFrame,
  list: readonly Observation[],
  context: SuspectContext,
): SuspectEventMessage {
  if (hits.length === 0) {
    throw new Error("buildSuspectEvent: a suspect event needs at least one rule hit");
  }
  if (list.length === 0) {
    throw new Error("buildSuspectEvent: a suspect event needs at least one observation");
  }

  const ordered = [...hits].sort(byPriority);
  const primary = ordered[0] as RuleHit;
  const rulesFired = ordered
    .filter((candidate) => candidate.symptom_key === primary.symptom_key)
    .sort((left, right) => ruleOrder(left.rule_id) - ruleOrder(right.rule_id));

  const coSymptoms: string[] = [];
  for (const candidate of ordered) {
    if (candidate.symptom_key === primary.symptom_key) continue;
    if (!coSymptoms.includes(candidate.symptom_key)) coSymptoms.push(candidate.symptom_key);
  }

  const kept = carriedObservations(list);

  // Only what moved earns a sentence: a still signal travels in `observations`
  // for the matcher and the decision state, not on the ticket.
  const evidence: EvidenceItem[] = [
    ...rulesFired.map((hit) => ruleEvidence(hit, frame)),
    ...kept.filter(isNonNormal).map(observationEvidence),
  ];

  const onsets = hits
    .map((hit) => Date.parse(hit.since_sim_ts))
    .filter((value) => !Number.isNaN(value));
  const fromMs = onsets.length === 0 ? frame.sim_ts_ms : Math.min(...onsets);

  const alarms = [...new Set(context.activeAlarms ?? frame.active_alarms)];
  const observations: ContractObservation[] = [
    ...kept.map((observation) => toContractObservation(observation)),
    ...dayOnlyObservations(frame),
  ].slice(0, MAX_OBSERVATIONS);

  return {
    schema: SUSPECT_EVENT_SCHEMA,
    unit_id: context.unitId,
    wall_ts: context.wallTs,
    event_id: context.eventId,
    sim_ts: frame.sim_ts,
    symptom_key: primary.symptom_key,
    rule_ids: rulesFired.map((hit) => hit.rule_id) as [string, ...string[]],
    machine_state: {
      mode: frame.mode,
      since_sim_ts: frame.mode_since_sim_ts,
      dryer_tower: frame.dryer_tower,
    },
    window: {
      from_sim_ts: new Date(fromMs).toISOString(),
      to_sim_ts: frame.sim_ts,
      samples: frame.window.samples,
    },
    evidence: evidence as [EvidenceItem, ...EvidenceItem[]],
    observations: observations as [ContractObservation, ...ContractObservation[]],
    active_alarms: alarms,
    co_symptoms: coSymptoms,
    ambient: frame.ambient_bucket,
    // Additive, outside the schema's required list but part of the message: the
    // per-rule numbers the ticket shows, and the baseline the words mean.
    rules_fired: rulesFired.map((hit) => ({
      rule_id: hit.rule_id,
      since_sim_ts: hit.since_sim_ts,
      detail: hit.detail,
      ...(hit.value === undefined ? {} : { value: hit.value }),
      ...(hit.threshold === undefined ? {} : { threshold: hit.threshold }),
      ...(hit.unit === undefined ? {} : { unit: hit.unit }),
    })),
    baseline_ref: context.baselineRef ?? BASELINE_REF,
  };
}
