// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  useActiveAlerts,
  useCatalogFault,
  useCost,
  useDecision,
  useDecisions,
  useEvents,
  useOverlayActive,
  useOverlayCatalog,
  useOverlayInjections,
  useOverlayMarkers,
  useSeries,
  useSignals,
  useStatusSnapshot,
  useTabCounts,
  useTicket,
  useTickets,
} from "@/api/queries";
import { qk } from "@/api/query-keys";
import { fixtures } from "@/test/msw/fixtures";
import { apiError } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { createTestQueryClient } from "@/test/render";

let queryClient: QueryClient;
let paths: string[] = [];

function recordPath({ request }: { request: Request }): void {
  const url = new URL(request.url);
  paths.push(`${url.pathname}${url.search}`);
}

function Providers({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderQuery<T>(hook: () => T) {
  return renderHook(hook, { wrapper: Providers });
}

beforeEach(() => {
  queryClient = createTestQueryClient();
  paths = [];
  server.events.on("request:start", recordPath);
});

afterEach(() => {
  server.events.removeListener("request:start", recordPath);
  queryClient.clear();
});

describe("the read hooks", () => {
  it("load the status snapshot and the signal registry into their keys", async () => {
    const status = renderQuery(() => useStatusSnapshot());
    const signals = renderQuery(() => useSignals());

    await waitFor(() => {
      expect(status.result.current.data).toEqual(fixtures.status);
      expect(signals.result.current.data).toEqual(fixtures.signals);
    });
    expect(queryClient.getQueryData(qk.status())).toEqual(fixtures.status);
    // The registry does not change while the backend runs, so it never goes stale.
    expect(queryClient.getQueryCache().find({ queryKey: qk.signals() })?.isStale()).toBe(false);
  });

  it("load the events, the decisions and one episode's history", async () => {
    const events = renderQuery(() => useEvents());
    const decisions = renderQuery(() => useDecisions());
    const history = renderQuery(() => useDecisions(fixtures.ticket.episode_id));

    await waitFor(() => {
      expect(events.result.current.data).toEqual(fixtures.events);
      expect(decisions.result.current.data).toEqual(fixtures.decisions);
      expect(history.result.current.data?.items).toHaveLength(2);
    });
    expect(queryClient.getQueryData(qk.decisions(fixtures.ticket.episode_id))).toBeDefined();
    expect(queryClient.getQueryData(qk.decisions())).toEqual(fixtures.decisions);
  });

  it("stay idle while an id is unknown, then load it", async () => {
    const decision = renderQuery(() => useDecision(null));
    const ticket = renderQuery(() => useTicket(null));
    expect(decision.result.current.fetchStatus).toBe("idle");
    expect(ticket.result.current.fetchStatus).toBe("idle");

    const loadedDecision = renderQuery(() => useDecision(fixtures.decision.decision_id));
    const loadedTicket = renderQuery(() => useTicket(fixtures.ticket.ticket_id));
    await waitFor(() => {
      expect(loadedDecision.result.current.data).toEqual(fixtures.decision);
      expect(loadedTicket.result.current.data).toEqual(fixtures.ticket);
    });
    expect(paths).toEqual([
      `/api/decisions/${fixtures.decision.decision_id}`,
      `/api/tickets/${fixtures.ticket.ticket_id}`,
    ]);
  });

  it("load the tickets of one status into that status's key", async () => {
    const review = renderQuery(() => useTickets("review"));

    await waitFor(() => {
      expect(review.result.current.data?.items.map((ticket) => ticket.status)).toEqual(["review"]);
    });
    expect(queryClient.getQueryData(qk.tickets("review"))).toBeDefined();
    expect(paths).toEqual(["/api/tickets?status=review"]);
  });

  it("load the cost, the raised alerts and a catalog cause only once it is asked for", async () => {
    const cost = renderQuery(() => useCost());
    const alerts = renderQuery(() => useActiveAlerts());
    const idleFault = renderQuery(() => useCatalogFault(fixtures.catalogFault.fault_id, false));

    await waitFor(() => {
      expect(cost.result.current.data).toEqual(fixtures.cost);
      expect(alerts.result.current.data).toEqual(fixtures.alerts);
    });
    expect(idleFault.result.current.fetchStatus).toBe("idle");

    const fault = renderQuery(() => useCatalogFault(fixtures.catalogFault.fault_id, true));
    await waitFor(() => {
      expect(fault.result.current.data).toEqual(fixtures.catalogFault);
    });
  });

  it("load the overlay catalog, the running injections, and the intervals and markers of a window", async () => {
    const catalog = renderQuery(() => useOverlayCatalog());
    const active = renderQuery(() => useOverlayActive());
    const from = Date.UTC(2020, 5, 5);
    const injections = renderQuery(() => useOverlayInjections(from, "2020-06-06T00:00:00.000Z"));
    const markers = renderQuery(() => useOverlayMarkers());

    await waitFor(() => {
      expect(catalog.result.current.data).toEqual(fixtures.overlayCatalog);
      expect(active.result.current.data).toEqual(fixtures.overlayActive);
      expect(injections.result.current.data).toEqual(fixtures.overlayInjections);
      expect(markers.result.current.data).toEqual(fixtures.overlayMarkers);
    });
    expect(
      queryClient.getQueryData(qk.overlayInjections({ from, to: "2020-06-06T00:00:00.000Z" })),
    ).toEqual(fixtures.overlayInjections);
  });

  it("load a series window, and stay idle while disabled", async () => {
    const query = {
      tags: ["line_pressure"],
      from: "2020-06-05T09:40:00.000Z",
      to: "2020-06-05T09:41:12.000Z",
    };
    const idle = renderQuery(() => useSeries(query, false));
    expect(idle.result.current.fetchStatus).toBe("idle");

    const series = renderQuery(() => useSeries(query));
    await waitFor(() => {
      expect(series.result.current.data?.from).toBe("2020-06-05T09:40:00.000Z");
    });
    expect(paths).toHaveLength(1);
  });
});

describe("useTabCounts", () => {
  it("is null for every tab until the counts load", () => {
    const counts = renderQuery(() => useTabCounts());

    expect(counts.result.current).toEqual({
      tickets: null,
      review: null,
      events: null,
      cost: null,
    });
  });

  it("counts the open tickets, the review queue and the events, and shows the running cost", async () => {
    const counts = renderQuery(() => useTabCounts());

    await waitFor(() => {
      expect(counts.result.current).toEqual({
        tickets: "1",
        review: "1",
        events: "3",
        cost: "$0.031841",
      });
    });
  });

  it("marks a count with more pages behind it", async () => {
    server.use(
      http.get("/api/events/suspect", () =>
        HttpResponse.json({ ...fixtures.events, next_cursor: "next-page" }),
      ),
    );
    const counts = renderQuery(() => useTabCounts());

    await waitFor(() => {
      expect(counts.result.current.events).toBe("3+");
    });
  });

  it("follows the ticket caches, so a patched list moves the badge", async () => {
    const counts = renderQuery(() => useTabCounts());
    await waitFor(() => {
      expect(counts.result.current.tickets).toBe("1");
    });

    queryClient.setQueryData(qk.tickets("open"), { items: [], next_cursor: null });

    await waitFor(() => {
      expect(counts.result.current.tickets).toBe("0");
    });
  });

  it("shows no badge for a count that failed to load", async () => {
    server.use(http.get("/api/cost", () => apiError(500, "internal_error", "boom")));
    const counts = renderQuery(() => useTabCounts());

    await waitFor(() => {
      expect(counts.result.current.tickets).toBe("1");
    });
    expect(counts.result.current.cost).toBeNull();
  });
});
