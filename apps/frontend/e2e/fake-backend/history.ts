// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What the fake has replayed so far, as stretches of data time (`Segment`s). A jump or a reset
// starts a new stretch and forgets anything recorded at or after its start, so the timeline never
// overlaps itself; a played sample extends the current stretch. `GET /api/telemetry/series` is
// answered from here by regenerating the samples of the requested window — the waveform is a pure
// function of time and conditions, so the history equals what was streamed — and downsampling
// them the way the backend does.

import { signalOf } from "./data.ts";
import { decimateTrack, type Reading } from "./decimate.ts";
import {
  readingsAt,
  sampleValues,
  SAMPLE_INTERVAL_MS,
  type Conditions,
  type InjectionRun,
} from "./waveform.ts";

import type { SeriesEntry } from "@/api/types";

/** One uninterrupted stretch of replayed data time and what was wrong with the unit in it. */
export interface Segment extends Conditions {
  readonly fromMs: number;
  /** The newest sample of the stretch; below `fromMs` while it holds none. */
  toMs: number;
  readonly injections: InjectionRun[];
}

export interface SeriesQuery {
  /** Tag ids of the register map, in the order the answer keeps. */
  readonly tags: readonly string[];
  readonly fromMs: number;
  readonly toMs: number;
  /** At most this many points per tag. */
  readonly points: number;
}

export interface SeriesAnswer {
  readonly series: SeriesEntry[];
  /** Every instant inside the window where data time jumped, ascending. */
  readonly discontinuities: string[];
}

export interface History {
  /** Start a new stretch at `fromMs`, forgetting everything recorded at or after it. */
  begin(fromMs: number, leakSinceMs: number | null): Segment;
  /** The stretch being played. */
  current(): Segment;
  /** Record that the current stretch now reaches `instantMs`. */
  extend(instantMs: number): void;
  series(query: SeriesQuery): SeriesAnswer;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** The first sample instant at or after `ms` (samples sit on the 10 s grid of epoch time). */
function gridCeil(ms: number): number {
  return Math.ceil(ms / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS;
}

export function createHistory(firstMs: number, seed: number): History {
  const segments: Segment[] = [];

  function begin(fromMs: number, leakSinceMs: number | null): Segment {
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      if (segment === undefined) {
        continue;
      }
      if (segment.fromMs >= fromMs) {
        segments.splice(index, 1);
      } else if (segment.toMs >= fromMs) {
        segment.toMs = fromMs - SAMPLE_INTERVAL_MS;
      }
    }
    const segment: Segment = { fromMs, toMs: fromMs - 1, leakSinceMs, injections: [] };
    segments.push(segment);
    return segment;
  }

  begin(firstMs, null);

  function current(): Segment {
    const segment = segments.at(-1);
    if (segment === undefined) {
      throw new Error("the history holds no segment");
    }
    return segment;
  }

  function series(query: SeriesQuery): SeriesAnswer {
    const readings = new Map<string, Reading[]>(query.tags.map((tag) => [tag, []]));
    const discontinuities: string[] = [];
    const ordered = [...segments].sort((a, b) => a.fromMs - b.fromMs);
    ordered.forEach((segment, index) => {
      if (segment.toMs < segment.fromMs) {
        return;
      }
      if (index > 0 && segment.fromMs >= query.fromMs && segment.fromMs <= query.toMs) {
        discontinuities.push(isoOf(segment.fromMs));
      }
      const until = Math.min(query.toMs, segment.toMs);
      for (
        let ms = gridCeil(Math.max(query.fromMs, segment.fromMs));
        ms <= until;
        ms += SAMPLE_INTERVAL_MS
      ) {
        const values = sampleValues(readingsAt(ms, segment, seed));
        const iso = isoOf(ms);
        for (const [tag, track] of readings) {
          const value = values[tag];
          if (value !== undefined) {
            track.push({ ms, iso, value: Number(value) });
          }
        }
      }
    });

    const entries = query.tags.map((tag): SeriesEntry => {
      const signal = signalOf(tag);
      const kind = signal?.kind ?? "analog";
      return {
        tag,
        kind,
        unit: signal?.unit ?? "",
        points: decimateTrack(readings.get(tag) ?? [], kind === "digital", query.points),
      };
    });
    return { series: entries, discontinuities };
  }

  return {
    begin,
    current,
    extend(instantMs: number): void {
      const segment = current();
      segment.toMs = Math.max(segment.toMs, instantMs);
    },
    series,
  };
}
