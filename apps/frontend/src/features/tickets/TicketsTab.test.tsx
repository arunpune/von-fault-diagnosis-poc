// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiTickets, Ticket } from "@/api/types";
import { LazyTicketSheet } from "@/components/app-shell/lazy-panels";
import TicketsTab from "@/features/tickets/TicketsTab";
import { tid } from "@/lib/testids";
import { apiError } from "@/test/msw/handlers";
import { fixtures } from "@/test/msw/fixtures";
import { server } from "@/test/msw/server";
import { renderWithProviders } from "@/test/render";

function ticketWithStatus(status: Ticket["status"]): Ticket {
  const ticket = fixtures.tickets.items.find((item) => item.status === status);
  if (ticket === undefined) {
    throw new Error(`the fixtures have no ${status} ticket`);
  }
  return ticket;
}

const OPEN = ticketWithStatus("open");
const RESOLVED = ticketWithStatus("resolved");
const CLOSED = ticketWithStatus("closed");
const REVIEW = ticketWithStatus("review");

/** Records the `status` query of every tickets request, then lets the fixture handler answer. */
function spyOnTicketFilters(): string[] {
  const seen: string[] = [];
  server.use(
    http.get("/api/tickets", ({ request }) => {
      seen.push(new URL(request.url).searchParams.get("status") ?? "");
    }),
  );
  return seen;
}

function bodyRows(): HTMLElement[] {
  const table = screen.getByRole("table", { name: "Tickets" });
  return within(table).getAllByRole("row").slice(1);
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("TicketsTab", () => {
  it("lists the open tickets with their severity, confidence, status and verdict", async () => {
    renderWithProviders(<TicketsTab />);

    const row = await screen.findByTestId(tid.tickets.row(OPEN.ticket_id));
    expect(bodyRows()).toHaveLength(1);
    expect(within(row).getByRole("link", { name: "Open ticket #8d7e60" })).toHaveAttribute(
      "href",
      `#/tickets/${OPEN.ticket_id}`,
    );
    expect(within(row).getByText("8d7e60")).toHaveAttribute("title", OPEN.ticket_id);
    expect(within(row).getByText(OPEN.title)).toBeInTheDocument();
    expect(within(row).getByText("high")).toHaveAttribute("data-severity", "high");
    expect(within(row).getByText("91 %")).toBeInTheDocument();
    expect(within(row).getByText("open")).toHaveAttribute("data-status", "open");
    expect(within(row).getByTitle("No verdict yet")).toHaveTextContent("—");
    expect(within(row).getAllByText("2020-06-05 09:41:12")).toHaveLength(2);
  });

  it("starts on the open filter and asks the backend for each filter it switches to", async () => {
    const user = userEvent.setup();
    const seen = spyOnTicketFilters();
    renderWithProviders(<TicketsTab />);

    const filters = screen.getByRole("radiogroup", { name: "Ticket status" });
    expect(within(filters).getByRole("radio", { name: "Open" })).toBeChecked();
    await screen.findByTestId(tid.tickets.row(OPEN.ticket_id));

    await user.click(within(filters).getByRole("radio", { name: "Closed" }));
    const closedRow = await screen.findByTestId(tid.tickets.row(CLOSED.ticket_id));
    expect(within(closedRow).getByText("correct")).toHaveAttribute("data-verdict", "correct");
    expect(screen.queryByTestId(tid.tickets.row(OPEN.ticket_id))).not.toBeInTheDocument();

    await user.click(within(filters).getByRole("radio", { name: "Resolved" }));
    expect(await screen.findByTestId(tid.tickets.row(RESOLVED.ticket_id))).toBeInTheDocument();

    await user.click(within(filters).getByRole("radio", { name: "All" }));
    await waitFor(() => {
      expect(bodyRows()).toHaveLength(4);
    });

    expect(seen).toEqual(["open", "closed", "resolved", "all"]);
  });

  it("keeps a filter selected when its pressed item is pressed again", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketsTab />);
    await screen.findByTestId(tid.tickets.row(OPEN.ticket_id));

    await user.click(screen.getByRole("radio", { name: "Open" }));

    expect(screen.getByRole("radio", { name: "Open" })).toBeChecked();
    expect(screen.getByTestId(tid.tickets.row(OPEN.ticket_id))).toBeInTheDocument();
  });

  it("puts the most recently updated ticket first, whatever order the page has", async () => {
    const user = userEvent.setup();
    const shuffled: ApiTickets = {
      items: [REVIEW, OPEN, CLOSED, RESOLVED],
      next_cursor: null,
    };
    server.use(http.get("/api/tickets", () => HttpResponse.json(shuffled)));
    renderWithProviders(<TicketsTab />);

    await user.click(screen.getByRole("radio", { name: "All" }));
    await screen.findByTestId(tid.tickets.row(RESOLVED.ticket_id));

    expect(bodyRows().map((row) => row.dataset.testid)).toEqual(
      [RESOLVED, OPEN, CLOSED, REVIEW].map((ticket) => tid.tickets.row(ticket.ticket_id)),
    );
  });

  it("opens the ticket sheet through the hash route from a row click", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketsTab />);

    const row = await screen.findByTestId(tid.tickets.row(OPEN.ticket_id));
    await user.click(within(row).getByText(OPEN.title));

    expect(window.location.hash).toBe(`#/tickets/${OPEN.ticket_id}`);
  });

  it("opens the ticket sheet from the keyboard through the row's link", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketsTab />);
    await screen.findByTestId(tid.tickets.row(OPEN.ticket_id));

    // The filter group is one tab stop (arrow keys move inside it); the row's link is the next.
    await user.tab();
    expect(screen.getByRole("radio", { name: "Open" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Open ticket #8d7e60" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(window.location.hash).toBe(`#/tickets/${OPEN.ticket_id}`);
  });

  it("starts loading the sheet when a row is hovered or focused", async () => {
    const user = userEvent.setup();
    const preload = vi.spyOn(LazyTicketSheet, "preload");
    renderWithProviders(<TicketsTab />);

    const row = await screen.findByTestId(tid.tickets.row(OPEN.ticket_id));
    await user.hover(row);

    expect(preload).toHaveBeenCalled();
  });

  it("says how a ticket appears when there is none in the status", async () => {
    server.use(http.get("/api/tickets", () => HttpResponse.json({ items: [], next_cursor: null })));
    renderWithProviders(<TicketsTab />);

    expect(
      await screen.findByText(
        "No open tickets. A ticket opens when a decision passes the confidence gate.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows loading rows first, then says what failed and retries on request", async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.get("/api/tickets", () => {
        calls += 1;
        return calls === 1
          ? apiError(503, "db_unavailable", "The database is not reachable")
          : undefined;
      }),
    );
    renderWithProviders(<TicketsTab />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading tickets");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load tickets.");
    expect(alert).toHaveTextContent("The database is not reachable");

    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByTestId(tid.tickets.row(OPEN.ticket_id))).toBeInTheDocument();
    expect(calls).toBe(2);
  });
});
