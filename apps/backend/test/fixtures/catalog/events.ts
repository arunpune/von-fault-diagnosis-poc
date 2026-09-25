// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Five hand-built `suspect-event` messages, for the decision tests.
 *
 * They are written by hand rather than replayed, because these tests prove a
 * property of the decision layer, not of detection: the same five events feed
 * the state builder, the matcher, the rules backend's calibration and
 * the gate table, and a fixture that came out of a detector would make a
 * calibration failure ambiguous between the two.
 *
 * Each one is the bucket picture of a situation the evaluation harness cares
 * about:
 *
 * | event | situation | what the rules twin must do |
 * | --- | --- | --- |
 * | {@link SIGNATURE_A_EVENT} | purge valve not seating, unit stuck loaded | ticket or review on `dryer_purge_leak` |
 * | {@link FAST_DECAY_EVENT} | a loss in the plant, days before it is acute | log: a busy plant looks the same |
 * | {@link OIL_COOLER_EVENT} | fouled oil cooler on a mild day | ticket or review on `oil_cooler_fouled` |
 * | {@link BASELINE_EVENT} | ordinary first-month behaviour | log |
 * | {@link DEPOT_LPS_EVENT} | parked at the depot, low-pressure switch closed | log, abstained |
 *
 * Every value is a word. None of them carries a number, because detection
 * turned the numbers into buckets before the message left it.
 */

import { assertValid } from "@fdp/contracts";
import type { LevelBucket, Observation, SuspectEvent, TrendBucket } from "@fdp/contracts";

/** The unit of this proof of concept (`common.schema.json#/$defs/unit_id`). */
export const FIXTURE_UNIT_ID = "cau-7";

type ObservationTuple = readonly [string, LevelBucket, TrendBucket, string];

function observations(rows: readonly ObservationTuple[]): Observation[] {
  return rows.map(([signal, level, trend, since]) => ({ signal, level, trend, since }));
}

interface EventDraft {
  readonly event_id: string;
  readonly sim_ts: string;
  readonly symptom_key: string;
  readonly rule_ids: readonly string[];
  readonly mode: SuspectEvent["machine_state"]["mode"];
  readonly mode_since_sim_ts: string;
  readonly window_from_sim_ts: string;
  readonly evidence: readonly string[];
  readonly observations: readonly ObservationTuple[];
  readonly active_alarms: readonly string[];
  readonly co_symptoms: readonly string[];
  readonly ambient: SuspectEvent["ambient"];
}

/** Assemble and validate one event, so a fixture can never drift off-contract. */
function suspectEvent(draft: EventDraft): SuspectEvent {
  return assertValid("suspect-event", {
    schema: "urn:fdp:schema:suspect-event:v1",
    unit_id: FIXTURE_UNIT_ID,
    wall_ts: "2026-09-20T08:00:00.000Z",
    event_id: draft.event_id,
    sim_ts: draft.sim_ts,
    symptom_key: draft.symptom_key,
    rule_ids: [...draft.rule_ids],
    machine_state: { mode: draft.mode, since_sim_ts: draft.mode_since_sim_ts, dryer_tower: 1 },
    window: { from_sim_ts: draft.window_from_sim_ts, to_sim_ts: draft.sim_ts, samples: 360 },
    evidence: draft.evidence.map((observation, index) => ({
      metric: draft.observations[index]?.[0] ?? draft.symptom_key,
      observation,
    })),
    observations: observations(draft.observations),
    active_alarms: [...draft.active_alarms],
    co_symptoms: [...draft.co_symptoms],
    ambient: draft.ambient,
  });
}

/**
 * Signature A: the dryer purge valve does not seat.
 *
 * The purge line carries pressure all the time, the unit never reaches its
 * cut-out and the line sags while it keeps delivering. The low-pressure switch
 * stays open, which is what separates it from a loss in the plant.
 */
export const SIGNATURE_A_EVENT: SuspectEvent = suspectEvent({
  event_id: "11111111-1111-4111-8111-111111111111",
  sim_ts: "2020-06-05T11:00:00.000Z",
  symptom_key: "continuous_load",
  rule_ids: ["stuck_loaded", "motor_current_low"],
  mode: "loaded",
  mode_since_sim_ts: "2020-06-05T10:00:00.000Z",
  window_from_sim_ts: "2020-06-05T10:00:00.000Z",
  evidence: [
    "Dryer purge pressure has been far above its normal band for about an hour.",
    "The loaded run has lasted far longer than any run of the reference month.",
    "No loaded run has ended at the cut-out pressure in the last hour.",
  ],
  observations: [
    ["dryer_purge_pressure", "far_above", "flat", "about an hour"],
    ["loaded_run_duration", "far_above", "rising", "about an hour"],
    ["cut_out_reached", "far_below", "flat", "about an hour"],
    ["line_pressure", "below", "flat", "about an hour"],
    ["motor_current", "below", "flat", "about an hour"],
    ["oil_temperature", "above", "rising", "about an hour"],
    ["load_cycle_rate", "below", "flat", "about an hour"],
    ["pressure_rise_while_loaded", "below", "flat", "about an hour"],
    ["unloaded_pressure_decay", "normal", "flat", "about an hour"],
    ["discharge_pressure", "normal", "flat", "about an hour"],
    ["purge_switch", "normal", "flat", "about an hour"],
    ["low_pressure_switch", "normal", "flat", "about an hour"],
  ],
  active_alarms: ["W102", "W103"],
  co_symptoms: ["purge_pressure_high"],
  ambient: "warm",
});

