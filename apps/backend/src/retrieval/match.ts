// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The signal-move matcher: stage 1 of retrieval, and the rules twin's scorer.
 *
 * The manual states what a cause does to the machine in its own closed
 * vocabulary — `rises`, `high`, `stays_off`, `not_reached` and the rest of the
 * `signal_move` direction enum of the contracts. Detection states what the machine
 * actually did in the bucket vocabulary of `detection/buckets.ts`. This module
 * is the one place the two meet: every direction word is judged against one
 * observed {@link Level} and {@link Trend} as a match, a contradiction or
 * silence, and a candidate's score is how many of its movements match.
 *
 * The manual's words come in three kinds, and each is read the way it is
 * meant:
 *
 * - a **state** word (`high`, `low`, `near_zero`, `not_venting`, `higher`,
 *   `lower`, `longer`, `shorter`, `faster`, `slower`, `not_reached`) says where
 *   a signal sits, so its level alone shows or denies it — a normal level that
 *   happens to be moving is neither;
 * - a **movement** word (`rises`, `falls`) says where it is going, so the level
 *   or the trend shows it;
 * - a **digital** word (`on`, `off`, `stays_on`, `stays_off`, `toggles`,
 *   `no_pulse`) is about a boolean, whose level says only whether the value it
 *   reads is common or rare in the machine's current mode. Reading the value
 *   back takes that mode, which is why the matcher takes a {@link MatchContext}.
 *
 * `unchanged` means normal and flat, contradicted by any movement, and
 * `fluctuates` asks for an erratic trend.
 *
 * It is pure and it has two callers. Retrieval ranks the whole catalog with it
 * (stage 1 of the fusion), and the rules backend uses the same numbers as its
 * per-candidate support, so the rules twin and the retrieval ranking can never
 * disagree about what "matches" means.
 *
 * A movement whose signal is absent from the observations is neither a match
 * nor a contradiction: it simply does not score, and the divisor still counts
 * it, so a candidate that expects six movements and shows three lands at a
 * half. A contradiction is stronger than silence and costs half a match.
 */

import { SIGNALS } from "@fdp/contracts";
import type {
  LevelBucket,
  MachineMode,
  Observation,
  SignalMove,
  SuspectEvent,
  TrendBucket,
} from "@fdp/contracts";

import { DIGITAL_NORMAL_SHARE, FIRST_MONTH_DIGITAL_SHARE } from "../detection/baseline.ts";
import { parseBucket } from "../detection/buckets.ts";
import { DIGITAL_ROLES, ROLE_COLUMNS, type DigitalRole } from "../detection/signals.ts";
import type { Level, Trend } from "../detection/types.ts";
import type { MatchContext, ObservedBuckets, SignalMoveScore } from "./types.ts";

/** Which side of its normal band a word points at. */
type Side = "above" | "below";

/**
 * What a direction word asks of one observation.
 *
 * These are tests, not a vocabulary: the contracts' direction enum is the only
 * vocabulary, and several of its words ask for the same test — `high`,
 * `longer` and `not_venting` all ask whether the signal sits above its band.
 */
type WordTest =
  /** Where the signal sits: the level alone decides. */
  | { readonly kind: "state"; readonly side: Side }
  /** Where the signal sits or is heading: the level or the trend. */
  | { readonly kind: "movement"; readonly side: Side }
  /** `unchanged`: normal and flat. */
  | { readonly kind: "steady" }
  /** `fluctuates`: an erratic trend. */
  | { readonly kind: "unsettled" }
  /** `on` / `off`: the value a digital reads. */
  | { readonly kind: "reads"; readonly on: boolean }
  /** `stays_on` / `stays_off`: that value, with no transition in the window. */
  | { readonly kind: "holds"; readonly on: boolean }
  /** `toggles`: transitions in the window. */
  | { readonly kind: "toggles" }
  /** `no_pulse`: a digital that does not move. */
  | { readonly kind: "no_pulse" };

const SITS_ABOVE: WordTest = { kind: "state", side: "above" };
const SITS_BELOW: WordTest = { kind: "state", side: "below" };

