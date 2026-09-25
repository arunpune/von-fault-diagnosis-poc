// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Ticket-to-window matching, the decision every other metric rests on
// (docs/evaluation.md, "The true-positive span").
//
// The unit of scoring is the ticket, one per episode. A decision is re-made
// every 30 sim minutes while a symptom persists, so scoring decisions would
// count one leak dozens of times; scoring only ticket-level items would hide
// the review queue, which is why the level is a parameter and every figure is
// reported twice.
//
// The seven outcomes, in the order the rules are applied to one ticket:
//
//   tp           opened in the true-positive span [spanFrom, to) of a positive
//                window, fault accepted, and it is the first such ticket for
//                that window
//   duplicates   the same, but the window already had one — listed, never a
//                false positive: one leak that produces two correct tickets is
//                an episode-merge question, not a diagnosis error
//   benign       the fault is one the scenario's ground truth calls benign —
//                never a true positive, never a false one
//   misdiagnosed inside a positive window with another non-benign fault; it is
//                also a false positive for the fault it names, and the window
//                stays missed unless a later ticket is correct
//   recovered    a window that was misdiagnosed first and diagnosed correctly
//                afterwards; the same Match object appears in `tp`
//   ignored      opened inside an excluded window (a repair, a frozen block, a
//                collapsed gap) — counted apart, never scored
//   fp           anything else
//   fn           a positive window with no true positive
//
// A failure window wins over an excluded one, the same precedence
// `labelAt` uses in `@fdp/ground-truth`, so a frozen block reaching into a
// failure does not make the failure unscoreable.
//
// Where the span opens is decided here and nowhere else (`spanFrom`, the
// credited span): the in-process runner, stack mode and the sweep's
// re-score of a stored `run.json` all classify through this module, so they
// cannot disagree about it, the binders use the same function to say where
// a bound window starts, and lead time searches its native alarm from it.

import type {
  ExcludedWindow,
  Level,
  Match,
  MatchResult,
  ScoringWindow,
  TicketRecord,
} from "./types.ts";
import { instant } from "./time.ts";

/** The fields of a window its true-positive span is read from. */
export type SpanFields = Pick<ScoringWindow, "id" | "leadFrom" | "onset" | "onsetKnown">;

export type { Match, MatchResult } from "./types.ts";

/** True when `at` falls in `[from, to)`; the boundary rule of every window in this repository. */
export function covers(from: Date, to: Date, at: Date, what: string): boolean {
  const value = instant(at, `${what} instant`);
  return instant(from, `${what} start`) <= value && value < instant(to, `${what} end`);
}

/**
 * Where a window's true-positive span opens: the credited span.
 *
 * The span opens at `leadFrom` — the precursor when the failure has one, else the window
 * start — or at the data onset when the onset is known and earlier: `min(leadFrom, onset)`.
 * A correct ticket between F3's onset (09:48:30) and its labelled start (10:00) is therefore
 * a true positive rather than a false one, and the same for F2 (23:14:56 against 23:30).
 * Nothing else moves: an onset that is only a lower bound (F1, `onsetKnown: false`) opens
 * nothing, an onset after `leadFrom` (F4's precursor, F4b's start) never makes the span
 * later, and an injected window's onset is its `leadFrom`. Lead time's native alarm is
 * searched over the same span, `[spanFrom, to)` (`firstAlarmByWindow` in `leadtime.ts`), so
 * F3's reference is its `W103` at 09:51:19; latency and the budget keep the onset.
 *
 * @throws RangeError when `leadFrom` or a known onset names no instant.
 */
export function spanFrom(window: SpanFields): Date {
  const lead = instant(window.leadFrom, `window ${window.id} lead_from`);
  if (!window.onsetKnown || window.onset === undefined) return window.leadFrom;
  return instant(window.onset, `window ${window.id} onset`) < lead ? window.onset : window.leadFrom;
}

/** True when the ticket opened inside the window's true-positive span `[spanFrom, to)`. */
function opensIn(window: ScoringWindow, ticket: TicketRecord): boolean {
  return covers(spanFrom(window), window.to, ticket.openedSimTs, `window ${window.id}`);
}

/**
 * Whether a ticket participates at this level.
 *
 * A review-level ticket is an item in the review queue; at `ticket` level it does not exist,
 * at `review` level every ticket does. Filtering here rather than after matching is what makes
 * the two levels honest: at `ticket` level a review item cannot be the window's first correct
 * ticket, so a later promoted one takes its place.
 */
function participates(ticket: TicketRecord, level: Level): boolean {
  return level === "review" || ticket.maxLevel === "ticket";
}

