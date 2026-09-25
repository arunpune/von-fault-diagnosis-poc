// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The Events tab. App.tsx loads this default export lazily from this fixed path. One row per
// suspect event, newest first: when detection saw it (sim time), the symptom in words, the
// rules that fired, the machine's mode and how many signals were read. A row opens the latest
// decision made on that event through the hash route; an event nobody decided yet expands in
// place to show its evidence. The row's last cell holds the same action as a link or a button,
// so the keyboard reaches it too.

import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import { memo, useMemo, useState, type MouseEvent } from "react";

import { useDecisions, useEvents, useSignals } from "@/api/queries";
import type { SuspectEvent } from "@/api/types";
import { LazyDecisionSheet } from "@/components/app-shell/lazy-panels";
import { Code } from "@/components/common/Code";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorState } from "@/components/common/ErrorState";
import { EvidenceTable } from "@/components/common/EvidenceTable";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { latestDecisionByEvent } from "@/features/events/events";
import { suspectEventRows } from "@/lib/evidence";
import { humanize, shortId } from "@/lib/format";
import { hashRouteHref, openHashRoute } from "@/lib/hash-route";
import { tid } from "@/lib/testids";
import { fmtSim } from "@/lib/time";

const COLUMN_COUNT = 6;

const NO_DECISIONS: readonly never[] = [];

const LOADING = (
  <div role="status" className="space-y-2 px-4 py-3">
    <span className="sr-only">Loading suspect events</span>
    <Skeleton className="h-4 w-2/3" />
    <Skeleton className="h-4 w-1/2" />
    <Skeleton className="h-4 w-3/5" />
  </div>
);

const HEADER = (
  <TableHeader>
    <TableRow>
      <TableHead>Sim time</TableHead>
      <TableHead>Symptom</TableHead>
      <TableHead>Rules fired</TableHead>
      <TableHead>Machine state</TableHead>
      <TableHead className="text-right">Observations</TableHead>
      <TableHead>Decision</TableHead>
    </TableRow>
  </TableHeader>
);

const CHEVRON = (
  <ChevronDownIcon
    aria-hidden="true"
    className="transition-transform group-aria-expanded/button:rotate-180 motion-reduce:transition-none"
  />
);

function preloadDecisionSheet(): void {
  void LazyDecisionSheet.preload();
}

/** True when a click landed on the row's own link or button, which acts on its own. */
function isFromControl(event: MouseEvent<HTMLElement>): boolean {
  return event.target instanceof Element && event.target.closest("a, button") !== null;
}

/** The evidence of an undecided event, with the registry's signal labels. */
function EventEvidence({ event }: { event: SuspectEvent }) {
  const signals = useSignals().data?.signals;
  const labels = useMemo(
    () => new Map(signals?.map((signal) => [signal.signal_id, signal.label])),
    [signals],
  );
  return (
    <EvidenceTable
      rows={suspectEventRows(event)}
      signalLabel={(signal) => labels.get(signal)}
      caption={`Evidence of the suspect event at ${fmtSim(event.sim_ts)}`}
    />
  );
}

function EventCells({ event }: { event: SuspectEvent }) {
  return (
    <>
      <TableCell className="tabular-nums">{fmtSim(event.sim_ts)}</TableCell>
      <TableCell className="font-medium">{humanize(event.symptom_key)}</TableCell>
      <TableCell className="whitespace-normal">
        <span className="flex flex-wrap gap-x-2 gap-y-0.5">
          {event.rule_ids.map((ruleId) => (
            <Code key={ruleId} value={ruleId} />
          ))}
        </span>
      </TableCell>
      <TableCell>{humanize(event.machine_state.mode)}</TableCell>
      <TableCell className="text-right tabular-nums">{event.observations.length}</TableCell>
    </>
  );
}

interface DecidedEventRowProps {
  event: SuspectEvent;
  decisionId: string;
}

/** An event with a decision: the row opens that decision's sheet. */
const DecidedEventRow = memo(function DecidedEventRow({ event, decisionId }: DecidedEventRowProps) {
  function openDecision(click: MouseEvent<HTMLTableRowElement>): void {
    if (!isFromControl(click)) {
      openHashRoute("decision", decisionId);
    }
  }
  return (
    <TableBody className="border-b last:border-b-0">
      <TableRow
        data-testid={tid.events.row(event.event_id)}
        className="cursor-pointer"
        onClick={openDecision}
        onPointerEnter={preloadDecisionSheet}
      >
        <EventCells event={event} />
        <TableCell>
          <Button asChild variant="link" size="xs" className="h-auto px-0">
            <a
              href={hashRouteHref("decision", decisionId)}
              aria-label={`Open decision ${shortId(decisionId)}`}
              onFocus={preloadDecisionSheet}
            >
              <Code value={decisionId} short />
            </a>
          </Button>
        </TableCell>
      </TableRow>
    </TableBody>
  );
});

/** An event nobody decided yet: the row expands to show its evidence in place. */
const UndecidedEventRow = memo(function UndecidedEventRow({ event }: { event: SuspectEvent }) {
  const [open, setOpen] = useState(false);
  function toggle(click: MouseEvent<HTMLTableRowElement>): void {
    if (!isFromControl(click)) {
      setOpen((wasOpen) => !wasOpen);
    }
  }
  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <TableBody className="border-b last:border-b-0">
        <TableRow
          data-testid={tid.events.row(event.event_id)}
          className="cursor-pointer"
          onClick={toggle}
        >
          <EventCells event={event} />
          <TableCell>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="xs">
                Evidence
                {CHEVRON}
              </Button>
            </CollapsibleTrigger>
          </TableCell>
        </TableRow>
        <CollapsibleContent asChild>
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={COLUMN_COUNT} className="bg-muted/40 p-0 whitespace-normal">
              <EventEvidence event={event} />
            </TableCell>
          </TableRow>
        </CollapsibleContent>
      </TableBody>
    </Collapsible>
  );
});

export default function EventsTab() {
  const events = useEvents();
  const decisions = useDecisions().data?.items ?? NO_DECISIONS;
  const latestByEvent = useMemo(() => latestDecisionByEvent(decisions), [decisions]);

  if (events.isPending) {
    return LOADING;
  }
  if (events.isError) {
    return (
      <ErrorState
        message="Couldn't load suspect events."
        detail={events.error.message}
        onRetry={() => void events.refetch()}
      />
    );
  }
  if (events.data.items.length === 0) {
    return <EmptyState>No suspect events yet.</EmptyState>;
  }
  return (
    <div className="px-2 py-1">
      <Table className="text-meta">
        <TableCaption className="sr-only">Suspect events, newest first</TableCaption>
        {HEADER}
        {events.data.items.map((event) => {
          const decisionId = latestByEvent.get(event.event_id)?.decision_id;
          return decisionId === undefined ? (
            <UndecidedEventRow key={event.event_id} event={event} />
          ) : (
            <DecidedEventRow key={event.event_id} event={event} decisionId={decisionId} />
          );
        })}
      </Table>
    </div>
  );
}
