// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The manual's words against detection's buckets.
 *
 * The tables below are the contract between two vocabularies nobody can change
 * independently: the manual writes `not_reached`, detection writes `far below normal`,
 * and every candidate's support and every retrieval ranking rests on the
 * mapping between them. So all twenty-one directions are asserted, in both
 * directions — what counts as a match and what counts as a contradiction — and
 * so is silence, which is what a state word says about a normal level and what
 * a digital resting at its usual value says about any word.
 *
 * The digitals are the register map's own tags, read in an explicit mode:
 * their level only says whether the value they read is common or rare in that
 * mode (`detection/buckets.ts`), so the same observation means different things
 * while loaded and while idling.
 */

import { describe, expect, it } from "vitest";

import type { MachineMode, SignalMove } from "@fdp/contracts";

import {
  fromContractLevel,
  fromContractTrend,
  matchContextOf,
  moveTarget,
  observedFromEvent,
  parseObservedBuckets,
  scoreSignalMoves,
} from "./match.ts";
import type { MatchContext, ObservedBuckets } from "./types.ts";
import type { Level, Trend } from "../detection/types.ts";

type Direction = SignalMove["direction"];
type Verdict = "match" | "contradiction" | "neither";

const SIGNAL = "line_pressure";

/** The mode the analog rows are read in; an analog word never reads it. */
const LOADED: MatchContext = { mode: "loaded" };

function observed(level: Level, trend: Trend): ObservedBuckets[] {
  return [{ signal: SIGNAL, level, trend }];
}

function move(direction: Direction): SignalMove {
  return { signal: SIGNAL, direction };
}

/** What one movement against one observation of `signal`, read in `mode`, counted as. */
function verdict(
  direction: Direction,
  level: Level,
  trend: Trend,
  signal = SIGNAL,
  mode: MachineMode = "loaded",
): Verdict {
  const score = scoreSignalMoves([{ signal, level, trend }], [{ signal, direction }], { mode });
  if (score.matches === 1) return "match";
  if (score.contradictions === 1) return "contradiction";
  return "neither";
}

/** The eleven words that say where a signal sits. */
const STATE_WORDS: readonly Direction[] = [
  "high",
  "low",
  "near_zero",
  "not_venting",
  "higher",
  "lower",
  "longer",
  "shorter",
  "faster",
  "slower",
  "not_reached",
];

const TRENDS: readonly Trend[] = [
  "rising_sharply",
  "rising",
  "flat",
  "falling",
  "falling_sharply",
  "stuck",
  "erratic",
];

/** Analog signals and behaviours; the mode never matters to these words. */
const ANALOG_TABLE: readonly [Direction, Level, Trend, Verdict][] = [
  // A movement word: sitting above the band or climbing is moving up.
  ["rises", "far_above_normal", "flat", "match"],
  ["rises", "normal", "rising", "match"],
  ["rises", "normal", "falling", "contradiction"],
  ["rises", "below_normal", "flat", "contradiction"],
  ["rises", "normal", "flat", "neither"],

  // …and the mirror image.
  ["falls", "below_normal", "flat", "match"],
  ["falls", "normal", "falling", "match"],
  ["falls", "above_normal", "flat", "contradiction"],
  ["falls", "normal", "rising", "contradiction"],

  // A state word reads the level alone: a normal level is silent however it moves.
  ["high", "above_normal", "flat", "match"],
  ["high", "above_normal", "falling", "match"],
  ["high", "far_below_normal", "flat", "contradiction"],
  ["high", "normal", "flat", "neither"],
  ["high", "normal", "rising", "neither"],
  ["low", "far_below_normal", "flat", "match"],
  ["low", "above_normal", "flat", "contradiction"],
  ["low", "normal", "rising", "neither"],
  ["low", "normal", "falling", "neither"],

  // "Stays where it was" is the only direction any movement contradicts.
  ["unchanged", "normal", "flat", "match"],
  ["unchanged", "above_normal", "flat", "contradiction"],
  ["unchanged", "normal", "rising", "contradiction"],
  ["unchanged", "normal", "erratic", "contradiction"],
  ["unchanged", "normal", "stuck", "contradiction"],

  // Fluctuating is a trend, not a level.
  ["fluctuates", "normal", "erratic", "match"],
  ["fluctuates", "normal", "flat", "contradiction"],
  ["fluctuates", "above_normal", "rising", "neither"],

  // A line that should have emptied and a line that should have vented.
  ["near_zero", "far_below_normal", "flat", "match"],
  ["near_zero", "above_normal", "flat", "contradiction"],
  ["near_zero", "normal", "falling", "neither"],
  ["not_venting", "above_normal", "flat", "match"],
  ["not_venting", "below_normal", "flat", "contradiction"],

  // The behaviour directions, which the manual uses for the derived signals.
  ["higher", "above_normal", "flat", "match"],
  ["lower", "below_normal", "flat", "match"],
  ["longer", "far_above_normal", "flat", "match"],
  ["longer", "normal", "rising", "neither"],
  ["shorter", "far_below_normal", "flat", "match"],
  ["faster", "above_normal", "flat", "match"],
  ["faster", "below_normal", "rising", "contradiction"],
  ["slower", "below_normal", "flat", "match"],
  ["not_reached", "far_below_normal", "flat", "match"],
  ["not_reached", "far_above_normal", "flat", "contradiction"],
  ["not_reached", "normal", "falling", "neither"],
];

