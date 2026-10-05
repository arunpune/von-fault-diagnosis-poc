// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The scripted pipeline: what the real backend would detect, decide and ticket, written down
// instead of computed. Two scripts exist:
//
//   * `F3_AIR_LEAK`, after a jump to `f3_air_leak_jun05`: 90 simulated minutes later a
//     continuous-load suspect event, a decision for the dryer purge leak and a ticket;
//   * `OIL_COOLER`, after `inject oil_cooler_fouling`: 60 simulated minutes later an
//     oil-temperature suspect event, a decision for the fouled oil cooler and a ticket.
//
// Each script answers per decision backend. The Von backend clears the ticket gate (0.91 and
// 0.88) and is billed at the input-token price; the rules backend answers with the medium
// confidence of its scoring formula, so its ticket opens in `review`, and bills nothing.

import { createHash } from "node:crypto";

import { requireFault, tagOf } from "./data.ts";
import type { IdSource } from "./random.ts";
import type { Readings } from "./waveform.ts";

import type {
  AmbientBucket,
  Candidate,
  Decision,
  DecisionBackend,
  Episode,
  EvidenceItem,
  Observation,
  SuspectEvent,
  Ticket,
} from "@/api/types";

/** The two decision backends the fake can play. */
export type BackendMode = Extract<DecisionBackend, "von" | "rules">;

/** The model each backend reports in `hello`, `status.backend` and its decisions. */
export const MODELS: Readonly<Record<BackendMode, string>> = {
  von: "von-1.13.0",
  rules: "rules-v1",
};

/** The confidence gate: ticket at 0.85 and above, review at 0.60 and above. */
export const GATE = { ticket_min_confidence: 0.85, review_min_confidence: 0.6 } as const;

/**
 * Von's list price of a million input tokens and the day it was checked, the defaults of
 * `VON_PRICE_INPUT_PER_MTOK` and `PRICES_AS_OF` (docs/decision-backends.md); output tokens are
 * free.
 */
export const PRICES = { vonInputPerMtok: 0.042, asOf: "2026-09-19" } as const;

const MINUTE_MS = 60_000;

/** How one backend answers one script. */
export interface Verdict {
  /** Mass over the candidate fault ids plus `none_of_these`; sums to 1. */
  readonly probabilities: Readonly<Record<string, number>>;
  readonly support: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly inputTokens: number;
  readonly latencyMs: number;
}

/** What detection saw when the script fires. */
export interface Observed {
  readonly readings: Readings;
  /** Data time the script fires at. */
  readonly atMs: number;
  /** Data time the trigger (the jump or the injection) happened at. */
  readonly triggerMs: number;
}

