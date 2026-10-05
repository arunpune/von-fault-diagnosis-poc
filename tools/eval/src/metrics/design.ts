// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The design target of a diagnostic scenario, read and reported, never scored.
//
// `unlabelled_leak_may19` replays one of the twelve unlabelled stuck-loaded
// episodes of the failure table. The failure table keeps every such episode an
// excluded window — neither positive nor negative — and nothing here changes
// that: no ticket inside the episode is scored, and no gate, exit eval, pass
// rule or threshold selection reads this module. The scenario may serve as a
// *design case* all the same: its file carries a design target, the causes a
// diagnosis of the episode is read against — for may19 the signature-A pair
// `dryer_purge_leak` and `downstream_air_leak`, inferred from the signature-A
// analysis and unverified — and the tuning readout and the threshold sweep
// report how a backend's tickets and decisions inside the episode stand against
// it.
//
// It is kept structurally apart from scoring. `ScenarioBinding` has no field
// for a design target, so `scoreScenario`, the core-10 gate, the E3 check and
// the sweep's figures cannot read one; the runner and the sweep call
// `designReading` beside them and write what it returns in a block of its own,
// marked `gated: false`. The pre-registered Von threshold selection
// (tools/eval/records/von-thresholds-preregistration.md) excludes may19 by name
// as well.
//
// The episodes are the scenario's excluded windows with the reason
// `unlabelled_positive`, which the binder resolves from `@fdp/ground-truth`, so
// the scenario file carries no timestamp for them.

import type { DecisionRecord, ExcludedWindow, Interval, Level, TicketRecord } from "./types.ts";
import { NONE_OF_THESE } from "./types.ts";
import { covers } from "./match.ts";
import { instant } from "./time.ts";

/** The exclusion reason of the failure table's unlabelled episodes. */
export const UNLABELLED_EPISODE_REASON = "unlabelled_positive";

/** A design target as a scenario file states it (`design_target`). */
export interface DesignTarget {
  /** The causes a diagnosis of the scenario's unlabelled episodes is read against. */
  readonly accepted: readonly string[];
  /** Where the target comes from, in words; for may19, an inference nobody verified. */
  readonly provenance: string;
}

/** How one backend's tickets at one level stand against a design target. */
export interface DesignLevelReading {
  readonly level: Level;
  /** Tickets opened inside a design episode that name an accepted cause. */
  readonly onTarget: number;
  /** Tickets opened inside a design episode that name another cause the scenario does not call benign. */
  readonly offTarget: number;
  /** Tickets opened inside a design episode that name a benign cause. */
  readonly benign: number;
  /** Tickets opened after the warmup outside every design episode. */
  readonly outside: number;
  /** The first ticket at this level inside a design episode, when there was one. */
  readonly first?: TicketRecord;
  /** True when `first` names an accepted cause. */
  readonly met: boolean;
}

/** One backend's reading of one scenario's design target: reported, never gated. */
export interface DesignReading {
  readonly scenarioId: string;
  readonly backend: string;
  readonly target: DesignTarget;
  /** The unlabelled episodes of the scenario's replayed range the target applies to. */
  readonly episodes: readonly Interval[];
  readonly review: DesignLevelReading;
  readonly ticket: DesignLevelReading;
  /** The answered decisions taken inside a design episode, by choice. */
  readonly decisions: {
    readonly total: number;
    /** How many chose an accepted cause. */
    readonly onTarget: number;
    readonly byChoice: Readonly<Record<string, number>>;
  };
  /** Always false: a design target enters no gate, exit eval or threshold selection. */
  readonly gated: false;
}

/** What `designReading` reads: the scenario's scored records and its excluded windows. */
export interface DesignInput {
  readonly scenarioId: string;
  readonly backend: string;
  readonly target: DesignTarget;
  /** The scenario's excluded windows; those with the unlabelled-episode reason are read. */
  readonly excluded: readonly ExcludedWindow[];
  /** The scored tickets: the ones the warmup left (`ScenarioMetrics.tickets`). */
  readonly tickets: readonly TicketRecord[];
  readonly decisions: readonly DecisionRecord[];
  /** The causes the scenario's ground truth calls benign. */
  readonly benignFaultIds: ReadonlySet<string>;
}

/** The unlabelled episodes among a scenario's excluded windows, in time order. */
export function designEpisodes(excluded: readonly ExcludedWindow[]): Interval[] {
  return excluded
    .filter((window) => window.reason === UNLABELLED_EPISODE_REASON)
    .map((window) => ({ from: window.from, to: window.to }))
    .sort(
      (left, right) => instant(left.from, "episode start") - instant(right.from, "episode start"),
    );
}

function inEpisode(episodes: readonly Interval[], at: Date): boolean {
  return episodes.some((episode) => covers(episode.from, episode.to, at, "design episode"));
}

function levelReading(
  level: Level,
  input: DesignInput,
  episodes: readonly Interval[],
): DesignLevelReading {
  const accepted = new Set(input.target.accepted);
  const participating = input.tickets
    .filter((ticket) => level === "review" || ticket.maxLevel === "ticket")
    .sort(
      (left, right) =>
        instant(left.openedSimTs, `ticket ${left.ticketId}`) -
          instant(right.openedSimTs, `ticket ${right.ticketId}`) ||
        left.ticketId.localeCompare(right.ticketId),
    );
  const inside = participating.filter((ticket) => inEpisode(episodes, ticket.openedSimTs));
  const onTarget = inside.filter((ticket) => accepted.has(ticket.faultAtOpen)).length;
  const benign = inside.filter(
    (ticket) => !accepted.has(ticket.faultAtOpen) && input.benignFaultIds.has(ticket.faultAtOpen),
  ).length;
  const first = inside[0];
  return {
    level,
    onTarget,
    offTarget: inside.length - onTarget - benign,
    benign,
    outside: participating.length - inside.length,
    ...(first === undefined ? {} : { first }),
    met: first !== undefined && accepted.has(first.faultAtOpen),
  };
}

/**
 * How one backend's tickets and decisions inside a scenario's unlabelled episodes stand against
 * its design target. The result is a report: nothing that scores, gates or selects reads it.
 */
export function designReading(input: DesignInput): DesignReading {
  const episodes = designEpisodes(input.excluded);
  const accepted = new Set(input.target.accepted);
  const inside = input.decisions.filter((decision) => inEpisode(episodes, decision.simTs));
  const byChoice: Record<string, number> = {};
  for (const decision of inside) byChoice[decision.choice] = (byChoice[decision.choice] ?? 0) + 1;
  return {
    scenarioId: input.scenarioId,
    backend: input.backend,
    target: { accepted: [...input.target.accepted], provenance: input.target.provenance },
    episodes,
    review: levelReading("review", input, episodes),
    ticket: levelReading("ticket", input, episodes),
    decisions: {
      total: inside.length,
      onTarget: inside.filter(
        (decision) => decision.choice !== NONE_OF_THESE && accepted.has(decision.choice),
      ).length,
      byChoice,
    },
    gated: false,
  };
}
