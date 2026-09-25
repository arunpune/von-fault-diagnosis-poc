// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The `full` profile's two additions to a run (E6): calendar-month progress
// while the whole MetroPT-3 recording streams through the pipeline, and the
// summary of that recording beside the per-scenario figures.
//
// **One stream, one pipeline, months as checkpoints.** `metropt3_full`
// (`source.kind = csv`) streams `METROPT_CSV` from 1 February to 1 September
// through the same host as every other scenario. The range is cut into
// calendar months, but only for bookkeeping: the months run sequentially
// through the *one* pipeline and the *one* replay source, so an episode that
// is open at midnight on the last day of a month is still open on the first
// of the next, and a CTRL-7 delay timer running across the boundary keeps
// running. Nothing is re-started at a month boundary, so no boundary is a
// forced discontinuity and the metrics are those of an uncut replay. Each month
// closes with one log line — samples and samples per second — which is the
// progress a user watches during the minute or so the whole recording takes
// and the throughput figure. A parallel split (one pipeline per month in worker
// threads, `--jobs > 1`) is not built: the loop measured 27,000 samples/s over
// the whole file, eighteen times the 1,500 the profile needs, so `--jobs`
// stays at 1.
//
// **The recording's own summary.** The run summary pools every scenario of a
// backend, so in a `full` run it mixes the fixture slices of F1–F4 with the
// whole-recording windows of the same four failures. E6 reads the recording
// alone: the MetroPT-3 check over its headline windows at ticket level (the
// E6 pass line) and at review level, false tickets per machine-day over its
// negative time (about 168 machine-days by the first estimate; the binder's
// excluded windows put it lower), and the detections that fell inside the
// failure table's unlabelled episodes, listed apart because they are never
// false positives. `fullRecordingSummary` reads exactly that from every pair whose
// scenario is bound to `ground_truth.kind = recording`.

import { performance } from "node:perf_hooks";

import type { Logger } from "../log.ts";
import { metropt3Check } from "../metrics/index.ts";
import type { FullRecordingResult, ScenarioResult, UnlabelledDetection } from "./types.ts";

export type { FullRecordingResult, UnlabelledDetection } from "./types.ts";

/** The excluded-window reason of an unlabelled positive episode of the failure table. */
export const UNLABELLED_REASON = "unlabelled_positive";

/** One calendar month of a replayed range, clipped to the range. */
export interface MonthChunk {
  /** `YYYY-MM`, UTC. */
  readonly month: string;
  readonly from: Date;
  readonly to: Date;
}

/** What one month of the stream took. */
export interface MonthProgress {
  readonly month: string;
  readonly samples: number;
  readonly wallMs: number;
  /** Samples per real second; `null` when the month took no measurable time. */
  readonly samplesPerS: number | null;
}

/** What a batch tells the progress tracker: the sim time it reached and how many samples it held. */
export interface BatchProgress {
  readonly simTs: string;
  readonly samples: number;
}

/** The first instant of the UTC month after the one `at` falls in. */
function nextMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

function monthLabel(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/**
 * The calendar months `[from, to)` spans, each clipped to the range.
 *
 * @throws RangeError when the range is empty or names no instant.
 */
export function monthChunks(range: { readonly from: Date; readonly to: Date }): MonthChunk[] {
  const fromMs = range.from.getTime();
  const toMs = range.to.getTime();
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) {
    throw new RangeError(
      `monthChunks: ${String(range.from)} → ${String(range.to)} is not a non-empty range`,
    );
  }
  const chunks: MonthChunk[] = [];
  let start = new Date(fromMs);
  while (start.getTime() < toMs) {
    const end = new Date(Math.min(nextMonth(start).getTime(), toMs));
    chunks.push({ month: monthLabel(start), from: start, to: end });
    start = end;
  }
  return chunks;
}

/** What the month tracker reaches for. */
export interface MonthProgressOptions {
  readonly log: Logger;
  /** Context repeated on every line, typically the scenario and the backend. */
  readonly fields?: Readonly<Record<string, string>>;
  /** A monotonic millisecond timer; `performance.now` by default. */
  readonly elapsedMs?: () => number;
}

/** The month tracker: feed it every pushed batch, then `finish()` once the stream has ended. */
export interface MonthTracker {
  onBatch(progress: BatchProgress): void;
  /** Closes the month still open and returns every month that received a sample. */
  finish(): MonthProgress[];
}