/**
 * The register map's digitals, each read in the mode that gives the row its
 * meaning. The usual values come from the first month (`baseline.ts`):
 * `low_pressure_switch` rests off in every state, `oil_level_ok`,
 * `purge_switch` and `flow_pulse` rest on, `regulator_contact` and
 * `intake_closed` rest off while loaded and on otherwise, `load_valve` the
 * other way round, and the dryer tower reads either value while loaded.
 */
const DIGITAL_TABLE: readonly [string, MachineMode, Direction, Level, Trend, Verdict][] = [
  // `on` / `off`: the value decides; a digital resting on the named value is silent.
  ["low_pressure_switch", "loaded", "on", "normal", "flat", "contradiction"],
  ["low_pressure_switch", "loaded", "on", "far_above_normal", "flat", "match"],
  ["low_pressure_switch", "unloaded", "off", "normal", "flat", "neither"],
  ["oil_level_ok", "off", "off", "normal", "flat", "contradiction"],
  ["oil_level_ok", "loaded", "off", "far_below_normal", "flat", "match"],
  ["oil_level_ok", "loaded", "on", "normal", "flat", "neither"],
  // Not resting: it has just gone to its usual value, and the value is what counts.
  ["load_valve", "off", "off", "normal", "falling", "match"],
  ["load_valve", "loaded", "off", "normal", "flat", "contradiction"],
  // Both values are ordinary for the tower while loaded, and an unknown state has no band.
  ["dryer_tower", "loaded", "on", "normal", "flat", "neither"],
  ["regulator_contact", "unknown", "off", "normal", "flat", "neither"],

  // `stays_on` / `stays_off`: any transition contradicts, and so does the other value.
  ["purge_switch", "loaded", "stays_on", "normal", "rising", "contradiction"],
  ["purge_switch", "loaded", "stays_on", "normal", "flat", "neither"],
  ["purge_switch", "loaded", "stays_on", "below_normal", "flat", "contradiction"],
  ["intake_closed", "loaded", "stays_on", "far_above_normal", "flat", "match"],
  ["intake_closed", "loaded", "stays_on", "far_above_normal", "rising", "contradiction"],
  ["regulator_contact", "loaded", "stays_off", "normal", "flat", "neither"],
  ["regulator_contact", "unloaded", "stays_off", "normal", "flat", "contradiction"],
  ["regulator_contact", "unloaded", "stays_off", "far_below_normal", "flat", "match"],
  ["load_valve", "loaded", "stays_on", "normal", "erratic", "contradiction"],

  // `toggles` means transitions.
  ["dryer_tower", "loaded", "toggles", "normal", "rising", "match"],
  ["dryer_tower", "loaded", "toggles", "normal", "falling", "match"],
  ["flow_pulse", "loaded", "toggles", "normal", "erratic", "match"],
  ["dryer_tower", "unloaded", "toggles", "normal", "flat", "neither"],
  ["dryer_tower", "unloaded", "toggles", "far_below_normal", "flat", "contradiction"],
  ["dryer_tower", "unloaded", "toggles", "normal", "stuck", "contradiction"],

  // `no_pulse` means stuck, or a rare value held through the window.
  ["purge_switch", "loaded", "no_pulse", "normal", "stuck", "match"],
  ["flow_pulse", "loaded", "no_pulse", "far_below_normal", "flat", "match"],
  ["flow_pulse", "loaded", "no_pulse", "normal", "rising", "contradiction"],
  ["flow_pulse", "loaded", "no_pulse", "normal", "flat", "neither"],
];

