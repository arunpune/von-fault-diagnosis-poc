// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The per-decision ledger of the Cost tab: the backend's newest billed decisions merged with the
// decisions cache (`ledger.ts`), newest first, under a small step chart of the running total over
// wall time. Each decision id opens its decision sheet through the hash route and preloads the
// sheet's chunk on hover or focus. The chart is a chunk of its own (`RunningTotalChart.tsx`, with
// the charting library), so the table never waits for it.

import { lazy, memo, Suspense, useId, useMemo } from "react";

import { useDecisions } from "@/api/queries";
import type { LedgerRow } from "@/api/types";
import { LazyDecisionSheet } from "@/components/app-shell/lazy-panels";
import { Code } from "@/components/common/Code";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
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
import { costBefore, cumulativeCost, mergeLedger } from "@/features/cost/ledger";
import { backendLabel } from "@/features/cost/summary";
import { fmtTokens, fmtUsd, shortId } from "@/lib/format";
import { hashRouteHref } from "@/lib/hash-route";
import { tid } from "@/lib/testids";
import { fmtWall } from "@/lib/time";

const RunningTotalChart = lazy(() => import("@/features/cost/RunningTotalChart"));

export interface CostLedgerProps {
  /** `recent` of `GET /api/cost`: the newest billed decisions, newest first. */
  recent: readonly LedgerRow[];
  /** The running total the chart ends at. */
  totalUsd: number;
}

const NO_DECISIONS: readonly never[] = [];

/** Holds the chart's height while its chunk loads, so the table does not jump. */
const CHART_FALLBACK = <Skeleton className="h-28 w-full" />;

function preloadDecisionSheet(): void {
  void LazyDecisionSheet.preload();
}

const LEDGER_HEADER = (
  <TableHeader>
    <TableRow>
      <TableHead>Decision</TableHead>
      <TableHead>Wall time</TableHead>
      <TableHead>Backend and model</TableHead>
      <TableHead className="text-right">Tokens in</TableHead>
      <TableHead className="text-right">Tokens out</TableHead>
      <TableHead className="text-right">Cost</TableHead>
    </TableRow>
  </TableHeader>
);

const LedgerTableRow = memo(function LedgerTableRow({ row }: { row: LedgerRow }) {
  return (
    <TableRow data-testid={tid.cost.row(row.decision_id)}>
      <TableCell>
        <Button asChild variant="link" size="xs" className="h-auto px-0">
          <a
            href={hashRouteHref("decision", row.decision_id)}
            aria-label={`Open decision ${shortId(row.decision_id)}`}
            onPointerEnter={preloadDecisionSheet}
            onFocus={preloadDecisionSheet}
          >
            <Code value={row.decision_id} short />
          </a>
        </Button>
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">{fmtWall(row.wall_ts)}</TableCell>
      <TableCell>
        <span className="block">{backendLabel(row.backend)}</span>
        <Code value={row.model} className="text-muted-foreground" />
      </TableCell>
      <TableCell className="text-right tabular-nums">{fmtTokens(row.input_tokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtTokens(row.output_tokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtUsd(row.cost_usd)}</TableCell>
    </TableRow>
  );
});

export function CostLedger({ recent, totalUsd }: CostLedgerProps) {
  const headingId = useId();
  const decisions = useDecisions().data?.items ?? NO_DECISIONS;
  const ledger = useMemo(() => mergeLedger(recent, decisions), [recent, decisions]);
  const points = useMemo(
    () => cumulativeCost(ledger, costBefore(totalUsd, ledger)),
    [ledger, totalUsd],
  );

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <h3 id={headingId} className="text-sm font-medium">
        Cost per decision
      </h3>
      {ledger.length === 0 ? (
        <EmptyState className="px-0 py-2">No decisions yet, so nothing has been spent.</EmptyState>
      ) : (
        <>
          {/* A line needs two decisions; one alone is its own row below. */}
          {ledger.length > 1 ? (
            <Suspense fallback={CHART_FALLBACK}>
              <RunningTotalChart points={points} />
            </Suspense>
          ) : null}
          <Table className="text-meta">
            <TableCaption className="sr-only">Cost per decision, newest first</TableCaption>
            {LEDGER_HEADER}
            <TableBody>
              {ledger.map((row) => (
                <LedgerTableRow key={row.decision_id} row={row} />
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </section>
  );
}
