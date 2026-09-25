// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { qk } from "@/api/query-keys";
import type { ApiDecisions, ApiEvents, Decision, SuspectEvent } from "@/api/types";
import { LazyDecisionSheet, LazyTicketSheet } from "@/components/app-shell/lazy-panels";
import AlertsPanel from "@/features/alerts/AlertsPanel";
import { tid } from "@/lib/testids";
import { applyStatusSnapshot, resetLiveStore } from "@/store/live-store";
import { fixtures } from "@/test/msw/fixtures";
import { apiError } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { renderWithProviders } from "@/test/render";

const EMPTY_PAGE = { items: [], next_cursor: null };

afterEach(() => {
  resetLiveStore();
  window.history.replaceState(null, "", "/");
});

function alertsRegion(): HTMLElement {
  return screen.getByRole("region", { name: "Alerts" });
}

async function renderLoaded() {
  const result = renderWithProviders(<AlertsPanel />);
  const list = await screen.findByTestId(tid.alerts.list);
  return { ...result, list };
}

function viewport(): HTMLElement {
  const element = alertsRegion().querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
  if (element === null) {
    throw new Error("the alerts list has no scroll viewport");
  }
  return element;
}

function scrollListTo(top: number): void {
  const element = viewport();
  element.scrollTop = top;
  fireEvent.scroll(element);
}

function newDecision(): Decision {
  return {
    ...structuredClone(fixtures.decision),
    decision_id: "5b1e2f3a-7c4d-4e8f-9a0b-1c2d3e4f5a6b",
    sim_ts: "2020-06-05T11:41:12.000Z",
    confidence: 0.87,
  };
}

function pushDecision(queryClient: QueryClient, decision: Decision): void {
  act(() => {
    queryClient.setQueryData<ApiDecisions>(qk.decisions(null), (page) =>
      page === undefined ? page : { ...page, items: [decision, ...page.items] },
    );
  });
}

function pushEvent(queryClient: QueryClient, event: SuspectEvent): void {
  act(() => {
    queryClient.setQueryData<ApiEvents>(qk.events(), (page) =>
      page === undefined ? page : { ...page, items: [event, ...page.items] },
    );
  });
}

function liveRegion(): HTMLElement {
  return within(alertsRegion()).getByRole("status");
}

