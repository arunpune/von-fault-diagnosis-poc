// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { http } from "msw";
import { toast } from "sonner";
import { afterEach, describe, expect, it } from "vitest";

import { qk } from "@/api/query-keys";
import type { ApiTickets, Ticket } from "@/api/types";
import TicketSheet from "@/features/tickets/TicketSheet";
import { tid } from "@/lib/testids";
import { apiError } from "@/test/msw/handlers";
import { fixtures } from "@/test/msw/fixtures";
import { server } from "@/test/msw/server";
import { createTestQueryClient, renderWithProviders } from "@/test/render";

function ticketWithStatus(status: Ticket["status"]): Ticket {
  const ticket = fixtures.tickets.items.find((item) => item.status === status);
  if (ticket === undefined) {
    throw new Error(`the fixtures have no ${status} ticket`);
  }
  return ticket;
}

const OPEN = ticketWithStatus("open");
const REVIEW = ticketWithStatus("review");
const CLOSED = ticketWithStatus("closed");

function pageOf(...items: Ticket[]): ApiTickets {
  return { items, next_cursor: null };
}

/** Records every close body, then lets the fixture handler answer. */
function spyOnCloseBodies(): unknown[] {
  const bodies: unknown[] = [];
  server.use(
    http.post("/api/tickets/:id/close", async ({ request }) => {
      bodies.push(await request.clone().json());
    }),
  );
  return bodies;
}

async function openSheet(ticket: Ticket) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(qk.tickets(ticket.status), pageOf(ticket));
  queryClient.setQueryData(qk.tickets("closed"), pageOf(CLOSED));
  renderWithProviders(<TicketSheet ticketId={ticket.ticket_id} onClose={() => undefined} />, {
    queryClient,
  });
  const sheet = await screen.findByRole("dialog", { name: ticket.title });
  return { queryClient, sheet };
}

function submitButton(): HTMLElement {
  return screen.getByTestId(tid.tickets.closeSubmit);
}

/** Presses Tab until `element` has focus; the sheet's links come before the form. */
async function tabTo(user: UserEvent, element: HTMLElement): Promise<void> {
  for (let step = 0; step < 20 && document.activeElement !== element; step += 1) {
    await user.tab();
  }
  expect(element).toHaveFocus();
}

afterEach(() => {
  toast.dismiss();
});

describe("CloseTicketForm", () => {
  it("keeps the button disabled until a verdict is chosen", async () => {
    const user = userEvent.setup();
    await openSheet(OPEN);

    expect(submitButton()).toBeDisabled();
    expect(submitButton()).toHaveTextContent("Close ticket");

    await user.click(screen.getByRole("radio", { name: "Wrong" }));

    expect(submitButton()).toBeEnabled();
  });

  it("posts the verdict and the note, moves the ticket to the closed list and says so", async () => {
    const user = userEvent.setup();
    const bodies = spyOnCloseBodies();
    const { queryClient, sheet } = await openSheet(OPEN);

    await user.click(screen.getByTestId(tid.tickets.closeCorrect));
    await user.type(screen.getByRole("textbox", { name: /Note/ }), "Purge valve seat worn.");
    await user.click(submitButton());

    expect(await screen.findByText("Ticket #8d7e60 closed as correct")).toBeInTheDocument();
    expect(bodies).toEqual([{ verdict: "correct", note: "Purge valve seat worn." }]);

    expect(queryClient.getQueryData<ApiTickets>(qk.tickets("open"))?.items).toEqual([]);
    const closed = queryClient.getQueryData<ApiTickets>(qk.tickets("closed"))?.items ?? [];
    expect(closed.map((ticket) => ticket.ticket_id)).toEqual([OPEN.ticket_id, CLOSED.ticket_id]);

    const record = within(sheet).getByRole("region", { name: "Closure" });
    expect(within(record).getByText("correct")).toHaveAttribute("data-verdict", "correct");
    expect(record).toHaveTextContent("Purge valve seat worn.");
    expect(within(sheet).queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(within(sheet).getByText("closed")).toHaveAttribute("data-status", "closed");
  });

  it("sends no note when the note is left blank", async () => {
    const user = userEvent.setup();
    const bodies = spyOnCloseBodies();
    await openSheet(OPEN);

    await user.click(screen.getByTestId(tid.tickets.closeWrong));
    await user.click(submitButton());

    expect(await screen.findByText("Ticket #8d7e60 closed as wrong")).toBeInTheDocument();
    expect(bodies).toEqual([{ verdict: "wrong" }]);
  });

  it("closes a review ticket too", async () => {
    const user = userEvent.setup();
    const { queryClient } = await openSheet(REVIEW);

    await user.click(screen.getByTestId(tid.tickets.closeWrong));
    await user.click(submitButton());

    expect(await screen.findByText("Ticket #8d9e01 closed as wrong")).toBeInTheDocument();
    expect(queryClient.getQueryData<ApiTickets>(qk.tickets("review"))?.items).toEqual([]);
  });

  it("says what failed and keeps the form as it was when the close is refused", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/tickets/:id/close", () =>
        apiError(409, "conflict", "the ticket already has a verdict"),
      ),
    );
    const { queryClient } = await openSheet(OPEN);

    await user.click(screen.getByTestId(tid.tickets.closeCorrect));
    await user.type(screen.getByRole("textbox", { name: /Note/ }), "Seat worn.");
    await user.click(submitButton());

    expect(
      await screen.findByText("Couldn't close ticket #8d7e60: the ticket already has a verdict"),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Correct" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: /Note/ })).toHaveValue("Seat worn.");
    expect(submitButton()).toBeEnabled();
    expect(queryClient.getQueryData<ApiTickets>(qk.tickets("open"))?.items).toEqual([OPEN]);
  });

  it("works from the keyboard: arrows pick the verdict, Tab reaches the note and the button", async () => {
    const user = userEvent.setup();
    const bodies = spyOnCloseBodies();
    await openSheet(OPEN);
    const correct = screen.getByRole("radio", { name: "Correct" });
    const wrong = screen.getByRole("radio", { name: "Wrong" });

    await tabTo(user, correct);
    await user.keyboard(" ");
    expect(correct).toBeChecked();
    // Held and released as two steps, like a person does: Radix checks the radio that an arrow
    // key moved focus to while the key is down.
    await user.keyboard("{ArrowDown>}{/ArrowDown}");
    expect(wrong).toHaveFocus();
    expect(wrong).toBeChecked();
    await user.keyboard("{ArrowUp>}{/ArrowUp}");
    expect(correct).toBeChecked();

    await user.tab();
    expect(screen.getByRole("textbox", { name: /Note/ })).toHaveFocus();
    await user.keyboard("Replaced the valve kit.");
    await user.tab();
    expect(submitButton()).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(await screen.findByText("Ticket #8d7e60 closed as correct")).toBeInTheDocument();
    expect(bodies).toEqual([{ verdict: "correct", note: "Replaced the valve kit." }]);
  });
});
