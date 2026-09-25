// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Detection level: the suspect events, scored against the windows.
//
// E3 was re-scoped after the E3 and E4 results had been seen: it no longer
// gates the rules backend's diagnosis, which is structurally out of reach on
// the manual's catalog, and gates what the rules layer actually does, detection
// (docs/evaluation.md). A ticket is a diagnosis; a suspect event is detection's
// own output, raised before any backend is asked. So this module reads suspect
// events, never tickets:
//
//   positive     detected when a suspect event after the warmup falls in the
//                credited span [spanFrom, to) of a positive window, at or
//                before the budget's deadline — the budget and the span are
//                exactly the ones a ticket is held to (`deadline`, `spanFrom`)
//   negative     a normal-operation case (group `negative`) raises no suspect
//                event after the warmup outside the excluded windows
//
// The abstain cases keep their ticket rule, which `summary.ts` applies. The
// thresholds do not move: the gate is still ≥ 8/10 and ≥ 5/6, and the MetroPT-3
// check still 4/4, now read here (`check.ts`).
//
// The warmup is the ticket rule's too: suspect events raised before the
// replay has run its warmup are replayed but not scored. The E3 check reads
// every suspect event of a negative on top of this, warmup included, as it
// reads every ticket of one (`evaluateE3` in the runner).

import type {
  DetectionResult,
  ExcludedWindow,
  ScenarioBinding,
  ScoringWindow,
  SuspectRecord,
  WindowDetection,
} from "./types.ts";
import { covers, spanFrom } from "./match.ts";
import { MS_PER_MINUTE, instant } from "./time.ts";

export type { DetectionResult, SuspectRecord, WindowDetection } from "./types.ts";

/** The instant the warmup ends: `replay.from` plus `warmupMin`. */
export function warmupEnd(binding: Pick<ScenarioBinding, "id" | "replay" | "warmupMin">): Date {
  return new Date(
    instant(binding.replay.from, `${binding.id} replay start`) + binding.warmupMin * MS_PER_MINUTE,
  );
}

/** The instant a scenario's budget starts: the onset, or the end of the warmup if that is later. */
function budgetStart(binding: ScenarioBinding, positives: readonly ScoringWindow[]): Date {
  const warmupEnds = warmupEnd(binding).getTime();
  const onsets = positives.map((window) =>
    instant(window.onset ?? window.from, `${binding.id} window ${window.id}`),
  );
  const onset = onsets.length === 0 ? warmupEnds : Math.min(...onsets);
  return new Date(Math.max(onset, warmupEnds));
}

/**
 * The latest instant a ticket may open, or a suspect event fall, and still be in time; `undefined`
 * when the scenario states no budget (`max(onset, replay.from + warmup) + within_min`).
 */
export function deadline(
  binding: ScenarioBinding,
  positives: readonly ScoringWindow[],
): Date | undefined {
  if (binding.expect.withinMin === undefined) return undefined;
  return new Date(
    budgetStart(binding, positives).getTime() + binding.expect.withinMin * MS_PER_MINUTE,
  );
}

/** Suspect events in time order; the event id breaks ties so the reading is deterministic. */
function inTimeOrder(suspects: readonly SuspectRecord[]): SuspectRecord[] {
  return [...suspects].sort(
    (left, right) =>
      instant(left.simTs, `suspect ${left.eventId}`) -
        instant(right.simTs, `suspect ${right.eventId}`) ||
      left.eventId.localeCompare(right.eventId),
  );
}

function inExcluded(excluded: readonly ExcludedWindow[], suspect: SuspectRecord): boolean {
  return excluded.some((span) => covers(span.from, span.to, suspect.simTs, span.id));
}

/**
 * Reads one scenario's suspect events at detection level.
 *
 * @param binding the scenario as the scorer binds it; its benign windows are never positives.
 * @param suspects every suspect event the replay raised, warmup included, in any order.
 * @returns the scored and warmup counts, the events raised outside every positive span and every
 * excluded window, and one entry per positive window with its first in-span event.
 */
export function scoreDetection(
  binding: ScenarioBinding,
  suspects: readonly SuspectRecord[],
): DetectionResult {
  const warmupEnds = warmupEnd(binding).getTime();
  const ordered = inTimeOrder(suspects);
  const scored = ordered.filter(
    (suspect) => instant(suspect.simTs, `suspect ${suspect.eventId}`) >= warmupEnds,
  );
  const positives = binding.windows.filter((window) => !window.benign);
  const by = deadline(binding, positives);

  const windows: WindowDetection[] = positives.map((window) => {
    const first = scored.find((suspect) =>
      covers(spanFrom(window), window.to, suspect.simTs, `window ${window.id}`),
    );
    const detected =
      first !== undefined && (by === undefined || first.simTs.getTime() <= by.getTime());
    return {
      windowId: window.id,
      headline: window.headline,
      ...(first === undefined ? {} : { first }),
      ...(by === undefined ? {} : { deadline: by }),
      detected,
    };
  });

  const outsideWindows = scored.filter(
    (suspect) =>
      !positives.some((window) =>
        covers(spanFrom(window), window.to, suspect.simTs, `window ${window.id}`),
      ) && !inExcluded(binding.excluded, suspect),
  ).length;

  return {
    suspects: scored.length,
    warmupSuspects: ordered.length - scored.length,
    outsideWindows,
    windows,
  };
}
