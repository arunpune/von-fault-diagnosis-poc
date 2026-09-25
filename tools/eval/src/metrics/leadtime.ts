// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Lead time against the native alarm, and detection latency against the data
// onset (docs/evaluation.md, "Lead time against the unit's own alarms").
//
//   leadMinutes    = native_alarm_first − first_correct_ticket
//   latencyMinutes = first_correct_ticket − data_onset
//
// The sign of the first one is the whole point: positive means the system
// named the fault *before* the controller raised its warning, which is the
// claim the README makes. It is therefore written as "native minus ticket",
// never the other way round, and never rounded.
//
// Two native references are reported side by side. `nativeFirst` is the first
// activation of a scenario's `native_alarm_codes` computed by the CTRL-7 port,
// which is what makes the metric meaningful for signature-A leaks; they never
// trip the LPS switch, so the ground truth's own `native_alarm_first` (LPS) is
// reported beside it and is simply absent for three of the four headline
// failures.
//
// `nativeFirst` is searched over the same stretch a ticket is credited in,
// `[spanFrom, to)`, the credited span: a window whose known onset precedes
// `leadFrom` — F2, F3 — would otherwise credit a ticket against a later
// activation, or none, and overstate the lead. Latency keeps the onset; the LPS
// reference is the failure table's and does not move.
//
// F1's onset is a lower bound — the logger was frozen through the lead-in — so
// its latency carries the qualifier `>=`. A latency printed without it would
// claim a precision the recording does not have.

import type { LeadTime, Match, MatchResult, ScoringWindow } from "./types.ts";
import { spanFrom } from "./match.ts";
import { minutesBetween } from "./time.ts";

export type { LeadTime } from "./types.ts";

/** The first activation of a scenario's native alarm codes inside a window, per window id. */
export type AlarmFirstByWindow = ReadonlyMap<string, { code: string; simTs: Date } | null>;

/** The ground truth's own LPS activation per window id, when it overrides `nativeLpsFirst`. */
export type LpsFirstByWindow = ReadonlyMap<string, Date | null>;

/** The instant latency is measured from: the data onset, or the window start when unlabelled. */
function onsetOf(window: ScoringWindow): Date {
  return window.onset ?? window.from;
}

function lpsOf(window: ScoringWindow, overrides?: LpsFirstByWindow): Date | undefined {
  const override = overrides?.get(window.id);
  if (override !== undefined) return override ?? undefined;
  return window.nativeLpsFirst;
}

function leadTime(match: Match, alarms: AlarmFirstByWindow, lps?: LpsFirstByWindow): LeadTime {
  const { window, ticket } = match;
  const opened = ticket.openedSimTs;
  const native = alarms.get(window.id) ?? undefined;
  const lpsFirst = lpsOf(window, lps);

  return {
    windowId: window.id,
    fault: ticket.faultAtOpen,
    firstCorrectTicket: opened,
    ...(native === undefined
      ? {}
      : {
          nativeCode: native.code,
          nativeFirst: native.simTs,
          leadMinutes: minutesBetween(opened, native.simTs),
        }),
    ...(lpsFirst === undefined
      ? {}
      : { lpsFirst, lpsLeadMinutes: minutesBetween(opened, lpsFirst) }),
    latencyMinutes: minutesBetween(onsetOf(window), opened),
    qualifier: window.onsetKnown ? "" : ">=",
  };
}

/**
 * One row per detected window, in the order the windows were matched.
 *
 * Only windows with a true positive appear: a lead time over a window nobody detected would
 * be an arbitrary number, and the miss is already reported as a false negative.
 *
 * @param match the classification the rows are read from; its `tp` list holds one first
 * correct ticket per window by construction.
 * @param alarmFirstByWindow the CTRL-7 reference per window id; a `null` or a missing entry
 * means no native alarm fired inside the window, and the row carries no lead time.
 * @param lpsFirstByWindow overrides the windows' own `nativeLpsFirst`, for stack mode, where
 * the LPS activation is read from `app.native_alarms` rather than from the failure table.
 */
export function leadTimes(
  match: MatchResult,
  alarmFirstByWindow: AlarmFirstByWindow,
  lpsFirstByWindow?: LpsFirstByWindow,
): LeadTime[] {
  return match.tp.map((entry) => leadTime(entry, alarmFirstByWindow, lpsFirstByWindow));
}

/**
 * The first activation of any of `codes` inside `[spanFrom, to)` of each window.
 *
 * It is the bridge between the alarm log a run records and the map `leadTimes` reads. An
 * empty `codes` list means "every code that fired", which is what a scenario without an
 * explicit `native_alarm_codes` asks for once the runner has applied the default.
 *
 * The search opens where the window's true-positive span opens (`spanFrom` in `match.ts`), so a
 * ticket credited in `[onset, leadFrom)` is measured against the controller's first warning in
 * that same stretch: F3's `W103` at 09:51:19 rather than the first activation after 10:00. Where
 * the span opens at `leadFrom` — F1's onset is a lower bound, F4's precursor is earlier than its
 * onset, F4b's onset is after its start, an injection's onset is its `leadFrom` — the search is
 * where it always was.
 */
export function firstAlarmByWindow(
  windows: readonly ScoringWindow[],
  alarms: readonly { code: string; simTs: Date }[],
  codes: readonly string[] = [],
): Map<string, { code: string; simTs: Date } | null> {
  const wanted = new Set(codes);
  const byWindow = new Map<string, { code: string; simTs: Date } | null>();

  for (const window of windows) {
    const opens = spanFrom(window).getTime();
    const inside = alarms
      .filter(
        (alarm) =>
          (wanted.size === 0 || wanted.has(alarm.code)) &&
          opens <= alarm.simTs.getTime() &&
          alarm.simTs.getTime() < window.to.getTime(),
      )
      .sort((left, right) => left.simTs.getTime() - right.simTs.getTime());
    byWindow.set(window.id, inside[0] ?? null);
  }
  return byWindow;
}
