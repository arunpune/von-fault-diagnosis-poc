// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The review queue: the tickets whose latest decision landed between the gate's review and ticket
// thresholds, read from `GET /api/tickets?status=review`. Each row shows how sure the decision
// was against those two thresholds, so the technician sees how close it came to opening a ticket
// on its own. The queue has no actions of its own: a row opens the ticket sheet, where the
// technician closes the ticket as correct or wrong, and a later decision that passes the gate
// promotes the ticket to open, which takes it off this list.
//
// App.tsx loads this default export lazily from this fixed path as the Review tab.

import { memo, useMemo } from "react";

import { useStatusSnapshot, useTickets } from "@/api/queries";
import type { ApiStatus, Ticket } from "@/api/types";
import { LazyTicketSheet } from "@/components/app-shell/lazy-panels";
import { ConfidenceMeter, type ConfidenceThreshold } from "@/components/common/ConfidenceMeter";
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
import { byUpdatedDesc, updatesLabel } from "@/features/tickets/ticket-format";
import { fmtPct, shortId } from "@/lib/format";
import { hashRouteHref, openHashRoute } from "@/lib/hash-route";
import { tid } from "@/lib/testids";
import { fmtSim } from "@/lib/time";

type GateThresholds = ApiStatus["gate"];

/**
 * The rules and LLM backends' default pair (`GATE_*`), review 0.60 and ticket 0.85, shown until
 * the backend reports the pair it runs. Jev's own pair (`JEV_GATE_*`) defaults to review 0.65 and
 * ticket 0.85 (docs/decision-backends.md), which `/api/status` reports when Jev is the running
 * backend.
 */
const DEFAULT_GATE: GateThresholds = { review_min_confidence: 0.6, ticket_min_confidence: 0.85 };

const LOADING = (
  <div role="status" className="space-y-2 px-4 py-3">
    <span className="sr-only">Loading the review queue</span>
    <Skeleton className="h-5 w-full" />
    <Skeleton className="h-5 w-2/3" />
  </div>
);

const HEADER = (
  <TableHeader>
    <TableRow>
      <TableHead>Ticket</TableHead>
      <TableHead>Confidence</TableHead>
      <TableHead>Severity</TableHead>
      <TableHead>Updated</TableHead>
      <TableHead>Updates</TableHead>
    </TableRow>
  </TableHeader>
);

function preloadSheet(): void {
  void LazyTicketSheet.preload();
}

/** The thresholds the gate runs with, as the status snapshot reports them. */
function useGateThresholds(): GateThresholds {
  return useStatusSnapshot().data?.gate ?? DEFAULT_GATE;
}

function thresholdMarks(gate: GateThresholds): ConfidenceThreshold[] {
  return [
    { value: gate.review_min_confidence, label: `Review at ${fmtPct(gate.review_min_confidence)}` },
    { value: gate.ticket_min_confidence, label: `Ticket at ${fmtPct(gate.ticket_min_confidence)}` },
  ];
}

interface ReviewRowProps {
  ticket: Ticket;
  thresholds: readonly ConfidenceThreshold[];
}

const ReviewRow = memo(function ReviewRow({ ticket, thresholds }: ReviewRowProps) {
  const id = ticket.ticket_id;
  return (
    <TableRow
      data-testid={tid.review.row(id)}
      className="cursor-pointer text-[0.8125rem]"
      onClick={() => openHashRoute("ticket", id)}
      onPointerEnter={preloadSheet}
      onFocus={preloadSheet}
    >
      <TableCell className="min-w-60 whitespace-normal">
        <a
          href={hashRouteHref("ticket", id)}
          title={`Ticket #${shortId(id)}`}
          className="rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {ticket.title}
        </a>
      </TableCell>
      <TableCell>
        <ConfidenceMeter
          value={ticket.confidence}
          thresholds={thresholds}
          label={`Confidence of ticket #${shortId(id)}`}
          className="w-40"
        />
      </TableCell>
      <TableCell>
        <SeverityBadge level={ticket.severity} />
      </TableCell>
      <TableCell className="tabular-nums">{fmtSim(ticket.updated_sim_ts)}</TableCell>
      <TableCell className="text-muted-foreground">{updatesLabel(ticket.update_count)}</TableCell>
    </TableRow>
  );
});

interface ReviewTableProps {
  tickets: readonly Ticket[];
  gate: GateThresholds;
}

function ReviewTable({ tickets, gate }: ReviewTableProps) {
  const sorted = useMemo(() => byUpdatedDesc(tickets), [tickets]);
  const thresholds = useMemo(() => thresholdMarks(gate), [gate]);
  return (
    <Table>
      <TableCaption className="sr-only">Review queue</TableCaption>
      {HEADER}
      <TableBody>
        {sorted.map((ticket) => (
          <ReviewRow key={ticket.ticket_id} ticket={ticket} thresholds={thresholds} />
        ))}
      </TableBody>
    </Table>
  );
}

export default function ReviewTab() {
  const { data, error, refetch } = useTickets("review");
  const gate = useGateThresholds();
  if (data === undefined) {
    // A failed background refetch keeps the rows already on screen; only a first load fails here.
    return error === null ? (
      LOADING
    ) : (
      <ErrorState
        message="Couldn't load the review queue."
        detail={error.message}
        onRetry={() => void refetch()}
      />
    );
  }
  if (data.items.length === 0) {
    return (
      <EmptyState>
        Nothing to review. Decisions between {fmtPct(gate.review_min_confidence)} and{" "}
        {fmtPct(gate.ticket_min_confidence)} confidence land here.
      </EmptyState>
    );
  }
  return <ReviewTable tickets={data.items} gate={gate} />;
}
