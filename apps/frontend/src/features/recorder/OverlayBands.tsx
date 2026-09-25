// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// How the reference windows look: dataset failures and injected faults as hatched bands,
// excluded windows and unlabelled episodes as a light wash, replay markers as dashed lines, on
// every lane; a legend under the time axis names them. Bands and markers carry a native
// tooltip, and their test ids in the first lane only. The hatch is an SVG pattern defined once,
// inside the first lane's <defs>, with the same 6 px tile as the `hatch` utility of index.css,
// so the legend's swatches match the bands.

import { memo, type SVGProps } from "react";
import { ReferenceArea, ReferenceLine } from "recharts";

import type {
  BandKind,
  OverlayBand,
  OverlayMarkerLine,
  OverlayModel,
} from "@/features/recorder/overlay-model";
import { tid } from "@/lib/testids";

const HATCH_FAILURE_ID = "recorder-hatch-failure";
const HATCH_INJECTION_ID = "recorder-hatch-injection";

const BAND_FILL: Readonly<Record<BandKind, string>> = {
  failure: `url(#${HATCH_FAILURE_ID})`,
  excluded: "var(--overlay-excluded)",
  injection: `url(#${HATCH_INJECTION_ID})`,
};

function hatch(id: string, fill: string, stroke: string) {
  return (
    <pattern
      id={id}
      width={6}
      height={6}
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(45)"
    >
      <rect width={6} height={6} fill={fill} />
      <line x1={0} y1={0} x2={0} y2={6} stroke={stroke} strokeWidth={1.25} />
    </pattern>
  );
}

const PATTERNS = (
  <defs>
    {hatch(HATCH_FAILURE_ID, "var(--overlay-failure)", "var(--overlay-failure-line)")}
    {hatch(HATCH_INJECTION_ID, "var(--overlay-injection)", "var(--overlay-injection-line)")}
  </defs>
);

/** The hatch patterns every band refers to; rendered once, in the first lane. */
export function RecorderPatterns() {
  return PATTERNS;
}

interface BandShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

function bandShape(entry: OverlayBand, tagged: boolean) {
  return function BandShape({ x = 0, y = 0, width = 0, height = 0 }: BandShapeProps) {
    return (
      <rect
        data-testid={tagged ? tid.recorder.band(entry.id) : undefined}
        data-band-kind={entry.kind}
        x={x}
        y={y}
        width={width}
        height={height}
        fill={BAND_FILL[entry.kind]}
      >
        <title>{entry.title}</title>
      </rect>
    );
  };
}

function markerShape(marker: OverlayMarkerLine, tagged: boolean) {
  return function MarkerShape(props: SVGProps<SVGLineElement>) {
    return (
      <line {...props} data-testid={tagged ? tid.recorder.marker(marker.id) : undefined}>
        <title>{marker.title}</title>
      </line>
    );
  };
}

export interface OverlayBandsProps {
  model: OverlayModel;
  /** True in one lane only, so each band's and marker's test id is unique on the page. */
  tagged: boolean;
}

/** The bands and marker lines of one lane; a child of the lane's chart. */
export const OverlayBands = memo(function OverlayBands({ model, tagged }: OverlayBandsProps) {
  return (
    <>
      {model.bands.map((entry) => (
        <ReferenceArea
          key={entry.id}
          x1={entry.from}
          x2={entry.to}
          ifOverflow="hidden"
          shape={bandShape(entry, tagged)}
        />
      ))}
      {model.markers.map((marker) => (
        <ReferenceLine
          key={marker.id}
          x={marker.at}
          stroke="var(--overlay-marker)"
          strokeDasharray="4 3"
          ifOverflow="hidden"
          shape={markerShape(marker, tagged)}
        />
      ))}
    </>
  );
});

const LEGEND = (
  <ul
    aria-label="Reference windows"
    className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
  >
    <li className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="hatch size-3 rounded-[2px] bg-overlay-failure hatch-overlay-failure-line"
      />
      Dataset failure
    </li>
    <li className="flex items-center gap-1.5">
      <span aria-hidden="true" className="size-3 rounded-[2px] border bg-overlay-excluded" />
      Excluded
    </li>
    <li className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="hatch size-3 rounded-[2px] bg-overlay-injection hatch-overlay-injection-line"
      />
      Injected fault
    </li>
    <li className="flex items-center gap-1.5">
      <span aria-hidden="true" className="w-3 border-t border-dashed border-overlay-marker" />
      Jump
    </li>
  </ul>
);

/** The legend row under the time axis. */
export function OverlayLegend() {
  return LEGEND;
}
