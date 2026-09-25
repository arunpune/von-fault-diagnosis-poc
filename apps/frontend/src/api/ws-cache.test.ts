// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import type { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { qk } from "@/api/query-keys";
import type {
  ApiCost,
  ApiDecisions,
  ApiEvents,
  ApiTickets,
  Decision,
  DecisionDetail,
  SnapshotPayload,
  SuspectEvent,
  Ticket,
  TicketDetail,
} from "@/api/types";
import {
  DECISIONS_CAP,
  EVENTS_CAP,
  installWsCache,
  seedFromSnapshot,
  upsertNewestFirst,
} from "@/api/ws-cache";
import { dispatchFrame } from "@/api/ws-dispatch";
import type { FrameOf } from "@/api/ws-types";
import { fixtures, frames } from "@/test/msw/fixtures";
import { createTestQueryClient } from "@/test/render";

let queryClient: QueryClient;
let uninstall: () => void;

beforeEach(() => {
  queryClient = createTestQueryClient();
  uninstall = installWsCache(queryClient);
});

afterEach(() => {
  uninstall();
  queryClient.clear();
});

/** A frame of `type` around `payload`, in the fixture's envelope. */
function frame<T extends keyof typeof frames>(type: T, payload: FrameOf<T>["payload"]): FrameOf<T> {
  return { ...frames[type], payload } as FrameOf<T>;
}

function suspect(eventId: string, simTs: string): SuspectEvent {
  return { ...frames["event.suspect"].payload, event_id: eventId, sim_ts: simTs };
}

function decisionAt(decisionId: string, simTs: string, episodeId?: string): Decision {
  const base = frames.decision.payload;
  return {
    ...base,
    decision_id: decisionId,
    sim_ts: simTs,
    episode_id: episodeId ?? base.episode_id,
  };
}

function ticketWithStatus(status: Ticket["status"]): Ticket {
  const ticket = fixtures.tickets.items.find((item) => item.status === status);
  if (ticket === undefined) {
    throw new Error(`tickets.json has no ${status} ticket`);
  }
  return ticket;
}

function ids<T>(items: readonly T[] | undefined, idOf: (item: T) => string): string[] {
  return (items ?? []).map(idOf);
}

const eventIds = (page: ApiEvents | undefined) => ids(page?.items, (event) => event.event_id);
const decisionIds = (page: ApiDecisions | undefined) =>
  ids(page?.items, (decision) => decision.decision_id);
const ticketIds = (page: ApiTickets | undefined) => ids(page?.items, (ticket) => ticket.ticket_id);

describe("upsertNewestFirst", () => {
  const rows = [
    { id: "c", sim_ts: "2020-06-05T12:00:00.000Z" },
    { id: "b", sim_ts: "2020-06-05T11:00:00.000Z" },
    { id: "a", sim_ts: "2020-06-05T10:00:00.000Z" },
  ];
  const idOf = (row: { id: string }) => row.id;

  it("puts a row where sim_ts descending puts it, before rows of the same instant", () => {
    const place = (sim_ts: string) =>
      upsertNewestFirst(rows, { id: "n", sim_ts }, idOf, 10).map(idOf);

    expect(place("2020-06-05T13:00:00.000Z")).toEqual(["n", "c", "b", "a"]);
    expect(place("2020-06-05T11:30:00.000Z")).toEqual(["c", "n", "b", "a"]);
    expect(place("2020-06-05T11:00:00.000Z")).toEqual(["c", "n", "b", "a"]);
    expect(place("2020-06-05T09:00:00.000Z")).toEqual(["c", "b", "a", "n"]);
  });

  it("replaces a row with the same id instead of repeating it", () => {
    const moved = upsertNewestFirst(
      rows,
      { id: "a", sim_ts: "2020-06-05T11:30:00.000Z" },
      idOf,
      10,
    );
    expect(moved.map(idOf)).toEqual(["c", "a", "b"]);
  });

  it("keeps at most `cap` rows and returns the list itself for a row beyond them", () => {
    expect(
      upsertNewestFirst(rows, { id: "n", sim_ts: "2020-06-05T13:00:00.000Z" }, idOf, 3).map(idOf),
    ).toEqual(["n", "c", "b"]);
    expect(upsertNewestFirst(rows, { id: "n", sim_ts: "2020-06-05T09:00:00.000Z" }, idOf, 3)).toBe(
      rows,
    );
  });
});

