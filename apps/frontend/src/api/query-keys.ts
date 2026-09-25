// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The only place query keys are spelled. The hooks of `queries.ts` read these keys, and the
// WebSocket reducers write into the same ones, so a pushed ticket lands in exactly the cache a
// tab is showing. The `…Lists()` keys are prefixes: they match every list of that kind, whatever
// its filter, for invalidation and patching.

import type { SeriesQuery, SimRange } from "@/api/endpoints";
import type { TicketStatusFilter } from "@/api/types";

function rangeKey(range: SimRange): { from: string | number | null; to: string | number | null } {
  return { from: range.from ?? null, to: range.to ?? null };
}

export const qk = {
  status: () => ["status"] as const,
  signals: () => ["signals"] as const,
  series: (query: SeriesQuery) =>
    [
      "series",
      {
        tags: query.tags === undefined ? null : query.tags.join(","),
        from: query.from,
        to: query.to,
        points: query.points ?? null,
      },
    ] as const,
  events: () => ["events"] as const,
  /** Every decisions list: the unfiltered one and each episode's history. */
  decisionLists: () => ["decisions"] as const,
  /** The newest decisions, or one episode's decisions when `episodeId` is given. */
  decisions: (episodeId: string | null = null) => ["decisions", episodeId] as const,
  decision: (decisionId: string) => ["decision", decisionId] as const,
  /** Every tickets list, whatever its status filter. */
  ticketLists: () => ["tickets"] as const,
  tickets: (status: TicketStatusFilter) => ["tickets", status] as const,
  ticket: (ticketId: string) => ["ticket", ticketId] as const,
  cost: () => ["cost"] as const,
  activeAlerts: () => ["alerts", "active"] as const,
  catalogFault: (faultId: string) => ["catalog", "faults", faultId] as const,
  overlayCatalog: () => ["overlay", "catalog"] as const,
  overlayActive: () => ["overlay", "active"] as const,
  /** Every injection-interval list, whatever its window. */
  overlayInjectionLists: () => ["overlay", "injections"] as const,
  overlayInjections: (range: SimRange) => ["overlay", "injections", rangeKey(range)] as const,
  /** Every marker list, whatever its window. */
  overlayMarkerLists: () => ["overlay", "markers"] as const,
  overlayMarkers: (range: SimRange) => ["overlay", "markers", rangeKey(range)] as const,
} as const;