describe("scoreSignalMoves: the contracts' direction vocabulary", () => {
  it.each(ANALOG_TABLE)("%s against %s / %s is a %s", (direction, level, trend, expected) => {
    expect(verdict(direction, level, trend)).toBe(expected);
  });

  it.each(DIGITAL_TABLE)(
    "%s while %s: %s against %s / %s is a %s",
    (signal, mode, direction, level, trend, expected) => {
      expect(verdict(direction, level, trend, signal, mode)).toBe(expected);
    },
  );

  it("covers every direction the contract allows", () => {
    const covered = new Set([
      ...ANALOG_TABLE.map(([direction]) => direction),
      ...DIGITAL_TABLE.map(([, , direction]) => direction),
    ]);
    const declared: readonly Direction[] = [
      "rises",
      "falls",
      "high",
      "low",
      "unchanged",
      "fluctuates",
      "near_zero",
      "not_venting",
      "on",
      "off",
      "stays_on",
      "stays_off",
      "toggles",
      "no_pulse",
      "higher",
      "lower",
      "longer",
      "shorter",
      "faster",
      "slower",
      "not_reached",
    ];
    expect([...covered].sort()).toEqual([...declared].sort());
  });

  it("reads every state word on the level alone: a normal level is silent whatever the trend", () => {
    for (const direction of STATE_WORDS) {
      for (const trend of TRENDS) {
        expect(verdict(direction, "normal", trend), `${direction} / ${trend}`).toBe("neither");
      }
    }
  });
});

describe("scoreSignalMoves: the word semantics", () => {
  /** The score of `moves` with and without `resting` among the observations. */
  function withAndWithout(
    resting: ObservedBuckets,
    moves: readonly SignalMove[],
    context: MatchContext,
  ): { readonly present: unknown; readonly absent: unknown } {
    const others: ObservedBuckets[] = [
      { signal: "dryer_purge_pressure", level: "far_above_normal", trend: "flat" },
    ];
    return {
      present: scoreSignalMoves([resting, ...others], moves, context),
      absent: scoreSignalMoves(others, moves, context),
    };
  }

  it("contradicts stays_on when the purge switch made one transition", () => {
    expect(verdict("stays_on", "normal", "rising", "purge_switch")).toBe("contradiction");
  });

  it("scores the purge switch resting on as if it were absent", () => {
    const { present, absent } = withAndWithout(
      { signal: "purge_switch", level: "normal", trend: "flat" },
      [
        { signal: "purge_switch", direction: "stays_on" },
        { signal: "dryer_purge_pressure", direction: "high" },
      ],
      LOADED,
    );
    expect(present).toEqual(absent);
    expect(present).toEqual({ score: 0.5, matches: 1, contradictions: 0, moves: 2 });
  });

  it("scores the regulator contact at its usual off value while loaded as if it were absent", () => {
    const { present, absent } = withAndWithout(
      { signal: "regulator_contact", level: "normal", trend: "flat" },
      [
        { signal: "regulator_contact", direction: "stays_off" },
        { signal: "dryer_purge_pressure", direction: "high" },
      ],
      LOADED,
    );
    expect(present).toEqual(absent);
  });

  it("contradicts on when the low-pressure switch is normal and flat", () => {
    expect(verdict("on", "normal", "flat", "low_pressure_switch")).toBe("contradiction");
  });

  it("contradicts off when the oil level switch is normal", () => {
    expect(verdict("off", "normal", "flat", "oil_level_ok")).toBe("contradiction");
  });

  it("finds a normal, falling line pressure silent for low and a match for falls", () => {
    expect(verdict("low", "normal", "falling", "line_pressure")).toBe("neither");
    expect(verdict("falls", "normal", "falling", "line_pressure")).toBe("match");
  });

  it("finds high silent at a normal level with a rising trend", () => {
    expect(verdict("high", "normal", "rising")).toBe("neither");
  });

  it("judges each observation in the mode it is given, and carries nothing between calls", () => {
    const contact: ObservedBuckets[] = [
      { signal: "regulator_contact", level: "normal", trend: "flat" },
    ];
    const moves: SignalMove[] = [{ signal: "regulator_contact", direction: "stays_off" }];
    const loaded = scoreSignalMoves(contact, moves, { mode: "loaded" });
    const unloaded = scoreSignalMoves(contact, moves, { mode: "unloaded" });

    expect(loaded.contradictions).toBe(0);
    expect(unloaded.contradictions).toBe(1);
    expect(scoreSignalMoves(contact, moves, { mode: "loaded" })).toEqual(loaded);
  });

  it("takes the context from the event's machine state", () => {
    const context = matchContextOf({
      machine_state: { mode: "off", since_sim_ts: "2020-02-03T04:00:00.000Z" },
    });
    expect(context).toEqual({ mode: "off" });
  });
});