/** The candidates retrieval offers under `continuous_load`. */
export const SIGNATURE_A_CANDIDATE_IDS: readonly string[] = [
  "dryer_purge_leak",
  "purge_silencer_damaged",
  "downstream_air_leak",
  "high_air_demand",
  "intake_filter_clogged",
  "airend_element_wear",
];

/**
 * Signature B, days early: the idle decay has grown and the cycles with it.
 *
 * This is the case the catalog is designed to make hard: a leak in
 * the plant and a plant that is simply drawing more air move the same signals
 * the same way, and the rules twin is expected to say so by staying under the
 * review threshold rather than guessing.
 */
export const FAST_DECAY_EVENT: SuspectEvent = suspectEvent({
  event_id: "22222222-2222-4222-8222-222222222222",
  sim_ts: "2020-07-14T18:00:00.000Z",
  symptom_key: "low_line_pressure",
  rule_ids: ["fast_decay"],
  mode: "unloaded",
  mode_since_sim_ts: "2020-07-14T17:55:00.000Z",
  window_from_sim_ts: "2020-07-14T12:00:00.000Z",
  evidence: [
    "Line pressure falls far faster while the unit is idle than in the reference month.",
    "The compressor has loaded more often than usual for several hours.",
    "Each loaded run lasts longer than the recent median.",
  ],
  observations: [
    ["unloaded_pressure_decay", "far_above", "rising", "several hours"],
    ["load_cycle_rate", "above", "rising", "several hours"],
    ["loaded_run_duration", "above", "rising", "several hours"],
    ["line_pressure", "below", "flat", "several hours"],
    ["cut_out_reached", "normal", "flat", "several hours"],
    ["dryer_purge_pressure", "normal", "flat", "several hours"],
    ["separator_discharge_pressure", "normal", "flat", "several hours"],
    ["motor_current", "normal", "flat", "several hours"],
    ["discharge_pressure", "normal", "flat", "several hours"],
    ["oil_temperature", "normal", "flat", "several hours"],
    ["pressure_rise_while_loaded", "normal", "flat", "several hours"],
    ["low_pressure_switch", "normal", "flat", "several hours"],
  ],
  active_alarms: ["W108"],
  co_symptoms: ["frequent_cycling"],
  ambient: "warm",
});

/** The candidates retrieval offers under `low_line_pressure` for a running unit. */
export const FAST_DECAY_CANDIDATE_IDS: readonly string[] = [
  "downstream_air_leak",
  "high_air_demand",
  "condensate_drain_stuck_open",
  "dryer_purge_leak",
  "intake_filter_clogged",
];

/**
 * A fouled oil cooler on a mild day.
 *
 * The oil climbs while the cooling air, the current and the load pattern all
 * stay where they were — the one picture that rules out a hot day, a closed
 * oil filter and a low oil level at the same time.
 */
export const OIL_COOLER_EVENT: SuspectEvent = suspectEvent({
  event_id: "33333333-3333-4333-8333-333333333333",
  sim_ts: "2020-05-20T15:00:00.000Z",
  symptom_key: "oil_temperature_high",
  rule_ids: ["oil_temperature_rising", "oil_temperature_high"],
  mode: "loaded",
  mode_since_sim_ts: "2020-05-20T14:50:00.000Z",
  window_from_sim_ts: "2020-05-20T09:00:00.000Z",
  evidence: [
    "Oil temperature has been far above its normal band for several hours.",
    "The ambient temperature at the cooling-air inlet is inside its normal band.",
  ],
  observations: [
    ["oil_temperature", "far_above", "rising", "several hours"],
    ["ambient_temperature", "normal", "flat", "several hours"],
    ["motor_current", "normal", "flat", "several hours"],
    ["load_cycle_rate", "normal", "flat", "several hours"],
    ["oil_level_ok", "normal", "flat", "several hours"],
    ["line_pressure", "normal", "flat", "several hours"],
    ["discharge_pressure", "normal", "flat", "several hours"],
  ],
  active_alarms: ["W104"],
  co_symptoms: [],
  ambient: "mild",
});

