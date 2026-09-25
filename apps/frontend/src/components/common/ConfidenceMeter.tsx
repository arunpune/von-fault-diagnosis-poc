// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// A confidence as a bar and a number: the shadcn Progress with the value as a percentage beside
// it, and a thin tick for each threshold the caller passes — the decision gate's ticket and
// review thresholds in the decision sheet and the review queue. The bar carries the accessible
// name and value; the ticks and the visible number repeat it for the eye only.

import type { CSSProperties } from "react";

import { Progress } from "@/components/ui/progress";
import { fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ConfidenceThreshold {
  /** 0 to 1, like the confidence. */
  value: number;
  /** What crossing it means, e.g. "Ticket at 85 %"; shown as the tick's tooltip. */
  label: string;
}

export interface ConfidenceMeterProps {
  /** 0 to 1. */
  value: number;
  thresholds?: readonly ConfidenceThreshold[];
  /** The bar's accessible name. */
  label?: string;
  className?: string;
  "data-testid"?: string;
}

const NO_THRESHOLDS: readonly ConfidenceThreshold[] = [];

function toPercent(fraction: number): number {
  return Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) * 100 : 0;
}

function tickStyle(threshold: ConfidenceThreshold): CSSProperties {
  return { left: `${toPercent(threshold.value)}%` };
}

export function ConfidenceMeter({
  value,
  thresholds = NO_THRESHOLDS,
  label = "Confidence",
  className,
  "data-testid": testId,
}: ConfidenceMeterProps) {
  const percent = toPercent(value);
  const text = fmtPct(value);
  return (
    <div className={cn("flex min-w-32 items-center gap-2", className)} data-testid={testId}>
      <div className="relative flex-1">
        <Progress
          value={percent}
          aria-label={label}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={text}
          className="h-1.5"
        />
        {thresholds.map((threshold) => (
          <span
            key={threshold.label}
            aria-hidden="true"
            title={threshold.label}
            data-threshold={threshold.value}
            className="absolute -top-1 h-3.5 w-px -translate-x-1/2 bg-foreground/70"
            style={tickStyle(threshold)}
          />
        ))}
      </div>
      <span aria-hidden="true" className="w-10 text-right text-[0.8125rem] tabular-nums">
        {text}
      </span>
    </div>
  );
}
