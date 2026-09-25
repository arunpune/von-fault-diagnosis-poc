// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The running total of the Cost tab over wall time: a small shadcn chart, a Recharts step area
// that jumps at each decision and never animates — it redraws when a decision lands, and a
// sliding line would misplace the step for a moment. The ledger table under it is its accessible
// view, so the chart is one named image and not a keyboard stop of its own. `CostLedger` loads
// this module lazily: the totals and the table do not wait for the charting library.

import { memo } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis, type TooltipContentProps } from "recharts";

import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import type { CumulativePoint } from "@/features/cost/ledger";
import { fmtUsd, NO_VALUE } from "@/lib/format";
import { fmtWall } from "@/lib/time";

export interface RunningTotalChartProps {
  /** Oldest first, as `cumulativeCost` returns them. */
  points: readonly CumulativePoint[];
}

const CHART_CONFIG = {
  usd: { label: "Running total", color: "var(--primary)" },
} satisfies ChartConfig;

/** Room on the right for the last tick's label, which is centred on the plot's edge. */
const CHART_MARGIN = { top: 6, right: 40, bottom: 0, left: 0 };

const wallTickFormat = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** A wall-clock axis tick in the viewer's zone: "06-05 09:41". */
function fmtWallTick(ms: number): string {
  const parts = new Map(wallTickFormat.formatToParts(ms).map(({ type, value }) => [type, value]));
  return `${parts.get("month")}-${parts.get("day")} ${parts.get("hour")}:${parts.get("minute")}`;
}

function RunningTotalTooltip({ active, label, payload }: TooltipContentProps) {
  const value = payload[0]?.value;
  if (!active || typeof label !== "number") {
    return null;
  }
  return (
    <div className="grid gap-1 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground">
      <span className="text-muted-foreground">{fmtWall(label)}</span>
      <span className="tabular-nums">
        Running total {typeof value === "number" ? fmtUsd(value) : NO_VALUE}
      </span>
    </div>
  );
}

function renderTooltip(props: TooltipContentProps) {
  return <RunningTotalTooltip {...props} />;
}

/** The first and the last decision's time: two ticks are all a chart this small can label. */
function edgeTicks(points: readonly CumulativePoint[]): number[] | undefined {
  const first = points[0];
  const last = points.at(-1);
  return first === undefined || last === undefined ? undefined : [first.t, last.t];
}

const RunningTotalChart = memo(function RunningTotalChart({ points }: RunningTotalChartProps) {
  return (
    <ChartContainer
      config={CHART_CONFIG}
      className="aspect-auto h-28 w-full"
      role="img"
      aria-label="Running total over wall time"
    >
      <AreaChart data={points} margin={CHART_MARGIN} accessibilityLayer={false}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          domain={["dataMin", "dataMax"]}
          ticks={edgeTicks(points)}
          tickFormatter={fmtWallTick}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          dataKey="usd"
          tickFormatter={fmtUsd}
          tickLine={false}
          axisLine={false}
          tickCount={3}
          width={76}
        />
        <ChartTooltip content={renderTooltip} />
        <Area
          dataKey="usd"
          type="stepAfter"
          stroke="var(--color-usd)"
          strokeWidth={1.5}
          fill="var(--color-usd)"
          fillOpacity={0.12}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
});

export default RunningTotalChart;