/** Every direction of `common.schema.json#/$defs/signal_move`, as a test. */
const DIRECTION_TESTS: Readonly<Record<SignalMove["direction"], WordTest>> = {
  rises: { kind: "movement", side: "above" },
  falls: { kind: "movement", side: "below" },
  high: SITS_ABOVE,
  low: SITS_BELOW,
  unchanged: { kind: "steady" },
  fluctuates: { kind: "unsettled" },
  /** A line that should hold pressure sits at the bottom of its band. */
  near_zero: SITS_BELOW,
  /** A vessel that did not blow down stays up where it should have fallen. */
  not_venting: SITS_ABOVE,
  on: { kind: "reads", on: true },
  off: { kind: "reads", on: false },
  stays_on: { kind: "holds", on: true },
  stays_off: { kind: "holds", on: false },
  toggles: { kind: "toggles" },
  no_pulse: { kind: "no_pulse" },
  higher: SITS_ABOVE,
  lower: SITS_BELOW,
  longer: SITS_ABOVE,
  shorter: SITS_BELOW,
  faster: SITS_ABOVE,
  slower: SITS_BELOW,
  /** `cut_out_reached` is a flag: not reaching it puts the flag below its band. */
  not_reached: SITS_BELOW,
};

/** What one movement counted as against one observation. */
type Verdict = "match" | "contradiction" | "silent";

const ABOVE_LEVELS = new Set<Level>(["above_normal", "far_above_normal"]);
const BELOW_LEVELS = new Set<Level>(["below_normal", "far_below_normal"]);
const RISING_TRENDS = new Set<Trend>(["rising", "rising_sharply"]);
const FALLING_TRENDS = new Set<Trend>(["falling", "falling_sharply"]);

/** The contract's coarser level enum, read back into the internal words. */
export function fromContractLevel(value: LevelBucket): Level | undefined {
  switch (value) {
    case "far_below":
      return "far_below_normal";
    case "below":
      return "below_normal";
    case "normal":
      return "normal";
    case "above":
      return "above_normal";
    case "far_above":
      return "far_above_normal";
    case "unknown":
      return undefined;
  }
}

/**
 * The contract's coarser trend enum, read back into the internal words.
 *
 * `rising_sharply` travelled as `rising` and cannot come back: the matcher
 * never asks how sharp a movement was, only which way it went.
 */
export function fromContractTrend(value: TrendBucket): Trend | undefined {
  switch (value) {
    case "falling":
      return "falling";
    case "flat":
      return "flat";
    case "rising":
      return "rising";
    case "erratic":
      return "erratic";
    case "stuck":
      return "stuck";
    case "unknown":
      return undefined;
  }
}

/**
 * The observations of a `suspect-event`, as the matcher reads them.
 *
 * A signal whose level or trend is `unknown` is dropped: detection could not
 * say where it sat, and an expectation must not be scored against a hole.
 */
export function observedFromEvent(
  observations: readonly Observation[],
): readonly ObservedBuckets[] {
  const read: ObservedBuckets[] = [];
  for (const observation of observations) {
    const level = fromContractLevel(observation.level);
    const trend = fromContractTrend(observation.trend);
    if (level === undefined || trend === undefined) continue;
    read.push({ signal: observation.signal, level, trend });
  }
  return read;
}

/** The three words `decision/state.ts` writes, as one observation reads them. */
export interface ObservationWords {
  readonly signal: string;
  readonly level: string;
  readonly trend: string;
  readonly since: string;
}

/** The word a bucket carries when detection could not place the signal. */
const UNKNOWN_WORD = "unknown";

/**
 * The observations of a built state, read back into buckets.
 *
 * This is what makes the rules backend a twin rather than a second
 * implementation: it scores the very sentence the model would have read, so a
 * change to the state changes both backends at once.
 */
export function parseObservedBuckets(
  observations: readonly ObservationWords[],
): readonly ObservedBuckets[] {
  const read: ObservedBuckets[] = [];
  for (const observation of observations) {
    if (observation.level === UNKNOWN_WORD || observation.trend === UNKNOWN_WORD) continue;
    const { level, trend } = parseBucket(
      `${observation.level}; ${observation.trend}; ${observation.since}`,
    );
    read.push({ signal: observation.signal, level, trend });
  }
  return read;
}

/**
 * The context an event's observations are matched in: the mode detection read
 * them in. Both callers build it here, from the same event, so retrieval and
 * the rules twin cannot disagree about it.
 */
export function matchContextOf(event: Pick<SuspectEvent, "machine_state">): MatchContext {
  return { mode: event.machine_state.mode };
}

