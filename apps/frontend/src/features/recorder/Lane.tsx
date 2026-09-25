// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// One lane of the chart recorder: a Recharts line chart inside the shadcn chart container, drawn
// for static data — no animation, no dots, linear segments broken at nulls, a fixed Y domain and
// the shared X domain and ticks the store computes once per flush, with the reference windows
// behind the lines. The lane is memoised and its inputs are stable between flushes, so it redraws
// only when its own points, the time axis or the reference windows moved; the readouts above it
// are a separate component, so a new value never redraws the SVG by itself.

import { memo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";

import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import type { ResolvedLane } from "@/features/recorder/lanes";
import { OverlayBands, RecorderPatterns } from "@/features/recorder/OverlayBands";
import type { OverlayModel } from "@/features/recorder/overlay-model";
import type { ChartPoint } from "@/lib/downsample";
import { fmtNumber, NO_VALUE } from "@/lib/format";
import { fmtSim } from "@/lib/time";
import type { RecorderAxis } from "@/store/telemetry-store";

/** Width of the Y axis, which every row under the lanes keeps free so the time axes line up. */
export const Y_AXIS_WIDTH = 48;

/** The chart margins every lane and row shares, for the same reason. */
export const CHART_RIGHT_MARGIN = 8;

const LANE_MARGIN = { top: 6, right: CHART_RIGHT_MARGIN, bottom: 2, left: 0 };

const AXIS_TICK = { fontSize: 11 };

/** The id the recorder's charts synchronise their crosshair on (by time, not by index). */
export const RECORDER_SYNC_ID = "recorder";

export interface LaneProps {
  lane: ResolvedLane;
  /** Per series of the lane, the points to draw (stable between flushes). */
  points: readonly (readonly ChartPoint[])[];
  axis: RecorderAxis;
  /** The reference windows to draw, or null while they are switched off. */
  overlay: OverlayModel | null;
  /** The first lane holds the hatch patterns and the bands' test ids. */
  first: boolean;
}

/** The value in force at `t`: the last point at or before it, or null inside a break. */
function valueAt(points: readonly ChartPoint[], t: number): number | null {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((points[middle]?.t ?? Infinity) <= t) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return points[low - 1]?.v ?? null;
}

interface LaneTooltipProps {
  lane: ResolvedLane;
  points: readonly (readonly ChartPoint[])[];
  active: boolean;
  label: string | number | undefined;
}

/**
 * The lane's hover readout: the sim time under the cursor and every series' value at it. The
 * series have their own timestamps, so the values are looked up by time rather than taken from
 * Recharts' payload, which pairs points by index.
 */
function LaneTooltip({ lane, points, active, label }: LaneTooltipProps) {
  if (!active || typeof label !== "number") {
    return null;
  }
  return (
    <div className="grid gap-1 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-sm">
      <span className="font-medium tabular-nums">{fmtSim(label)} UTC</span>
      {lane.series.map((series, index) => {
        const value = valueAt(points[index] ?? [], label);
        return (
          <span key={series.key} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2 rounded-[2px]"
              style={{ background: series.color }}
            />
            <span className="text-muted-foreground">{series.label}</span>
            <span className="ml-auto tabular-nums">
              {value === null ? NO_VALUE : `${fmtNumber(value, lane.decimals)} ${lane.unit}`}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export const Lane = memo(function Lane({ lane, points, axis, overlay, first }: LaneProps) {
  const renderTooltip = (props: TooltipContentProps) => (
    <LaneTooltip lane={lane} points={points} active={props.active} label={props.label} />
  );
  return (
    <ChartContainer config={lane.chartConfig} className="aspect-auto h-[84px] w-full">
      <LineChart
        id={`recorder-lane-chart-${lane.id}`}
        margin={LANE_MARGIN}
        syncId={RECORDER_SYNC_ID}
        syncMethod="value"
        accessibilityLayer={false}
      >
        {first ? <RecorderPatterns /> : null}
        <CartesianGrid horizontal={false} verticalValues={[...axis.ticks]} stroke="var(--border)" />
        <XAxis
          type="number"
          dataKey="t"
          domain={[axis.from, axis.to]}
          ticks={axis.ticks}
          allowDataOverflow
          hide
        />
        <YAxis
          type="number"
          domain={lane.domain}
          ticks={lane.ticks}
          allowDataOverflow
          width={Y_AXIS_WIDTH}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
        />
        {overlay === null ? null : <OverlayBands model={overlay} tagged={first} />}
        {lane.guides.map((value) => (
          <ReferenceLine
            key={value}
            y={value}
            stroke="var(--muted-foreground)"
            strokeOpacity={0.5}
            strokeDasharray="2 4"
            ifOverflow="hidden"
          />
        ))}
        {lane.series.map((series, index) => (
          <Line
            key={series.key}
            data={points[index]}
            dataKey="v"
            name={series.key}
            type="linear"
            stroke={`var(--color-${series.key})`}
            strokeWidth={1.25}
            dot={false}
            activeDot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
        <ChartTooltip content={renderTooltip} isAnimationActive={false} />
      </LineChart>
    </ChartContainer>
  );
});