describe("AlertsPanel feed", () => {
  it("shows a loading state until the three lists answer", async () => {
    renderWithProviders(<AlertsPanel />);

    expect(within(alertsRegion()).getByText("Loading alerts")).toBeInTheDocument();
    expect(await screen.findByTestId(tid.alerts.list)).toBeInTheDocument();
  });

  it("lists suspect events, decisions and tickets newest first", async () => {
    const { list } = await renderLoaded();

    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(10);
    expect(items.map((item) => item.dataset.kind)).toEqual([
      "ticket",
      "decision_failed",
      "suspect",
      "ticket",
      "decision",
      "suspect",
      "ticket",
      "ticket",
      "decision",
      "suspect",
    ]);
    expect(items[0]).toHaveTextContent("Ticket #5f6a70 resolved");
    expect(items[1]).toHaveTextContent("Decision failed: timeout");
    expect(items[2]).toHaveTextContent("Suspect: Continuous load");
  });

  it("gives decisions and tickets a severity badge with its word, and decisions the gate word", async () => {
    const { list } = await renderLoaded();

    const decision = within(list).getByTestId(
      tid.alerts.item(`decision-${fixtures.decision.decision_id}`),
    );
    expect(within(decision).getByText("high")).toHaveAttribute("data-severity", "high");
    expect(within(decision).getByText("91 %")).toBeInTheDocument();
    expect(within(decision).getByText("Ticket")).toBeInTheDocument();
    expect(within(decision).getByText("2020-06-05 09:41:12")).toBeInTheDocument();

    const review = within(list).getByTestId(
      tid.alerts.item("decision-0e5f7a21-9c34-4b6d-81a7-2f3e4d5c6b70"),
    );
    expect(within(review).getByText("medium")).toBeInTheDocument();
    expect(within(review).getByText("Review")).toBeInTheDocument();

    const ticket = within(list).getByTestId(
      tid.alerts.item("ticket-2c7f8a15-4b90-4d63-8e27-1a0b9c8d7e60"),
    );
    expect(within(ticket).getByText("high")).toBeInTheDocument();
    expect(within(ticket).getByText("Open")).toBeInTheDocument();

    const failed = within(list).getByTestId(
      tid.alerts.item(`decision-${fixtures.decisionFailed.decision_id}`),
    );
    expect(failed.querySelector("[data-severity]")).toBeNull();
    expect(within(failed).getByText("Logged")).toBeInTheDocument();
  });

  it("links each row to its sheet, names every link and preloads the sheet on hover", async () => {
    const user = userEvent.setup();
    const preloadDecision = vi.spyOn(LazyDecisionSheet, "preload");
    const preloadTicket = vi.spyOn(LazyTicketSheet, "preload");
    const { list } = await renderLoaded();

    const links = within(list).getAllByRole("link");
    expect(links).toHaveLength(10);
    for (const link of links) {
      expect(link).toHaveAccessibleName();
    }
    const decision = within(list).getByRole("link", {
      name: /Decision: Dryer purge valve not seating/,
    });
    await user.hover(decision);
    expect(preloadDecision).toHaveBeenCalled();
    await user.hover(within(list).getByRole("link", { name: /Ticket #8d7e60 opened/ }));
    expect(preloadTicket).toHaveBeenCalled();
  });

  it("sets the hash route of the decision or ticket a row is clicked on", async () => {
    const user = userEvent.setup();
    const { list } = await renderLoaded();

    await user.click(
      within(list).getByRole("link", { name: /Decision: Dryer purge valve not seating/ }),
    );
    expect(window.location.hash).toBe(`#/decisions/${fixtures.decision.decision_id}`);

    await user.click(within(list).getByRole("link", { name: /Ticket #8d7e60 opened/ }));
    expect(window.location.hash).toBe("#/tickets/2c7f8a15-4b90-4d63-8e27-1a0b9c8d7e60");

    await user.click(within(list).getByRole("link", { name: /Suspect: Frequent cycling/ }));
    expect(window.location.hash).toBe("#/decisions/0e5f7a21-9c34-4b6d-81a7-2f3e4d5c6b70");
  });

  it("does not link a suspect event no decision has answered", async () => {
    server.use(
      http.get("/api/decisions", () => HttpResponse.json(EMPTY_PAGE)),
      http.get("/api/tickets", () => HttpResponse.json(EMPTY_PAGE)),
    );
    const { list } = await renderLoaded();

    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).queryByRole("link")).not.toBeInTheDocument();
  });

  it("marks rows for content-visibility so off-screen rows skip layout", async () => {
    const { list } = await renderLoaded();

    for (const item of within(list).getAllByRole("listitem")) {
      expect(item.className).toContain("[content-visibility:auto]");
    }
  });

  it("directs the reader to Play or a jump when there is nothing yet", async () => {
    server.use(
      http.get("/api/events/suspect", () => HttpResponse.json(EMPTY_PAGE)),
      http.get("/api/decisions", () => HttpResponse.json(EMPTY_PAGE)),
      http.get("/api/tickets", () => HttpResponse.json(EMPTY_PAGE)),
    );
    renderWithProviders(<AlertsPanel />);

    expect(
      await screen.findByText("No alerts yet. Press Play, or jump to a known failure."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId(tid.alerts.list)).not.toBeInTheDocument();
  });

  it("says what failed, keeps the rows that loaded and retries", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/decisions", () => apiError(503, "upstream_unavailable", "Database down."), {
        once: true,
      }),
    );
    renderWithProviders(<AlertsPanel />);

    const message = await within(alertsRegion()).findByText("Couldn't load alerts.");
    const error = message.closest<HTMLElement>('[role="alert"]');
    if (error === null) {
      throw new Error("the error state is not an alert");
    }
    expect(error).toHaveTextContent("Database down.");
    expect(await screen.findByText("Ticket #8d7e60 opened")).toBeInTheDocument();

    await user.click(within(error).getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Decision failed: timeout")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load alerts.")).not.toBeInTheDocument();
  });
});

