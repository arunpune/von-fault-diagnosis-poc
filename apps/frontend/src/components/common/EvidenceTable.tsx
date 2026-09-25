// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Evidence rows as a table: what was measured, the sentence, the value against its usual level,
// and how long it has lasted. The rows come from `lib/evidence.ts`, so a suspect event and a
// ticket read the same. Signal ids are shown through `signalLabel` (the registry's labels, from
// `useSignals()`) and humanised when no label is given.

import { memo } from "react";

import { EmptyState } from "@/components/common/EmptyState";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { EvidenceRow } from "@/lib/evidence";
import { fmtValue, humanize, NO_VALUE } from "@/lib/format";

export interface EvidenceTableProps {
  rows: readonly EvidenceRow[];
  /** The label of a signal or behaviour id; ids are humanised when absent or unknown. */
  signalLabel?: (signal: string) => string | undefined;
  /** Names the table for assistive technology. */
  caption?: string;
  /** Shown instead of the table when there are no rows. */
  emptyMessage?: string;
}

const HEADER = (
  <TableHeader>
    <TableRow>
      <TableHead>Signal</TableHead>
      <TableHead>Observation</TableHead>
      <TableHead className="text-right">Value</TableHead>
      <TableHead>Duration</TableHead>
    </TableRow>
  </TableHeader>
);

interface EvidenceTableRowProps {
  row: EvidenceRow;
  label: string;
}

const EvidenceTableRow = memo(function EvidenceTableRow({ row, label }: EvidenceTableRowProps) {
  return (
    <TableRow className="align-top">
      <TableCell className="font-medium">{label}</TableCell>
      <TableCell className="max-w-[60ch] whitespace-normal">{row.statement}</TableCell>
      <TableCell className="text-right tabular-nums">
        {fmtValue(row.value, row.unit)}
        {row.baseline === undefined ? null : (
          <span className="block text-[0.75rem] text-muted-foreground">
            usual {fmtValue(row.baseline, row.unit)}
          </span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">{row.window ?? NO_VALUE}</TableCell>
    </TableRow>
  );
});

export function EvidenceTable({
  rows,
  signalLabel,
  caption = "Evidence",
  emptyMessage = "No evidence was recorded.",
}: EvidenceTableProps) {
  if (rows.length === 0) {
    return <EmptyState>{emptyMessage}</EmptyState>;
  }
  return (
    <Table className="text-[0.8125rem]">
      <TableCaption className="sr-only">{caption}</TableCaption>
      {HEADER}
      <TableBody>
        {rows.map((row, index) => (
          <EvidenceTableRow
            // Rows have no id and one signal may appear twice; the order is the evidence's own.
            key={`${index}-${row.signal}`}
            row={row}
            label={signalLabel?.(row.signal) ?? humanize(row.signal)}
          />
        ))}
      </TableBody>
    </Table>
  );
}
