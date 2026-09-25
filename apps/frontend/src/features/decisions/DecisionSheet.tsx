// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The decision sheet. App.tsx loads this default export lazily from this fixed path and drives it
// from the `#/decisions/<id>` hash route: a non-null `decisionId` opens the sheet, and `onClose`
// clears the route. It opens on the right, 560 px wide, so the recorder keeps running beside it.
//
// The header names what was chosen (or that the call failed), with the choice's id, the severity,
// what the confidence gate did, and which backend and model answered. The sections follow in this
// order: confidence against the decision's own gate thresholds, the candidates, severity, the
// evidence of the suspect event, the ticket, the cost, and — only when the backend stored it — the
// input the model saw. Until the decision loads, the header reads "Decision" with its id.

import CircleXIcon from "lucide-react/dist/esm/icons/circle-x";
import { useState } from "react";

import { isApiError } from "@/api/client";
import { useDecision } from "@/api/queries";
import type { Decision, DecisionDetail } from "@/api/types";
import { Code } from "@/components/common/Code";
import { ConfidenceMeter } from "@/components/common/ConfidenceMeter";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorState } from "@/components/common/ErrorState";
import { SeverityBadge } from "@/components/common/SeverityBadge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Candidates } from "@/features/decisions/Candidates";
import { DecisionCost } from "@/features/decisions/DecisionCost";
import { DecisionEvidence } from "@/features/decisions/DecisionEvidence";
import { DecisionInput } from "@/features/decisions/DecisionInput";
import { DecisionSection } from "@/features/decisions/DecisionSection";
import { DecisionTicket } from "@/features/decisions/DecisionTicket";
import {
  backendLabel,
  chosenTitle,
  failureWords,
  gateWord,
  isFailedDecision,
  NONE_OF_THESE,
} from "@/features/decisions/decision-text";
import { SeverityDetail } from "@/features/decisions/SeverityDetail";
import type { SignalLabelLookup } from "@/features/decisions/signal-moves";
import { useSignalLabels } from "@/features/decisions/use-signal-labels";
import { fmtPct } from "@/lib/format";
import { tid } from "@/lib/testids";
import { fmtSim } from "@/lib/time";

export interface DecisionSheetProps {
  decisionId: string | null;
  onClose(): void;
}

const FAILURE_ICON = <CircleXIcon aria-hidden="true" />;

const LOADING_BODY = (
  <div role="status" className="space-y-3 px-4">
    <span className="sr-only">Loading the decision</span>
    <Skeleton className="h-4 w-1/2" />
    <Skeleton className="h-24 w-full" />
    <Skeleton className="h-24 w-full" />
  </div>
);

const BODY_CLASS = "min-h-0 flex-1 space-y-6 overflow-y-auto px-4 pb-6";

/** The header while the decision is not known: "Decision" and the id the route asked for. */
function PendingHeader({ decisionId }: { decisionId: string }) {
  return (
    <SheetHeader className="pr-12">
      <SheetTitle className="text-2xl">Decision</SheetTitle>
      <SheetDescription>
        <Code value={decisionId} />
      </SheetDescription>
    </SheetHeader>
  );
}

function DecisionHeader({ decision }: { decision: Decision }) {
  const failed = isFailedDecision(decision);
  const named = !failed && decision.choice !== NONE_OF_THESE;
  return (
    <SheetHeader className="gap-1.5 pr-12">
      <SheetTitle className={named ? "text-2xl font-semibold" : "text-2xl"}>
        {failed ? "Decision failed" : chosenTitle(decision)}
      </SheetTitle>
      <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {failed ? null : <Code value={decision.choice} />}
        {failed ? null : <SeverityBadge level={decision.severity.level} />}
        <span className="text-foreground">{gateWord(decision)}</span>
        <Badge variant="secondary">{backendLabel(decision.backend, decision.model)}</Badge>
        <span className="tabular-nums">{fmtSim(decision.sim_ts)} UTC</span>
      </SheetDescription>
    </SheetHeader>
  );
}

