// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The MetroPT-3 check: were the four headline failures found?
//
// It is the headline number and the one that most deserves its caveat. The
// detection rules and thresholds were designed after inspecting F1–F4, so this
// check measures the data it was tuned on. The label is permanent rather than a
// footnote: the result carries `in_sample: true`, every report prints it, and
// no run can quote 4/4 without it. The honest out-of-sample figures are the
// injected faults and the negatives, which nobody looked at while writing the
// rules.
//
// The level is the phase's, not the check's. The Von phase asks for a true
// positive at ticket level (E4), and `metropt3Check` answers it, and the review
// level beside it. The rules-only phase (detection-level E3) asks for detection
// instead: a suspect event in each failure's credited span within its budget,
// which `metropt3DetectionCheck` reads from the per-window detections. The
// rules backend's review-level check stays computed and reported as a baseline.

import type { Level, MatchResult, Metropt3Check, ScoringWindow, WindowDetection } from "./types.ts";

export type { Metropt3Check } from "./types.ts";

/**
 * Whether every headline failure was detected at `level`.
 *
 * @param headlineWindows the windows the check is over — the caller passes the headline ones,
 * and a window with `headline: false` is dropped here so a run that hands over every window
 * still measures the four failures and not the secondary positives.
 * @param match the classification at `level`.
 * @param level the level the phase requires.
 * @returns the detected and missed window ids, sorted, and the pass flag. A check over no
 * windows does not pass: a run that replayed nothing has not found the headline failures.
 * @throws TypeError when `level` contradicts the level the match was built at.
 */
export function metropt3Check(
  headlineWindows: readonly ScoringWindow[],
  match: MatchResult,
  level: Level,
): Metropt3Check {
  if (match.level !== level) {
    throw new TypeError(`match was scored at ${match.level} level, not at ${level} level`);
  }

  const wanted = headlineWindows.filter((window) => window.headline && !window.benign);
  const found = new Set(match.tp.map(({ window }) => window.id));
  const detected = wanted.filter((window) => found.has(window.id)).map((window) => window.id);
  const missed = wanted.filter((window) => !found.has(window.id)).map((window) => window.id);

  return {
    level,
    detected: [...new Set(detected)].sort(),
    missed: [...new Set(missed)].sort(),
    pass: wanted.length > 0 && missed.length === 0,
    in_sample: true,
  };
}

/**
 * Whether every headline failure was detected at detection level: a suspect event in its
 * credited span within its scenario's budget.
 *
 * @param detections the per-window detections of the scenarios the check is over; a window that
 * is not a headline one is dropped here, as `metropt3Check` drops it. A failure several scenarios
 * bind is detected when any of them detected it.
 * @returns the detected and missed failure ids, sorted, and the pass flag; a check over no
 * headline window does not pass.
 */
export function metropt3DetectionCheck(detections: readonly WindowDetection[]): Metropt3Check {
  const wanted = detections.filter((entry) => entry.headline);
  const found = new Set(wanted.filter((entry) => entry.detected).map((entry) => entry.windowId));
  const ids = [...new Set(wanted.map((entry) => entry.windowId))].sort();
  const missed = ids.filter((id) => !found.has(id));
  return {
    level: "detection",
    detected: [...found].sort(),
    missed,
    pass: ids.length > 0 && missed.length === 0,
    in_sample: true,
  };
}
