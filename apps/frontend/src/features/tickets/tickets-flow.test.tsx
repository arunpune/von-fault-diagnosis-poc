// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The technician's path through the whole page with the mock backend: from the tickets tab or
// the review queue to the ticket sheet, a verdict, the toast, and the ticket gone from the list
// it was in.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "@/App";
import type { Ticket } from "@/api/types";
import { tid } from "@/lib/testids";
import { reloadUiPrefs } from "@/store/ui-prefs";
import { fixtures } from "@/test/msw/fixtures";
import { renderWithProviders } from "@/test/render";

function ticketWithStatus(status: Ticket["status"]): Ticket {
  const ticket = fixtures.tickets.items.find((item) => item.status === status);
  if (ticket === undefined) {
    throw new Error(`the fixtures have no ${status} ticket`);
  }
  return ticket;
}

const OPEN = ticketWithStatus("open");
const REVIEW = ticketWithStatus("review");

beforeEach(() => {
  window.localStorage.clear();
  reloadUiPrefs();
});

afterEach(() => {
  toast.dismiss();
  window.history.replaceState(null, "", "/");
});

describe("tickets in the app", () => {
  it("opens an open ticket from the tickets tab and closes it as correct", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    const row = await screen.findByTestId(tid.tickets.row(OPEN.ticket_id));
    await waitFor(() => {
      expect(screen.getByTestId(tid.tickets.tab)).toHaveTextContent("Tickets1");
    });
    await user.click(within(row).getByText(OPEN.title));
    expect(window.location.hash).toBe(`#/tickets/${OPEN.ticket_id}`);

    const sheet = await screen.findByRole("dialog", { name: OPEN.title });
    expect(sheet).toHaveAttribute("data-testid", tid.tickets.sheet);
    await user.click(within(sheet).getByTestId(tid.tickets.closeCorrect));
    await user.click(within(sheet).getByTestId(tid.tickets.closeSubmit));

    expect(await screen.findByText("Ticket #8d7e60 closed as correct")).toBeInTheDocument();
    expect(within(sheet).getByRole("region", { name: "Closure" })).toHaveTextContent("correct");

    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(window.location.hash).toBe("");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "No open tickets. A ticket opens when a decision passes the confidence gate.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId(tid.tickets.tab)).toHaveTextContent("Tickets0");
  });

  it("opens a ticket from the review queue and closes it as wrong", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByTestId(tid.review.tab));
    const row = await screen.findByTestId(tid.review.row(REVIEW.ticket_id));
    await user.click(within(row).getByRole("link", { name: REVIEW.title }));

    const sheet = await screen.findByRole("dialog", { name: REVIEW.title });
    expect(within(sheet).getByText("review")).toHaveAttribute("data-status", "review");
    await user.click(within(sheet).getByTestId(tid.tickets.closeWrong));
    await user.type(within(sheet).getByRole("textbox", { name: /Note/ }), "Busy shift, no leak.");
    await user.click(within(sheet).getByTestId(tid.tickets.closeSubmit));

    expect(await screen.findByText("Ticket #8d9e01 closed as wrong")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(
      screen.getByText("Nothing to review. Decisions between 60 % and 85 % confidence land here."),
    ).toBeInTheDocument();
    expect(screen.getByTestId(tid.review.tab)).toHaveTextContent("Review0");
  });
});
