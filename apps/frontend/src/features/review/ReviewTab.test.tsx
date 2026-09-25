// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiStatus, Ticket } from "@/api/types";
import { LazyTicketSheet } from "@/components/app-shell/lazy-panels";
import ReviewTab from "@/features/review/ReviewTab";
import { tid } from "@/lib/testids";
import { apiError } from "@/test/msw/handlers";
import { fixtures } from "@/test/msw/fixtures";
import { server } from "@/test/msw/server";
import { renderWithProviders } from "@/test/render";

function reviewTicket(): Ticket {
  const ticket = fixtures.tickets.items.find((item) => item.status === "review");
  if (ticket === undefined) {
    throw new Error("the fixtures have no review ticket");
  }
  return ticket;
}

const REVIEW = reviewTicket();

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

function answerStatusWithGate(gate: ApiStatus["gate"]): void {
  server.use(http.get("/api/status", () => HttpResponse.json({ ...fixtures.status, gate })));
}

function thresholdTicks(row: HTMLElement): (string | null)[] {
  return Array.from(row.querySelectorAll("[data-threshold]"), (tick) => tick.getAttribute("title"));
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("ReviewTab", () => {
  it("lists the review tickets with confidence against the gate, severity and updates", async () => {
    const seen = spyOnTicketFilters();
    renderWithProviders(<ReviewTab />);

    const row = await screen.findByTestId(tid.review.row(REVIEW.ticket_id));
    const table = screen.getByRole("table", { name: "Review queue" });
    expect(within(table).getAllByRole("row").slice(1)).toEqual([row]);
    expect(seen).toEqual(["review"]);

    expect(within(row).getByRole("link", { name: REVIEW.title })).toHaveAttribute(
      "href",
      `#/tickets/${REVIEW.ticket_id}`,
    );
    const meter = within(row).getByRole("progressbar", { name: "Confidence of ticket #8d9e01" });
    expect(meter).toHaveAttribute("aria-valuetext", "65 %");
    expect(within(row).getByText("medium")).toHaveAttribute("data-severity", "medium");
    expect(row).toHaveTextContent("2020-05-22 04:15:00");
    expect(row).toHaveTextContent("no updates");
    expect(thresholdTicks(row)).toEqual(["Review at 60 %", "Ticket at 85 %"]);
  });

  it("marks the thresholds the gate reports it runs with", async () => {
    answerStatusWithGate({ review_min_confidence: 0.55, ticket_min_confidence: 0.9 });
    renderWithProviders(<ReviewTab />);

    const row = await screen.findByTestId(tid.review.row(REVIEW.ticket_id));

    await vi.waitFor(() => {
      expect(thresholdTicks(row)).toEqual(["Review at 55 %", "Ticket at 90 %"]);
    });
  });

  it("opens the ticket sheet from a row, where the ticket is closed", async () => {
    const user = userEvent.setup();
    const preload = vi.spyOn(LazyTicketSheet, "preload");
    renderWithProviders(<ReviewTab />);

    const row = await screen.findByTestId(tid.review.row(REVIEW.ticket_id));
    await user.hover(row);
    expect(preload).toHaveBeenCalled();

    await user.click(within(row).getByText("2020-05-22 04:15:00"));

    expect(window.location.hash).toBe(`#/tickets/${REVIEW.ticket_id}`);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("opens the ticket sheet from the keyboard through the row's link", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReviewTab />);
    await screen.findByTestId(tid.review.row(REVIEW.ticket_id));

    await user.tab();
    expect(screen.getByRole("link", { name: REVIEW.title })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(window.location.hash).toBe(`#/tickets/${REVIEW.ticket_id}`);
  });

  it("says where review tickets come from when the queue is empty", async () => {
    server.use(http.get("/api/tickets", () => HttpResponse.json({ items: [], next_cursor: null })));
    renderWithProviders(<ReviewTab />);

    expect(
      await screen.findByText(
        "Nothing to review. Decisions between 60 % and 85 % confidence land here.",
      ),
    ).toBeInTheDocument();
  });

  it("says what failed and retries on request", async () => {
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
    renderWithProviders(<ReviewTab />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the review queue");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the review queue.");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByTestId(tid.review.row(REVIEW.ticket_id))).toBeInTheDocument();
  });
});
