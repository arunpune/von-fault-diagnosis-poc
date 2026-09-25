// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Tickets per machine-day, and the covered time they are divided by.
//
// A rate over wall time would flatter any backend that ran while the logger
// was frozen or the compressor was off the air. Covered machine-days are the
// replayed range minus everything that is not honest machine time: sampling
// gaps longer than 60 s, frozen-logger blocks and every excluded window
// (repairs, depot depressurisations, the collapsed jump of the CI slice).
//
// The three lists overlap freely — a frozen block usually contains several
// gaps, and a repair window can sit inside one — so they are subtracted as a
// union of intervals, never summed. Summing them is the arithmetic error this
// module exists to prevent: 909 h of gaps plus 171 h of frozen blocks inside a
// 5,116 h recording would remove hours twice and turn a false-ticket rate into
// a number that cannot be compared with anything.

import type { ExcludedWindow, Interval, TicketRates, TicketRecord } from "./types.ts";
import { MS_PER_DAY, instant } from "./time.ts";

export type { TicketRates } from "./types.ts";

interface Span {
  from: number;
  to: number;
}

function span(interval: Interval, what: string): Span {
  const from = instant(interval.from, `${what} start`);
  const to = instant(interval.to, `${what} end`);
  if (to < from) throw new RangeError(`${what} ends before it starts`);
  return { from, to };
}

/**
 * The given spans clipped to `range` and merged, in chronological order.
 *
 * Merging is what makes overlapping inputs safe; touching spans (`to === from`) are merged
 * too, because two adjacent gaps are one hole in the recording.
 */
function union(range: Span, spans: readonly Span[]): Span[] {
  const clipped = spans
    .map((entry) => ({ from: Math.max(entry.from, range.from), to: Math.min(entry.to, range.to) }))
    .filter((entry) => entry.to > entry.from)
    .sort((left, right) => left.from - right.from);

  const merged: Span[] = [];
  for (const entry of clipped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && entry.from <= last.to) {
      last.to = Math.max(last.to, entry.to);
    } else {
      merged.push({ ...entry });
    }
  }
  return merged;
}

/**
 * Covered machine-days of a replayed range.
 *
 * @param range the replayed range, half-open.
 * @param gapsGt60s sampling gaps longer than 60 s.
 * @param frozenBlocks frozen-logger blocks.
 * @param excluded the windows that are neither positive nor negative.
 * @returns the range's length minus the union of the three lists, in days; never negative.
 * @throws RangeError when an interval ends before it starts or names no instant.
 */
export function coveredMachineDays(
  range: Interval,
  gapsGt60s: readonly Interval[] = [],
  frozenBlocks: readonly Interval[] = [],
  excluded: readonly ExcludedWindow[] = [],
): number {
  const bounds = span(range, "replayed range");
  const removed = union(bounds, [
    ...gapsGt60s.map((gap, index) => span(gap, `gap ${index}`)),
    ...frozenBlocks.map((block, index) => span(block, `frozen block ${index}`)),
    ...excluded.map((window) => span(window, `excluded window ${window.id}`)),
  ]);

  const uncovered = removed.reduce((total, entry) => total + (entry.to - entry.from), 0);
  return Math.max(0, bounds.to - bounds.from - uncovered) / MS_PER_DAY;
}

/**
 * Tickets per machine-day and false tickets per machine-day.
 *
 * The two rates have different denominators on purpose: every ticket is divided by the
 * covered time, but a false ticket is only meaningful over the time that was *negative* —
 * dividing it by a range that is mostly a failure window would flatter a noisy backend.
 *
 * @param tickets every ticket opened in the range, whatever it named.
 * @param fpTickets the false positives of the same range (misdiagnoses included).
 * @param coveredDays covered machine-days, from `coveredMachineDays`.
 * @param negativeDays the part of the covered time that carries no positive window.
 * @returns both rates, `null` where the denominator is zero — "no covered time" is not a
 * rate of zero.
 */
export function ticketRates(
  tickets: readonly TicketRecord[],
  fpTickets: readonly TicketRecord[],
  coveredDays: number,
  negativeDays: number,
): TicketRates {
  return {
    tickets: tickets.length,
    falseTickets: fpTickets.length,
    coveredMachineDays: coveredDays,
    negativeMachineDays: negativeDays,
    ticketsPerMachineDay: coveredDays > 0 ? tickets.length / coveredDays : null,
    falseTicketsPerMachineDay: negativeDays > 0 ? fpTickets.length / negativeDays : null,
  };
}

/**
 * The covered time of a range that carries no positive window, in days.
 *
 * It is `coveredMachineDays` with the positive windows subtracted as well, which is the
 * denominator of the false-ticket rate.
 */
export function negativeMachineDays(
  range: Interval,
  positives: readonly Interval[],
  gapsGt60s: readonly Interval[] = [],
  frozenBlocks: readonly Interval[] = [],
  excluded: readonly ExcludedWindow[] = [],
): number {
  return coveredMachineDays(range, [...gapsGt60s, ...positives], frozenBlocks, excluded);
}
