// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The matcher behind the `best-overlap` answer policy. The CI Compose stack runs the mock instead
// of Von, and a stack whose decision depends on which candidate happens to sit first in the catalog
// is not a test. This module makes the answer a pure function of the request: the winning candidate
// is the one whose expected movements overlap the observed movements most, and equal scores are
// broken by candidate id.
//
// The unit of overlap is a **(signal-label word, direction) pair**. A sentence such as
// "dryer purge pressure rises far above normal while loaded" contributes
// `dryer|up`, `purge|up` and `pressure|up`; an observation of `dryer purge pressure` at
// `far above normal` contributes exactly the same three pairs, so the two agree. An
// observation of the same signal *below* normal contributes `…|down` and does not.
//
// The vocabulary is deliberately small and fixed. It reproduces shapes, never judgment: the
// real model reads the sentences, this counts words.

/** The five movement directions of the manual's `signal_move` vocabulary. */
export type Direction = "up" | "down" | "flat" | "erratic" | "missing";

const DIRECTION_WORDS: Readonly<Record<Direction, readonly string[]>> = {
  up: [
    "above",
    "climbing",
    "climbs",
    "exceeding",
    "exceeds",
    "faster",
    "grows",
    "growing",
    "high",
    "higher",
    "increase",
    "increases",
    "increasing",
    "longer",
    "more",
    "rise",
    "risen",
    "rises",
    "rising",
    "up",
  ],
  down: [
    "below",
    "decline",
    "declines",
    "declining",
    "decrease",
    "decreases",
    "decreasing",
    "down",
    "drops",
    "dropping",
    "fall",
    "fallen",
    "falling",
    "falls",
    "fewer",
    "less",
    "low",
    "lower",
    "shorter",
    "slower",
    "under",
  ],
  flat: [
    "constant",
    "flat",
    "holding",
    "holds",
    "normal",
    "stay",
    "staying",
    "stays",
    "steady",
    "unchanged",
  ],
  erratic: [
    "erratic",
    "fluctuate",
    "fluctuates",
    "fluctuating",
    "noisy",
    "oscillates",
    "swinging",
    "swings",
    "unstable",
  ],
  missing: ["absent", "dropout", "dropouts", "frozen", "lost", "missing", "stale", "stuck"],
};

const DIRECTIONS: readonly Direction[] = ["up", "down", "flat", "erratic", "missing"];

const WORD_TO_DIRECTION: ReadonlyMap<string, Direction> = new Map(
  DIRECTIONS.flatMap((direction) =>
    DIRECTION_WORDS[direction].map((word) => [word, direction] as const),
  ),
);

// Grammar, hedges and the duration words of `observations[].since`, none of which names a
// signal. Direction words are excluded separately, so they are not repeated here.
const STOP_WORDS: ReadonlySet<string> = new Set([
  "about",
  "after",
  "ago",
  "all",
  "also",
  "and",
  "any",
  "are",
  "around",
  "been",
  "before",
  "both",
  "but",
  "cases",
  "day",
  "days",
  "did",
  "does",
  "during",
  "each",
  "few",
  "for",
  "from",
  "had",
  "has",
  "have",
  "hour",
  "hours",
  "how",
  "into",
  "its",
  "just",
  "keep",
  "keeps",
  "kept",
  "long",
  "may",
  "might",
  "minute",
  "minutes",
  "month",
  "months",
  "much",
  "never",
  "none",
  "not",
  "off",
  "only",
  "other",
  "others",
  "out",
  "over",
  "per",
  "same",
  "second",
  "seconds",
  "several",
  "show",
  "shows",
  "slightly",
  "some",
  "still",
  "than",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "very",
  "was",
  "week",
  "weeks",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "with",
  "year",
  "years",
  "yet",
]);

/** Lower-cased alphanumeric words of at least three characters, numbers dropped. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length >= 3 && !/^[0-9]+$/u.test(word));
}

/**
 * The directions a sentence expresses. A sentence that moves in some direction is not also
 * "flat", so `far above normal` is `up` even though it contains the word `normal`.
 */
export function directionsOf(tokens: readonly string[]): Set<Direction> {
  const found = new Set<Direction>();
  for (const token of tokens) {
    const direction = WORD_TO_DIRECTION.get(token);
    if (direction !== undefined) found.add(direction);
  }
  if (found.size > 1) found.delete("flat");
  return found;
}

/**
 * The `(word, direction)` pairs of one sentence, as `"<word>|<direction>"` strings so that
 * they can live in a `Set`.
 */
export function movePairs(text: string): Set<string> {
  const tokens = tokenize(text);
  const directions = directionsOf(tokens);
  const pairs = new Set<string>();
  if (directions.size === 0) return pairs;
  for (const token of tokens) {
    if (WORD_TO_DIRECTION.has(token) || STOP_WORDS.has(token)) continue;
    for (const direction of directions) pairs.add(`${token}|${direction}`);
  }
  return pairs;
}

/** The pairs of a whole list of sentences. */
export function movePairsOf(sentences: readonly string[]): Set<string> {
  const pairs = new Set<string>();
  for (const sentence of sentences) for (const pair of movePairs(sentence)) pairs.add(pair);
  return pairs;
}

/** One answer candidate: the label the Choice may return and the movements it expects. */
export interface OverlapCandidate {
  readonly id: string;
  readonly moves: readonly string[];
}

/** How well one candidate matched, kept so a test can explain a ranking. */
export interface OverlapScore {
  readonly id: string;
  readonly score: number;
}

/**
 * Ranks `candidates` against `observations`, best first, ties broken by ascending id. The
 * result is a total order, so the winner is `rank(...)[0]` for any input, including an input
 * where nothing overlaps at all.
 */
export function rankByOverlap(
  candidates: readonly OverlapCandidate[],
  observations: readonly string[],
): OverlapScore[] {
  const observed = movePairsOf(observations);
  const scored = candidates.map((candidate) => {
    let score = 0;
    for (const pair of movePairsOf(candidate.moves)) if (observed.has(pair)) score += 1;
    return { id: candidate.id, score };
  });
  return scored.sort((a, b) => (a.score === b.score ? (a.id < b.id ? -1 : 1) : b.score - a.score));
}

/** The best-overlapping candidate id, or `undefined` when there are no candidates. */
export function bestOverlap(
  candidates: readonly OverlapCandidate[],
  observations: readonly string[],
): string | undefined {
  return rankByOverlap(candidates, observations)[0]?.id;
}
