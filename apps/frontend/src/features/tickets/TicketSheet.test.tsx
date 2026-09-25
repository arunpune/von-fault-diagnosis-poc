// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Ticket } from "@/api/types";
import TicketSheet from "@/features/tickets/TicketSheet";
import { tid } from "@/lib/testids";
import { fmtWall } from "@/lib/time";
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

const DETAIL = fixtures.ticket;
const RESOLVED = ticketWithStatus("resolved");
const CLOSED = ticketWithStatus("closed");

/** The decisions of the detail's episode, as `decisions.json` holds them (newest first). */
const EPISODE_DECISIONS = fixtures.decisions.items.filter(
  (decision) => decision.episode_id === DETAIL.episode_id,
);

function renderSheet(ticketId: string | null, onClose = vi.fn()) {
  return { onClose, ...renderWithProviders(<TicketSheet ticketId={ticketId} onClose={onClose} />) };
}

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("TicketSheet", () => {
  it("renders nothing while no ticket is routed", () => {
    renderSheet(null);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("titles the sheet with the fault and badges the ticket's standing", async () => {
    renderSheet(DETAIL.ticket_id);

    const sheet = await screen.findByRole("dialog", { name: DETAIL.title });
    expect(sheet).toHaveAttribute("data-testid", tid.tickets.sheet);
    expect(within(sheet).getByText("8d7e60")).toHaveAttribute("title", DETAIL.ticket_id);
    expect(within(sheet).getByText(/opened 2020-06-05 09:41:12 UTC/)).toBeInTheDocument();
    expect(within(sheet).getByText("open")).toHaveAttribute("data-status", "open");
    expect(within(sheet).getByText("high")).toHaveAttribute("data-severity", "high");
    expect(within(sheet).getByText("91 % confidence")).toBeInTheDocument();
    expect(within(sheet).getByText("no updates")).toBeInTheDocument();
  });

  it("shows cause, the checks in order, remedy, manual reference and evidence", async () => {
    renderSheet(DETAIL.ticket_id);
    await screen.findByRole("dialog", { name: DETAIL.title });

    expect(section("Cause")).toHaveTextContent(DETAIL.cause);
    const checks = within(section("Checks")).getByRole("list");
    expect(checks.tagName).toBe("OL");
    expect(
      within(checks)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(DETAIL.checks);
    expect(section("Remedy")).toHaveTextContent(DETAIL.remedy);
    expect(section("Manual reference")).toHaveTextContent(
      "§8.3 Compressor stays loaded and does not reach cut-out",
    );

    const evidence = within(section("Evidence")).getByRole("table", {
      name: "Evidence behind this ticket",
    });
    const rows = within(evidence).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(DETAIL.evidence.length);
    expect(rows[0]).toHaveTextContent(DETAIL.evidence[0]?.observation ?? "");
    // The registry's label once /api/signals answered; the derived metric is humanised.
    expect(await within(rows[1] as HTMLElement).findByText("Dryer purge pressure")).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText("Loaded run duration")).toBeVisible();
  });

  it("lists the episode's decisions from GET /api/decisions?episode_id= and opens one", async () => {
    const user = userEvent.setup();
    const episodes: (string | null)[] = [];
    server.use(
      http.get("/api/decisions", ({ request }) => {
        episodes.push(new URL(request.url).searchParams.get("episode_id"));
      }),
    );
    renderSheet(DETAIL.ticket_id);
    await screen.findByRole("dialog", { name: DETAIL.title });

    const table = await within(section("Decisions")).findByRole("table", {
      name: "Decisions of this episode",
    });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(EPISODE_DECISIONS.length);
    expect(episodes).toEqual([DETAIL.episode_id]);

    const [failed, answered] = rows as [HTMLElement, HTMLElement];
    expect(failed).toHaveTextContent("2020-06-05 10:11:12");
    expect(failed).toHaveTextContent("Jev");
    expect(failed).toHaveTextContent("—");
    expect(failed).toHaveTextContent("Failed");
    expect(answered).toHaveTextContent("2020-06-05 09:41:12");
    expect(answered).toHaveTextContent("91 %");
    expect(answered).toHaveTextContent("Ticket");

    await user.click(within(answered).getByRole("link", { name: /^Open the decision of/ }));

    expect(window.location.hash).toBe(`#/decisions/${EPISODE_DECISIONS[1]?.decision_id ?? ""}`);
  });

  it("offers the close form while the ticket is open", async () => {
    renderSheet(DETAIL.ticket_id);
    await screen.findByRole("dialog", { name: DETAIL.title });

    const form = section("Close ticket");
    expect(
      within(form).getByRole("radiogroup", { name: "Was the diagnosis right?" }),
    ).toBeVisible();
    expect(within(form).getByRole("button", { name: "Close ticket" })).toBeDisabled();
  });

  it("shows the closure record of a closed ticket and no form", async () => {
    const closure = CLOSED.closure;
    renderSheet(CLOSED.ticket_id);
    await screen.findByRole("dialog", { name: CLOSED.title });

    const record = section("Closure");
    expect(within(record).getByText("correct")).toHaveAttribute("data-verdict", "correct");
    expect(record).toHaveTextContent(closure?.note ?? "");
    expect(record).toHaveTextContent("shift-fitter-2");
    expect(record).toHaveTextContent(fmtWall(closure?.wall_ts ?? ""));
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close ticket" })).not.toBeInTheDocument();
  });

  it("says a resolved ticket was resolved by the system and offers no form", async () => {
    renderSheet(RESOLVED.ticket_id);
    await screen.findByRole("dialog", { name: RESOLVED.title });

    const resolution = section("Resolution");
    expect(resolution).toHaveTextContent("Resolved by the system");
    expect(resolution).toHaveTextContent(
      "The episode ended at 2020-07-18 16:05:00 UTC because the symptom went quiet.",
    );
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close ticket" })).not.toBeInTheDocument();
  });

  it("names the ticket it could not load and retries on request", async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.get("/api/tickets/:id", () => {
        calls += 1;
        return calls === 1 ? apiError(500, "internal", "The ticket store failed") : undefined;
      }),
    );
    renderSheet(DETAIL.ticket_id);

    const sheet = await screen.findByRole("dialog", { name: "Ticket" });
    const alert = await within(sheet).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load ticket #8d7e60.");
    expect(alert).toHaveTextContent("The ticket store failed");

    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("dialog", { name: DETAIL.title })).toBeInTheDocument();
  });

  it("asks to close when the close button or Escape is pressed", async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet(DETAIL.ticket_id);
    const sheet = await screen.findByRole("dialog", { name: DETAIL.title });

    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