/** The signal or behaviour a movement is about; exactly one of the two is set. */
export function moveTarget(move: SignalMove): string | undefined {
  return move.signal ?? move.behaviour;
}

/** The side of its band a level sits on; `undefined` inside it. */
function levelSide(level: Level): Side | undefined {
  if (ABOVE_LEVELS.has(level)) return "above";
  if (BELOW_LEVELS.has(level)) return "below";
  return undefined;
}

/** The side a trend is heading to; `undefined` when it goes nowhere in particular. */
function trendSide(trend: Trend): Side | undefined {
  if (RISING_TRENDS.has(trend)) return "above";
  if (FALLING_TRENDS.has(trend)) return "below";
  return undefined;
}

/**
 * A state word: the level alone decides.
 *
 * A normal level is silent whatever the trend, so a line that is normal and
 * falling neither shows `low` nor denies it, and supports do not flip between
 * two decisions a few minutes apart because the saw-tooth changed direction.
 */
function judgeState(side: Side, observed: ObservedBuckets): Verdict {
  const at = levelSide(observed.level);
  if (at === undefined) return "silent";
  return at === side ? "match" : "contradiction";
}

/** A movement word: sitting on that side or heading there shows it; the other side denies it. */
function judgeMovement(side: Side, observed: ObservedBuckets): Verdict {
  const at = levelSide(observed.level);
  const heading = trendSide(observed.trend);
  if (at === side || heading === side) return "match";
  if (at !== undefined || heading !== undefined) return "contradiction";
  return "silent";
}

/**
 * `unchanged`: normal and flat, and contradicted by any movement — an
 * expectation that the signal stays put is denied by the signal not staying
 * put.
 */
function judgeSteady(observed: ObservedBuckets): Verdict {
  return observed.level === "normal" && observed.trend === "flat" ? "match" : "contradiction";
}

/** `fluctuates` is a trend, not a level: erratic shows it, a signal holding still denies it. */
function judgeUnsettled(observed: ObservedBuckets): Verdict {
  if (observed.trend === "erratic") return "match";
  if (observed.trend === "flat" || observed.trend === "stuck") return "contradiction";
  return "silent";
}

/**
 * The digital role behind each register-map tag.
 *
 * The resolution `detection/signals.ts` performs — a role names its MetroPT-3
 * column and the register map names the tag that carries it — done once over
 * the contracts' fixed register map, so the matcher, like detection, never
 * writes a tag literal.
 */
const DIGITAL_ROLE_BY_TAG: ReadonlyMap<string, DigitalRole> = new Map(
  DIGITAL_ROLES.flatMap((role) => {
    const signal = SIGNALS.find((candidate) => candidate.metropt_column === ROLE_COLUMNS[role]);
    return signal === undefined ? [] : [[signal.tag, role] as const];
  }),
);

/**
 * The value a digital must be reading when detection calls it normal in
 * `mode`, if only one value can be.
 *
 * `detection/buckets.ts` calls a digital's value normal when at least
 * {@link DIGITAL_NORMAL_SHARE} of the first month's samples in that state
 * showed it ({@link FIRST_MONTH_DIGITAL_SHARE}). So a normal reading is `on`
 * exactly when `off` could not have been normal, and the other way round.
 * Where both values are ordinary — the dryer tower while loaded — or the state
 * is unknown and has no band, a normal level does not say which value it is.
 */
function usualValue(signal: string, mode: MachineMode): boolean | undefined {
  const role = DIGITAL_ROLE_BY_TAG.get(signal);
  if (role === undefined || mode === "unknown") return undefined;
  const share = FIRST_MONTH_DIGITAL_SHARE[role][mode];
  if (1 - share < DIGITAL_NORMAL_SHARE) return true;
  if (share < DIGITAL_NORMAL_SHARE) return false;
  return undefined;
}

/**
 * The value a digital reads. A level off its band says it outright — a digital
 * reads above normal when it shows the `on` its state rarely shows, below when
 * it shows a rare `off` — and a normal level is the mode's usual value.
 */
function digitalValue(observed: ObservedBuckets, context: MatchContext): boolean | undefined {
  const at = levelSide(observed.level);
  if (at !== undefined) return at === "above";
  return usualValue(observed.signal, context.mode);
}

