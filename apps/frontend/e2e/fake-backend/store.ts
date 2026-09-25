// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The fake backend's records: what the real one keeps in Postgres (suspect events, decisions,
// episodes, tickets, the cost ledger, system alerts) and in its overlay recorder (markers and
// injection intervals), held in memory and served in the list shapes of the real routes —
// newest first, paged by an opaque `before` cursor.

import { PRICES } from "./pipeline.ts";

import type {
  AlertSystem,
  ApiCost,
  ApiDecisions,
  ApiEvents,
  ApiTickets,
  BackendTotals,
  CostDay,
  Decision,
  DecisionDetail,
  Episode,
  InjectionInterval,
  LedgerRow,
  OverlayMarker,
  SuspectEvent,
  Ticket,
  TicketDetail,
  TicketStatusFilter,
} from "@/api/types";

/** Default and largest page of the list routes. */
const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;

/** How many ledger rows `GET /api/cost` repeats in `recent`. */
const RECENT_LEDGER_ROWS = 50;

/** A `before` the store never issued: the route answers 400 `bad_cursor`. */
export class InvalidCursorError extends Error {
  constructor(cursor: string) {
    super(`the cursor ${cursor} was not issued by this list`);
    this.name = "InvalidCursorError";
  }
}

export interface PageQuery {
  readonly limit?: number;
  readonly before?: string;
}

/** A window of data time; either bound may be open. */
export interface SimRange {
  readonly fromMs?: number;
  readonly toMs?: number;
}

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

function page<T>(items: readonly T[], idOf: (item: T) => string, query: PageQuery): Page<T> {
  const limit = Math.min(PAGE_MAX, Math.max(1, query.limit ?? PAGE_DEFAULT));
  let start = 0;
  if (query.before !== undefined) {
    const index = items.findIndex((item) => idOf(item) === query.before);
    if (index < 0) {
      throw new InvalidCursorError(query.before);
    }
    start = index + 1;
  }
  const slice = items.slice(start, start + limit);
  const last = slice.at(-1);
  const more = start + limit < items.length;
  return { items: slice, next_cursor: more && last !== undefined ? idOf(last) : null };
}

function inRange(instant: string, range: SimRange): boolean {
  const ms = Date.parse(instant);
  return (
    (range.fromMs === undefined || ms >= range.fromMs) &&
    (range.toMs === undefined || ms <= range.toMs)
  );
}

function roundUsd(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}

/** The running totals `cost.update` carries after a decision was billed. */
export interface BillingTotals {
  readonly totalUsd: number;
  readonly calls: number;
}

export interface Store {
  addEvent(event: SuspectEvent): void;
  /** Store a decision and, when the backend kept one, the state it saw. */
  addDecision(decision: Decision, state?: Record<string, unknown>): void;
  /** Insert or replace a ticket by id; a new one goes first. */
  putTicket(ticket: Ticket): void;
  putEpisode(episode: Episode): void;
  /** Write a ledger row and return the running totals. */
  bill(row: LedgerRow): BillingTotals;
  putAlert(alert: AlertSystem): void;
  addMarker(marker: OverlayMarker): void;
  openInterval(interval: InjectionInterval): void;
  closeInterval(instanceId: string, endSimTs: string, reason: string): void;

  events(query: PageQuery): ApiEvents;
  decisions(query: PageQuery & { readonly episodeId?: string }): ApiDecisions;
  decision(decisionId: string): DecisionDetail | undefined;
  tickets(status: TicketStatusFilter, query: PageQuery): ApiTickets;
  ticket(ticketId: string): Ticket | undefined;
  /** The ticket with its episode's decisions, newest first, as `GET /api/tickets/:id` answers. */
  ticketDetail(ticketId: string): TicketDetail | undefined;
  /** Tickets in the review or open state, newest first. */
  activeTickets(): Ticket[];
  openEpisodes(): Episode[];
  episode(episodeId: string): Episode | undefined;
  /** The newest decisions, newest first. */
  recentDecisions(limit: number): Decision[];
  cost(): ApiCost;
  alerts(active: boolean | undefined): AlertSystem[];
  markers(range: SimRange): OverlayMarker[];
  intervals(range: SimRange): InjectionInterval[];
}

