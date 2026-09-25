// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The gate-threshold sweep (`fdp-eval sweep`).
//
// The gate is pure and every stored decision carries its `choice` and its
// `confidence`, so a recorded run can be re-gated for a grid of
// (GATE_TICKET_MIN_CONFIDENCE, GATE_REVIEW_MIN_CONFIDENCE) pairs without
// calling a model again. That is what makes threshold changes configuration
// rather than a new experiment.
//
// Two honesty rules hold this in place.
//
// 1. **It is an approximation, and says so.** Episode merging depends on the
//    gate — a new episode is linked to an open one when its first decision
//    picks the same fault at review or above — so a different threshold could
//    merge differently and produce a different number of tickets. Re-running
//    the merge would mean re-running the pipeline, which is exactly what the
//    sweep exists to avoid. Every row therefore carries `approximate: true`,
//    and `sweep()` rebuilds tickets per episode as if no merging happened.
// 2. **It never tunes on the test split.** The core-10 is the test set,
//    every sweep runs on `dev`, and a run whose split is `test` is refused
//    unless the caller passes `allowTestSplit` — which only reporting does,
//    never the choice of a default threshold. A `heldout` run is refused
//    whatever the caller passes: the held-out set is never re-gated.
//
// 3. **It respects the persistence before the ticket.** An episode that owns no
//    ticket is decided only once its symptom has fired for
//    `GATE_PERSIST_SIM_MIN`; one that owns a ticket is decided whatever its
//    evidence reads. A run's decisions of the second kind carry a
//    `persistedSimMin` below the floor, and at a stricter pair, where the
//    episode would have owned no ticket yet, such a decision could not have
//    been taken, so it never opens the rebuilt ticket: it can only update one.
//    A run recorded before decisions carried the figure is re-gated as before.
//    What stays approximate is the other direction: at a looser pair a ticket
//    opens earlier, and the updates it would have drawn on unpersisted evidence
//    were never asked for.
//
// The row at the run's own thresholds must reproduce the run's own metrics.
// That is the sweep's self-test, and `sweep.test.ts` asserts it, because a
// re-gating that disagrees with the run it came from cannot be trusted one
// grid point further out.

import type {
  DecisionRecord,
  ExcludedWindow,
  GateOutcome,
  PrecisionRecall,
  ScoringWindow,
  Split,
  TicketRates,
  TicketRecord,
} from "./types.ts";
import { NONE_OF_THESE } from "./types.ts";
import { matchTickets } from "./match.ts";
import { precisionRecall } from "./precision.ts";
import { ticketRates } from "./rate.ts";
import { instant } from "./time.ts";

/** What the gate decided for one decision, at one pair of thresholds. */
export interface GateVerdict {
  readonly outcome: GateOutcome;
  readonly abstained: boolean;
}

/**
 * The confidence gate (docs/decision-backends.md), as a pure function.
 *
 * It is re-implemented here rather than imported because `src/metrics` imports nothing from
 * `@fdp/backend`; `sweep.test.ts` pins the four branches against the gate's rule so the two
 * copies cannot drift silently.
 */
export function gate(
  choice: string,
  confidence: number,
  ticketMin: number,
  reviewMin: number,
): GateVerdict {
  if (choice !== NONE_OF_THESE && confidence >= ticketMin) {
    return { outcome: "ticket", abstained: false };
  }
  if (choice !== NONE_OF_THESE && confidence >= reviewMin) {
    return { outcome: "review", abstained: false };
  }
  if (choice === NONE_OF_THESE && confidence >= reviewMin) {
    return { outcome: "log", abstained: true };
  }
  return { outcome: "log", abstained: false };
}

/** The decisions of one episode, in any order. */
export interface SweepEpisode {
  readonly episodeId: string;
  readonly decisions: readonly DecisionRecord[];
}

/** One pair of thresholds, `[ticketMin, reviewMin]`. */
export type ThresholdPair = readonly [ticketMin: number, reviewMin: number];

/** A stored run, reduced to what re-gating needs. */
export interface SweepRun {
  /** A `test` run is refused unless the caller opts in. */
  readonly split?: Split;
  readonly thresholds: { readonly ticketMin: number; readonly reviewMin: number };
  readonly windows: readonly ScoringWindow[];
  readonly excluded: readonly ExcludedWindow[];
  readonly benignFaultIds: ReadonlySet<string>;
  readonly episodes: readonly SweepEpisode[];
  readonly coveredMachineDays: number;
  readonly negativeMachineDays: number;
  /**
   * `GATE_PERSIST_SIM_MIN` of the run: a decision whose `persistedSimMin` is below it
   * never opens a rebuilt ticket. Absent or 0, every decision may.
   */
  readonly persistSimMin?: number;
}

/** One grid point's metrics. */
export interface SweepRow {
  readonly ticketMin: number;
  readonly reviewMin: number;
  /** Always true: episode merging is not simulated. */
  readonly approximate: true;
  readonly tickets: readonly TicketRecord[];
  readonly precisionRecall: { readonly ticket: PrecisionRecall; readonly review: PrecisionRecall };
  readonly rates: TicketRates;
  readonly abstained: number;
}

/** How a sweep may be widened past its guard rail. */
export interface SweepOptions {
  /** Reporting a test-split run is allowed; choosing a default from it is not. */
  readonly allowTestSplit?: boolean;
}

/**
 * Whether a decision could have been taken by an episode that owns no ticket: its
 * evidence had persisted for `persistSimMin`, or the run did not say how long it had.
 */
