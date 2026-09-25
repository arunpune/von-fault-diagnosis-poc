// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The two writes the UI performs: simulator commands and ticket closures. Neither is optimistic. A
// simulator command resolves with the acknowledgement, whose fresh status goes to the live store at
// once; a refusal or a missing acknowledgement rejects with an `ApiError` whose code the control
// turns into a sentence. A closure patches the ticket caches with the ticket the backend answered,
// so the ticket leaves the open list and the tab counts move before any push arrives, and announces
// itself with the button's verb.

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError } from "@/api/client";
import { closeTicket, SIM_TIMEOUT_CODE, simCommand } from "@/api/endpoints";
import { qk } from "@/api/query-keys";
import type {
  ApiTicketClose,
  ApiTickets,
  ControlAck,
  SimCommandArgs,
  SimCommandSegment,
  StatusSim,
  Ticket,
  TicketDetail,
  TicketStatusFilter,
  TicketVerdict,
} from "@/api/types";
import { shortId } from "@/lib/format";
import { applyAck } from "@/store/live-store";

/** One simulator command: the route segment and its arguments, checked against each other. */
export type SimCommandRequest = {
  [S in SimCommandSegment]: { cmd: S; args: SimCommandArgs[S] };
}[SimCommandSegment];

/** The code of a refusal whose acknowledgement named no reason. */
const REFUSED_WITHOUT_REASON = "internal";

export interface SimCommandOptions {
  /**
   * Receives the status the acknowledgement carries, for refused commands too; the live store's
   * `applyAck` by default, so the play button and the clock follow the command at once.
   */
  onAck?: (status: StatusSim) => void;
}

async function sendSimCommand(
  request: SimCommandRequest,
  onAck: (status: StatusSim) => void,
): Promise<ControlAck> {
  const result = await simCommand(request.cmd, request.args);
  const { ack } = result;
  if (ack === null) {
    // Published, but the simulator did not acknowledge within the backend's wait.
    throw new ApiError(202, SIM_TIMEOUT_CODE, "The simulator did not answer in time");
  }
  onAck(ack.status);
  if (!ack.ok) {
    const code = ack.error?.code ?? REFUSED_WITHOUT_REASON;
    const message = ack.error?.message ?? "The simulator refused the command";
    throw new ApiError(202, code, message, ack.error);
  }
  return ack;
}

/**
 * Sends one simulator command and resolves with its acknowledgement. The success toast belongs to
 * the control, which knows the label ("Jumped to Air leak – 5 Jun 2020"): pass it through
 * `mutate(request, { onSuccess })`.
 */
export function useSimCommand({ onAck = applyAck }: SimCommandOptions = {}) {
  return useMutation({
    mutationFn: (request: SimCommandRequest) => sendSimCommand(request, onAck),
  });
}

const TICKET_STATUS_FILTERS: ReadonlySet<unknown> = new Set<TicketStatusFilter>([
  "review",
  "open",
  "resolved",
  "closed",
  "all",
]);

function isTicketStatusFilter(value: unknown): value is TicketStatusFilter {
  return TICKET_STATUS_FILTERS.has(value);
}

/**
 * A tickets page with `ticket` applied: replaced in place or prepended (newest first) when the
 * ticket belongs under `filter`, removed when it no longer does. Returns `page` itself when
 * nothing changes, so an unaffected list keeps its reference.
 */
export function withTicket(
  page: ApiTickets,
  ticket: Ticket,
  filter: TicketStatusFilter,
): ApiTickets {
  const belongs = filter === "all" || filter === ticket.status;
  const index = page.items.findIndex((item) => item.ticket_id === ticket.ticket_id);
  if (belongs) {
    const items = index === -1 ? [ticket, ...page.items] : page.items.with(index, ticket);
    return { ...page, items };
  }
  if (index === -1) {
    return page;
  }
  return { ...page, items: page.items.filter((item) => item.ticket_id !== ticket.ticket_id) };
}

/** Writes a ticket into its detail cache and into every cached tickets list it belongs to. */
export function patchTicketCaches(queryClient: QueryClient, ticket: Ticket): void {
  queryClient.setQueryData<TicketDetail>(qk.ticket(ticket.ticket_id), (detail) =>
    detail === undefined ? undefined : { ...ticket, decisions: detail.decisions },
  );
  for (const [key, page] of queryClient.getQueriesData<ApiTickets>({
    queryKey: qk.ticketLists(),
  })) {
    const filter = key[1];
    if (page === undefined || !isTicketStatusFilter(filter)) {
      continue;
    }
    const patched = withTicket(page, ticket, filter);
    if (patched !== page) {
      queryClient.setQueryData(key, patched);
    }
  }
}

export interface CloseTicketRequest {
  ticketId: string;
  verdict: TicketVerdict;
  /** What the technician found; blank notes are not sent. */
  note?: string;
  /** A role or shift name, never a personal identifier. */
  closedBy?: string;
}

function closeBody({ verdict, note, closedBy }: CloseTicketRequest): ApiTicketClose {
  const trimmedNote = note?.trim() ?? "";
  const trimmedBy = closedBy?.trim() ?? "";
  return {
    verdict,
    ...(trimmedNote === "" ? {} : { note: trimmedNote }),
    ...(trimmedBy === "" ? {} : { closed_by: trimmedBy }),
  };
}

/** Closes a ticket with the technician's verdict and patches the ticket caches. */
export function useCloseTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CloseTicketRequest) => closeTicket(request.ticketId, closeBody(request)),
    onSuccess: (ticket, request) => {
      patchTicketCaches(queryClient, ticket);
      const verdict = ticket.closure?.verdict ?? request.verdict;
      toast.success(`Ticket #${shortId(ticket.ticket_id)} closed as ${verdict}`);
    },
  });
}