/** The candidates retrieval offers under `oil_temperature_high`. */
export const OIL_COOLER_CANDIDATE_IDS: readonly string[] = [
  "oil_cooler_fouled",
  "high_ambient_temperature",
  "oil_filter_clogged",
  "oil_level_low",
];

/**
 * Ordinary behaviour, with one rule firing at its threshold.
 *
 * Nothing is wrong: the cycle rate has drifted a little above its band and
 * every other signal sits where the reference month put it. A backend that
 * opens a ticket on this is the failure the negative scenarios measure.
 */
export const BASELINE_EVENT: SuspectEvent = suspectEvent({
  event_id: "44444444-4444-4444-8444-444444444444",
  sim_ts: "2020-02-20T09:00:00.000Z",
  symptom_key: "frequent_cycling",
  rule_ids: ["frequent_cycling"],
  mode: "unloaded",
  mode_since_sim_ts: "2020-02-20T08:56:00.000Z",
  window_from_sim_ts: "2020-02-20T08:00:00.000Z",
  evidence: ["The compressor has loaded slightly more often than the reference month."],
  observations: [
    ["load_cycle_rate", "above", "flat", "about an hour"],
    ["line_pressure", "normal", "flat", "about an hour"],
    ["unloaded_pressure_decay", "normal", "flat", "about an hour"],
    ["loaded_run_duration", "normal", "flat", "about an hour"],
    ["cut_out_reached", "normal", "flat", "about an hour"],
    ["dryer_purge_pressure", "normal", "flat", "about an hour"],
    ["separator_discharge_pressure", "normal", "flat", "about an hour"],
    ["motor_current", "normal", "flat", "about an hour"],
    ["oil_temperature", "normal", "flat", "about an hour"],
  ],
  active_alarms: [],
  co_symptoms: [],
  ambient: "mild",
});

/** The candidates retrieval offers under `frequent_cycling`. */
export const BASELINE_CANDIDATE_IDS: readonly string[] = [
  "downstream_air_leak",
  "high_air_demand",
  "condensate_drain_stuck_open",
];

/**
 * Parked at the depot with the low-pressure switch closed.
 *
 * The unit is idling with the line down and has not loaded for an hour. It
 * looks alarming and no catalog cause explains it, which is the abstention the
 * evaluation harness counts: the answer the model should give here is "none of
 * these", not the closest-looking leak.
 */
export const DEPOT_LPS_EVENT: SuspectEvent = suspectEvent({
  event_id: "55555555-5555-4555-8555-555555555555",
  sim_ts: "2020-07-31T05:00:00.000Z",
  symptom_key: "low_line_pressure",
  rule_ids: ["low_pressure_switch"],
  mode: "unloaded",
  mode_since_sim_ts: "2020-07-31T04:00:00.000Z",
  window_from_sim_ts: "2020-07-31T04:00:00.000Z",
  evidence: [
    "The low-pressure switch has been closed for about an hour while the unit idles.",
    "The compressor has not loaded once in that hour.",
  ],
  observations: [
    ["low_pressure_switch", "far_above", "flat", "about an hour"],
    ["line_pressure", "far_below", "flat", "about an hour"],
    ["load_cycle_rate", "far_below", "flat", "about an hour"],
    ["loaded_run_duration", "far_below", "flat", "about an hour"],
    ["separator_discharge_pressure", "below", "flat", "about an hour"],
    ["oil_temperature", "below", "flat", "about an hour"],
    ["motor_current", "normal", "flat", "about an hour"],
    ["discharge_pressure", "normal", "flat", "about an hour"],
    ["unloaded_pressure_decay", "normal", "flat", "about an hour"],
    ["dryer_purge_pressure", "normal", "flat", "about an hour"],
  ],
  active_alarms: ["W101"],
  co_symptoms: [],
  ambient: "mild",
});

/** The candidates retrieval offers under `low_line_pressure` for a parked unit. */
export const DEPOT_LPS_CANDIDATE_IDS: readonly string[] = [
  "downstream_air_leak",
  "high_air_demand",
  "dryer_purge_leak",
  "intake_filter_clogged",
  "airend_element_wear",
];

/** Every fixture event, with the candidate list retrieval would offer for it. */
export const FIXTURE_CASES = [
  { name: "signature A", event: SIGNATURE_A_EVENT, candidateIds: SIGNATURE_A_CANDIDATE_IDS },
  { name: "fast decay", event: FAST_DECAY_EVENT, candidateIds: FAST_DECAY_CANDIDATE_IDS },
  { name: "oil cooler", event: OIL_COOLER_EVENT, candidateIds: OIL_COOLER_CANDIDATE_IDS },
  { name: "baseline", event: BASELINE_EVENT, candidateIds: BASELINE_CANDIDATE_IDS },
  { name: "depot LPS", event: DEPOT_LPS_EVENT, candidateIds: DEPOT_LPS_CANDIDATE_IDS },
] as const;
