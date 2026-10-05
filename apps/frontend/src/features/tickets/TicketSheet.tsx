// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The ticket sheet: everything a technician needs to act on one ticket, in the order they need
// it — what is wrong (cause), what to look at (the catalog's checks, which are a sequence, so
// they are numbered), what to do (remedy), where the manual says so, the evidence behind it and
// the decisions that shaped it. Below them sits the ticket's outcome: the close form while it
// waits for a verdict, the closure record once closed, or the note that the system resolved it.
//
// App.tsx loads this default export lazily from this fixed path and drives it from the
// `#/tickets/<id>` hash route: a non-null `ticketId` opens the sheet, `onClose` clears the route.
// The sheet keeps the last ticket on screen while it slides out.

import { memo, useId, useMemo, useState, type ReactNode } from "react";

import { useDecisions, useSignals, useTicket } from "@/api/queries";
import type { Decision, Ticket, TicketDetail } from "@/api/types";
import { LazyDecisionSheet } from "@/components/app-shell/lazy-panels";
import { Code } from "@/components/common/Code";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorState } from "@/components/common/ErrorState";
import { EvidenceTable } from "@/components/common/EvidenceTable";
import { ManualRef } from "@/components/common/ManualRef";
import { SeverityBadge } from "@/components/common/SeverityBadge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { CloseTicketForm } from "@/features/tickets/CloseTicketForm";
import { TicketStatusBadge, VerdictBadge } from "@/features/tickets/TicketBadges";
import { updatesLabel } from "@/features/tickets/ticket-format";
import { ticketEvidenceRows } from "@/lib/evidence";
import { fmtPct, humanize, NO_VALUE, shortId } from "@/lib/format";
import { hashRouteHref, openHashRoute } from "@/lib/hash-route";
import { tid } from "@/lib/testids";
import { fmtSim, fmtWall } from "@/lib/time";

export interface TicketSheetProps {
  ticketId: string | null;
  onClose(): void;
}

const BACKEND_LABELS: Readonly<Record<string, string>> = {
  von: "Von",
  llm: "LLM",
  rules: "Rules",
};

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  ticket: "Ticket",
  review: "Review",
  log: "Logged",
};

/** Why the system ended an episode, as the end of a sentence. */
const RESOLVE_REASONS: Readonly<Record<string, string>> = {
  silence: "the symptom went quiet",
  discontinuity: "the replay jumped to another time",
};

const PROSE = "max-w-[72ch] text-sm leading-relaxed";

const SHEET_LOADING = (
  <div role="status" className="space-y-3 px-4">
    <span className="sr-only">Loading ticket</span>
    <Skeleton className="h-5 w-1/2" />
    <Skeleton className="h-16 w-full" />
    <Skeleton className="h-24 w-full" />
  </div>
);

const DECISIONS_LOADING = (
  <div role="status" className="space-y-2">
    <span className="sr-only">Loading decisions</span>
    <Skeleton className="h-5 w-full" />
    <Skeleton className="h-5 w-2/3" />
  </div>
);

const DECISIONS_HEADER = (
  <TableHeader>
    <TableRow>
      <TableHead>Sim time</TableHead>
      <TableHead>Backend</TableHead>
      <TableHead className="text-right">Confidence</TableHead>
      <TableHead>Gate</TableHead>
    </TableRow>
  </TableHeader>
);

function backendLabel(backend: string): string {
  return BACKEND_LABELS[backend] ?? humanize(backend);
}

/** What became of a decision: failed, abstained, or the gate's outcome in a word. */
function outcomeLabel(decision: Decision): string {
  if (decision.status === "failed") {
    return "Failed";
  }
  if (decision.gate.abstained) {
    return "Abstained";
  }
  return OUTCOME_LABELS[decision.gate.outcome] ?? humanize(decision.gate.outcome);
}

function preloadDecisionSheet(): void {
  void LazyDecisionSheet.preload();
}

