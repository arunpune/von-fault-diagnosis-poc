// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The REST reads as TanStack Query hooks. Each hook is a thin wrapper: its key comes from
// `query-keys.ts`, its fetcher from `endpoints.ts`, and the cache is the single source a panel
// renders from — the WebSocket reducers patch the same keys, so a panel never cares whether a row
// arrived by fetch or by push. Hooks whose argument can be absent take `null` (or an `enabled`
// flag) and stay idle until it is known, instead of firing a request for nothing.

import { keepPreviousData, queryOptions, skipToken, useQuery } from "@tanstack/react-query";

import {
  getActiveAlerts,
  getCatalogFault,
  getCost,
  getDecision,
  getDecisions,
  getEvents,
  getOverlayActive,
  getOverlayCatalog,
  getOverlayInjections,
  getOverlayMarkers,
  getSeries,
  getSignals,
  getStatus,
  getTicket,
  getTickets,
  type SeriesQuery,
} from "@/api/endpoints";
import { qk } from "@/api/query-keys";
import type { ApiCost, TicketStatusFilter } from "@/api/types";
import { fmtUsd } from "@/lib/format";

/** `GET /api/status`: the retained statuses, the raised alerts, the running injections, the gate. */
export function useStatusSnapshot() {
  return useQuery({ queryKey: qk.status(), queryFn: ({ signal }) => getStatus({ signal }) });
}

/** `GET /api/signals`: the signal registry; it does not change while the backend runs. */
export function useSignals() {
  return useQuery({
    queryKey: qk.signals(),
    queryFn: ({ signal }) => getSignals({ signal }),
    staleTime: Infinity,
  });
}

/** The series history of a window; keeps the previous window on screen while the next loads. */
export function useSeries(query: SeriesQuery, enabled = true) {
  return useQuery({
    queryKey: qk.series(query),
    queryFn: enabled ? ({ signal }) => getSeries(query, { signal }) : skipToken,
    placeholderData: keepPreviousData,
  });
}

function eventsQuery() {
  return queryOptions({
    queryKey: qk.events(),
    queryFn: ({ signal }) => getEvents({}, { signal }),
  });
}

/** The newest suspect events: the alerts feed, the Events tab and the decision evidence. */
export function useEvents() {
  return useQuery(eventsQuery());
}

/** The newest decisions, or one episode's history when `episodeId` is given. */
export function useDecisions(episodeId?: string) {
  return useQuery({
    queryKey: qk.decisions(episodeId ?? null),
    queryFn: ({ signal }) => getDecisions({ episodeId }, { signal }),
  });
}

/** One decision with the state the backend saw; idle while `decisionId` is null. */
export function useDecision(decisionId: string | null) {
  return useQuery({
    queryKey: qk.decision(decisionId ?? ""),
    queryFn: decisionId === null ? skipToken : ({ signal }) => getDecision(decisionId, { signal }),
  });
}

function ticketsQuery(status: TicketStatusFilter) {
  return queryOptions({
    queryKey: qk.tickets(status),
    queryFn: ({ signal }) => getTickets(status, {}, { signal }),
  });
}

/** One page of tickets in a status, or every ticket with `"all"`; `"review"` is the review queue. */
export function useTickets(status: TicketStatusFilter) {
  return useQuery(ticketsQuery(status));
}

/** One ticket with its episode's decisions; idle while `ticketId` is null. */
export function useTicket(ticketId: string | null) {
  return useQuery({
    queryKey: qk.ticket(ticketId ?? ""),
    queryFn: ticketId === null ? skipToken : ({ signal }) => getTicket(ticketId, { signal }),
  });
}

function costQuery() {
  return queryOptions({ queryKey: qk.cost(), queryFn: ({ signal }) => getCost({ signal }) });
}

/** `GET /api/cost`: running totals, per backend and per day, prices and the newest ledger rows. */
export function useCost() {
  return useQuery(costQuery());
}

/** The system alerts raised right now, from REST; live updates arrive through the live store. */
export function useActiveAlerts() {
  return useQuery({
    queryKey: qk.activeAlerts(),
    queryFn: ({ signal }) => getActiveAlerts({ signal }),
  });
}

/** One catalog cause, fetched when a candidate row is expanded; the catalog is fixed per run. */
export function useCatalogFault(faultId: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.catalogFault(faultId),
    queryFn: enabled ? ({ signal }) => getCatalogFault(faultId, { signal }) : skipToken,
    staleTime: Infinity,
  });
}

/** The jump presets, the injection menu and the dataset failure windows. */
export function useOverlayCatalog() {
  return useQuery({
    queryKey: qk.overlayCatalog(),
    queryFn: ({ signal }) => getOverlayCatalog({ signal }),
  });
}

/** The injections running right now, as the overlay reports them. */
export function useOverlayActive() {
  return useQuery({
    queryKey: qk.overlayActive(),
    queryFn: ({ signal }) => getOverlayActive({ signal }),
  });
}

/** Injection intervals inside a window of sim time; keeps the last window while the next loads. */
export function useOverlayInjections(from?: string | number, to?: string | number) {
  return useQuery({
    queryKey: qk.overlayInjections({ from, to }),
    queryFn: ({ signal }) => getOverlayInjections({ from, to }, { signal }),
    placeholderData: keepPreviousData,
  });
}

/** Replay markers (jumps, resets, loops) inside a window of sim time. */
export function useOverlayMarkers(from?: string | number, to?: string | number) {
  return useQuery({
    queryKey: qk.overlayMarkers({ from, to }),
    queryFn: ({ signal }) => getOverlayMarkers({ from, to }, { signal }),
    placeholderData: keepPreviousData,
  });
}

/**
 * What each bottom tab shows beside its name, already formatted; null while the number is not
 * known, so a tab shows no badge rather than a wrong one.
 */
export interface TabCounts {
  readonly tickets: string | null;
  readonly review: string | null;
  readonly events: string | null;
  readonly cost: string | null;
}

interface CountablePage {
  items: readonly unknown[];
  next_cursor: string | null;
}

/** The rows of one page, with a "+" when the backend holds more pages than the one loaded. */
function pageCount(page: CountablePage): string {
  return page.next_cursor === null ? String(page.items.length) : `${page.items.length}+`;
}

function runningCost(cost: ApiCost): string {
  return fmtUsd(cost.totals.usd);
}

/**
 * The open tickets, the review queue, the suspect events and the running cost, read from the
 * same caches the tabs render, so a patched ticket or a pushed event moves the badge at once.
 * Each count is derived with `select`, so the tab strip re-renders only when a label changes.
 */
export function useTabCounts(): TabCounts {
  const tickets = useQuery({ ...ticketsQuery("open"), select: pageCount }).data;
  const review = useQuery({ ...ticketsQuery("review"), select: pageCount }).data;
  const events = useQuery({ ...eventsQuery(), select: pageCount }).data;
  const cost = useQuery({ ...costQuery(), select: runningCost }).data;
  return {
    tickets: tickets ?? null,
    review: review ?? null,
    events: events ?? null,
    cost: cost ?? null,
  };
}
