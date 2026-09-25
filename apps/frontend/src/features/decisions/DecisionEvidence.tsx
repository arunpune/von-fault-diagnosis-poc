// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What detection saw when it raised the suspect event the decision answered: the event's sentences
// and bucketed readings as one evidence table, the machine state and observation window, the
// detection rules that fired and the controller alarms that were active. The event comes from the
// suspect-events cache the feed already holds; one older than the loaded page is reported as not
// loaded rather than fetched on its own.

import { useMemo } from "react";

import { useEvents } from "@/api/queries";
import type { SuspectEvent } from "@/api/types";
import { Code } from "@/components/common/Code";
import { ErrorState } from "@/components/common/ErrorState";
import { EvidenceTable } from "@/components/common/EvidenceTable";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { SignalLabelLookup } from "@/features/decisions/signal-moves";
import { suspectEventRows } from "@/lib/evidence";
import { humanize } from "@/lib/format";
import { fmtDuration, fmtSim, parseIso } from "@/lib/time";

const LOADING = (
  <div role="status" className="space-y-2">
    <span className="sr-only">Loading the evidence</span>
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-4/5" />
  </div>
);

const NOT_LOADED = (
  <p className="text-meta text-muted-foreground">
    Evidence not loaded: the suspect event is older than the events this page holds.
  </p>
);

function windowSentence(event: SuspectEvent): string {
  const span = parseIso(event.window.to_sim_ts) - parseIso(event.window.from_sim_ts);
  const mode = humanize(event.machine_state.mode).toLowerCase();
  return `Machine ${mode}; observed over ${fmtDuration(span)} up to ${fmtSim(event.window.to_sim_ts)}.`;
}

interface EventEvidenceProps {
  event: SuspectEvent;
  signalLabel: SignalLabelLookup;
}

function EventEvidence({ event, signalLabel }: EventEvidenceProps) {
  const rows = useMemo(() => suspectEventRows(event), [event]);
  return (
    <div className="space-y-3">
      <p className="text-meta text-muted-foreground">{windowSentence(event)}</p>
      <EvidenceTable
        rows={rows}
        signalLabel={signalLabel}
        caption="Evidence of the suspect event"
      />
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-meta">
        <dt className="text-muted-foreground">Rules fired</dt>
        <dd className="flex flex-wrap gap-x-3 gap-y-1">
          {event.rule_ids.map((ruleId) => (
            <Code key={ruleId} value={ruleId} />
          ))}
        </dd>
        <dt className="text-muted-foreground">Active alarms</dt>
        <dd className="flex flex-wrap gap-1.5">
          {event.active_alarms.length === 0
            ? "None"
            : event.active_alarms.map((code) => (
                <Badge key={code} variant="outline" className="rounded-sm">
                  <Code value={code} />
                </Badge>
              ))}
        </dd>
      </dl>
    </div>
  );
}

export interface DecisionEvidenceProps {
  eventId: string;
  signalLabel: SignalLabelLookup;
}

export function DecisionEvidence({ eventId, signalLabel }: DecisionEvidenceProps) {
  const events = useEvents();
  const event = useMemo(
    () => events.data?.items.find((item) => item.event_id === eventId),
    [events.data, eventId],
  );
  if (event !== undefined) {
    return <EventEvidence event={event} signalLabel={signalLabel} />;
  }
  if (events.isPending) {
    return LOADING;
  }
  if (events.isError) {
    return (
      <ErrorState
        className="px-0"
        message="Couldn't load the evidence."
        detail={events.error.message}
        onRetry={() => void events.refetch()}
      />
    );
  }
  return NOT_LOADED;
}