describe("event.suspect", () => {
  it("lands newest first in the loaded events list, without duplicates", () => {
    queryClient.setQueryData(qk.events(), fixtures.events);
    const [newest, middle] = fixtures.events.items;

    dispatchFrame(frame("event.suspect", suspect("e-later", "2020-06-05T11:00:00.000Z")));
    dispatchFrame(frame("event.suspect", suspect("e-between", "2020-06-01T00:00:00.000Z")));
    dispatchFrame(frame("event.suspect", { ...(middle as SuspectEvent) }));

    const page = queryClient.getQueryData<ApiEvents>(qk.events());
    expect(eventIds(page)).toEqual([
      "e-later",
      newest?.event_id,
      middle?.event_id,
      "e-between",
      fixtures.events.items[2]?.event_id,
    ]);
    expect(page?.next_cursor).toBe(fixtures.events.next_cursor);
  });

  it("keeps at most 500 events, dropping the oldest", () => {
    const start = Date.UTC(2020, 5, 1);
    const items = Array.from({ length: EVENTS_CAP }, (_, index) =>
      suspect(`e-${index}`, new Date(start - index * 60_000).toISOString()),
    );
    queryClient.setQueryData<ApiEvents>(qk.events(), { items, next_cursor: null });

    dispatchFrame(frame("event.suspect", suspect("e-new", "2020-06-02T00:00:00.000Z")));

    const page = queryClient.getQueryData<ApiEvents>(qk.events());
    expect(page?.items).toHaveLength(EVENTS_CAP);
    expect(page?.items[0]?.event_id).toBe("e-new");
    expect(page?.items.at(-1)?.event_id).toBe(`e-${EVENTS_CAP - 2}`);

    const before = queryClient.getQueryData<ApiEvents>(qk.events());
    dispatchFrame(frame("event.suspect", suspect("e-ancient", "2019-01-01T00:00:00.000Z")));
    expect(queryClient.getQueryData<ApiEvents>(qk.events())).toBe(before);
  });

  it("creates no list that no query has loaded", () => {
    dispatchFrame(frames["event.suspect"]);

    expect(queryClient.getQueryData(qk.events())).toBeUndefined();
  });
});

describe("decision", () => {
  const episodeId = frames.decision.payload.episode_id;
  const otherEpisode = "5c8a2e64-0b37-4f91-8d25-6a7b8c9d0e11";

  function loadLists(): void {
    queryClient.setQueryData(qk.decisions(), fixtures.decisions);
    queryClient.setQueryData<ApiDecisions>(qk.decisions(episodeId), {
      items: fixtures.decisions.items.filter((item) => item.episode_id === episodeId),
      next_cursor: null,
    });
    queryClient.setQueryData<ApiDecisions>(qk.decisions(otherEpisode), {
      items: fixtures.decisions.items.filter((item) => item.episode_id === otherEpisode),
      next_cursor: null,
    });
  }

  it("lands in the newest list and in its own episode's list only", () => {
    loadLists();
    const other = queryClient.getQueryData<ApiDecisions>(qk.decisions(otherEpisode));

    dispatchFrame(frame("decision", decisionAt("d-new", "2020-06-05T12:00:00.000Z")));

    expect(decisionIds(queryClient.getQueryData(qk.decisions()))[0]).toBe("d-new");
    expect(decisionIds(queryClient.getQueryData(qk.decisions(episodeId)))[0]).toBe("d-new");
    expect(queryClient.getQueryData(qk.decisions(otherEpisode))).toBe(other);
  });

  it("replaces a decision it already lists", () => {
    loadLists();
    const before = decisionIds(queryClient.getQueryData(qk.decisions()));

    dispatchFrame(frames.decision);

    expect(decisionIds(queryClient.getQueryData(qk.decisions()))).toEqual(before);
  });

  it("keeps at most 500 decisions per list", () => {
    const start = Date.UTC(2020, 5, 1);
    const items = Array.from({ length: DECISIONS_CAP }, (_, index) =>
      decisionAt(`d-${index}`, new Date(start - index * 60_000).toISOString()),
    );
    queryClient.setQueryData<ApiDecisions>(qk.decisions(), { items, next_cursor: "more" });

    dispatchFrame(frame("decision", decisionAt("d-new", "2020-06-02T00:00:00.000Z")));

    const page = queryClient.getQueryData<ApiDecisions>(qk.decisions());
    expect(page?.items).toHaveLength(DECISIONS_CAP);
    expect(page?.items[0]?.decision_id).toBe("d-new");
    expect(page?.next_cursor).toBe("more");
  });

  it("seeds the detail from the push and marks it stale, so the sheet fetches the state", () => {
    const decision = decisionAt("d-new", "2020-06-05T12:00:00.000Z");

    dispatchFrame(frame("decision", decision));

    expect(queryClient.getQueryData(qk.decision("d-new"))).toEqual(decision);
    expect(queryClient.getQueryState(qk.decision("d-new"))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(qk.decisions())).toBeUndefined();
  });

  it("keeps the stored state of a detail already fetched", () => {
    const detail: DecisionDetail = fixtures.decision;
    queryClient.setQueryData(qk.decision(detail.decision_id), detail);
    const pushed = { ...frames.decision.payload, decision_id: detail.decision_id, latency_ms: 1 };

    dispatchFrame(frame("decision", pushed));

    const held = queryClient.getQueryData<DecisionDetail>(qk.decision(detail.decision_id));
    expect(held).toEqual({ ...pushed, state: detail.state });
    expect(queryClient.getQueryState(qk.decision(detail.decision_id))?.isInvalidated).toBe(false);
  });

  it("replaces a detail fetched without state as it is", () => {
    const bare: DecisionDetail = structuredClone(frames.decision.payload);
    queryClient.setQueryData(qk.decision(bare.decision_id), bare);
    const pushed = { ...bare, latency_ms: 1 };

    dispatchFrame(frame("decision", pushed));

    const held = queryClient.getQueryData<DecisionDetail>(qk.decision(bare.decision_id));
    expect(held).toEqual(pushed);
    expect(held).not.toHaveProperty("state");
  });
});

