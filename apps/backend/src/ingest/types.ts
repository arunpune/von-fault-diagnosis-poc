// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The vocabulary the four ingest modules share.
 *
 * A telemetry batch is decoded exactly once, on the way in, and the ring, the
 * aggregator and the alarm tracker all read the same {@link DecodedSample}.
 * Keeping that shape here rather than in `ring.ts` is what lets the aggregator
 * and the alarm tracker be tested without a ring, and what keeps the modules
 * free of imports of each other.
 *
 * Booleans become `0` and `1` the moment a sample is decoded. The signal
 * registry already says which tag is a state and which is a measurement, so a
 * second representation of the same fact would only be a second thing to keep
 * in step.
 */

import type { Sample, Signal } from "@fdp/contracts";

/** Bit 0 of the ring's `flags` column: data time jumped before this sample. */
export const FLAG_DISCONTINUITY = 1;

/** Bit 1 of the ring's `flags` column: at least one source column was unreadable. */
export const FLAG_MISSING = 2;

/** How a signal is charted and folded: a measurement, or a state. */
export type SignalKind = "analog" | "digital";

/** One telemetry sample, decoded once for every consumer of a batch. */
export interface DecodedSample {
  readonly seq: number;
  /** `sim_ts` as epoch milliseconds; the sample keeps its ISO form in `simTs`. */
  readonly simTsMs: number;
  readonly simTs: string;
  readonly discontinuity: boolean;
  readonly missing: boolean;
  /** One number per known tag; a digital state is `0` or `1`. */
  readonly values: Readonly<Record<string, number>>;
  /** The controller alarm codes active on this sample, as published. */
  readonly alarms: readonly string[];
  /** The same codes as a bit field, by `REGISTER_MAP.alarms[].bit`. */
  readonly alarmBits: number;
}

/**
 * One controller alarm that changed between two samples.
 *
 * `sim_ts` and `seq` are the sample that carried the change, so a row in
 * `app.native_alarms` can be lined up with the telemetry that produced it.
 */
export interface AlarmTransition {
  readonly code: string;
  readonly state: "raised" | "cleared";
  readonly sim_ts: string;
  readonly seq: number;
}

/**
 * One folded minute of one signal, in the column names of
 * `app.telemetry_agg_1m`.
 *
 * `duty` is the fraction of samples that read true and is `null` for an analog
 * signal; `min`, `max`, `avg` and `last` are `0`/`1` statistics for a digital
 * one, so a reader needs no special case.
 */
export interface AggregateRow {
  readonly unit_id: string;
  readonly minute_sim_ts: string;
  readonly signal_id: string;
  readonly n: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly last: number;
  readonly duty: number | null;
  /** A discontinuity flag fell inside this minute, so it has no comparable neighbour. */
  readonly discontinuity: boolean;
}

/** What {@link import("./index.ts").Ingest.push} did with one batch. */
export interface IngestResult {
  readonly accepted: number;
  readonly rejected: number;
  /** At least one accepted sample carried the discontinuity flag. */
  readonly discontinuity: boolean;
  readonly alarms: readonly AlarmTransition[];
}

/** The window and the tags a series request names. */
export interface SeriesQuery {
  readonly signalIds: readonly string[];
  readonly fromMs: number;
  readonly toMs: number;
  /** At most {@link MAX_SERIES_POINTS} points per tag; the default is the cap. */
  readonly points?: number;
}

/** The `api-telemetry-series` cap: no tag ever carries more than this many points. */
export const MAX_SERIES_POINTS = 2000;

/** Whether a registry signal is charted as a measurement or as a state. */
export function signalKind(signal: Signal): SignalKind {
  return signal.group === "digital" ? "digital" : "analog";
}

/** The contracts sample this decoded one came from, rebuilt for `latest()`. */
export function toContractSample(decoded: DecodedSample, signals: readonly Signal[]): Sample {
  const values: Record<string, number | boolean> = {};
  for (const signal of signals) {
    const value = decoded.values[signal.tag];
    if (value === undefined) continue;
    values[signal.tag] = signalKind(signal) === "digital" ? value !== 0 : value;
  }
  return {
    seq: decoded.seq,
    sim_ts: decoded.simTs,
    flags: { discontinuity: decoded.discontinuity, missing: decoded.missing },
    values,
    alarms: [...decoded.alarms],
  };
}
