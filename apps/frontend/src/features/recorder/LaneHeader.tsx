// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The line above a lane: its name and unit on the left, the newest value of each series on
// the right in tabular figures, so the readouts do not jitter as they change. Memoised apart
// from the chart: a new value re-renders this line, not the SVG.

import { memo } from "react";

import type { ResolvedSeries } from "@/features/recorder/lanes";
import { fmtNumber, NO_VALUE } from "@/lib/format";

export interface LaneHeaderProps {
  title: string;
  unit: string;
  decimals: number;
  series: readonly ResolvedSeries[];
  /** Per series, the newest value in the window, or null. */
  latest: readonly (number | null)[];
}

export const LaneHeader = memo(function LaneHeader({
  title,
  unit,
  decimals,
  series,
  latest,
}: LaneHeaderProps) {
  return (
    <div className="flex items-baseline gap-2 pr-2 text-xs">
      <span className="text-sm font-medium">{title}</span>
      <span className="text-muted-foreground">{unit}</span>
      <dl className="ml-auto flex flex-wrap justify-end gap-x-4">
        {series.map((entry, index) => {
          const value = latest[index] ?? null;
          return (
            <div key={entry.key} className="flex items-baseline gap-1.5">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  aria-hidden="true"
                  className="inline-block h-0.5 w-3 rounded-full"
                  style={{ background: entry.color }}
                />
                {entry.label}
              </dt>
              <dd className="min-w-[4ch] text-right font-medium tabular-nums">
                {value === null ? NO_VALUE : fmtNumber(value, decimals)}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
});
