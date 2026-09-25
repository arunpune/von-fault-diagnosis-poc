// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The causes the decision weighed: one row per candidate, most likely first, with its cause
// name, fault id, probability, manual reference and — when the backend asked one question per
// candidate — how well the evidence matches the cause's expected signal movements.
// "None of these" is always the last row. A row expands to the catalog entry, fetched the first
// time it opens: what the cause is, how the signals should move, the checks in the manual's
// order and the remedy.

import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import { memo, useMemo, useState } from "react";

import { isApiError } from "@/api/client";
import { useCatalogFault } from "@/api/queries";
import type { Candidate, CatalogEntry, Decision } from "@/api/types";
import { Code } from "@/components/common/Code";
import { ConfidenceMeter } from "@/components/common/ConfidenceMeter";
import { ErrorState } from "@/components/common/ErrorState";
import { ManualRef } from "@/components/common/ManualRef";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { NONE_OF_THESE } from "@/features/decisions/decision-text";
import { describeSignalMove, type SignalLabelLookup } from "@/features/decisions/signal-moves";
import { tid } from "@/lib/testids";

const SUPPORT_HINT = "Does the evidence match this fault's expected signal movements?";

const CHEVRON = (
  <ChevronRightIcon
    aria-hidden="true"
    className="transition-transform group-data-[state=open]/trigger:rotate-90"
  />
);

const CATALOG_LOADING = (
  <div role="status" className="space-y-2">
    <span className="sr-only">Loading the catalog entry</span>
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-5/6" />
    <Skeleton className="h-4 w-2/3" />
  </div>
);

/** Most likely first; equal probabilities keep a stable order by fault id. */
function byProbability(a: Candidate, b: Candidate): number {
  return b.probability - a.probability || a.fault_id.localeCompare(b.fault_id);
}

const METER_GRID = "grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5";

interface CatalogEntryViewProps {
  entry: CatalogEntry;
  signalLabel: SignalLabelLookup;
}

function CatalogEntryView({ entry, signalLabel }: CatalogEntryViewProps) {
  return (
    <div className="max-w-[72ch] space-y-3 text-meta">
      <p>{entry.summary}</p>
      <div className="space-y-1">
        <h4 className="font-medium">Expected signal movements</h4>
        <ul className="list-disc space-y-0.5 pl-5">
          {entry.signal_moves.map((move, index) => (
            // The moves have no id and their order is the manual's own.
            <li key={index}>{describeSignalMove(move, signalLabel)}</li>
          ))}
        </ul>
      </div>
      {entry.checks.length === 0 ? null : (
        <div className="space-y-1">
          <h4 className="font-medium">Checks</h4>
          <ol className="list-decimal space-y-0.5 pl-5">
            {entry.checks.map((check, index) => (
              <li key={index}>{check}</li>
            ))}
          </ol>
        </div>
      )}
      <div className="space-y-1">
        <h4 className="font-medium">Remedy</h4>
        <p>{entry.remedy}</p>
      </div>
    </div>
  );
}

interface CatalogDetailProps {
  query: ReturnType<typeof useCatalogFault>;
  signalLabel: SignalLabelLookup;
}

function CatalogDetail({ query, signalLabel }: CatalogDetailProps) {
  if (query.data !== undefined) {
    return <CatalogEntryView entry={query.data} signalLabel={signalLabel} />;
  }
  if (query.isError) {
    if (isApiError(query.error) && query.error.status === 404) {
      return <p className="text-meta text-muted-foreground">This cause is not in the catalog.</p>;
    }
    return (
      <ErrorState
        className="px-0"
        message="Couldn't load the catalog entry."
        detail={query.error.message}
        onRetry={() => void query.refetch()}
      />
    );
  }
  return CATALOG_LOADING;
}

interface CandidateRowProps {
  candidate: Candidate;
  chosen: boolean;
  /** The evidence-match support, when the backend asked for one. */
  support: number | undefined;
  signalLabel: SignalLabelLookup;
}

const CandidateRow = memo(function CandidateRow({
  candidate,
  chosen,
  support,
  signalLabel,
}: CandidateRowProps) {
  const [open, setOpen] = useState(false);
  const catalog = useCatalogFault(candidate.fault_id, open);
  return (
    <li data-testid={tid.decision.candidate(candidate.fault_id)} className="py-3">
      <Collapsible open={open} onOpenChange={setOpen} className="space-y-2">
        <div className="flex items-start gap-2">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="group/trigger -ml-2 h-auto min-w-0 flex-1 justify-start px-2 py-1 text-left text-sm whitespace-normal"
            >
              {CHEVRON}
              <span className="font-medium">{candidate.name}</span>
            </Button>
          </CollapsibleTrigger>
          {chosen ? <Badge variant="secondary">Chosen</Badge> : null}
          {candidate.benign ? <Badge variant="outline">benign</Badge> : null}
        </div>
        <div className="space-y-2 pl-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <Code value={candidate.fault_id} />
            <ManualRef reference={candidate.manual_ref} />
          </div>
          <div className={METER_GRID}>
            <span className="text-meta text-muted-foreground">Probability</span>
            <ConfidenceMeter
              value={candidate.probability}
              label={`Probability of ${candidate.name}`}
            />
            {support === undefined ? null : (
              <>
                <span className="text-meta text-muted-foreground" title={SUPPORT_HINT}>
                  Evidence match
                </span>
                <ConfidenceMeter
                  value={support}
                  label={`Evidence match of ${candidate.name}`}
                  className="[&_[data-slot=progress-indicator]]:bg-muted-foreground"
                />
              </>
            )}
          </div>
        </div>
        <CollapsibleContent className="pl-6">
          <CatalogDetail query={catalog} signalLabel={signalLabel} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
});

interface NoneOfTheseRowProps {
  probability: number | undefined;
  chosen: boolean;
}

function NoneOfTheseRow({ probability, chosen }: NoneOfTheseRowProps) {
  return (
    <li data-testid={tid.decision.candidate(NONE_OF_THESE)} className="space-y-2 py-3">
      <div className="flex items-start gap-2">
        <span className="flex-1 pl-6 text-sm font-medium">None of these</span>
        {chosen ? <Badge variant="secondary">Chosen</Badge> : null}
      </div>
      <div className="space-y-2 pl-6">
        <Code value={NONE_OF_THESE} />
        <div className={METER_GRID}>
          <span className="text-meta text-muted-foreground">Probability</span>
          <ConfidenceMeter value={probability ?? 0} label="Probability of none of these" />
        </div>
      </div>
    </li>
  );
}

export interface CandidatesProps {
  decision: Decision;
  signalLabel: SignalLabelLookup;
}

export function Candidates({ decision, signalLabel }: CandidatesProps) {
  const candidates: readonly Candidate[] = decision.candidates;
  const sorted = useMemo(() => candidates.toSorted(byProbability), [candidates]);
  return (
    <ul aria-label="Candidate causes" className="divide-y border-y">
      {sorted.map((candidate) => (
        <CandidateRow
          key={candidate.fault_id}
          candidate={candidate}
          chosen={candidate.fault_id === decision.choice}
          support={decision.support[candidate.fault_id]}
          signalLabel={signalLabel}
        />
      ))}
      <NoneOfTheseRow
        probability={decision.probabilities[NONE_OF_THESE]}
        chosen={decision.choice === NONE_OF_THESE}
      />
    </ul>
  );
}
