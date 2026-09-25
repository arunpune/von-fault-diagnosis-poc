// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Where the decision led: a link to the ticket of its episode when the tickets cache holds one,
// otherwise what the gate did instead — "Logged only" or "In review queue". The link is the
// `#/tickets/<id>` hash route, so following it swaps this sheet for the ticket sheet, whose
// chunk starts loading on hover or focus.

import { useMemo } from "react";

import { useTickets } from "@/api/queries";
import type { Decision } from "@/api/types";
import { LazyTicketSheet } from "@/components/app-shell/lazy-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtPct, humanize, shortId } from "@/lib/format";
import { hashRouteHref } from "@/lib/hash-route";
import { tid } from "@/lib/testids";

/** What the gate did when no ticket of the episode is in the cache. */
const GATE_NOTES: Readonly<Record<string, string>> = {
  log: "Logged only",
  review: "In review queue",
  ticket: "Ticket not loaded yet",
};

const LOADING = (
  <div role="status">
    <span className="sr-only">Loading the ticket</span>
    <Skeleton className="h-4 w-1/3" />
  </div>
);

function preloadTicketSheet(): void {
  void LazyTicketSheet.preload();
}

export interface DecisionTicketProps {
  decision: Decision;
}

export function DecisionTicket({ decision }: DecisionTicketProps) {
  const tickets = useTickets("all");
  const ticket = useMemo(
    () => tickets.data?.items.find((item) => item.episode_id === decision.episode_id),
    [tickets.data, decision.episode_id],
  );
  if (ticket !== undefined) {
    return (
      <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
        <a
          href={hashRouteHref("ticket", ticket.ticket_id)}
          title={ticket.ticket_id}
          data-testid={tid.decision.ticketLink}
          onPointerEnter={preloadTicketSheet}
          onFocus={preloadTicketSheet}
          className="font-medium text-primary underline-offset-4 hover:underline focus-visible:underline"
        >
          Ticket #{shortId(ticket.ticket_id)}
        </a>
        <span className="text-meta text-muted-foreground">
          {humanize(ticket.status)}, confidence {fmtPct(ticket.confidence)}
        </span>
      </p>
    );
  }
  if (tickets.isPending) {
    return LOADING;
  }
  const outcome: string = decision.gate.outcome;
  return (
    <p className="text-sm text-muted-foreground">{GATE_NOTES[outcome] ?? humanize(outcome)}</p>
  );
}
