// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Evidence as one kind of row. A suspect event says what detection saw twice over — plain
// sentences (`evidence`, one per rule hit or non-normal observation, which the ticket repeats
// verbatim) and bucketed readings of every signal (`observations`) — and a ticket carries the
// sentences only. Both become `EvidenceRow`s so the decision sheet, the ticket sheet and the
// events tab render one table. The level and trend buckets are put into words here; a bucket
// this build does not know reads as its own name.

import type {
  EvidenceItem,
  LevelBucket,
  Observation,
  SuspectEvent,
  Ticket,
  TrendBucket,
} from "@/api/types";
import { humanize } from "@/lib/format";

export interface EvidenceRow {
  /** What was measured: a signal tag id, a derived behaviour id or a cycle metric name. */
  signal: string;
  /** One sentence, without a verdict. */
  statement: string;
  value?: number;
  unit?: string;
  /** The first-month or rolling baseline the value was compared against. */
  baseline?: number;
  /** How long it has lasted, in duration words ("about an hour"). */
  window?: string;
}

const LEVEL_WORDS: Readonly<Record<LevelBucket, string>> = {
  far_below: "far below normal",
  below: "below normal",
  normal: "normal",
  above: "above normal",
  far_above: "far above normal",
  unknown: "level unknown",
};

const TREND_WORDS: Readonly<Record<TrendBucket, string>> = {
  falling: "falling",
  flat: "steady",
  rising: "rising",
  erratic: "erratic",
  stuck: "stuck",
  unknown: "trend unknown",
};

function bucketWords(words: Readonly<Record<string, string>>, bucket: string): string {
  return Object.hasOwn(words, bucket) ? (words[bucket] ?? bucket) : humanize(bucket).toLowerCase();
}

/** An observation's two buckets as a phrase: "Far above normal, steady". */
export function describeObservation(observation: Observation): string {
  const phrase = `${bucketWords(LEVEL_WORDS, observation.level)}, ${bucketWords(TREND_WORDS, observation.trend)}`;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** The sentences of a suspect event or a ticket, in their order. */
export function evidenceItemRows(items: readonly EvidenceItem[]): EvidenceRow[] {
  return items.map((item) => ({
    signal: item.metric,
    statement: item.observation,
    value: item.value,
    unit: item.unit,
    baseline: item.baseline,
    window: item.duration,
  }));
}

/** Bucketed readings, one row per signal or behaviour, in the event's order. */
export function observationRows(observations: readonly Observation[]): EvidenceRow[] {
  return observations.map((observation) => ({
    signal: observation.signal,
    statement: describeObservation(observation),
    value: observation.value,
    unit: observation.unit,
    window: observation.since,
  }));
}

/**
 * A suspect event's evidence: its sentences first, then the readings of every signal no sentence
 * already covers, so a signal that moved is stated once and the ones that held still are listed.
 */
export function suspectEventRows(event: SuspectEvent): EvidenceRow[] {
  const stated = new Set(event.evidence.map((item) => item.metric));
  const unstated = event.observations.filter((observation) => !stated.has(observation.signal));
  return [...evidenceItemRows(event.evidence), ...observationRows(unstated)];
}

/** A ticket's evidence: the sentences of the suspect events behind it. */
export function ticketEvidenceRows(ticket: Ticket): EvidenceRow[] {
  return evidenceItemRows(ticket.evidence);
}
