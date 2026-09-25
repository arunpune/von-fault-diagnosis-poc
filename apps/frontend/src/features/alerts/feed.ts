// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The alerts feed as data: the suspect events, the decisions (failed ones included) and the
// tickets of the three query caches, merged into one list of items with their title, their
// facts and where a click leads, newest first and capped. Everything here is pure, so the panel
// only memoises `buildFeed` on the three arrays and renders the result.

import type { Decision, SeverityLevel, SuspectEvent, Ticket } from "@/api/types";
import { chosenTitle, failureWords, gateWord } from "@/features/decisions/decision-text";
import { fmtPct, humanize, shortId } from "@/lib/format";
import type { HashRouteKind } from "@/lib/hash-route";
import { fmtSim, parseIso } from "@/lib/time";

export type FeedKind = "suspect" | "decision" | "decision_failed" | "ticket";

/** The sheet an item opens: `#/decisions/<id>` or `#/tickets/<id>`. */
export interface FeedRef {
  kind: HashRouteKind;
  id: string;
}

export interface FeedItem {
  /** Stable per record: `suspect-<event_id>`, `decision-<decision_id>`, `ticket-<ticket_id>`. */
  key: string;
  kind: FeedKind;
  /** When it happened, in data time; the feed's sort key. */
  sim_ts: string;
  /** Decisions that answered and tickets carry one; suspects and failed decisions do not. */
  severity?: SeverityLevel;
  title: string;
  /** The facts under the title, in reading order: confidence, gate or status, sim time. */
  meta: readonly string[];
  /** Null for a suspect event no decision has answered yet: there is nothing to open. */
  ref: FeedRef | null;
}

/** The feed keeps the newest items only; the Events and Tickets tabs hold the rest. */
export const FEED_CAP = 300;

/** Order among items stamped with the same instant: the outcome above what caused it. */
const KIND_ORDER: Readonly<Record<FeedKind, number>> = {
  ticket: 0,
  decision: 1,
  decision_failed: 1,
  suspect: 2,
};

const MODE_WORDS: Readonly<Record<string, string>> = {
  loaded: "Machine loaded",
  unloaded: "Machine unloaded",
  off: "Machine off",
  unknown: "Machine state unknown",
};

const TICKET_STATUS_WORDS: Readonly<Record<string, string>> = {
  review: "In review",
  open: "Open",
  resolved: "Resolved",
  closed: "Closed",
};

function words(table: Readonly<Record<string, string>>, value: string): string {
  return table[value] ?? humanize(value);
}

function suspectItem(event: SuspectEvent, answeredBy: ReadonlyMap<string, string>): FeedItem {
  const decisionId = answeredBy.get(event.event_id);
  return {
    key: `suspect-${event.event_id}`,
    kind: "suspect",
    sim_ts: event.sim_ts,
    title: `Suspect: ${humanize(event.symptom_key)}`,
    meta: [words(MODE_WORDS, event.machine_state.mode), fmtSim(event.sim_ts)],
    ref: decisionId === undefined ? null : { kind: "decision", id: decisionId },
  };
}

function decisionItem(decision: Decision): FeedItem {
  const ref: FeedRef = { kind: "decision", id: decision.decision_id };
  const key = `decision-${decision.decision_id}`;
  const failure = failureWords(decision);
  if (failure !== null) {
    return {
      key,
      kind: "decision_failed",
      sim_ts: decision.sim_ts,
      title: `Decision failed: ${failure}`,
      meta: [gateWord(decision), fmtSim(decision.sim_ts)],
      ref,
    };
  }
  return {
    key,
    kind: "decision",
    sim_ts: decision.sim_ts,
    severity: decision.severity.level,
    title: chosenTitle(decision),
    meta: [fmtPct(decision.confidence), gateWord(decision), fmtSim(decision.sim_ts)],
    ref,
  };
}

function ticketStatus(ticket: Ticket): string {
  if (ticket.closure !== null) {
    return `Closed as ${ticket.closure.verdict}`;
  }
  return words(TICKET_STATUS_WORDS, ticket.status);
}

function ticketItem(ticket: Ticket): FeedItem {
  return {
    key: `ticket-${ticket.ticket_id}`,
    kind: "ticket",
    sim_ts: ticket.updated_sim_ts,
    severity: ticket.severity,
    title: `Ticket #${shortId(ticket.ticket_id)} ${humanize(ticket.action).toLowerCase()}`,
    meta: [fmtPct(ticket.confidence), ticketStatus(ticket), fmtSim(ticket.updated_sim_ts)],
    ref: { kind: "ticket", id: ticket.ticket_id },
  };
}

/** The newest decision that answered each suspect event (the lists are newest first). */
function answeringDecisions(decisions: readonly Decision[]): ReadonlyMap<string, string> {
  const answeredBy = new Map<string, string>();
  for (const decision of decisions) {
    if (!answeredBy.has(decision.event_id)) {
      answeredBy.set(decision.event_id, decision.decision_id);
    }
  }
  return answeredBy;
}

/** Epoch ms for sorting; an instant that does not parse sorts below every real one. */
function sortTime(simTs: string): number {
  const ms = parseIso(simTs);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function newestFirst(a: { item: FeedItem; ms: number }, b: { item: FeedItem; ms: number }) {
  if (a.ms !== b.ms) {
    return b.ms - a.ms;
  }
  const byKind = KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind];
  if (byKind !== 0) {
    return byKind;
  }
  return a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0;
}

/**
 * Merges the three caches into the feed: newest first by sim time (ties put a ticket above the
 * decision above the suspect event that caused it), at most `FEED_CAP` items. Pure: the same
 * arrays always give an equal feed.
 */
export function buildFeed(
  events: readonly SuspectEvent[],
  decisions: readonly Decision[],
  tickets: readonly Ticket[],
): FeedItem[] {
  const answeredBy = answeringDecisions(decisions);
  const items = [
    ...events.map((event) => suspectItem(event, answeredBy)),
    ...decisions.map(decisionItem),
    ...tickets.map(ticketItem),
  ];
  return items
    .map((item) => ({ item, ms: sortTime(item.sim_ts) }))
    .sort(newestFirst)
    .slice(0, FEED_CAP)
    .map(({ item }) => item);
}

/** What makes an item new to someone who saw the feed before: a new record or a changed one. */
function revision(item: FeedItem): string {
  return `${item.key}|${item.sim_ts}|${item.title}`;
}

/** The items of `current` that `previous` did not show, or showed in an older state. */
export function newArrivals(
  current: readonly FeedItem[],
  previous: readonly FeedItem[],
): FeedItem[] {
  const seen = new Set(previous.map(revision));
  return current.filter((item) => !seen.has(revision(item)));
}

/** The sentence a screen reader hears for one arriving item; null for a suspect event. */
function announcement(item: FeedItem): string | null {
  switch (item.kind) {
    case "suspect":
      return null;
    case "decision":
      return `Decision: ${item.title}, ${item.meta.slice(0, 2).join(", ")}.`;
    case "decision_failed":
    case "ticket":
      return `${item.title}.`;
  }
}

/**
 * What the live region announces for a batch of arrivals: the decisions and ticket changes,
 * oldest first so they read in the order they happened. Suspect events are left out — they
 * arrive too often to announce. Null when there is nothing to say.
 */
export function describeArrivals(arrivals: readonly FeedItem[]): string | null {
  const sentences = arrivals
    .map(announcement)
    .filter((sentence) => sentence !== null)
    .reverse();
  return sentences.length === 0 ? null : sentences.join(" ");
}