describe("ticket", () => {
  it("moves a review ticket promoted to open from the review list to the open list", () => {
    const review = ticketWithStatus("review");
    const open = ticketWithStatus("open");
    queryClient.setQueryData<ApiTickets>(qk.tickets("review"), {
      items: [review],
      next_cursor: null,
    });
    queryClient.setQueryData<ApiTickets>(qk.tickets("open"), { items: [open], next_cursor: null });
    queryClient.setQueryData(qk.tickets("all"), fixtures.tickets);
    const promoted: Ticket = { ...review, status: "open", action: "updated", update_count: 2 };

    dispatchFrame(frame("ticket", promoted));

    expect(ticketIds(queryClient.getQueryData(qk.tickets("review")))).toEqual([]);
    expect(ticketIds(queryClient.getQueryData(qk.tickets("open")))).toEqual([
      promoted.ticket_id,
      open.ticket_id,
    ]);
    const all = queryClient.getQueryData<ApiTickets>(qk.tickets("all"));
    expect(ticketIds(all)).toEqual(ticketIds(fixtures.tickets));
    expect(all?.items.find((item) => item.ticket_id === promoted.ticket_id)?.status).toBe("open");
  });

  it("patches the ticket detail and keeps its decisions", () => {
    const detail: TicketDetail = fixtures.ticket;
    queryClient.setQueryData(qk.ticket(detail.ticket_id), detail);
    const ticket = frames.ticket.payload;
    const updated: Ticket = { ...ticket, update_count: ticket.update_count + 1 };

    dispatchFrame(frame("ticket", updated));

    expect(queryClient.getQueryData(qk.ticket(detail.ticket_id))).toEqual({
      ...updated,
      decisions: detail.decisions,
    });
  });
});

describe("cost.update", () => {
  it("patches the running totals in place, then invalidates ['cost']", () => {
    queryClient.setQueryData(qk.cost(), fixtures.cost);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    dispatchFrame(frames["cost.update"]);

    const cost = queryClient.getQueryData<ApiCost>(qk.cost());
    expect(cost?.totals).toEqual({
      ...fixtures.cost.totals,
      usd: frames["cost.update"].payload.total_usd,
      calls: frames["cost.update"].payload.calls,
    });
    expect(cost?.recent).toBe(fixtures.cost.recent);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: qk.cost() });
    expect(queryClient.getQueryState(qk.cost())?.isInvalidated).toBe(true);
  });

  it("creates no cost cache that no query has loaded", () => {
    dispatchFrame(frames["cost.update"]);

    expect(queryClient.getQueryData(qk.cost())).toBeUndefined();
  });
});

