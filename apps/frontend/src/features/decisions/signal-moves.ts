// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// A catalog cause's expected signal movements as sentences, for the candidate rows of the
// decision sheet. An entry built from the manual source carries each sentence already (`text`,
// the manual's controlled vocabulary rendered by its build); an entry the extraction recovered
// from the PDF may not, and its moves are then put into words here from the signal's label, the
// direction and the phase: "Oil temperature rises while loaded."

import type { SignalMove } from "@/api/types";
import { humanize } from "@/lib/format";

const DIRECTION_WORDS: Readonly<Record<string, string>> = {
  rises: "rises",
  falls: "falls",
  high: "is high",
  low: "is low",
  unchanged: "stays unchanged",
  fluctuates: "fluctuates",
  near_zero: "is near zero",
  not_venting: "does not vent",
  on: "is on",
  off: "is off",
  stays_on: "stays on",
  stays_off: "stays off",
  toggles: "toggles",
  no_pulse: "shows no pulse",
  higher: "is higher",
  lower: "is lower",
  longer: "is longer",
  shorter: "is shorter",
  faster: "is faster",
  slower: "is slower",
  not_reached: "is not reached",
};

const PHASE_WORDS: Readonly<Record<string, string>> = {
  loaded: "while loaded",
  unloaded: "while unloaded",
  off: "while off",
  start: "at start",
  any: "",
};

function wordsFor(table: Readonly<Record<string, string>>, value: string): string {
  return table[value] ?? humanize(value).toLowerCase();
}

/** The label of a signal tag id, when the registry has one. */
export type SignalLabelLookup = (signalId: string) => string | undefined;

function subjectOf(move: SignalMove, signalLabel: SignalLabelLookup): string {
  if (move.signal !== undefined) {
    return signalLabel(move.signal) ?? humanize(move.signal);
  }
  return humanize(move.behaviour ?? "");
}

/** One expected movement as a sentence: the catalog's own, or one built from its parts. */
export function describeSignalMove(move: SignalMove, signalLabel: SignalLabelLookup): string {
  if (move.text !== undefined && move.text.trim() !== "") {
    return move.text;
  }
  const phase = move.phase === undefined ? "" : wordsFor(PHASE_WORDS, move.phase);
  const words = [subjectOf(move, signalLabel), wordsFor(DIRECTION_WORDS, move.direction), phase];
  return `${words.filter((word) => word !== "").join(" ")}.`;
}
