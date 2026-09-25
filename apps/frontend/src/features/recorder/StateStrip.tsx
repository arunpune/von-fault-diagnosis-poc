// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The pen-recorder rows under the lanes: the machine state derived from the replayed digitals
// (loaded, unloaded, off), the low-pressure switch, the dryer towers and the controller alarms,
// each a 28 px row of segments on the lanes' time axis. The rows are Recharts charts too —
// ReferenceArea segments on a hidden unit Y axis — so the whole recorder stays inside the shadcn
// chart component. Each row reads its own transitions and re-renders only when they, or the axis,
// change.

import { memo } from "react";
import { ComposedChart, ReferenceArea, XAxis, YAxis } from "recharts";

import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { CHART_RIGHT_MARGIN, Y_AXIS_WIDTH } from "@/features/recorder/Lane";
import type { ResolvedStrips } from "@/features/recorder/lanes";
import { MACHINE_STATE, type MachineState } from "@/lib/machine-state";
import { tid } from "@/lib/testids";
import { fmtSimShort } from "@/lib/time";
import type { AlarmCodes, DigitalLevel } from "@/store/telemetry-buffer";
import { useStrip, type RecorderAxis, type StripKind } from "@/store/telemetry-store";

const NO_SERIES: ChartConfig = {};
const STRIP_MARGIN = { top: 2, right: CHART_RIGHT_MARGIN, bottom: 2, left: Y_AXIS_WIDTH };
const UNIT_DOMAIN = [0, 1] as const;

/** One drawn stretch of a row. */
interface Segment {
  readonly from: number;
  readonly to: number;
  readonly fill: string;
  readonly opacity: number;
  readonly title: string;
}

interface SegmentStyle {
  readonly fill: string;
  readonly opacity: number;
  readonly word: string;
}

const STATE_STYLES: Readonly<Partial<Record<MachineState, SegmentStyle>>> = {
  [MACHINE_STATE.loaded]: { fill: "var(--state-loaded)", opacity: 1, word: "Loaded" },
  [MACHINE_STATE.unloaded]: { fill: "var(--state-unloaded)", opacity: 1, word: "Unloaded" },
  [MACHINE_STATE.off]: { fill: "var(--state-off)", opacity: 1, word: "Off" },
};

const LPS_STYLE: SegmentStyle = {
  fill: "var(--accent-signal)",
  opacity: 0.45,
  word: "Low-pressure switch on",
};
const TOWERS_STYLE: SegmentStyle = { fill: "var(--series-purge)", opacity: 0.35, word: "Tower 1" };
const ALARM_FILL = "var(--severity-high)";

function span(from: number, to: number, withDate: boolean): string {
  return `${fmtSimShort(from, withDate)}–${fmtSimShort(to, withDate)}`;
}

/**
 * The stretches of a transition list inside the axis: each value holds until the next
 * transition or the axis' end. `styleOf` says how a value is drawn, or null for "nothing".
 */
function segmentsOf<V>(
  transitions: readonly (readonly [number, V])[],
  axis: RecorderAxis,
  styleOf: (value: V) => { fill: string; opacity: number; word: string } | null,
): Segment[] {
  const segments: Segment[] = [];
  transitions.forEach(([from, value], index) => {
    const style = styleOf(value);
    const to = transitions[index + 1]?.[0] ?? axis.to;
    if (style !== null && to > from) {
      segments.push({
        from,
        to,
        fill: style.fill,
        opacity: style.opacity,
        title: `${style.word}, ${span(from, to, axis.withDate)}`,
      });
    }
  });
  return segments;
}

function segmentShape(segment: Segment) {
  return function SegmentShape({ x = 0, y = 0, width = 0, height = 0 }) {
    return (
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={segment.fill}
        fillOpacity={segment.opacity}
      >
        <title>{segment.title}</title>
      </rect>
    );
  };
}

interface StripRowProps {
  label: string;
  testId: string;
  axis: RecorderAxis;
  segments: readonly Segment[];
}

function StripRow({ label, testId, axis, segments }: StripRowProps) {
  return (
    <div className="relative" data-testid={testId}>
      <span className="absolute top-1/2 left-0 -translate-y-1/2 text-xs text-muted-foreground">
        {label}
      </span>
      <ChartContainer config={NO_SERIES} className="aspect-auto h-7 w-full">
        <ComposedChart margin={STRIP_MARGIN} accessibilityLayer={false}>
          <XAxis type="number" dataKey="t" domain={[axis.from, axis.to]} allowDataOverflow hide />
          <YAxis type="number" domain={UNIT_DOMAIN} allowDataOverflow hide />
          {segments.map((segment) => (
            <ReferenceArea
              key={segment.from}
              x1={segment.from}
              x2={segment.to}
              ifOverflow="hidden"
              shape={segmentShape(segment)}
            />
          ))}
        </ComposedChart>
      </ChartContainer>
    </div>
  );
}

interface RowProps {
  windowMs: number;
  axis: RecorderAxis;
}

const StateRow = memo(function StateRow({ windowMs, axis }: RowProps) {
  const transitions = useStrip("state", windowMs);
  const segments = segmentsOf(transitions, axis, (state) => STATE_STYLES[state] ?? null);
  return (
    <StripRow label="State" testId={tid.recorder.lane("state")} axis={axis} segments={segments} />
  );
});

interface DigitalRowProps extends RowProps {
  kind: Extract<StripKind, "lps" | "towers">;
  label: string;
  /** The recording column the row shows, for its test id. */
  column: string;
  style: SegmentStyle;
}

const DigitalRow = memo(function DigitalRow({
  kind,
  label,
  column,
  style,
  windowMs,
  axis,
}: DigitalRowProps) {
  const transitions = useStrip(kind, windowMs);
  const segments = segmentsOf(transitions, axis, (level: DigitalLevel) =>
    level === 1 ? style : null,
  );
  return (
    <StripRow label={label} testId={tid.recorder.lane(column)} axis={axis} segments={segments} />
  );
});

const AlarmRow = memo(function AlarmRow({ windowMs, axis }: RowProps) {
  const transitions = useStrip("alarms", windowMs);
  const segments = segmentsOf(transitions, axis, (codes: AlarmCodes) =>
    codes.length === 0 ? null : { fill: ALARM_FILL, opacity: 0.45, word: codes.join(", ") },
  );
  return (
    <StripRow label="Alarms" testId={tid.recorder.lane("alarms")} axis={axis} segments={segments} />
  );
});

export interface StateStripProps {
  strips: ResolvedStrips;
  windowMs: number;
  axis: RecorderAxis;
}

/** The rows under the lanes; a row whose signals the registry lacks is left out. */
export function StateStrip({ strips, windowMs, axis }: StateStripProps) {
  return (
    <div className="flex flex-col">
      {strips.state ? <StateRow windowMs={windowMs} axis={axis} /> : null}
      {strips.lps === null ? null : (
        <DigitalRow
          kind="lps"
          label="LPS"
          column="LPS"
          style={LPS_STYLE}
          windowMs={windowMs}
          axis={axis}
        />
      )}
      {strips.towers === null ? null : (
        <DigitalRow
          kind="towers"
          label="Towers"
          column="Towers"
          style={TOWERS_STYLE}
          windowMs={windowMs}
          axis={axis}
        />
      )}
      <AlarmRow windowMs={windowMs} axis={axis} />
    </div>
  );
}
