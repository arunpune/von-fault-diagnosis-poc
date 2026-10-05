// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The running total of the Cost tab: what every billed decision has cost so far, the calls and
// tokens behind it, the prices it was computed with and the day they were checked, and the
// split per decision backend. Costs keep six decimals, so a Von decision billed at $0.000077 is
// visible and not rounded to zero.

import { useId } from "react";

import type { ApiCost } from "@/api/types";
import { Code } from "@/components/common/Code";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  backendLabel,
  backendRows,
  priceSentence,
  RULES_NOTICE,
  showsRulesNotice,
  type BackendRow,
} from "@/features/cost/summary";
import { fmtTokens, fmtUsd } from "@/lib/format";
import { tid } from "@/lib/testids";
import { useBackendStatus } from "@/store/live-store";

export interface CostSummaryProps {
  cost: ApiCost;
}

const BACKEND_HEADER = (
  <TableHeader>
    <TableRow>
      <TableHead>Backend and model</TableHead>
      <TableHead className="text-right">Calls</TableHead>
      <TableHead className="text-right">Tokens in</TableHead>
      <TableHead className="text-right">Tokens out</TableHead>
      <TableHead className="text-right">Cost</TableHead>
    </TableRow>
  </TableHeader>
);

/** One backend: its name with the model under it, so the split fits beside the ledger. */
function BackendTableRow({ row }: { row: BackendRow }) {
  return (
    <TableRow>
      <TableCell>
        <span className="block font-medium">{backendLabel(row.backend)}</span>
        <Code value={row.model} className="text-muted-foreground" />
      </TableCell>
      <TableCell className="text-right tabular-nums">{fmtTokens(row.calls)}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtTokens(row.input_tokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtTokens(row.output_tokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtUsd(row.usd)}</TableCell>
    </TableRow>
  );
}

function BackendTable({ rows }: { rows: readonly BackendRow[] }) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <Table className="text-meta">
      <TableCaption className="sr-only">Cost by backend</TableCaption>
      {BACKEND_HEADER}
      <TableBody>
        {rows.map((row) => (
          <BackendTableRow key={row.backend} row={row} />
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * The sentence that explains a zero total under the rules backend. It is the only part of the
 * summary that reads the live backend status, so a status poll re-renders this line alone.
 */
function RulesNotice({ cost }: CostSummaryProps) {
  const activeBackend = useBackendStatus()?.backend.name ?? null;
  if (!showsRulesNotice(activeBackend, cost)) {
    return null;
  }
  return <p className="text-sm">{RULES_NOTICE}</p>;
}

export function CostSummary({ cost }: CostSummaryProps) {
  const headingId = useId();
  const { totals } = cost;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <h3 id={headingId} className="text-sm font-medium">
        Running total
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Total spent</dt>
        <dd className="font-medium tabular-nums" data-testid={tid.cost.total}>
          {fmtUsd(totals.usd)}
        </dd>
        <dt className="text-muted-foreground">Billed calls</dt>
        <dd className="tabular-nums">{fmtTokens(totals.calls)}</dd>
        <dt className="text-muted-foreground">Input tokens</dt>
        <dd className="tabular-nums">{fmtTokens(totals.input_tokens)}</dd>
        <dt className="text-muted-foreground">Output tokens</dt>
        <dd className="tabular-nums">{fmtTokens(totals.output_tokens)}</dd>
      </dl>
      <p className="max-w-[72ch] text-meta text-muted-foreground" data-testid={tid.cost.prices}>
        {priceSentence(cost.prices)}
      </p>
      <RulesNotice cost={cost} />
      <BackendTable rows={backendRows(cost.by_backend)} />
    </section>
  );
}
