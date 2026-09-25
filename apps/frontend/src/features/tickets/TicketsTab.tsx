// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The tickets tab, the bottom tab open on load: one table of the tickets in the chosen status —
// open by default — with the most recently updated first. A row opens the ticket sheet through the
// `#/tickets/<id>` hash route; the ticket id is a real link, so the row is reachable and operable
// from the keyboard, and hovering or focusing a row starts loading the sheet's chunk. The list is
// the `['tickets', status]` cache the WebSocket reducers and a closure patch, so a pushed or closed
// ticket moves without a refetch.

import { memo, useMemo, useState } from "react";

import { useTickets } from "@/api/queries";
import type { Ticket } from "@/api/types";
import { LazyTicketSheet } from "@/components/app-shell/lazy-panels";
import { Code } from "@/components/common/Code";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorState } from "@/components/common/ErrorState";
import { SeverityBadge } from "@/components/common/SeverityBadge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TicketStatusBadge, VerdictBadge } from "@/features/tickets/TicketBadges";
import {
  byUpdatedDesc,
  isTicketsTabFilter,
  TICKET_FILTERS,
  type TicketsTabFilter,
} from "@/features/tickets/ticket-format";
import { fmtPct, shortId } from "@/lib/format";
import { hashRouteHref, openHashRoute } from "@/lib/hash-route";
import { tid } from "@/lib/testids";
import { fmtSim } from "@/lib/time";

const DEFAULT_FILTER: TicketsTabFilter = "open";

/** What each filter shows when it has no tickets: what happened, and what makes one appear. */
const EMPTY_MESSAGES: Readonly<Record<TicketsTabFilter, string>> = {
  open: "No open tickets. A ticket opens when a decision passes the confidence gate.",
  resolved: "No resolved tickets. A ticket resolves when its symptom goes quiet.",
  closed: "No closed tickets. Close a ticket as correct or wrong from its sheet.",
  all: "No tickets yet. Press Play, or jump to a known failure.",
};

const LOADING = (
  <div role="status" className="space-y-2 px-4 py-3">
    <span className="sr-only">Loading tickets</span>
    <Skeleton className="h-5 w-full" />
    <Skeleton className="h-5 w-full" />
    <Skeleton className="h-5 w-2/3" />
  </div>
);

const HEADER = (
  <TableHeader>
    <TableRow>
      <TableHead>Ticket</TableHead>
      <TableHead>Opened</TableHead>
      <TableHead>Fault</TableHead>
      <TableHead>Severity</TableHead>
      <TableHead className="text-right">Confidence</TableHead>
      <TableHead>Status</TableHead>
      <TableHead>Verdict</TableHead>
      <TableHead>Updated</TableHead>
    </TableRow>
  </TableHeader>
);

function preloadSheet(): void {
  void LazyTicketSheet.preload();
}

const TicketRow = memo(function TicketRow({ ticket }: { ticket: Ticket }) {
  const id = ticket.ticket_id;
  return (
    <TableRow
      data-testid={tid.tickets.row(id)}
      className="cursor-pointer text-[0.8125rem]"
      onClick={() => openHashRoute("ticket", id)}
      onPointerEnter={preloadSheet}
      onFocus={preloadSheet}
    >
      <TableCell>
        <a
          href={hashRouteHref("ticket", id)}
          aria-label={`Open ticket #${shortId(id)}`}
          className="rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          #<Code value={id} short />
        </a>
      </TableCell>
      <TableCell className="tabular-nums">{fmtSim(ticket.opened_sim_ts)}</TableCell>
      <TableCell className="min-w-60 whitespace-normal">{ticket.title}</TableCell>
      <TableCell>
        <SeverityBadge level={ticket.severity} />
      </TableCell>
      <TableCell className="text-right tabular-nums">{fmtPct(ticket.confidence)}</TableCell>
      <TableCell>
        <TicketStatusBadge status={ticket.status} />
      </TableCell>
      <TableCell>
        <VerdictBadge verdict={ticket.closure?.verdict ?? null} />
      </TableCell>
      <TableCell className="tabular-nums">{fmtSim(ticket.updated_sim_ts)}</TableCell>
    </TableRow>
  );
});

function TicketsTable({ tickets }: { tickets: readonly Ticket[] }) {
  const sorted = useMemo(() => byUpdatedDesc(tickets), [tickets]);
  return (
    <Table>
      <TableCaption className="sr-only">Tickets</TableCaption>
      {HEADER}
      <TableBody>
        {sorted.map((ticket) => (
          <TicketRow key={ticket.ticket_id} ticket={ticket} />
        ))}
      </TableBody>
    </Table>
  );
}

function TicketsBody({ filter }: { filter: TicketsTabFilter }) {
  const { data, error, refetch } = useTickets(filter);
  if (data === undefined) {
    // A failed background refetch keeps the rows already on screen; only a first load fails here.
    return error === null ? (
      LOADING
    ) : (
      <ErrorState
        message="Couldn't load tickets."
        detail={error.message}
        onRetry={() => void refetch()}
      />
    );
  }
  if (data.items.length === 0) {
    return <EmptyState>{EMPTY_MESSAGES[filter]}</EmptyState>;
  }
  return <TicketsTable tickets={data.items} />;
}

export default function TicketsTab() {
  const [filter, setFilter] = useState<TicketsTabFilter>(DEFAULT_FILTER);

  function handleFilterChange(value: string): void {
    // A single toggle group reports "" when the pressed item is pressed again; a filter is always set.
    if (isTicketsTabFilter(value)) {
      setFilter(value);
    }
  }

  return (
    <div className="flex flex-col">
      <div className="px-4 py-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={filter}
          onValueChange={handleFilterChange}
          aria-label="Ticket status"
        >
          {TICKET_FILTERS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <TicketsBody filter={filter} />
    </div>
  );
}