/**
 * The positive window a ticket is scored against, or `undefined`.
 *
 * Windows may overlap — F4's precursor window reaches into its acute one — so the choice is
 * pinned rather than left to array order: a window whose `accepted` contains the ticket's
 * fault wins, and among equals the first in the given (chronological) order. Without the
 * preference an overlap could turn a correct answer into a misdiagnosis of the neighbour.
 */
export function windowForTicket(
  windows: readonly ScoringWindow[],
  ticket: TicketRecord,
): ScoringWindow | undefined {
  let fallback: ScoringWindow | undefined;
  for (const window of windows) {
    if (!opensIn(window, ticket)) continue;
    if (window.accepted.includes(ticket.faultAtOpen)) return window;
    fallback ??= window;
  }
  return fallback;
}

/** Tickets in opening order; `ticketId` breaks ties so the classification is deterministic. */
function inOpeningOrder(tickets: readonly TicketRecord[]): TicketRecord[] {
  return [...tickets].sort((left, right) => {
    const delta =
      instant(left.openedSimTs, `ticket ${left.ticketId}`) -
      instant(right.openedSimTs, `ticket ${right.ticketId}`);
    return delta !== 0 ? delta : left.ticketId.localeCompare(right.ticketId);
  });
}

/**
 * Classifies every ticket against the scenario's windows.
 *
 * @param windows every scoring window of the scenario, benign ones included; a window with
 * `benign: true` is not a positive, so it is never missed and never detected.
 * @param excluded the windows whose tickets are ignored rather than scored.
 * @param tickets the scenario's tickets, in any order.
 * @param benign the fault ids the scenario's ground truth calls benign.
 * @param level the level to score at; `review` (every ticket participates) by default,
 * because that is the wider of the two and the one a caller who forgets means.
 */
export function matchTickets(
  windows: readonly ScoringWindow[],
  excluded: readonly ExcludedWindow[],
  tickets: readonly TicketRecord[],
  benign: ReadonlySet<string>,
  level: Level = "review",
): MatchResult {
  const positives = windows.filter((window) => !window.benign);
  const tp: Match[] = [];
  const fp: TicketRecord[] = [];
  const misdiagnosed: Match[] = [];
  const recovered: Match[] = [];
  const duplicates: Match[] = [];
  const ignored: TicketRecord[] = [];
  const benignTickets: TicketRecord[] = [];

  const detected = new Set<string>();
  const misdiagnosedWindows = new Set<string>();

  for (const ticket of inOpeningOrder(tickets)) {
    if (!participates(ticket, level)) continue;
    const window = windowForTicket(positives, ticket);

    if (window !== undefined) {
      if (window.accepted.includes(ticket.faultAtOpen)) {
        const match: Match = { window, ticket };
        if (detected.has(window.id)) {
          duplicates.push(match);
        } else {
          detected.add(window.id);
          tp.push(match);
          if (misdiagnosedWindows.has(window.id)) recovered.push(match);
        }
      } else if (benign.has(ticket.faultAtOpen)) {
        benignTickets.push(ticket);
      } else {
        misdiagnosed.push({ window, ticket });
        misdiagnosedWindows.add(window.id);
        fp.push(ticket);
      }
      continue;
    }

    if (excluded.some((span) => covers(span.from, span.to, ticket.openedSimTs, span.id))) {
      ignored.push(ticket);
    } else if (benign.has(ticket.faultAtOpen)) {
      benignTickets.push(ticket);
    } else {
      fp.push(ticket);
    }
  }

  return {
    level,
    windows,
    tp,
    fp,
    misdiagnosed,
    recovered,
    duplicates,
    ignored,
    benign: benignTickets,
    fn: positives.filter((window) => !detected.has(window.id)),
  };
}

/**
 * One match result over the tickets and windows of several scenarios.
 *
 * Run-level precision, recall and the MetroPT-3 check are the per-scenario classifications
 * pooled, not re-derived, so a scenario that was scored with its own warmup and its own
 * benign set keeps that judgement when it enters the run summary.
 *
 * @throws TypeError when the results were not all scored at the same level, which would
 * silently mix a review-level recall with a ticket-level precision.
 */
export function mergeMatches(results: readonly MatchResult[], level: Level): MatchResult {
  for (const result of results) {
    if (result.level !== level) {
      throw new TypeError(`cannot merge a ${result.level}-level match into a ${level}-level one`);
    }
  }
  return {
    level,
    windows: results.flatMap((result) => result.windows),
    tp: results.flatMap((result) => result.tp),
    fp: results.flatMap((result) => result.fp),
    misdiagnosed: results.flatMap((result) => result.misdiagnosed),
    recovered: results.flatMap((result) => result.recovered),
    duplicates: results.flatMap((result) => result.duplicates),
    ignored: results.flatMap((result) => result.ignored),
    benign: results.flatMap((result) => result.benign),
    fn: results.flatMap((result) => result.fn),
  };
}
