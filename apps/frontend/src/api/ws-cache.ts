// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Frame → query cache reducers. A pushed record lands in the very cache a panel renders from, so
// a panel never cares whether a row came by fetch or by push:
//
//   event.suspect             upsert into ['events'], newest first, at most 500
//   decision                  upsert into every ['decisions', …] list it belongs to, at most 500,
//                             and into ['decision', id]
//   ticket                    into every ['tickets', status] list it belongs to, out of the ones
//                             it left (review → open moves lists), and into ['ticket', id]
//   cost.update               patch the ['cost'] totals in place, then refetch the rest
//   overlay.injection/marker  invalidate the interval and marker lists
//   overlay.catalog           replace ['overlay', 'catalog']
//   overlay.injection_active  replace ['overlay', 'active']
//   snapshot                  seed the caches above from what a fresh socket is sent
//
// Lists are patched only once a query has loaded them: a cache created from pushes alone would
// look complete and hide the history the route holds. "Newest first" is the routes' own order,
// `sim_ts` descending, so a pushed row lands where a refetch would put it. Statuses, alerts and
// running injections live in the live store instead (`store/live-store.ts`).

import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { patchTicketCaches } from "@/api/mutations";
import { qk } from "@/api/query-keys";
import type {
  ApiCost,
  ApiDecisions,
  ApiEvents,
  CostUpdate,
  Decision,
  DecisionDetail,
  SnapshotPayload,
  SuspectEvent,
} from "@/api/types";
import { registerFrameHandler } from "@/api/ws-dispatch";

/** The longest suspect-event list the cache keeps. */
export const EVENTS_CAP = 500;
/** The longest decision list the cache keeps. */
export const DECISIONS_CAP = 500;

interface Timed {
  sim_ts: string;
}

/**
 * `items` with `item` in its place by `sim_ts` descending — before the rows of the same instant,
 * as the newest arrival — after dropping any row with the same id, cut to `cap` rows. Returns
 * `items` itself when the item falls outside the cap.
 */
export function upsertNewestFirst<T extends Timed>(
  items: readonly T[],
  item: T,
  idOf: (row: T) => string,
  cap: number,
): T[] {
  const id = idOf(item);
  const others = items.filter((row) => idOf(row) !== id);
  const at = Date.parse(item.sim_ts);
  const index = others.findIndex((row) => !(Date.parse(row.sim_ts) > at));
  const position = index === -1 ? others.length : index;
  if (position >= cap) {
    return items as T[];
  }
  return [...others.slice(0, position), item, ...others.slice(position)].slice(0, cap);
}

const eventId = (event: SuspectEvent): string => event.event_id;
const decisionId = (decision: Decision): string => decision.decision_id;

function upsertEvent(queryClient: QueryClient, event: SuspectEvent): void {
  queryClient.setQueryData<ApiEvents>(qk.events(), (page) => {
    if (page === undefined) {
      return undefined;
    }
    const items = upsertNewestFirst(page.items, event, eventId, EVENTS_CAP);
    return items === page.items ? page : { ...page, items };
  });
}

/** True when the decisions list under `key` shows `decision`: the newest list, or its episode's. */
function listShows(key: QueryKey, decision: Decision): boolean {
  const episodeId = key[1];
  return episodeId === null || episodeId === decision.episode_id;
}

function upsertDecisionLists(queryClient: QueryClient, decision: Decision): void {
  const lists = queryClient.getQueriesData<ApiDecisions>({ queryKey: qk.decisionLists() });
  for (const [key, page] of lists) {
    if (page === undefined || !listShows(key, decision)) {
      continue;
    }
    const items = upsertNewestFirst(page.items, decision, decisionId, DECISIONS_CAP);
    if (items !== page.items) {
      queryClient.setQueryData<ApiDecisions>(key, { ...page, items });
    }
  }
}

/**
 * The decision detail: the pushed message, keeping the stored state a fetched detail carries. A
 * detail seeded from the push alone is marked stale, so the sheet shows it at once and fetches
 * the state behind it when it opens.
 */
function upsertDecisionDetail(queryClient: QueryClient, decision: Decision): void {
  const key = qk.decision(decision.decision_id);
  const held = queryClient.getQueryData<DecisionDetail>(key);
  if (held === undefined) {
    queryClient.setQueryData<DecisionDetail>(key, decision);
    void queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" });
    return;
  }
  const detail: DecisionDetail = "state" in held ? { ...decision, state: held.state } : decision;
  queryClient.setQueryData<DecisionDetail>(key, detail);
}

function upsertDecision(queryClient: QueryClient, decision: Decision): void {
  upsertDecisionLists(queryClient, decision);
  upsertDecisionDetail(queryClient, decision);
}

/** The running totals the frame carries go in at once; `recent` and the splits are refetched. */
function applyCostUpdate(queryClient: QueryClient, update: CostUpdate): void {
  queryClient.setQueryData<ApiCost>(qk.cost(), (cost) =>
    cost === undefined
      ? undefined
      : { ...cost, totals: { ...cost.totals, usd: update.total_usd, calls: update.calls } },
  );
  void queryClient.invalidateQueries({ queryKey: qk.cost() });
}

/**
 * Seeds the caches from a `snapshot` frame: the overlay catalog and the running injections are
 * replaced, and the open and review tickets and the newest decisions are upserted into the lists
 * already loaded. The live store applies the statuses and the alerts of the same frame.
 */
export function seedFromSnapshot(queryClient: QueryClient, snapshot: SnapshotPayload): void {
  const { catalog, active } = snapshot.overlay;
  if (catalog !== null) {
    queryClient.setQueryData(qk.overlayCatalog(), catalog);
  }
  if (active !== null) {
    queryClient.setQueryData(qk.overlayActive(), active);
  }
  for (const decision of snapshot.decisions) {
    upsertDecisionLists(queryClient, decision);
  }
  // Oldest first, so each list ends with the newest ticket on top.
  for (const ticket of snapshot.tickets.toReversed()) {
    patchTicketCaches(queryClient, ticket);
  }
}

/**
 * Registers the reducers against `queryClient`; `main.tsx` calls it once through the live feed.
 * Returns the function that unregisters them again.
 */
export function installWsCache(queryClient: QueryClient): () => void {
  const disposers = [
    registerFrameHandler("event.suspect", (frame) => {
      upsertEvent(queryClient, frame.payload);
    }),
    registerFrameHandler("decision", (frame) => {
      upsertDecision(queryClient, frame.payload);
    }),
    registerFrameHandler("ticket", (frame) => {
      patchTicketCaches(queryClient, frame.payload);
    }),
    registerFrameHandler("cost.update", (frame) => {
      applyCostUpdate(queryClient, frame.payload);
    }),
    registerFrameHandler("overlay.injection", () => {
      void queryClient.invalidateQueries({ queryKey: qk.overlayInjectionLists() });
    }),
    registerFrameHandler("overlay.marker", () => {
      void queryClient.invalidateQueries({ queryKey: qk.overlayMarkerLists() });
    }),
    registerFrameHandler("overlay.catalog", (frame) => {
      queryClient.setQueryData(qk.overlayCatalog(), frame.payload);
    }),
    registerFrameHandler("overlay.injection_active", (frame) => {
      queryClient.setQueryData(qk.overlayActive(), frame.payload);
    }),
    registerFrameHandler("snapshot", (frame) => {
      seedFromSnapshot(queryClient, frame.payload);
    }),
  ];
  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}
