// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The recorder's lanes and rows, declared by the role of each signal and resolved at runtime
// against the signal registry of `GET /api/signals`: tag ids are fictional and known only
// there, so a lane names the recording column (`metropt_column`) each series comes from, and
// the synthetic ambient temperature by its tag id. A lane or row whose signals the registry
// lacks is left out and named in a muted note under the recorder.

import type { SignalDef } from "@/api/types";
import type { ChartConfig } from "@/components/ui/chart";
import { unitLabel } from "@/lib/format";
import { STATE_INPUT_COLUMNS } from "@/lib/machine-state";
import type { LaneSeriesSpec, LaneSpec, RecorderConfig } from "@/store/telemetry-store";

/** The series colour tokens of index.css. */
export type SeriesColor =
  "line-pressure" | "discharge" | "separator" | "purge" | "oil" | "ambient" | "current";

interface SeriesDef {
  /** The recording column the series comes from, or… */
  readonly column?: string;
  /** …the tag id of a synthetic signal, which has no column. */
  readonly tag?: string;
  readonly color: SeriesColor;
  /** A series the lane draws when the registry has it and simply omits otherwise. */
  readonly optional?: boolean;
}

interface LaneDef {
  /** The lane's test id and chart id: its first series' recording column. */
  readonly id: string;
  readonly title: string;
  /** Fixed Y domain: no per-frame domain scans. */
  readonly domain: readonly [number, number];
  readonly ticks: readonly number[];
  /** Muted horizontal guides, e.g. the regulation's cut-in and cut-out pressures. */
  readonly guides: readonly number[];
  /** Decimals of the lane's readouts (pressure 2, temperature 1, current 2). */
  readonly decimals: number;
  readonly series: readonly SeriesDef[];
}

/** Cut-in and cut-out of the load/unload regulation, bar. */
const REGULATION_BAR = [8.05, 10.03] as const;

const PRESSURE_DOMAIN = [-0.5, 11] as const;
const PRESSURE_TICKS = [0, 5, 10] as const;

/** The lanes, top to bottom. */
export const LANE_TABLE: readonly LaneDef[] = [
  {
    id: "TP3",
    title: "Line pressure",
    domain: PRESSURE_DOMAIN,
    ticks: PRESSURE_TICKS,
    guides: REGULATION_BAR,
    decimals: 2,
    series: [
      { column: "TP3", color: "line-pressure" },
      { column: "TP2", color: "discharge" },
    ],
  },
  {
    id: "H1",
    title: "Separator and purge",
    domain: PRESSURE_DOMAIN,
    ticks: PRESSURE_TICKS,
    guides: [],
    decimals: 2,
    series: [
      { column: "H1", color: "separator" },
      { column: "DV_pressure", color: "purge" },
    ],
  },
  {
    id: "Oil_temperature",
    title: "Oil temperature",
    domain: [0, 100],
    ticks: [0, 50, 100],
    guides: [],
    decimals: 1,
    series: [
      { column: "Oil_temperature", color: "oil" },
      { tag: "ambient_temperature", color: "ambient", optional: true },
    ],
  },
  {
    id: "Motor_current",
    title: "Motor current",
    domain: [0, 10],
    ticks: [0, 5, 10],
    guides: [],
    decimals: 2,
    series: [{ column: "Motor_current", color: "current" }],
  },
];

/** The recording columns of the two digital rows under the lanes. */
export const STRIP_COLUMNS = { lps: "LPS", towers: "Towers" } as const;

/** One series of a resolved lane: what it reads and how it is drawn and labelled. */
export interface ResolvedSeries extends LaneSeriesSpec {
  readonly label: string;
  /** A CSS colour: the series token of index.css. */
  readonly color: string;
}

export interface ResolvedLane extends LaneSpec {
  readonly title: string;
  /** The unit as it reads on screen (°C, not degC). */
  readonly unit: string;
  readonly domain: readonly [number, number];
  readonly ticks: readonly number[];
  readonly guides: readonly number[];
  readonly decimals: number;
  readonly series: readonly ResolvedSeries[];
  /** The shadcn chart config: each series key's label and colour. */
  readonly chartConfig: ChartConfig;
}

