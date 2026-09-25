// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Precision and recall per fault, and the two aggregates.
//
//   precision_f = TP_f / (TP_f + FP_f)
//   recall_f    = detected windows accepting f / windows accepting f
//
// The two counters live on different objects on purpose. Precision is about
// tickets — a ticket is attributed to the fault it named when it opened, which
// is why a misdiagnosis is a false positive for *its* fault and not for the
// one it should have named. Recall is about windows — a window is detected or
// it is not, whatever the backend named it, and a window accepting two faults
// is one recall opportunity for each of them.
//
// Zero denominators are `null`, never 0 and never NaN: "no tickets for this
// fault" and "precision 0" are different findings, and a report that prints
// them the same way hides a degenerate run behind a number.

import type { FaultScore, Level, MatchResult, PrecisionRecall } from "./types.ts";

export type { FaultScore, MacroScore, PrecisionRecall } from "./types.ts";

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Every fault the scores are reported for: the ones tickets named and the ones windows accept.
 *
 * A fault nobody ever named still appears, with `tp = 0` and a recall of 0, because "the
 * backend never says air leak" is exactly what a per-fault table must show. Sorting keeps two
 * runs of the same data byte-identical in the report.
 */
function faultIds(match: MatchResult): string[] {
  const ids = new Set<string>();
  for (const { ticket } of match.tp) ids.add(ticket.faultAtOpen);
  for (const ticket of match.fp) ids.add(ticket.faultAtOpen);
  for (const window of match.windows) {
    if (window.benign) continue;
    for (const fault of window.accepted) ids.add(fault);
  }
  return [...ids].sort();
}

/**
 * Precision and recall per fault, micro and macro, from a classification.
 *
 * `micro` pools the counters: `tp` and `fp` are the per-fault sums, and `fn` counts *windows*
 * rather than (window, fault) pairs, so `micro.tp + micro.fn` is the number of scored windows
 * and the micro recall is the fraction of failures that were detected. Summing the per-fault
 * `fn` instead would count a window accepting two faults twice and read as a worse recall
 * than the run had.
 *
 * @throws TypeError when `level` contradicts the level the match was built at; the two must
 * agree, because the classification itself depends on which tickets participate.
 */
export function precisionRecall(match: MatchResult, level: Level): PrecisionRecall {
  if (match.level !== level) {
    throw new TypeError(`match was scored at ${match.level} level, not at ${level} level`);
  }

  const detected = new Set(match.tp.map(({ window }) => window.id));
  const perFault: Record<string, FaultScore> = {};

  for (const fault of faultIds(match)) {
    const tp = match.tp.filter(({ ticket }) => ticket.faultAtOpen === fault).length;
    const fp = match.fp.filter((ticket) => ticket.faultAtOpen === fault).length;
    const windows = match.windows.filter(
      (window) => !window.benign && window.accepted.includes(fault),
    );
    const found = windows.filter((window) => detected.has(window.id)).length;
    perFault[fault] = {
      tp,
      fp,
      fn: windows.length - found,
      windows: windows.length,
      precision: ratio(tp, tp + fp),
      recall: ratio(found, windows.length),
    };
  }

  const scores = Object.values(perFault);
  const scored = match.windows.filter((window) => !window.benign).length;
  const micro: FaultScore = {
    tp: match.tp.length,
    fp: match.fp.length,
    fn: match.fn.length,
    windows: scored,
    precision: ratio(match.tp.length, match.tp.length + match.fp.length),
    recall: ratio(match.tp.length, scored),
  };

  const precisions = scores.map((score) => score.precision).filter((value) => value !== null);
  const recalls = scores.map((score) => score.recall).filter((value) => value !== null);

  return {
    level,
    perFault,
    micro,
    macro: {
      precision: mean(precisions),
      recall: mean(recalls),
      precisionFaults: precisions.length,
      recallFaults: recalls.length,
    },
  };
}