/** Detection writes a digital's transitions as a rising or falling trend, four or more as erratic. */
function transitioned(trend: Trend): boolean {
  return trend !== "flat" && trend !== "stuck";
}

/** At its usual value with no transition in its window: where the digital rests anyway. */
function resting(observed: ObservedBuckets): boolean {
  return observed.level === "normal" && !transitioned(observed.trend);
}

/**
 * `on` / `off`, judged by the value the digital reads.
 *
 * Any other value contradicts. The named value matches, unless the digital is
 * simply resting there: a switch at its usual value with nothing happening is
 * what every healthy machine shows, so it is silent — the same score as an
 * absent signal — rather than a free match, until the weight of a resting
 * state is settled.
 */
function judgeReading(on: boolean, observed: ObservedBuckets, context: MatchContext): Verdict {
  const value = digitalValue(observed, context);
  if (value === undefined) return "silent";
  if (value !== on) return "contradiction";
  return resting(observed) ? "silent" : "match";
}

/**
 * `stays_on` / `stays_off`: the named value with no transition in the window.
 * A single transition contradicts it, whichever way it went.
 */
function judgeHolding(on: boolean, observed: ObservedBuckets, context: MatchContext): Verdict {
  if (transitioned(observed.trend)) return "contradiction";
  return judgeReading(on, observed, context);
}

/**
 * `toggles` means transitions. A digital that cannot move (`stuck`), or holds
 * a rare value through its whole window, denies it; one resting at its usual
 * value is silent.
 */
function judgeToggling(observed: ObservedBuckets): Verdict {
  if (transitioned(observed.trend)) return "match";
  if (observed.trend === "stuck") return "contradiction";
  return resting(observed) ? "silent" : "contradiction";
}

/**
 * `no_pulse` means stuck: the `stuck` trend, or a rare value held through the
 * whole window, shows it; a transition denies it; a digital resting at its
 * usual value is silent.
 */
function judgeNoPulse(observed: ObservedBuckets): Verdict {
  if (observed.trend === "stuck") return "match";
  if (transitioned(observed.trend)) return "contradiction";
  return resting(observed) ? "silent" : "match";
}

/** What one expected movement counts as against the observation of its target. */
function judge(test: WordTest, observed: ObservedBuckets, context: MatchContext): Verdict {
  switch (test.kind) {
    case "state":
      return judgeState(test.side, observed);
    case "movement":
      return judgeMovement(test.side, observed);
    case "steady":
      return judgeSteady(observed);
    case "unsettled":
      return judgeUnsettled(observed);
    case "reads":
      return judgeReading(test.on, observed, context);
    case "holds":
      return judgeHolding(test.on, observed, context);
    case "toggles":
      return judgeToggling(observed);
    case "no_pulse":
      return judgeNoPulse(observed);
  }
}

/** A contradiction costs half a match. */
const CONTRADICTION_WEIGHT = 0.5;

/**
 * Score one candidate's expected movements against what was observed.
 *
 * `score` is `(matches − contradictions / 2) / moves` clamped to 0…1, so it
 * reads as "how much of this cause's signature is on the machine right now".
 * A candidate with no movements at all scores zero rather than dividing by
 * nothing: the catalog schema forbids that entry, and a defensive zero is
 * better than a NaN travelling into a probability.
 *
 * `context` is the mode the observations were read in, passed by both callers
 * from the same event; only the digital words read it.
 */
export function scoreSignalMoves(
  observations: readonly ObservedBuckets[],
  moves: readonly SignalMove[],
  context: MatchContext,
): SignalMoveScore {
  const bySignal = new Map<string, ObservedBuckets>();
  for (const observation of observations) bySignal.set(observation.signal, observation);

  let matches = 0;
  let contradictions = 0;
  for (const move of moves) {
    const target = moveTarget(move);
    const observed = target === undefined ? undefined : bySignal.get(target);
    if (observed === undefined) continue;
    const verdict = judge(DIRECTION_TESTS[move.direction], observed, context);
    if (verdict === "match") matches += 1;
    else if (verdict === "contradiction") contradictions += 1;
  }

  const moveCount = moves.length;
  const raw = moveCount === 0 ? 0 : (matches - CONTRADICTION_WEIGHT * contradictions) / moveCount;
  return { score: Math.min(1, Math.max(0, raw)), matches, contradictions, moves: moveCount };
}
