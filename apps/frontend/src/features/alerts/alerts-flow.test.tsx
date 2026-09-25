// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The alerts path end to end inside the page (an integration test): <App/> renders against the
// mock backend, the WebSocket frames of one episode arrive — a suspect event, the decision that
// answers it, the ticket it opens — and the reader follows the feed into the decision sheet and
// on to the ticket.
//
// The frames go through the page's own cache reducers (`installWsCache`), which the live feed
// installs. The mock backend persists each record before its frame is dispatched, as the real
// one does, so a refetch returns what the frames announced.

import type { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "@/App";
import type { Decision, SuspectEvent, Ticket } from "@/api/types";
import { installWsCache } from "@/api/ws-cache";
import { dispatchFrame } from "@/api/ws-dispatch";
import type { FrameOf } from "@/api/ws-types";
import { tid } from "@/lib/testids";
import { resetLiveStore } from "@/store/live-store";
import { reloadUiPrefs } from "@/store/ui-prefs";
import { frames } from "@/test/msw/fixtures";
import { server } from "@/test/msw/server";
import { createTestQueryClient, renderWithProviders } from "@/test/render";

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** What the mock backend has persisted so far; each list is newest first. */
const persisted = {
  events: [] as SuspectEvent[],
  decisions: [] as Decision[],
  tickets: [] as Ticket[],
};

function page<T>(items: readonly T[]): Page<T> {
  return { items: [...items], next_cursor: null };
}

/** The backend persists the record, then pushes its frame. */
function arrive(frame: FrameOf<"event.suspect"> | FrameOf<"decision"> | FrameOf<"ticket">): void {
  switch (frame.type) {
    case "event.suspect":
      persisted.events.unshift(frame.payload);
      break;
    case "decision":
      persisted.decisions.unshift(frame.payload);
      break;
    case "ticket":
      persisted.tickets.unshift(frame.payload);
      break;
  }
  act(() => dispatchFrame(frame));
}

let queryClient: QueryClient;
let uninstallWsCache: () => void = () => undefined;

beforeEach(() => {
  window.localStorage.clear();
  reloadUiPrefs();
  persisted.events = [];
  persisted.decisions = [];
  persisted.tickets = [];
  server.use(
    http.get("/api/events/suspect", () => HttpResponse.json(page(persisted.events))),
    http.get("/api/decisions", () => HttpResponse.json(page(persisted.decisions))),
    http.get("/api/tickets", ({ request }) => {
      const status = new URL(request.url).searchParams.get("status") ?? "all";
      const items = persisted.tickets.filter(
        (ticket) => status === "all" || ticket.status === status,
      );
      return HttpResponse.json(page(items));
    }),
  );
  queryClient = createTestQueryClient();
  uninstallWsCache = installWsCache(queryClient);
});

afterEach(() => {
  uninstallWsCache();
  resetLiveStore();
  window.history.replaceState(null, "", "/");
});

function feed(): HTMLElement {
  return within(screen.getByRole("region", { name: "Alerts" })).getByTestId(tid.alerts.list);
}

describe("alerts feed and decision sheet inside the page", () => {
  it("shows suspect, decision and ticket frames as they arrive and opens the sheet from the feed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />, { queryClient });
    const alerts = screen.getByRole("region", { name: "Alerts" });
    expect(
      await within(alerts).findByText("No alerts yet. Press Play, or jump to a known failure."),
    ).toBeInTheDocument();

    const suspect = frames["event.suspect"];
    arrive(suspect);
    const suspectItem = await within(alerts).findByTestId(
      tid.alerts.item(`suspect-${suspect.payload.event_id}`),
    );
    expect(suspectItem).toHaveTextContent("Suspect: Continuous load");
    expect(within(suspectItem).queryByRole("link")).not.toBeInTheDocument();

    const decision = frames.decision;
    arrive(decision);
    const decisionItem = await within(alerts).findByTestId(
      tid.alerts.item(`decision-${decision.payload.decision_id}`),
    );
    expect(within(decisionItem).getByText("high")).toHaveAttribute("data-severity", "high");
    expect(within(decisionItem).getByText("91 %")).toBeInTheDocument();
    expect(within(suspectItem).getByRole("link")).toHaveAttribute(
      "href",
      `#/decisions/${decision.payload.decision_id}`,
    );

    const ticket = frames.ticket;
    arrive(ticket);
    expect(await within(alerts).findByText("Ticket #8d7e60 opened")).toBeInTheDocument();

    expect(
      within(feed())
        .getAllByRole("listitem")
        .map((item) => item.dataset.kind),
    ).toEqual(["ticket", "decision", "suspect"]);
    await waitFor(() => {
      expect(within(alerts).getByRole("status")).toHaveTextContent("Ticket #8d7e60 opened.");
    });

    await user.click(
      within(decisionItem).getByRole("link", { name: /^Decision: Dryer purge valve not seating/ }),
    );
    expect(window.location.hash).toBe(`#/decisions/${decision.payload.decision_id}`);

    const sheet = await screen.findByRole("dialog", { name: "Dryer purge valve not seating" });
    const candidates = within(sheet).getByRole("region", { name: "Candidates" });
    expect(within(candidates).getAllByRole("listitem")).toHaveLength(5);
    expect(within(candidates).getAllByText(/^§8\.3 /).length).toBeGreaterThan(0);
    expect(
      await within(sheet).findByRole("table", { name: "Evidence of the suspect event" }),
    ).toBeInTheDocument();

    await user.click(await within(sheet).findByTestId(tid.decision.ticketLink));

    expect(window.location.hash).toBe(`#/tickets/${ticket.payload.ticket_id}`);
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Dryer purge valve not seating" }),
      ).not.toBeInTheDocument();
    });
  });
});
