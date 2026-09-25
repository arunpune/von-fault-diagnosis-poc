// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The query one suspect event becomes (stages 2 and 3 of retrieval).
 *
 * The full-text stage and the vector stage search the same sentence, so it is
 * built once, here, and handed to both: the condition the event named and the
 * symptoms the manual prints under it, the sentences the rules wrote, the
 * names of the signals that moved and the titles of the controller alarms that
 * are up.
 *
 * **No bucket words.** The event's `evidence` also holds one sentence per
 * observation that moved (`Line pressure normal, falling for minutes.`), and
 * those are the one part of the message the query leaves out. Their words are
 * detection's level, trend and duration vocabulary, the same in every event,
 * so they matched every text that mentions a pressure, `normal`, `far` or
 * `minutes` and outvoted the symptom: on an oil-temperature event, most of the
 * query was pressure and bucket words from signals whose level was normal.
 * What moved enters by name only.
 *
 * **No digits.** Detection already turned every measurement into a word
 * (docs/decision-backends.md#the-state-words-not-numbers), and a number that
 * slipped through would be a measurement re-entering the reasoning through the
 * search index: it would weight `websearch_to_tsquery` on a reading rather than
 * on a symptom, and it would move the embedding towards chunks that happen to
 * print the same figure. The alarm codes (`W103`) and the panel labels (`P4`)
 * are the two places digits could arrive, and {@link stripDigits} is what keeps
 * them out; `query.test.ts` asserts the property on every fixture event.
 *
 * The third stage's input travels with the text because it comes from the same
 * event: `expectedMoves` is what the machine actually did, in the two-word
 * bucket vocabulary `retrieval/match.ts` scores a candidate's `signal_moves`
 * against.
 */

import { SIGNALS } from "@fdp/contracts";
import type { Observation, SuspectEvent } from "@fdp/contracts";

import type { Catalog } from "./catalog.ts";
import { observedFromEvent } from "./match.ts";
import type { ObservedBuckets } from "./types.ts";

/** What the three stages of one retrieval read. */
export interface RetrievalQuery {
  /** The sentence stages 2 and 3 search with. Words only, never a digit. */
  readonly text: string;
  /** What the machine did, as stage 1's matcher reads it. */
  readonly expectedMoves: readonly ObservedBuckets[];
}

/** How many observations reach the query text, most abnormal first. */
export const MAX_QUERY_OBSERVATIONS = 12;

/** Signal tag id to the human name the register map gives it. */
const SIGNAL_NAMES: ReadonlyMap<string, string> = new Map(
  SIGNALS.map((signal) => [signal.tag, signal.name]),
);

/**
 * The human name of one observed signal or derived behaviour.
 *
 * A behaviour is not in the register map — it is a quantity detection derives,
 * such as `load_cycle_rate` — so its id becomes its own words. That keeps the
 * query in the same English the manual is written in without a second table of
 * labels to maintain.
 */
export function observationLabel(signal: string): string {
  return SIGNAL_NAMES.get(signal) ?? signal.replaceAll("_", " ");
}

/**
 * Remove every digit, and the empty brackets a removed label leaves behind.
 *
 * `Line pressure (P2)` becomes `Line pressure (P)`; `W103` disappears
 * entirely. The result is collapsed to single spaces so the sentence stays one
 * line whatever was taken out of it.
 */
export function stripDigits(text: string): string {
  return text
    .replaceAll(/\d+/g, "")
    .replaceAll(/\(\s*\)/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

/** How far out of its band a signal sits, for the observation order. */
function levelWeight(observation: Observation): number {
  switch (observation.level) {
    case "far_below":
    case "far_above":
      return 3;
    case "below":
    case "above":
      return 2;
    case "normal":
    case "unknown":
      return 0;
  }
}

/** How hard a signal is moving, for the observation order. */
function trendWeight(observation: Observation): number {
  switch (observation.trend) {
    case "erratic":
    case "stuck":
      return 2;
    case "rising":
    case "falling":
      return 1;
    case "flat":
    case "unknown":
      return 0;
  }
}

/**
 * The observations whose names enter the query, most abnormal first.
 *
 * A signal sitting quietly inside its band says nothing a search index can use
 * — its name would only pull in every text that mentions it — so it is left
 * out; stage 1 still scores it against the causes that expect it to stay put.
 * Twelve names is already more than any condition of the manual lists, so the
 * tail is cut rather than diluting the query.
 */
function queryObservations(observations: readonly Observation[]): readonly Observation[] {
  return [...observations]
    .map((observation, index) => ({ observation, index }))
    .filter(({ observation }) => levelWeight(observation) + trendWeight(observation) > 0)
    .sort((left, right) => {
      const weight =
        levelWeight(right.observation) +
        trendWeight(right.observation) -
        (levelWeight(left.observation) + trendWeight(left.observation));
      return weight !== 0 ? weight : left.index - right.index;
    })
    .slice(0, MAX_QUERY_OBSERVATIONS)
    .map((entry) => entry.observation);
}

/** One entry of the additive `rules_fired` array, as far as the query reads it. */
interface FiredRule {
  readonly detail: string;
}

function isFiredRule(value: unknown): value is FiredRule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly detail?: unknown }).detail === "string"
  );
}

/**
 * The sentences the rules under `symptom_key` wrote.
 *
 * Detection's message carries them as `rules_fired[].detail`, an additive
 * field outside the contract's type, and that is what is read when the event
 * has it. An event without it — a bare contract message, or a hand-built one —
 * carries the same sentences as the first `rule_ids.length` items of
 * `evidence`: detection writes one item per rule hit under the symptom, in
 * `rule_ids` order, before the one per observation that moved. Only those
 * observation sentences are left out.
 */
export function ruleDetails(event: SuspectEvent): string[] {
  const fired: unknown = "rules_fired" in event ? event.rules_fired : undefined;
  if (Array.isArray(fired) && fired.every(isFiredRule)) {
    return fired.map((rule) => rule.detail);
  }
  return event.evidence.slice(0, event.rule_ids.length).map((item) => item.observation);
}

/**
 * Build the query one event searches with.
 *
 * The parts are joined in the order the manual would print them — the symptom
 * first, then what the rules saw, then what moved — because `ts_rank_cd`
 * rewards matches that sit close together and a chunk of the fault-finding
 * table reads in that order.
 */
export function buildQuery(event: SuspectEvent, catalog: Catalog): RetrievalQuery {
  const parts: string[] = [];

  const condition = catalog.conditions.get(event.symptom_key);
  parts.push(condition?.title ?? event.symptom_key.replaceAll("_", " "));
  if (condition !== undefined) parts.push(...condition.symptoms);

  parts.push(...ruleDetails(event));

  for (const observation of queryObservations(event.observations)) {
    parts.push(observationLabel(observation.signal));
  }

  for (const code of event.active_alarms) {
    const title = catalog.alarmTitles.get(code);
    if (title !== undefined) parts.push(title);
  }

  const text = stripDigits(parts.filter((part) => part.trim() !== "").join(" "));
  return { text, expectedMoves: observedFromEvent(event.observations) };
}