export interface Script {
  readonly id: string;
  /** Data time between the trigger and the suspect event. */
  readonly delayMs: number;
  readonly symptomKey: string;
  readonly ruleIds: readonly [string, ...string[]];
  readonly coSymptoms: readonly string[];
  readonly conditionId: string;
  readonly conditionTitle: string;
  readonly ambient: AmbientBucket;
  /** The chosen fault; the first of `candidates`. */
  readonly choice: string;
  readonly candidates: readonly string[];
  readonly severity: Decision["severity"];
  readonly verdicts: Readonly<Record<BackendMode, Verdict>>;
  evidence(observed: Observed): [EvidenceItem, ...EvidenceItem[]];
  observations(observed: Observed): [Observation, ...Observation[]];
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** A duration in the words the evidence sentences use. */
function durationWords(ms: number): string {
  const minutes = ms / MINUTE_MS;
  if (minutes < 45) {
    return "under an hour";
  }
  if (minutes < 75) {
    return "about an hour";
  }
  if (minutes < 105) {
    return "about an hour and a half";
  }
  return `about ${Math.round(minutes / 60)} hours`;
}

export const F3_AIR_LEAK: Script = {
  id: "f3_air_leak",
  delayMs: 90 * MINUTE_MS,
  symptomKey: "continuous_load",
  ruleIds: ["stuck_loaded", "purge_pressure_high"],
  coSymptoms: ["purge_pressure_high"],
  conditionId: "continuous_load",
  conditionTitle: "Compressor stays loaded and does not reach cut-out",
  ambient: "mild",
  choice: "dryer_purge_leak",
  candidates: ["dryer_purge_leak", "downstream_air_leak", "high_air_demand"],
  severity: {
    level: "high",
    score: 2.4,
    probabilities: { "0": 0, "1": 0.02, "2": 0.56, "3": 0.42 },
    confidence: 0.56,
  },
  verdicts: {
    von: {
      probabilities: {
        dryer_purge_leak: 0.78,
        downstream_air_leak: 0.11,
        high_air_demand: 0.07,
        none_of_these: 0.04,
      },
      support: { dryer_purge_leak: 0.88, downstream_air_leak: 0.41, high_air_demand: 0.24 },
      confidence: 0.91,
      inputTokens: 3100,
      latencyMs: 1180,
    },
    rules: {
      probabilities: {
        dryer_purge_leak: 0.46,
        downstream_air_leak: 0.32,
        high_air_demand: 0.22,
        none_of_these: 0,
      },
      support: { dryer_purge_leak: 0.9, downstream_air_leak: 0.63, high_air_demand: 0.43 },
      confidence: 0.81,
      inputTokens: 0,
      latencyMs: 12,
    },
  },
  evidence({ readings, atMs, triggerMs }) {
    const loadedMs = atMs - triggerMs;
    const duration = durationWords(loadedMs);
    return [
      {
        metric: "loaded_run_duration",
        observation: `The unit has been loaded without reaching cut-out for ${duration}.`,
        value: Math.round(loadedMs / 1000),
        unit: "s",
        baseline: 109,
        duration,
      },
      {
        metric: tagOf("DV_pressure"),
        observation:
          "Dryer purge pressure has stayed far above its resting value while the unit delivers.",
        value: round(readings.DV_pressure, 2),
        unit: "bar",
        baseline: -0.02,
        duration,
      },
      {
        metric: tagOf("TP3"),
        observation:
          "Line pressure sits on a plateau below the cut-out setting and no longer rises while the unit delivers.",
        value: round(readings.TP3, 2),
        unit: "bar",
        baseline: 10.03,
      },
    ];
  },
  observations({ readings, atMs, triggerMs }) {
    const since = durationWords(atMs - triggerMs);
    return [
      {
        signal: "loaded_run_duration",
        level: "far_above",
        trend: "rising",
        since,
        value: Math.round((atMs - triggerMs) / 1000),
        unit: "s",
      },
      {
        signal: "cut_out_reached",
        level: "far_below",
        trend: "flat",
        since,
        value: 0,
        unit: "bool",
      },
      {
        signal: tagOf("DV_pressure"),
        level: "far_above",
        trend: "flat",
        since,
        value: round(readings.DV_pressure, 2),
        unit: "bar",
      },
      {
        signal: tagOf("TP3"),
        level: "below",
        trend: "flat",
        since,
        value: round(readings.TP3, 2),
        unit: "bar",
      },
      {
        signal: tagOf("Oil_temperature"),
        level: "above",
        trend: "rising",
        since,
        value: round(readings.Oil_temperature, 1),
        unit: "degC",
      },
      {
        signal: tagOf("Motor_current"),
        level: "below",
        trend: "flat",
        since,
        value: round(readings.Motor_current, 2),
        unit: "A",
      },
      { signal: tagOf("LPS"), level: "normal", trend: "flat", value: 0, unit: "bool" },
      {
        signal: tagOf("ambient_temperature"),
        level: "normal",
        trend: "flat",
        value: round(readings.ambient_temperature, 1),
        unit: "degC",
      },
    ];
  },
};

export const OIL_COOLER: Script = {
  id: "oil_cooler",
  delayMs: 60 * MINUTE_MS,
  symptomKey: "oil_temperature_high",
  ruleIds: ["oil_temperature_high"],
  coSymptoms: [],
  conditionId: "oil_temperature_high",
  conditionTitle: "Oil temperature high",
  ambient: "mild",
  choice: "oil_cooler_fouled",
  candidates: ["oil_cooler_fouled", "high_ambient_temperature"],
  severity: {
    level: "medium",
    score: 1.3,
    probabilities: { "0": 0.05, "1": 0.6, "2": 0.35, "3": 0 },
    confidence: 0.6,
  },
  verdicts: {
    von: {
      probabilities: {
        oil_cooler_fouled: 0.84,
        high_ambient_temperature: 0.09,
        none_of_these: 0.07,
      },
      support: { oil_cooler_fouled: 0.86, high_ambient_temperature: 0.2 },
      confidence: 0.88,
      inputTokens: 2900,
      latencyMs: 960,
    },
    rules: {
      probabilities: { oil_cooler_fouled: 0.64, high_ambient_temperature: 0.36, none_of_these: 0 },
      support: { oil_cooler_fouled: 0.8, high_ambient_temperature: 0.45 },
      confidence: 0.8,
      inputTokens: 0,
      latencyMs: 12,
    },
  },
  evidence({ readings, atMs, triggerMs }) {
    const duration = durationWords(atMs - triggerMs);
    return [
      {
        metric: tagOf("Oil_temperature"),
        observation: `Oil temperature has risen steadily for ${duration} in every state while the cycling stayed as usual.`,
        value: round(readings.Oil_temperature, 1),
        unit: "degC",
        baseline: 56,
        duration,
      },
      {
        metric: tagOf("ambient_temperature"),
        observation: "The room around the unit is as warm as it usually is.",
        value: round(readings.ambient_temperature, 1),
        unit: "degC",
      },
    ];
  },
  observations({ readings, atMs, triggerMs }) {
    const since = durationWords(atMs - triggerMs);
    return [
      {
        signal: tagOf("Oil_temperature"),
        level: "above",
        trend: "rising",
        since,
        value: round(readings.Oil_temperature, 1),
        unit: "degC",
      },
      {
        signal: tagOf("ambient_temperature"),
        level: "normal",
        trend: "flat",
        value: round(readings.ambient_temperature, 1),
        unit: "degC",
      },
      { signal: "load_cycle_rate", level: "normal", trend: "flat", value: 1.95, unit: "1/h" },
      {
        signal: tagOf("Motor_current"),
        level: "normal",
        trend: "flat",
        value: round(readings.Motor_current, 2),
        unit: "A",
      },
      {
        signal: tagOf("TP3"),
        level: "normal",
        trend: "flat",
        value: round(readings.TP3, 2),
        unit: "bar",
      },
    ];
  },
};

export interface RunContext extends Observed {
  readonly unitId: string;
  readonly backend: BackendMode;
  readonly wallIso: string;
  readonly ids: IdSource;
  /** When the unit entered the mode it is in at `atMs`, for the event's `machine_state`. */
  readonly modeSinceMs: number;
}

/** Everything one run of a script produces, in the order the backend would emit it. */
export interface PipelineRun {
  readonly event: SuspectEvent;
  readonly decision: Decision;
  /** The state the decision backend saw; stored, never sent over the socket. */
  readonly state: Record<string, unknown>;
  /** Null when the gate only logged the decision. */
  readonly ticket: Ticket | null;
  readonly episode: Episode;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function gateOf(confidence: number): Decision["gate"] {
  const outcome =
    confidence >= GATE.ticket_min_confidence
      ? "ticket"
      : confidence >= GATE.review_min_confidence
        ? "review"
        : "log";
  const reasons = {
    ticket: "A named cause at or above the ticket threshold opens a ticket.",
    review: "A named cause between the review and the ticket threshold goes to the review queue.",
    log: "A confidence below the review threshold is only logged.",
  } as const;
  return { outcome, abstained: false, reason: reasons[outcome], ...GATE };
}

function candidateOf(script: Script, faultId: string, verdict: Verdict): Candidate {
  const fault = requireFault(faultId);
  return {
    fault_id: faultId,
    condition_id: script.conditionId,
    name: fault.name,
    probability: verdict.probabilities[faultId] ?? 0,
    benign: fault.benign,
    manual_ref: fault.manual_ref,
  };
}

/** The contract allows at most six candidates; the scripts name two or three. */
function candidateList(candidates: readonly Candidate[]): Decision["candidates"] {
  if (candidates.length > 6) {
    throw new RangeError("a decision carries at most six candidates");
  }
  return [...candidates] as Decision["candidates"];
}

/** The billed cost of `inputTokens` at Von's price, to the tenth of a micro-dollar. */
function vonCostUsd(inputTokens: number): number {
  return round((inputTokens * PRICES.vonInputPerMtok) / 1e6, 10);
}

/** The state the decision backend saw, as `GET /api/decisions/:id` returns it. */
function decisionState(
  script: Script,
  context: RunContext,
  observations: readonly Observation[],
  candidates: readonly Candidate[],
): Record<string, unknown> {
  return {
    machine: {
      mode: context.readings.mode,
      mode_for: durationWords(context.atMs - context.modeSinceMs),
      ambient: script.ambient,
    },
    symptom: {
      condition: script.conditionTitle,
      for: durationWords(context.atMs - context.triggerMs),
    },
    observations: observations.map(({ signal, level, trend, since }) => ({
      signal,
      level,
      trend,
      since,
    })),
    candidates: candidates.map((candidate) => ({
      id: candidate.fault_id,
      cause: candidate.name,
      condition: script.conditionTitle,
      benign: candidate.benign,
    })),
  };
}

/** Run one script at `context.atMs`: the suspect event, the decision, the ticket and the episode. */
export function runScript(script: Script, context: RunContext): PipelineRun {
  const verdict = script.verdicts[context.backend];
  const atIso = isoOf(context.atMs);
  const episodeId = context.ids.uuid();
  const evidence = script.evidence(context);
  const observations = script.observations(context);

  const event: SuspectEvent = {
    schema: "urn:fdp:schema:suspect-event:v1",
    unit_id: context.unitId,
    wall_ts: context.wallIso,
    event_id: context.ids.uuid(),
    sim_ts: atIso,
    symptom_key: script.symptomKey,
    rule_ids: [...script.ruleIds],
    machine_state: {
      mode: context.readings.mode,
      since_sim_ts: isoOf(context.modeSinceMs),
      dryer_tower: context.readings.Towers ? 2 : 1,
    },
    window: { from_sim_ts: isoOf(context.atMs - 60 * MINUTE_MS), to_sim_ts: atIso, samples: 360 },
    evidence,
    observations,
    active_alarms: [],
    co_symptoms: [...script.coSymptoms],
    ambient: script.ambient,
  };

  const candidates = script.candidates.map((faultId) => candidateOf(script, faultId, verdict));
  const state = decisionState(script, context, observations, candidates);
  const billed = context.backend === "von";
  const gate = gateOf(verdict.confidence);
  const decision: Decision = {
    schema: "urn:fdp:schema:decision:v1",
    unit_id: context.unitId,
    wall_ts: context.wallIso,
    decision_id: context.ids.uuid(),
    episode_id: episodeId,
    event_id: event.event_id,
    sim_ts: atIso,
    backend: context.backend,
    model: MODELS[context.backend],
    status: "ok",
    choice: script.choice,
    probabilities: { ...verdict.probabilities },
    confidence: verdict.confidence,
    support: { ...verdict.support },
    candidates: candidateList(candidates),
    severity: script.severity,
    gate,
    usage: { input_tokens: verdict.inputTokens, output_tokens: 0 },
    cost: {
      usd: billed ? vonCostUsd(verdict.inputTokens) : 0,
      price_input_per_mtok: billed ? PRICES.vonInputPerMtok : 0,
      price_output_per_mtok: 0,
      prices_as_of: PRICES.asOf,
    },
    latency_ms: verdict.latencyMs,
    state_digest: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
    error: null,
  };

  const ticket =
    gate.outcome === "log" ? null : openTicket(script, context, decision, evidence, episodeId);

  const episode: Episode = {
    episode_id: episodeId,
    unit_id: context.unitId,
    symptom_key: script.symptomKey,
    symptom_keys: [script.symptomKey, ...script.coSymptoms],
    status: "open",
    opened_sim_ts: atIso,
    last_event_sim_ts: atIso,
    last_decision_sim_ts: atIso,
    closed_sim_ts: null,
    close_reason: null,
    ticket_id: ticket?.ticket_id ?? null,
    event_count: 1,
    decision_count: 1,
  };

  return { event, decision, state, ticket, episode };
}

function openTicket(
  script: Script,
  context: RunContext,
  decision: Decision,
  evidence: EvidenceItem[],
  episodeId: string,
): Ticket {
  const fault = requireFault(script.choice);
  return {
    schema: "urn:fdp:schema:ticket:v1",
    unit_id: context.unitId,
    wall_ts: context.wallIso,
    ticket_id: context.ids.uuid(),
    episode_id: episodeId,
    action: "opened",
    status: decision.gate.outcome === "ticket" ? "open" : "review",
    fault_id: fault.fault_id,
    condition_id: script.conditionId,
    title: `${fault.name} — ${script.conditionTitle}`,
    cause: fault.summary,
    checks: [...fault.checks],
    remedy: fault.remedy,
    manual_ref: fault.manual_ref,
    evidence,
    confidence: decision.confidence,
    probabilities: decision.probabilities,
    severity: decision.severity.level,
    backend: decision.backend,
    model: decision.model,
    latest_decision_id: decision.decision_id,
    opened_sim_ts: decision.sim_ts,
    updated_sim_ts: decision.sim_ts,
    resolved_sim_ts: null,
    close_reason: null,
    update_count: 0,
    closure: null,
  };
}