describe("the overlay frames", () => {
  it("invalidate every injection-interval list on overlay.injection", () => {
    queryClient.setQueryData(
      qk.overlayInjections({ from: "a", to: "b" }),
      fixtures.overlayInjections,
    );
    queryClient.setQueryData(qk.overlayMarkers({}), fixtures.overlayMarkers);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    dispatchFrame(frames["overlay.injection"]);

    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: qk.overlayInjectionLists() });
    expect(
      queryClient.getQueryState(qk.overlayInjections({ from: "a", to: "b" }))?.isInvalidated,
    ).toBe(true);
    expect(queryClient.getQueryState(qk.overlayMarkers({}))?.isInvalidated).toBe(false);
  });

  it("invalidate every marker list on overlay.marker", () => {
    queryClient.setQueryData(qk.overlayMarkers({ from: 1, to: 2 }), fixtures.overlayMarkers);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    dispatchFrame(frames["overlay.marker"]);

    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: qk.overlayMarkerLists() });
    expect(queryClient.getQueryState(qk.overlayMarkers({ from: 1, to: 2 }))?.isInvalidated).toBe(
      true,
    );
  });

  it("replace the catalog and the running injections", () => {
    dispatchFrame(frames["overlay.catalog"]);
    dispatchFrame(frames["overlay.injection_active"]);

    expect(queryClient.getQueryData(qk.overlayCatalog())).toEqual(
      frames["overlay.catalog"].payload,
    );
    expect(queryClient.getQueryData(qk.overlayActive())).toEqual(
      frames["overlay.injection_active"].payload,
    );
  });
});

describe("snapshot", () => {
  it("seeds the overlay caches and upserts its tickets and decisions into the loaded lists", () => {
    const review = ticketWithStatus("review");
    queryClient.setQueryData<ApiTickets>(qk.tickets("open"), { items: [], next_cursor: null });
    queryClient.setQueryData<ApiTickets>(qk.tickets("review"), {
      items: [review],
      next_cursor: null,
    });
    queryClient.setQueryData<ApiDecisions>(qk.decisions(), { items: [], next_cursor: null });
    const snapshot = frames.snapshot.payload;

    dispatchFrame(frames.snapshot);

    expect(queryClient.getQueryData(qk.overlayCatalog())).toEqual(snapshot.overlay.catalog);
    expect(queryClient.getQueryData(qk.overlayActive())).toEqual(snapshot.overlay.active);
    expect(ticketIds(queryClient.getQueryData(qk.tickets("open")))).toEqual(
      snapshot.tickets.map((ticket) => ticket.ticket_id),
    );
    expect(ticketIds(queryClient.getQueryData(qk.tickets("review")))).toEqual([review.ticket_id]);
    expect(decisionIds(queryClient.getQueryData(qk.decisions()))).toEqual(
      snapshot.decisions.map((decision) => decision.decision_id),
    );
  });

  it("puts the snapshot's newest ticket first", () => {
    const open = ticketWithStatus("open");
    const older: Ticket = {
      ...open,
      ticket_id: "t-older",
      updated_sim_ts: "2020-06-01T00:00:00.000Z",
    };
    const snapshot: SnapshotPayload = {
      ...frames.snapshot.payload,
      tickets: [open, older],
      overlay: { catalog: null, active: null },
    };
    queryClient.setQueryData<ApiTickets>(qk.tickets("open"), { items: [], next_cursor: null });

    seedFromSnapshot(queryClient, snapshot);

    expect(ticketIds(queryClient.getQueryData(qk.tickets("open")))).toEqual([
      open.ticket_id,
      "t-older",
    ]);
    expect(queryClient.getQueryData(qk.overlayCatalog())).toBeUndefined();
    expect(queryClient.getQueryData(qk.overlayActive())).toBeUndefined();
  });
});

describe("installWsCache", () => {
  it("stops reducing once uninstalled", () => {
    queryClient.setQueryData(qk.events(), fixtures.events);
    uninstall();

    dispatchFrame(frame("event.suspect", suspect("e-late", "2020-07-01T00:00:00.000Z")));

    expect(queryClient.getQueryData(qk.events())).toBe(fixtures.events);
    uninstall = () => undefined;
  });
});