/** The registry label of a signal id, for the evidence table; ids are humanised until it loads. */
function useSignalLabel(): (signal: string) => string | undefined {
  const { data } = useSignals();
  return useMemo(() => {
    const labels = new Map(data?.signals.map((signal) => [signal.signal_id, signal.label]));
    return (signal: string) => labels.get(signal);
  }, [data]);
}

/** The last ticket asked for, so the sheet keeps its content while it closes. */
function useShownTicketId(ticketId: string | null): string | null {
  const [shown, setShown] = useState(ticketId);
  if (ticketId !== null && ticketId !== shown) {
    // State derived from props during render, the documented alternative to an effect.
    setShown(ticketId);
  }
  return ticketId ?? shown;
}

interface SheetSectionProps {
  title: string;
  children: ReactNode;
}

function SheetSection({ title, children }: SheetSectionProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2 border-t px-4 py-4">
      <h3 id={headingId} className="text-base font-medium">
        {title}
      </h3>
      {children}
    </section>
  );
}

const DecisionRow = memo(function DecisionRow({ decision }: { decision: Decision }) {
  const id = decision.decision_id;
  const simTime = fmtSim(decision.sim_ts);
  const failed = decision.status === "failed";
  return (
    <TableRow
      className="cursor-pointer"
      onClick={() => openHashRoute("decision", id)}
      onPointerEnter={preloadDecisionSheet}
      onFocus={preloadDecisionSheet}
    >
      <TableCell className="tabular-nums">
        <a
          href={hashRouteHref("decision", id)}
          aria-label={`Open the decision of ${simTime}`}
          className="rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {simTime}
        </a>
      </TableCell>
      <TableCell title={decision.model}>{backendLabel(decision.backend)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {failed ? NO_VALUE : fmtPct(decision.confidence)}
      </TableCell>
      <TableCell className={failed ? "text-destructive" : undefined}>
        {outcomeLabel(decision)}
      </TableCell>
    </TableRow>
  );
});

/** The episode's decisions, newest first, each opening the decision sheet. */
function TicketDecisions({ episodeId }: { episodeId: string }) {
  const { data, error, refetch } = useDecisions(episodeId);
  if (data === undefined) {
    return error === null ? (
      DECISIONS_LOADING
    ) : (
      <ErrorState
        className="px-0"
        message="Couldn't load the decisions."
        detail={error.message}
        onRetry={() => void refetch()}
      />
    );
  }
  if (data.items.length === 0) {
    return <EmptyState className="px-0">No decisions are recorded for this episode.</EmptyState>;
  }
  return (
    <Table className="text-[0.8125rem]">
      <TableCaption className="sr-only">Decisions of this episode</TableCaption>
      {DECISIONS_HEADER}
      <TableBody>
        {data.items.map((decision) => (
          <DecisionRow key={decision.decision_id} decision={decision} />
        ))}
      </TableBody>
    </Table>
  );
}

function ClosureRecord({ closure }: { closure: Ticket["closure"] }) {
  if (closure === null) {
    return <p className={PROSE}>Closed without a recorded verdict.</p>;
  }
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      <dt className="text-muted-foreground">Verdict</dt>
      <dd>
        <VerdictBadge verdict={closure.verdict} />
      </dd>
      <dt className="text-muted-foreground">Note</dt>
      <dd className="max-w-[60ch]">{closure.note ?? NO_VALUE}</dd>
      <dt className="text-muted-foreground">Closed by</dt>
      <dd>{closure.closed_by ?? NO_VALUE}</dd>
      <dt className="text-muted-foreground">Closed at</dt>
      <dd className="tabular-nums">{fmtWall(closure.wall_ts)}</dd>
    </dl>
  );
}

function Resolution({ ticket }: { ticket: Ticket }) {
  const reason = ticket.close_reason === null ? undefined : RESOLVE_REASONS[ticket.close_reason];
  const ended = ticket.resolved_sim_ts === null ? null : fmtSim(ticket.resolved_sim_ts);
  return (
    <div className="space-y-1">
      <p className={PROSE}>Resolved by the system</p>
      {ended === null ? null : (
        <p className="text-[0.8125rem] text-muted-foreground">
          The episode ended at {ended} UTC{reason === undefined ? "" : ` because ${reason}`}.
        </p>
      )}
    </div>
  );
}

