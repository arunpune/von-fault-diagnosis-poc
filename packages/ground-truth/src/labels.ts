// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The label logic of the ground truth, as pure functions over a failure table. Nothing here reads
// the file system, so the evaluation harness can run them over a table it built itself; `index.ts`
// binds them to the committed one.
//
// Every window is half-open: `start` inclusive, `end` exclusive. Instants are compared as
// canonical `iso_ts` strings, which sort in the same order as the instants they denote — same
// length, same zone, same precision — so the lookups need no date arithmetic.

import { ISO_MS_PATTERN, toIsoMs } from "@fdp/contracts";
import type { SchemaType } from "@fdp/contracts";

/** The failure-table document, `data/metropt3-failures.json`. */
export type GtFailureTable = SchemaType<"gt-failure-table">;

/** One row of the corrected failure table. */
export type GtFailure = GtFailureTable["failures"][number];

/** One window the evaluation counts neither as a positive nor as a negative. */
export type GtExcludedWindow = GtFailureTable["excluded_windows"][number];

/** Why an instant is excluded from scoring. */
export type ExclusionReason = GtExcludedWindow["reason"];

/** What the evaluation knows about one instant of the replay. */
export interface Label {
  /** The failure whose scoring window contains the instant, or `null`. */
  readonly failure_id: string | null;
  /** The cause a correct answer names, or `null` outside a failure window. */
  readonly fault_id: string | null;
  /** Every cause accepted as correct, the primary one first; empty outside a failure window. */
  readonly accepted_fault_ids: readonly string[];
  /** True when the instant counts neither as a positive nor as a negative. */
  readonly excluded: boolean;
  /** Why it is excluded, or `null`. */
  readonly reason: ExclusionReason | null;
  /** False for a secondary positive, which is reported apart from the headline metrics. */
  readonly in_headline: boolean;
}

/** One scoring window, in the form the evaluation harness iterates over. */
export interface ScoringWindow {
  readonly from: Date;
  readonly to: Date;
  readonly failure_id: string;
  readonly fault_id: string;
  readonly accepted_fault_ids: readonly string[];
}

/** Whether the secondary positives (`in_headline: false`) count as failures for this lookup. */
export interface LabelOptions {
  readonly includeSecondary?: boolean;
}

const NEGATIVE: Label = {
  failure_id: null,
  fault_id: null,
  accepted_fault_ids: [],
  excluded: false,
  reason: null,
  in_headline: false,
};

/**
 * The canonical `iso_ts` form of an instant.
 *
 * A `Date` and any string an engine can parse are accepted, so a caller may pass the shorter
 * `2020-02-02T12:00Z` form; the result is always `YYYY-MM-DDTHH:MM:SS.mmmZ`.
 *
 * @throws TypeError when the string denotes no instant.
 */
export function toInstant(simTs: string | Date): string {
  if (simTs instanceof Date) return toIsoMs(simTs);
  if (ISO_MS_PATTERN.test(simTs)) return simTs;
  const parsed = new Date(simTs);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`not an instant: ${simTs}`);
  return toIsoMs(parsed);
}

function coversFailure(failure: GtFailure, instant: string): boolean {
  return failure.start <= instant && instant < failure.end;
}

/** The failure whose scoring window contains the instant, or `undefined`. */
export function failureAt(
  table: GtFailureTable,
  simTs: string | Date,
  options: LabelOptions = {},
): GtFailure | undefined {
  const instant = toInstant(simTs);
  return table.failures.find(
    (failure) =>
      (failure.in_headline || options.includeSecondary === true) && coversFailure(failure, instant),
  );
}

/**
 * Whether the instant falls in an excluded window, and why.
 *
 * This is the raw window lookup; `labelAt` is the one that gives a failure window precedence
 * over an excluded one, so a frozen block that reaches into a failure still scores.
 */
export function isExcluded(
  table: GtFailureTable,
  simTs: string | Date,
): { excluded: boolean; reason: ExclusionReason | null } {
  const instant = toInstant(simTs);
  const window = table.excluded_windows.find(
    (candidate) => candidate.from <= instant && instant < candidate.to,
  );
  return window === undefined
    ? { excluded: false, reason: null }
    : { excluded: true, reason: window.reason };
}

/**
 * The label of one instant: failure window first, then excluded window, then the negative label.
 */
export function labelAt(
  table: GtFailureTable,
  simTs: string | Date,
  options: LabelOptions = {},
): Label {
  const instant = toInstant(simTs);
  const failure = failureAt(table, instant, options);
  if (failure !== undefined) {
    return {
      failure_id: failure.id,
      fault_id: failure.fault_id,
      accepted_fault_ids: failure.accepted_fault_ids,
      excluded: false,
      reason: null,
      in_headline: failure.in_headline,
    };
  }
  const excluded = isExcluded(table, instant);
  if (excluded.excluded) {
    return { ...NEGATIVE, excluded: true, reason: excluded.reason };
  }
  return NEGATIVE;
}

/** Every window a positive is scored in, in chronological order. */
export function scoringWindows(table: GtFailureTable, options: LabelOptions = {}): ScoringWindow[] {
  return table.failures
    .filter((failure) => failure.in_headline || options.includeSecondary === true)
    .map((failure) => ({
      from: new Date(failure.start),
      to: new Date(failure.end),
      failure_id: failure.id,
      fault_id: failure.fault_id,
      accepted_fault_ids: failure.accepted_fault_ids,
    }));
}

/**
 * The instant from which a failure's signature is measurable ahead of its window, or `null`.
 *
 * @throws Error when no failure carries that id, so a typo in an evaluation scenario fails loudly.
 */
export function precursorFrom(table: GtFailureTable, failureId: string): Date | null {
  const failure = table.failures.find((candidate) => candidate.id === failureId);
  if (failure === undefined) throw new Error(`unknown failure id: ${failureId}`);
  return failure.precursor_from === null ? null : new Date(failure.precursor_from);
}
