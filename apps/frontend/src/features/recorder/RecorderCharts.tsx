// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The recorder's charts: the lanes with their readouts, the state, LPS, Towers and alarm rows,
// the time axis and the reference-window legend. They are the only part of the page that draws
// with Recharts, so RecorderPanel loads this file as its own chunk: the first paint needs only
// the panel's header and its empty state, and the chunk is fetched as soon as the panel
// mounts, well before the first telemetry arrives.

import { memo } from "react";

import { Lane } from "@/features/recorder/Lane";
import { LaneHeader } from "@/features/recorder/LaneHeader";
import type { RecorderLayout, ResolvedLane } from "@/features/recorder/lanes";
import { OverlayLegend } from "@/features/recorder/OverlayBands";
import { useOverlayModel, type OverlayModel } from "@/features/recorder/overlay-model";
import { StateStrip } from "@/features/recorder/StateStrip";
import { TimeAxis } from "@/features/recorder/TimeAxis";
import { tid } from "@/lib/testids";
import { useAxis, useLaneSeries, type RecorderAxis } from "@/store/telemetry-store";

interface LaneRowProps {
  lane: ResolvedLane;
  windowMs: number;
  axis: RecorderAxis;
  overlay: OverlayModel | null;
  first: boolean;
}

/** One lane with its readouts: subscribes to its own slice, so it alone re-renders on change. */
const LaneRow = memo(function LaneRow({ lane, windowMs, axis, overlay, first }: LaneRowProps) {
  const { points, latest } = useLaneSeries(lane, windowMs);
  return (
    <div data-testid={tid.recorder.lane(lane.id)}>
      <LaneHeader
        title={lane.title}
        unit={lane.unit}
        decimals={lane.decimals}
        series={lane.series}
        latest={latest}
      />
      <Lane lane={lane} points={points} axis={axis} overlay={overlay} first={first} />
    </div>
  );
});

export interface RecorderChartsProps {
  layout: RecorderLayout;
  windowMs: number;
  overlays: boolean;
}

interface RecorderBodyProps extends RecorderChartsProps {
  axis: RecorderAxis;
}

function RecorderBody({ layout, windowMs, overlays, axis }: RecorderBodyProps) {
  const overlay = useOverlayModel(axis, overlays);
  return (
    <div className="flex flex-col gap-2 px-4 pt-1 pb-2">
      {layout.lanes.map((lane, index) => (
        <LaneRow
          key={lane.id}
          lane={lane}
          windowMs={windowMs}
          axis={axis}
          overlay={overlay}
          first={index === 0}
        />
      ))}
      <StateStrip strips={layout.strips} windowMs={windowMs} axis={axis} />
      <TimeAxis axis={axis} />
      {overlays ? <OverlayLegend /> : null}
    </div>
  );
}

export default function RecorderCharts({ layout, windowMs, overlays }: RecorderChartsProps) {
  const axis = useAxis(windowMs);
  return axis === null ? null : (
    <RecorderBody layout={layout} windowMs={windowMs} overlays={overlays} axis={axis} />
  );
}