/** Where the ticket stands: waiting for a verdict, closed with one, or resolved by the system. */
function TicketOutcome({ ticket }: { ticket: Ticket }) {
  switch (ticket.status) {
    case "open":
    case "review":
      return (
        <SheetSection title="Close ticket">
          <CloseTicketForm ticketId={ticket.ticket_id} />
        </SheetSection>
      );
    case "closed":
      return (
        <SheetSection title="Closure">
          <ClosureRecord closure={ticket.closure} />
        </SheetSection>
      );
    case "resolved":
      return (
        <SheetSection title="Resolution">
          <Resolution ticket={ticket} />
        </SheetSection>
      );
    default:
      return null;
  }
}

function TicketDetailView({ ticket }: { ticket: TicketDetail }) {
  const signalLabel = useSignalLabel();
  const evidence = useMemo(() => ticketEvidenceRows(ticket), [ticket]);
  return (
    <>
      <SheetHeader className="gap-2 pr-12">
        <SheetTitle className="text-2xl leading-tight font-medium">{ticket.title}</SheetTitle>
        <SheetDescription>
          Ticket #<Code value={ticket.ticket_id} short />, opened {fmtSim(ticket.opened_sim_ts)} UTC
        </SheetDescription>
        <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
          <TicketStatusBadge status={ticket.status} />
          <SeverityBadge level={ticket.severity} />
          <span className="tabular-nums">{fmtPct(ticket.confidence)} confidence</span>
          <span className="text-muted-foreground">{updatesLabel(ticket.update_count)}</span>
        </div>
      </SheetHeader>
      <SheetSection title="Cause">
        <p className={PROSE}>{ticket.cause}</p>
      </SheetSection>
      <SheetSection title="Checks">
        <ol className={`${PROSE} list-decimal space-y-1 pl-5`}>
          {ticket.checks.map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ol>
      </SheetSection>
      <SheetSection title="Remedy">
        <p className={PROSE}>{ticket.remedy}</p>
      </SheetSection>
      <SheetSection title="Manual reference">
        <ManualRef reference={ticket.manual_ref} className="text-sm" />
      </SheetSection>
      <SheetSection title="Evidence">
        <EvidenceTable
          rows={evidence}
          signalLabel={signalLabel}
          caption="Evidence behind this ticket"
        />
      </SheetSection>
      <SheetSection title="Decisions">
        <TicketDecisions episodeId={ticket.episode_id} />
      </SheetSection>
      <TicketOutcome ticket={ticket} />
    </>
  );
}

/** The header shown until the ticket is loaded, naming the ticket the route asked for. */
function PendingHeader({ ticketId }: { ticketId: string }) {
  return (
    <SheetHeader className="pr-12">
      <SheetTitle className="text-2xl font-medium">Ticket</SheetTitle>
      <SheetDescription>
        <Code value={ticketId} />
      </SheetDescription>
    </SheetHeader>
  );
}

function TicketSheetBody({ ticketId }: { ticketId: string }) {
  const { data, error, refetch } = useTicket(ticketId);
  if (data !== undefined) {
    return <TicketDetailView ticket={data} />;
  }
  return (
    <>
      <PendingHeader ticketId={ticketId} />
      {error === null ? (
        SHEET_LOADING
      ) : (
        <ErrorState
          message={`Couldn't load ticket #${shortId(ticketId)}.`}
          detail={error.message}
          onRetry={() => void refetch()}
        />
      )}
    </>
  );
}

export default function TicketSheet({ ticketId, onClose }: TicketSheetProps) {
  const shownId = useShownTicketId(ticketId);
  return (
    <Sheet
      open={ticketId !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent
        side="right"
        data-testid={tid.tickets.sheet}
        className="gap-0 overflow-y-auto pb-4 data-[side=right]:w-full data-[side=right]:sm:max-w-[35rem]"
      >
        {shownId === null ? null : <TicketSheetBody ticketId={shownId} />}
      </SheetContent>
    </Sheet>
  );
}
