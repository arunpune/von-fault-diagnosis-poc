// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The reference windows the recorder draws across its lanes: the dataset's failure windows, the
// windows excluded from scoring and the unlabelled episodes, the injected-fault intervals and the
// replay markers. All of them come from the backend's read-only overlay endpoints; the UI draws
// them and reads them for nothing else (see the isolation section of docs/architecture.md).
//
// The model is built once per axis and clipped to it, so each lane only draws what is visible
// and a lane whose axis did not move receives the very same object.

import { useMemo } from "react";

import { useOverlayCatalog, useOverlayInjections, useOverlayMarkers } from "@/api/queries";
import type {
  InjectionInterval,
  OverlayCatalog,
  OverlayMarker,
  RunningInstance,
} from "@/api/types";
import { humanize } from "@/lib/format";
import { fmtSim, parseIso } from "@/lib/time";
import { useActiveInjections } from "@/store/live-store";
import type { RecorderAxis } from "@/store/telemetry-store";

export type BandKind = "failure" | "excluded" | "injection";

/** One reference window, clipped to the axis. */
export interface OverlayBand {
  readonly id: string;
  readonly kind: BandKind;
  readonly from: number;
  readonly to: number;
  /** What the band is, for its native tooltip. */
  readonly title: string;
}

/** One replay marker: a dashed line where data time jumped to. */
export interface OverlayMarkerLine {
  readonly id: string;
  readonly at: number;
  readonly title: string;
}

export interface OverlayModel {
  readonly bands: readonly OverlayBand[];
  readonly markers: readonly OverlayMarkerLine[];
}

const DAY_MS = 86_400_000;

const MARKER_WORDS: Readonly<Record<string, string>> = {
  jump: "Jump",
  reset: "Reset",
  loop: "Loop",
};

/**
 * The whole sim days around `now` that hold any window ending at `now` (24 h at most), so the
 * list queries change key once a sim day instead of at every flush.
 */
export function listRange(now: number): { from: number; to: number } {
  const day = Math.floor(now / DAY_MS) * DAY_MS;
  return { from: day - DAY_MS, to: day + DAY_MS };
}

interface OverlaySources {
  catalog: OverlayCatalog | undefined;
  intervals: readonly InjectionInterval[];
  active: readonly RunningInstance[];
  markers: readonly OverlayMarker[];
}

function band(id: string, kind: BandKind, from: string, to: string | null, title: string) {
  return { id, kind, from: parseIso(from), to: to === null ? Infinity : parseIso(to), title };
}

function datasetBands(catalog: OverlayCatalog | undefined): OverlayBand[] {
  if (catalog === undefined) {
    return [];
  }
  const { failures, excluded_windows: excluded, unlabelled_episodes: episodes } = catalog.failures;
  const bands: OverlayBand[] = failures.map((failure) =>
    band(failure.id, "failure", failure.start, failure.end, `Dataset failure ${failure.id}`),
  );
  const seen = new Set<string>();
  const light = [
    ...excluded.map((window) =>
      band(
        `excluded-${window.from}`,
        "excluded",
        window.from,
        window.to,
        `Excluded: ${humanize(window.reason)}`,
      ),
    ),
    ...episodes.map((episode) =>
      band(
        `unlabelled-${episode.start}`,
        "excluded",
        episode.start,
        episode.end,
        "Unlabelled episode",
      ),
    ),
  ];
  // An unlabelled episode is usually also an excluded window: draw each span once.
  for (const entry of light) {
    const span = `${entry.from}-${entry.to}`;
    if (!seen.has(span)) {
      seen.add(span);
      bands.push(entry);
    }
  }
  return bands;
}

function injectionBands(sources: OverlaySources): OverlayBand[] {
  const labels = new Map(
    (sources.catalog?.injections ?? []).map((entry) => [entry.injection_id, entry.label]),
  );
  const title = (injectionId: string): string =>
    `Injected fault: ${labels.get(injectionId) ?? humanize(injectionId)}`;
  const byInstance = new Map<string, OverlayBand>();
  for (const interval of sources.intervals) {
    byInstance.set(
      interval.instance_id,
      band(
        interval.instance_id,
        "injection",
        interval.start_sim_ts,
        interval.end_sim_ts,
        title(interval.injection_id),
      ),
    );
  }
  // What runs right now wins over the stored row, which may not have caught up yet.
  for (const running of sources.active) {
    byInstance.set(
      running.instance_id,
      band(
        running.instance_id,
        "injection",
        running.started_sim_ts,
        running.ends_sim_ts,
        title(running.injection_id),
      ),
    );
  }
  return [...byInstance.values()];
}

/**
 * One line per kind and target instant. The backend keeps every marker, so a replay that jumped to
 * the same preset twice holds two identical ones; they are drawn once, under one test id.
 */
function markerLines(markers: readonly OverlayMarker[]): OverlayMarkerLine[] {
  const lines = new Map<string, OverlayMarkerLine>();
  for (const marker of markers) {
    const id = `${marker.kind}-${marker.sim_ts_to}`;
    if (!lines.has(id)) {
      lines.set(id, {
        id,
        at: parseIso(marker.sim_ts_to),
        title: `${MARKER_WORDS[marker.kind] ?? humanize(marker.kind)} to ${fmtSim(marker.sim_ts_to)}`,
      });
    }
  }
  return [...lines.values()];
}

/** Every band and marker of the sources that shows inside the axis, clipped to it. */
export function buildOverlayModel(sources: OverlaySources, axis: RecorderAxis): OverlayModel {
  const bands: OverlayBand[] = [];
  for (const entry of [...datasetBands(sources.catalog), ...injectionBands(sources)]) {
    const from = Math.max(entry.from, axis.from);
    const to = Math.min(entry.to, axis.to);
    if (from < to) {
      bands.push({ ...entry, from, to });
    }
  }
  const markers = markerLines(sources.markers).filter(
    (marker) => marker.at >= axis.from && marker.at <= axis.to,
  );
  return { bands, markers };
}

/** The reference windows of the current axis, or null while the switch is off. */
export function useOverlayModel(axis: RecorderAxis, enabled: boolean): OverlayModel | null {
  const range = listRange(axis.to);
  const catalog = useOverlayCatalog().data;
  const intervals = useOverlayInjections(range.from, range.to).data?.items;
  const markers = useOverlayMarkers(range.from, range.to).data?.items;
  const active = useActiveInjections();
  return useMemo(
    () =>
      enabled
        ? buildOverlayModel(
            { catalog, intervals: intervals ?? [], active, markers: markers ?? [] },
            axis,
          )
        : null,
    [enabled, catalog, intervals, active, markers, axis],
  );
}