function FailureAlert({ decision }: { decision: Decision }) {
  const status = decision.error?.status;
  const kind = failureWords(decision);
  return (
    <Alert variant="destructive">
      {FAILURE_ICON}
      <AlertTitle>
        The decision backend failed: {status === undefined ? kind : `${kind}, HTTP ${status}`}
      </AlertTitle>
      <AlertDescription>
        {decision.error?.message ?? "The backend gave no reason."} {decision.gate.reason}
      </AlertDescription>
    </Alert>
  );
}

function ConfidenceSection({ decision }: { decision: Decision }) {
  const { ticket_min_confidence: ticketAt, review_min_confidence: reviewAt } = decision.gate;
  const thresholds = [
    { value: ticketAt, label: `Ticket at ${fmtPct(ticketAt)}` },
    { value: reviewAt, label: `Review at ${fmtPct(reviewAt)}` },
  ];
  return (
    <DecisionSection title="Confidence">
      <ConfidenceMeter
        value={decision.confidence}
        thresholds={thresholds}
        label="Decision confidence"
        data-testid={tid.decision.confidence}
      />
      <p className="max-w-[72ch] text-meta text-muted-foreground">
        Ticket at {fmtPct(ticketAt)} or more, review queue at {fmtPct(reviewAt)} or more.{" "}
        {decision.gate.reason}
      </p>
      {decision.rationale === undefined ? null : (
        <p className="max-w-[72ch] text-meta">
          <span className="text-muted-foreground">Rationale: </span>
          {decision.rationale}
        </p>
      )}
    </DecisionSection>
  );
}

interface DecisionBodyProps {
  decision: DecisionDetail;
  signalLabel: SignalLabelLookup;
}

function DecisionBody({ decision, signalLabel }: DecisionBodyProps) {
  const failed = isFailedDecision(decision);
  const hasInput = decision.state !== undefined && decision.state !== null;
  return (
    <div className={BODY_CLASS}>
      {failed ? (
        <FailureAlert decision={decision} />
      ) : (
        <>
          <ConfidenceSection decision={decision} />
          <DecisionSection title="Candidates">
            <Candidates decision={decision} signalLabel={signalLabel} />
          </DecisionSection>
          <DecisionSection title="Severity">
            <SeverityDetail severity={decision.severity} />
          </DecisionSection>
        </>
      )}
      <DecisionSection title="Evidence">
        <DecisionEvidence eventId={decision.event_id} signalLabel={signalLabel} />
      </DecisionSection>
      <DecisionSection title="Ticket">
        <DecisionTicket decision={decision} />
      </DecisionSection>
      <DecisionSection title="Cost">
        <DecisionCost decision={decision} />
      </DecisionSection>
      {hasInput ? <DecisionInput state={decision.state} /> : null}
    </div>
  );
}

function DecisionView({ decisionId }: { decisionId: string }) {
  const query = useDecision(decisionId);
  const signalLabel = useSignalLabels();
  if (query.data !== undefined) {
    return (
      <>
        <DecisionHeader decision={query.data} />
        <DecisionBody decision={query.data} signalLabel={signalLabel} />
      </>
    );
  }
  if (!query.isError) {
    return (
      <>
        <PendingHeader decisionId={decisionId} />
        {LOADING_BODY}
      </>
    );
  }
  const notFound = isApiError(query.error) && query.error.status === 404;
  return (
    <>
      <PendingHeader decisionId={decisionId} />
      {notFound ? (
        <EmptyState>
          No decision has this id. It may belong to an earlier run; pick one from the alerts feed.
        </EmptyState>
      ) : (
        <ErrorState
          message="Couldn't load the decision."
          detail={query.error.message}
          onRetry={() => void query.refetch()}
        />
      )}
    </>
  );
}

export default function DecisionSheet({ decisionId, onClose }: DecisionSheetProps) {
  // The last decision shown stays in the sheet while it closes, so the close animation does not
  // play over an empty panel.
  const [shownId, setShownId] = useState(decisionId);
  if (decisionId !== null && decisionId !== shownId) {
    setShownId(decisionId);
  }
  return (
    <Sheet
      open={decisionId !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent
        side="right"
        data-testid={tid.decision.sheet}
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[35rem]"
      >
        {shownId === null ? null : <DecisionView key={shownId} decisionId={shownId} />}
      </SheetContent>
    </Sheet>
  );
}
