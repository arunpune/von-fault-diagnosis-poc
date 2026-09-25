// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import type { QueryClient } from "@tanstack/react-query";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import { SIM_TIMEOUT_CODE } from "@/api/endpoints";
import {
  patchTicketCaches,
  useCloseTicket,
  useSimCommand,
  withTicket,
  type SimCommandRequest,
} from "@/api/mutations";
import { qk } from "@/api/query-keys";
import type { ApiTickets, StatusSim, Ticket, TicketDetail } from "@/api/types";
import { AppProviders } from "@/components/app-shell/AppProviders";
import { resetLiveStore, useSimStatus } from "@/store/live-store";
import { fixtures } from "@/test/msw/fixtures";
import { server } from "@/test/msw/server";
import { createTestQueryClient } from "@/test/render";

let queryClient: QueryClient;

function Providers({ children }: { children: ReactNode }) {
  return <AppProviders queryClient={queryClient}>{children}</AppProviders>;
}

beforeEach(() => {
  queryClient = createTestQueryClient();
});

afterEach(() => {
  queryClient.clear();
  resetLiveStore();
});

function ticketWithStatus(status: string): Ticket {
  const ticket = fixtures.tickets.items.find((item) => item.status === status);
  if (ticket === undefined) {
    throw new Error(`tickets.json has no ${status} ticket`);
  }
  return ticket;
}

function pageOf(...items: Ticket[]): ApiTickets {
  return { items, next_cursor: null };
}

const OPEN = ticketWithStatus("open");
const REVIEW = ticketWithStatus("review");
const CLOSED_OPEN: Ticket = {
  ...OPEN,
  action: "closed",
  status: "closed",
  close_reason: "technician",
  closure: { verdict: "correct", wall_ts: "2026-09-19T10:05:00.000Z" },
};

describe("withTicket", () => {
  it("replaces a ticket in place when it still belongs to the list", () => {
    const page = pageOf(REVIEW, OPEN);
    const updated = { ...OPEN, update_count: 4 };

    expect(withTicket(page, updated, "open").items).toEqual([REVIEW, updated]);
    expect(withTicket(page, updated, "all").items).toEqual([REVIEW, updated]);
  });

  it("puts a ticket that joins the list first, newest first", () => {
    expect(withTicket(pageOf(REVIEW), CLOSED_OPEN, "closed").items).toEqual([CLOSED_OPEN, REVIEW]);
  });

  it("removes a ticket that left the list's status", () => {
    const page = pageOf(REVIEW, OPEN);
    expect(withTicket(page, CLOSED_OPEN, "open").items).toEqual([REVIEW]);
  });

  it("returns the same page when the ticket neither belongs nor is listed", () => {
    const page = pageOf(REVIEW);
    expect(withTicket(page, CLOSED_OPEN, "open")).toBe(page);
  });
});

describe("patchTicketCaches", () => {
  it("moves a closed ticket between the cached lists and patches its detail", () => {
    queryClient.setQueryData(qk.tickets("open"), pageOf(OPEN));
    queryClient.setQueryData(qk.tickets("review"), pageOf(REVIEW));
    queryClient.setQueryData(qk.tickets("closed"), pageOf());
    queryClient.setQueryData(qk.tickets("all"), pageOf(OPEN, REVIEW));
    queryClient.setQueryData(qk.ticket(OPEN.ticket_id), fixtures.ticket);
    const review = queryClient.getQueryData(qk.tickets("review"));

    patchTicketCaches(queryClient, CLOSED_OPEN);

    expect(queryClient.getQueryData<ApiTickets>(qk.tickets("open"))?.items).toEqual([]);
    expect(queryClient.getQueryData<ApiTickets>(qk.tickets("closed"))?.items).toEqual([
      CLOSED_OPEN,
    ]);
    expect(queryClient.getQueryData<ApiTickets>(qk.tickets("all"))?.items).toEqual([
      CLOSED_OPEN,
      REVIEW,
    ]);
    expect(queryClient.getQueryData(qk.tickets("review"))).toBe(review);
    const detail = queryClient.getQueryData<TicketDetail>(qk.ticket(OPEN.ticket_id));
    expect(detail?.status).toBe("closed");
    expect(detail?.decisions).toEqual(fixtures.ticket.decisions);
  });

  it("leaves a ticket detail that was never loaded unloaded", () => {
    patchTicketCaches(queryClient, CLOSED_OPEN);

    expect(queryClient.getQueryData(qk.ticket(OPEN.ticket_id))).toBeUndefined();
  });

  it("leaves a list under a filter it does not know alone", () => {
    const unknownFilter = ["tickets", "pending"] as const;
    const page = pageOf(OPEN);
    queryClient.setQueryData(unknownFilter, page);

    patchTicketCaches(queryClient, CLOSED_OPEN);

    expect(queryClient.getQueryData(unknownFilter)).toBe(page);
  });
});