/** Which rows under the lanes can be drawn, with the digital tags they read. */
export interface ResolvedStrips {
  readonly state: boolean;
  readonly lps: string | null;
  readonly towers: string | null;
}

export interface RecorderLayout {
  readonly lanes: readonly ResolvedLane[];
  readonly strips: ResolvedStrips;
  /** The titles of the lanes and rows left out because the registry lacks their signals. */
  readonly missing: readonly string[];
  /** What the telemetry store needs to know about this layout. */
  readonly config: RecorderConfig;
}

function seriesSignal(
  def: SeriesDef,
  byColumn: ReadonlyMap<string, SignalDef>,
  byTag: ReadonlyMap<string, SignalDef>,
): SignalDef | undefined {
  if (def.column !== undefined) {
    return byColumn.get(def.column);
  }
  return def.tag === undefined ? undefined : byTag.get(def.tag);
}

function resolveLane(
  def: LaneDef,
  byColumn: ReadonlyMap<string, SignalDef>,
  byTag: ReadonlyMap<string, SignalDef>,
): ResolvedLane | null {
  const series: ResolvedSeries[] = [];
  for (const seriesDef of def.series) {
    const signal = seriesSignal(seriesDef, byColumn, byTag);
    if (signal === undefined) {
      if (seriesDef.optional === true) {
        continue;
      }
      return null;
    }
    series.push({
      key: seriesDef.column ?? signal.signal_id,
      tag: signal.signal_id,
      label: signal.label,
      color: `var(--series-${seriesDef.color})`,
    });
  }
  const first = series[0];
  const unit = first === undefined ? "" : unitLabel(byTag.get(first.tag)?.unit);
  const chartConfig: ChartConfig = Object.fromEntries(
    series.map((entry) => [entry.key, { label: entry.label, color: entry.color }]),
  );
  return {
    id: def.id,
    title: def.title,
    unit,
    domain: def.domain,
    ticks: def.ticks,
    guides: def.guides,
    decimals: def.decimals,
    series,
    chartConfig,
  };
}

/** Resolves the lane table and the rows against the signal registry. */
export function resolveLayout(signals: readonly SignalDef[]): RecorderLayout {
  const byColumn = new Map<string, SignalDef>();
  const byTag = new Map<string, SignalDef>();
  for (const signal of signals) {
    byTag.set(signal.signal_id, signal);
    if (signal.metropt_column !== null) {
      byColumn.set(signal.metropt_column, signal);
    }
  }

  const lanes: ResolvedLane[] = [];
  const missing: string[] = [];
  for (const def of LANE_TABLE) {
    const lane = resolveLane(def, byColumn, byTag);
    if (lane === null) {
      missing.push(def.title);
    } else {
      lanes.push(lane);
    }
  }

  const stateInputs = Object.values(STATE_INPUT_COLUMNS).map((column) => byColumn.get(column));
  const strips: ResolvedStrips = {
    state: stateInputs.every((signal) => signal !== undefined),
    lps: byColumn.get(STRIP_COLUMNS.lps)?.signal_id ?? null,
    towers: byColumn.get(STRIP_COLUMNS.towers)?.signal_id ?? null,
  };
  if (!strips.state) {
    missing.push("Machine state");
  }
  if (strips.lps === null) {
    missing.push("Low-pressure switch");
  }
  if (strips.towers === null) {
    missing.push("Dryer towers");
  }

  const tags = new Set<string>();
  for (const lane of lanes) {
    for (const series of lane.series) {
      tags.add(series.tag);
    }
  }
  for (const signal of stateInputs) {
    if (signal !== undefined) {
      tags.add(signal.signal_id);
    }
  }
  for (const tag of [strips.lps, strips.towers]) {
    if (tag !== null) {
      tags.add(tag);
    }
  }

  return {
    lanes,
    strips,
    missing,
    config: { signals, tags: [...tags], strips: { lps: strips.lps, towers: strips.towers } },
  };
}
