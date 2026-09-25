// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * What retrieval hands the decision layer.
 *
 * A candidate is a catalog entry exactly as the contracts define it, plus the
 * scores of the three stages that put it in the list. Nothing in `decision/`
 * ranks anything; the scores travel so the decision sheet and the evaluation
 * harness can explain why a cause was offered at all.
 */

import type { CatalogEntry, MachineMode } from "@fdp/contracts";

import type { Level, Trend } from "../detection/types.ts";

/** Where one candidate ranked in each stage of the fused search. */
export interface RetrievalScores {
  /** Stage 1: the signal-move match of `scoreSignalMoves`. */
  readonly catalog: number;
  /** Stage 2: `ts_rank_cd` over the catalog and chunk text indexes. */
  readonly text: number;
  /** Stage 3: cosine similarity of the embedded query against the chunks. */
  readonly vector: number;
  /** The reciprocal-rank fusion of the three, `k = 60`; the list is ordered by it. */
  readonly rrf: number;
}

/** One catalog cause offered to the decision backend, with its retrieval scores. */
export type Candidate = CatalogEntry & { readonly retrieval: RetrievalScores };

/**
 * One observed signal reduced to the two words the matcher compares.
 *
 * The duration is not part of a match: the catalog says which way a signal
 * moves, never for how long.
 */
export interface ObservedBuckets {
  /** A signal registry tag id or a derived behaviour id. */
  readonly signal: string;
  readonly level: Level;
  readonly trend: Trend;
}

/**
 * What the matcher needs to know besides the observations.
 *
 * A digital's level says only whether the value it reads is common or rare in
 * the state the machine is in, so reading the value back takes that state.
 * Both callers pass it explicitly — retrieval's stage 1 and the rules twin,
 * from the same event — so the two can never judge one observation against
 * two different modes.
 */
export interface MatchContext {
  /** The event's `machine_state.mode`. */
  readonly mode: MachineMode;
}

/** What one candidate's expected movements scored against the observations. */
export interface SignalMoveScore {
  /** `(matches − contradictions / 2) / moves`, clamped to 0…1. */
  readonly score: number;
  /** Expected movements the observations show. */
  readonly matches: number;
  /** Expected movements the observations show pointing the other way. */
  readonly contradictions: number;
  /** How many movements the candidate declares; the divisor of `score`. */
  readonly moves: number;
}