export function createStore(): Store {
  const events: SuspectEvent[] = [];
  const decisions: Decision[] = [];
  const states = new Map<string, Record<string, unknown>>();
  const tickets: Ticket[] = [];
  const episodes: Episode[] = [];
  const ledger: LedgerRow[] = [];
  const alerts: AlertSystem[] = [];
  const markers: OverlayMarker[] = [];
  const intervals: InjectionInterval[] = [];

  /** Replace the element with the same id, or put the new one first. */
  function upsert<T>(list: T[], item: T, idOf: (item: T) => string): void {
    const index = list.findIndex((existing) => idOf(existing) === idOf(item));
    if (index < 0) {
      list.unshift(item);
    } else {
      list[index] = item;
    }
  }

  function costSummary(): ApiCost {
    const totals = { usd: 0, calls: 0, input_tokens: 0, output_tokens: 0 };
    const byBackend: Record<string, BackendTotals> = {};
    const byDay = new Map<string, number>();
    for (const row of ledger) {
      totals.usd += row.cost_usd;
      totals.calls += 1;
      totals.input_tokens += row.input_tokens;
      totals.output_tokens += row.output_tokens;
      const backend = byBackend[row.backend] ?? {
        usd: 0,
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        model: row.model,
      };
      byBackend[row.backend] = {
        usd: roundUsd(backend.usd + row.cost_usd),
        calls: backend.calls + 1,
        input_tokens: backend.input_tokens + row.input_tokens,
        output_tokens: backend.output_tokens + row.output_tokens,
        model: row.model,
      };
      const day = row.wall_ts.slice(0, 10);
      byDay.set(day, roundUsd((byDay.get(day) ?? 0) + row.cost_usd));
    }
    const days: CostDay[] = [...byDay]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day_wall, usd]) => ({ day_wall, usd }));
    return {
      totals: { ...totals, usd: roundUsd(totals.usd) },
      by_backend: byBackend,
      by_day: days,
      prices: {
        jev_input_per_mtok: PRICES.jevInputPerMtok,
        llm_input_per_mtok: null,
        llm_output_per_mtok: null,
        as_of: PRICES.asOf,
      },
      recent: ledger.slice(0, RECENT_LEDGER_ROWS),
    };
  }

  return {
    addEvent(event) {
      upsert(events, event, (item) => item.event_id);
    },
    addDecision(decision, state) {
      upsert(decisions, decision, (item) => item.decision_id);
      if (state !== undefined) {
        states.set(decision.decision_id, state);
      }
    },
    putTicket(ticket) {
      upsert(tickets, ticket, (item) => item.ticket_id);
    },
    putEpisode(episode) {
      upsert(episodes, episode, (item) => item.episode_id);
    },
    bill(row) {
      ledger.unshift(row);
      return {
        totalUsd: roundUsd(ledger.reduce((sum, entry) => sum + entry.cost_usd, 0)),
        calls: ledger.length,
      };
    },
    putAlert(alert) {
      upsert(alerts, alert, (item) => item.alert_id);
    },
    addMarker(marker) {
      markers.push(marker);
    },
    openInterval(interval) {
      intervals.push(interval);
    },
    closeInterval(instanceId, endSimTs, reason) {
      const interval = intervals.find((item) => item.instance_id === instanceId);
      if (interval !== undefined && interval.end_sim_ts === null) {
        interval.end_sim_ts = endSimTs;
        interval.reason = reason;
      }
    },

    events(query) {
      return page(events, (item) => item.event_id, query);
    },
    decisions(query) {
      const selected =
        query.episodeId === undefined
          ? decisions
          : decisions.filter((item) => item.episode_id === query.episodeId);
      return page(selected, (item) => item.decision_id, query);
    },
    decision(decisionId) {
      const decision = decisions.find((item) => item.decision_id === decisionId);
      const state = states.get(decisionId);
      return decision === undefined || state === undefined ? decision : { ...decision, state };
    },
    tickets(status, query) {
      const selected =
        status === "all" ? tickets : tickets.filter((item) => item.status === status);
      return page(selected, (item) => item.ticket_id, query);
    },
    ticket(ticketId) {
      return tickets.find((item) => item.ticket_id === ticketId);
    },
    ticketDetail(ticketId) {
      const ticket = tickets.find((item) => item.ticket_id === ticketId);
      if (ticket === undefined) {
        return undefined;
      }
      const history = decisions.filter((item) => item.episode_id === ticket.episode_id);
      return { ...ticket, decisions: history };
    },
    activeTickets() {
      return tickets.filter((item) => item.status === "review" || item.status === "open");
    },
    openEpisodes() {
      return episodes.filter((item) => item.status === "open");
    },
    episode(episodeId) {
      return episodes.find((item) => item.episode_id === episodeId);
    },
    recentDecisions(limit) {
      return decisions.slice(0, limit);
    },
    cost: costSummary,
    alerts(active) {
      return active === undefined
        ? [...alerts]
        : alerts.filter((item) => (item.state === "raised") === active);
    },
    markers(range) {
      return markers.filter(
        (marker) => inRange(marker.sim_ts_to, range) || inRange(marker.sim_ts_from, range),
      );
    },
    intervals(range) {
      return intervals.filter((interval) => {
        const startMs = Date.parse(interval.start_sim_ts);
        const endMs = interval.end_sim_ts === null ? Infinity : Date.parse(interval.end_sim_ts);
        return (
          (range.toMs === undefined || startMs <= range.toMs) &&
          (range.fromMs === undefined || endMs >= range.fromMs)
        );
      });
    },
  };
}