/**
 * Tracks a stream through its calendar months and logs one line as each one closes.
 *
 * A batch is counted in the month its last sample falls in; a month the stream skipped (a gap
 * longer than a month does not exist in MetroPT-3, but a caller may replay any range) closes
 * with no line.
 */
export function createMonthTracker(
  range: { readonly from: Date; readonly to: Date },
  options: MonthProgressOptions,
): MonthTracker {
  const chunks = monthChunks(range);
  const elapsedMs = options.elapsedMs ?? (() => performance.now());
  const done: MonthProgress[] = [];
  let index = 0;
  let samples = 0;
  let startedMs = elapsedMs();

  const close = (): void => {
    const chunk = chunks[index];
    if (chunk === undefined) return;
    if (samples > 0) {
      const wallMs = elapsedMs() - startedMs;
      const progress: MonthProgress = {
        month: chunk.month,
        samples,
        wallMs,
        samplesPerS: wallMs > 0 ? (samples * 1000) / wallMs : null,
      };
      done.push(progress);
      options.log.info("month", {
        ...options.fields,
        month: progress.month,
        samples: progress.samples,
        samples_per_s: progress.samplesPerS === null ? null : Math.round(progress.samplesPerS),
      });
    }
    index += 1;
    samples = 0;
    startedMs = elapsedMs();
  };

  /** The end of the month being counted; past the last one, nothing ends. */
  const currentEnd = (): number => chunks[index]?.to.getTime() ?? Number.POSITIVE_INFINITY;

  return {
    onBatch(progress: BatchProgress): void {
      const at = Date.parse(progress.simTs);
      while (at >= currentEnd()) close();
      samples += progress.samples;
    },
    finish(): MonthProgress[] {
      while (index < chunks.length) close();
      return done;
    },
  };
}

// --- The recording's own summary (E6) ------------------------------------------------

function perDay(count: number, days: number): number | null {
  return days > 0 ? count / days : null;
}

/** Every ticket of the pair, the warmup's included, that opened inside an unlabelled episode. */
function unlabelledDetections(result: ScenarioResult): UnlabelledDetection[] {
  const episodes = result.binding.excluded.filter((window) => window.reason === UNLABELLED_REASON);
  const found: UnlabelledDetection[] = [];
  for (const ticket of result.summary.tickets) {
    const at = ticket.openedSimTs.getTime();
    const episode = episodes.find(
      (window) => window.from.getTime() <= at && at < window.to.getTime(),
    );
    if (episode !== undefined) {
      found.push({ ticket, episodeFrom: episode.from, episodeTo: episode.to });
    }
  }
  return found.sort(
    (left, right) =>
      left.ticket.openedSimTs.getTime() - right.ticket.openedSimTs.getTime() ||
      left.ticket.ticketId.localeCompare(right.ticket.ticketId),
  );
}

function recordingResult(result: ScenarioResult): FullRecordingResult {
  const { metrics } = result;
  const { ticket, review } = metrics.match;
  const negative = metrics.rates.negativeMachineDays;
  return {
    scenarioId: metrics.scenarioId,
    backend: metrics.backend,
    replay: { from: result.bound.replay.from, to: result.bound.replay.to },
    metropt3: {
      ticket: metropt3Check(ticket.windows, ticket, "ticket"),
      review: metropt3Check(review.windows, review, "review"),
    },
    falseTickets: { ticket: ticket.fp.length, review: review.fp.length },
    coveredMachineDays: metrics.rates.coveredMachineDays,
    negativeMachineDays: negative,
    falseTicketsPerMachineDay: {
      ticket: perDay(ticket.fp.length, negative),
      review: perDay(review.fp.length, negative),
    },
    unlabelled: unlabelledDetections(result),
  };
}

/**
 * The E6 summary of every pair that replayed the whole recording.
 *
 * @param results every scenario and backend pair of the run.
 * @returns one entry per pair whose scenario is bound to `ground_truth.kind = recording`, in
 * the order the run replayed them; empty for a run without one (every profile but `full` and
 * `dev`).
 */
export function fullRecordingSummary(results: readonly ScenarioResult[]): FullRecordingResult[] {
  return results
    .filter((result) => result.bound.scenario.ground_truth.kind === "recording")
    .map(recordingResult);
}