export function couldOpen(decision: DecisionRecord, persistSimMin: number): boolean {
  if (persistSimMin <= 0 || decision.persistedSimMin === undefined) return true;
  return decision.persistedSimMin >= persistSimMin;
}

/**
 * The ticket one episode would have produced at these thresholds.
 *
 * The rebuild follows the backend's ticket rules minus the merge: the first decision reaching
 * `review` opens the ticket, the first reaching `ticket` promotes it, and `faultLatest` is what the
 * last gated decision named. An episode whose decisions all stay at `log` opens nothing. A
 * decision a ticketless episode could not have taken (`couldOpen`) never opens the ticket; once
 * it is open, it updates it like any other.
 */
function rebuildTicket(
  episode: SweepEpisode,
  ticketMin: number,
  reviewMin: number,
  persistSimMin = 0,
): TicketRecord | undefined {
  const ordered = [...episode.decisions].sort(
    (left, right) =>
      instant(left.simTs, `decision ${left.decisionId}`) -
      instant(right.simTs, `decision ${right.decisionId}`),
  );

  let opened: DecisionRecord | undefined;
  let maxLevel: "review" | "ticket" = "review";
  let faultLatest = "";

  for (const decision of ordered) {
    const { outcome } = gate(decision.choice, decision.confidence, ticketMin, reviewMin);
    if (outcome === "log") continue;
    if (opened === undefined && !couldOpen(decision, persistSimMin)) continue;
    opened ??= decision;
    if (outcome === "ticket") maxLevel = "ticket";
    faultLatest = decision.choice;
  }
  if (opened === undefined) return undefined;

  return {
    ticketId: `sweep-${episode.episodeId}`,
    episodeId: episode.episodeId,
    openedSimTs: opened.simTs,
    faultAtOpen: opened.choice,
    faultLatest,
    maxLevel,
  };
}

/** How many decisions of the run were explicit abstentions at these thresholds. */
function abstainedCount(run: SweepRun, ticketMin: number, reviewMin: number): number {
  return run.episodes.reduce(
    (total, episode) =>
      total +
      episode.decisions.filter(
        (decision) => gate(decision.choice, decision.confidence, ticketMin, reviewMin).abstained,
      ).length,
    0,
  );
}

function row(run: SweepRun, pair: ThresholdPair): SweepRow {
  const [ticketMin, reviewMin] = pair;
  const tickets = run.episodes
    .map((episode) => rebuildTicket(episode, ticketMin, reviewMin, run.persistSimMin))
    .filter((ticket): ticket is TicketRecord => ticket !== undefined);

  const ticketMatch = matchTickets(
    run.windows,
    run.excluded,
    tickets,
    run.benignFaultIds,
    "ticket",
  );
  const reviewMatch = matchTickets(
    run.windows,
    run.excluded,
    tickets,
    run.benignFaultIds,
    "review",
  );

  return {
    ticketMin,
    reviewMin,
    approximate: true,
    tickets,
    precisionRecall: {
      ticket: precisionRecall(ticketMatch, "ticket"),
      review: precisionRecall(reviewMatch, "review"),
    },
    rates: ticketRates(tickets, reviewMatch.fp, run.coveredMachineDays, run.negativeMachineDays),
    abstained: abstainedCount(run, ticketMin, reviewMin),
  };
}

/**
 * Re-gates a stored run over a grid of threshold pairs.
 *
 * @param run the stored run: its decisions grouped by episode, its windows and its covered time.
 * @param grid the `(ticketMin, reviewMin)` pairs to score; the run's own pair is always added,
 * so the self-test row exists whether or not the caller asked for it.
 * @param options `allowTestSplit` lifts the test-split guard for a reporting run.
 * @returns one row per pair, sorted by `ticketMin` then `reviewMin`, each marked approximate.
 * @throws RangeError when a pair is out of order (`reviewMin > ticketMin`) or outside `[0, 1]`,
 * and Error when the run is on the test split and the caller did not opt in.
 */
export function sweep(
  run: SweepRun,
  grid: readonly ThresholdPair[],
  options: SweepOptions = {},
): SweepRow[] {
  if (run.split === "heldout") {
    throw new Error(
      "sweep() refuses a held-out run whatever the options: the held-out set is read once, " +
        "at thresholds already fixed, and never re-gated (tools/eval/records/heldout-seal.md).",
    );
  }
  if (run.split === "test" && options.allowTestSplit !== true) {
    throw new Error(
      "sweep() refuses a run on the test split: the core-10 is the test set and thresholds " +
        "are tuned on `dev`. Pass allowTestSplit to report — never to choose a default.",
    );
  }

  const pairs = [...grid, [run.thresholds.ticketMin, run.thresholds.reviewMin] as ThresholdPair];
  for (const [ticketMin, reviewMin] of pairs) {
    if (ticketMin < 0 || ticketMin > 1 || reviewMin < 0 || reviewMin > 1) {
      throw new RangeError(`threshold pair (${ticketMin}, ${reviewMin}) is outside [0, 1]`);
    }
    if (reviewMin > ticketMin) {
      throw new RangeError(
        `threshold pair (${ticketMin}, ${reviewMin}) has a review floor above the ticket floor`,
      );
    }
  }

  const seen = new Set<string>();
  return pairs
    .filter((pair) => {
      const key = `${pair[0]}|${pair[1]}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
    .map((pair) => row(run, pair));
}