describe("AlertsPanel system alerts", () => {
  it("shows a banner above the list for each raised alert of the live store", async () => {
    await renderLoaded();
    act(() => applyStatusSnapshot(fixtures.status));

    const banner = await screen.findByTestId(tid.alerts.banner("telemetry_silent"));
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent("Telemetry silent for 90 s while playing");
    expect(banner).toHaveTextContent("No telemetry sample arrived for 90 s.");
    expect(
      banner.compareDocumentPosition(screen.getByTestId(tid.alerts.list)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(banner).queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows no banner while the backend reports none", async () => {
    await renderLoaded();
    act(() => applyStatusSnapshot({ ...fixtures.status, alerts_active: [] }));

    expect(screen.queryByTestId(tid.alerts.banner("telemetry_silent"))).not.toBeInTheDocument();
  });
});

describe("AlertsPanel new-rows pill", () => {
  it("counts rows that arrive while the list is scrolled away from the top", async () => {
    const { queryClient } = await renderLoaded();

    scrollListTo(240);
    pushDecision(queryClient, newDecision());

    const pill = await screen.findByTestId(tid.alerts.newPill);
    expect(pill).toHaveAccessibleName("1 new alerts, scroll to the newest");
    expect(pill).toHaveTextContent("1 new");
  });

  it("scrolls back to the top on click and clears the count", async () => {
    const user = userEvent.setup();
    const { queryClient } = await renderLoaded();
    const scrollTo = vi.fn();
    viewport().scrollTo = scrollTo;

    scrollListTo(240);
    pushDecision(queryClient, newDecision());
    await user.click(await screen.findByTestId(tid.alerts.newPill));

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    expect(screen.queryByTestId(tid.alerts.newPill)).not.toBeInTheDocument();
  });

  it("jumps without animation when the reader asks for reduced motion", async () => {
    const user = userEvent.setup();
    const matchNothing = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      ...matchNothing(query),
      matches: query === "(prefers-reduced-motion: reduce)",
    }));
    const { queryClient } = await renderLoaded();
    const scrollTo = vi.fn();
    viewport().scrollTo = scrollTo;

    scrollListTo(240);
    pushDecision(queryClient, newDecision());
    await user.click(await screen.findByTestId(tid.alerts.newPill));

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
  });

  it("shows no pill while the list is at the top, nor for rows already seen", async () => {
    const { queryClient } = await renderLoaded();
    const decision = newDecision();

    pushDecision(queryClient, decision);
    expect(
      await screen.findByTestId(tid.alerts.item(`decision-${decision.decision_id}`)),
    ).toBeInTheDocument();
    scrollListTo(240);

    expect(screen.queryByTestId(tid.alerts.newPill)).not.toBeInTheDocument();
    scrollListTo(0);
    expect(screen.queryByTestId(tid.alerts.newPill)).not.toBeInTheDocument();
  });
});

describe("AlertsPanel live announcements", () => {
  it("announces arriving decisions but neither the first load nor suspect events", async () => {
    const { queryClient } = await renderLoaded();

    const region = liveRegion();
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();

    const event = {
      ...structuredClone(fixtures.events.items[0] as SuspectEvent),
      event_id: "e-new",
      sim_ts: "2020-06-05T11:41:12.000Z",
    };
    pushEvent(queryClient, event);
    await waitFor(() => {
      expect(screen.getByTestId(tid.alerts.item("suspect-e-new"))).toBeInTheDocument();
    });
    expect(region).toBeEmptyDOMElement();

    pushDecision(queryClient, newDecision());
    await waitFor(() => {
      expect(region).toHaveTextContent("Decision: Dryer purge valve not seating, 87 %, Ticket.");
    });
  });
});