describe("scoreSignalMoves: the score itself", () => {
  it("is the share of movements that are on the machine", () => {
    const score = scoreSignalMoves(
      [
        { signal: "line_pressure", level: "below_normal", trend: "flat" },
        { signal: "oil_temperature", level: "above_normal", trend: "rising" },
      ],
      [
        { signal: "line_pressure", direction: "low" },
        { signal: "oil_temperature", direction: "rises" },
        { signal: "motor_current", direction: "low" },
        { behaviour: "load_cycle_rate", direction: "higher" },
      ],
      LOADED,
    );
    expect(score).toEqual({ score: 0.5, matches: 2, contradictions: 0, moves: 4 });
  });

  it("does not count a signal the observations never mention", () => {
    const absent = scoreSignalMoves([], [{ signal: "line_pressure", direction: "low" }], LOADED);
    expect(absent).toEqual({ score: 0, matches: 0, contradictions: 0, moves: 1 });
  });

  it("charges a contradiction half a match", () => {
    const score = scoreSignalMoves(
      observed("above_normal", "flat"),
      [move("low"), move("low")],
      LOADED,
    );
    expect(score.contradictions).toBe(2);
    expect(score.score).toBe(0);
  });

  it("never falls below zero however wrong the candidate is", () => {
    const score = scoreSignalMoves(
      [
        { signal: "line_pressure", level: "above_normal", trend: "rising" },
        { signal: "oil_temperature", level: "below_normal", trend: "falling" },
      ],
      [
        { signal: "line_pressure", direction: "low" },
        { signal: "oil_temperature", direction: "high" },
      ],
      LOADED,
    );
    expect(score.score).toBe(0);
  });

  it("scores a candidate with no movements at zero rather than dividing by nothing", () => {
    expect(scoreSignalMoves(observed("normal", "flat"), [], LOADED).score).toBe(0);
  });

  it("reads a behaviour movement by its behaviour id", () => {
    const score = scoreSignalMoves(
      [{ signal: "load_cycle_rate", level: "above_normal", trend: "flat" }],
      [{ behaviour: "load_cycle_rate", direction: "higher" }],
      LOADED,
    );
    expect(score.matches).toBe(1);
  });
});

describe("moveTarget", () => {
  it("names the signal or the behaviour, whichever the movement carries", () => {
    expect(moveTarget({ signal: "line_pressure", direction: "low" })).toBe("line_pressure");
    expect(moveTarget({ behaviour: "cut_out_reached", direction: "not_reached" })).toBe(
      "cut_out_reached",
    );
  });
});

describe("reading buckets back", () => {
  it("maps the contract's coarser enums onto the internal words", () => {
    expect(fromContractLevel("far_above")).toBe("far_above_normal");
    expect(fromContractLevel("normal")).toBe("normal");
    expect(fromContractLevel("unknown")).toBeUndefined();
    expect(fromContractTrend("stuck")).toBe("stuck");
    expect(fromContractTrend("unknown")).toBeUndefined();
  });

  it("drops an observation detection could not place", () => {
    const read = observedFromEvent([
      { signal: "line_pressure", level: "below", trend: "flat" },
      { signal: "motor_current", level: "unknown", trend: "flat" },
      { signal: "oil_temperature", level: "normal", trend: "unknown" },
    ]);
    expect(read).toEqual([{ signal: "line_pressure", level: "below_normal", trend: "flat" }]);
  });

  it("reads the three words the state carries", () => {
    const read = parseObservedBuckets([
      {
        signal: "dryer_purge_pressure",
        level: "far above normal",
        trend: "flat",
        since: "about an hour",
      },
      { signal: "motor_current", level: "unknown", trend: "flat", since: "minutes" },
    ]);
    expect(read).toEqual([
      { signal: "dryer_purge_pressure", level: "far_above_normal", trend: "flat" },
    ]);
  });
});