describe("useCloseTicket", () => {
  it("posts the verdict and the note, patches the caches and says so with the button's verb", async () => {
    let body: unknown = null;
    server.use(
      // Returns nothing, so the default handler still answers.
      http.post("/api/tickets/:id/close", async ({ request }) => {
        body = await request.clone().json();
      }),
    );
    queryClient.setQueryData(qk.tickets("open"), pageOf(OPEN));
    const { result } = renderHook(() => useCloseTicket(), { wrapper: Providers });

    await act(() =>
      result.current.mutateAsync({
        ticketId: OPEN.ticket_id,
        verdict: "correct",
        note: "  Purge valve seat worn; replaced.  ",
        closedBy: "  ",
      }),
    );

    expect(body).toEqual({ verdict: "correct", note: "Purge valve seat worn; replaced." });
    expect(queryClient.getQueryData<ApiTickets>(qk.tickets("open"))?.items).toEqual([]);
    expect(await screen.findByText("Ticket #8d7e60 closed as correct")).toBeInTheDocument();
  });

  it("sends who closed it when given and reports a refused close as an ApiError", async () => {
    const { result } = renderHook(() => useCloseTicket(), { wrapper: Providers });
    const closed = ticketWithStatus("closed");

    await expect(
      act(() =>
        result.current.mutateAsync({
          ticketId: closed.ticket_id,
          verdict: "wrong",
          closedBy: "shift-2",
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });
  });
});

describe("useSimCommand", () => {
  const pause: SimCommandRequest = { cmd: "pause", args: {} };

  it("resolves with the acknowledgement and applies its status to the live store", async () => {
    const { result } = renderHook(() => ({ command: useSimCommand(), sim: useSimStatus() }), {
      wrapper: Providers,
    });

    const ack = await act(() => result.current.command.mutateAsync(pause));

    expect(ack).toMatchObject({ cmd: "pause", ok: true });
    await waitFor(() => {
      expect(result.current.sim?.state).toBe("paused");
    });
  });

  it("hands every acknowledged status to a custom onAck, refusals included", async () => {
    const onAck = vi.fn<(status: StatusSim) => void>();
    const { result } = renderHook(() => useSimCommand({ onAck }), { wrapper: Providers });

    const refused = act(() =>
      result.current.mutateAsync({ cmd: "jump", args: { preset_id: "no_such_preset" } }),
    );

    await expect(refused).rejects.toBeInstanceOf(ApiError);
    await expect(refused).rejects.toMatchObject({ status: 202, code: "unknown_preset" });
    expect(onAck).toHaveBeenCalledTimes(1);
    expect(onAck.mock.calls[0]?.[0]).toMatchObject({ schema: "urn:fdp:schema:status-sim:v1" });
  });

  it("reports a command the simulator never acknowledged as sim_timeout", async () => {
    server.use(
      http.post("/api/sim/:cmd", () =>
        HttpResponse.json(
          { cmd_id: fixtures.simCommandResult.cmd_id, accepted: true, ack: null },
          { status: 202 },
        ),
      ),
    );
    const onAck = vi.fn<(status: StatusSim) => void>();
    const { result } = renderHook(() => useSimCommand({ onAck }), { wrapper: Providers });

    await expect(act(() => result.current.mutateAsync(pause))).rejects.toMatchObject({
      code: SIM_TIMEOUT_CODE,
      message: "The simulator did not answer in time",
    });
    expect(onAck).not.toHaveBeenCalled();
  });

  it("names a refusal without a reason internal", async () => {
    const result202 = structuredClone(fixtures.simCommandResult);
    if (result202.ack === null) {
      throw new Error("sim-command-result.json carries an ack");
    }
    result202.ack = { ...result202.ack, ok: false, error: null };
    server.use(http.post("/api/sim/:cmd", () => HttpResponse.json(result202, { status: 202 })));
    const { result } = renderHook(() => useSimCommand({ onAck: vi.fn() }), { wrapper: Providers });

    await expect(act(() => result.current.mutateAsync(pause))).rejects.toMatchObject({
      code: "internal",
      message: "The simulator refused the command",
    });
  });
});
