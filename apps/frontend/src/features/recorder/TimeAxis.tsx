// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The recorder's one visible time axis: under the lanes and rows, it labels the ticks every chart
// above shares — sim time in UTC, "09:48", or "06-05 09:48" once the window spans two days. It is
// a Recharts chart too, with the lanes' left and right margins, so its ticks sit exactly under
// their grid lines.

import { memo } from "react";
import { ComposedChart, XAxis, YAxis } from "recharts";

import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { CHART_RIGHT_MARGIN, Y_AXIS_WIDTH } from "@/features/recorder/Lane";
import { fmtSimShort } from "@/lib/time";
import type { RecorderAxis } from "@/store/telemetry-store";

const NO_SERIES: ChartConfig = {};
const AXIS_MARGIN = { top: 0, right: CHART_RIGHT_MARGIN, bottom: 0, left: Y_AXIS_WIDTH };
const AXIS_TICK = { fontSize: 11 };
const UNIT_DOMAIN = [0, 1] as const;

export const TimeAxis = memo(function TimeAxis({ axis }: { axis: RecorderAxis }) {
  const formatTick = (value: number): string => fmtSimShort(value, axis.withDate);
  return (
    <ChartContainer config={NO_SERIES} className="aspect-auto h-6 w-full" aria-hidden="true">
      <ComposedChart margin={AXIS_MARGIN} accessibilityLayer={false}>
        <XAxis
          type="number"
          dataKey="t"
          domain={[axis.from, axis.to]}
          ticks={axis.ticks}
          tickFormatter={formatTick}
          allowDataOverflow
          orientation="top"
          height={20}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
        />
        <YAxis type="number" domain={UNIT_DOMAIN} allowDataOverflow hide />
      </ComposedChart>
    </ChartContainer>
  );
});
