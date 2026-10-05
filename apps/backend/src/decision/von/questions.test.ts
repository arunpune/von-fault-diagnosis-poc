// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Von question set, checked without a model.
 *
 * Nothing here asks whether Von answers well — that is for the evaluation on
 * labelled events. What is asserted is everything a question must be
 * before it is worth asking, over every labelled event
 * rather than one hand-picked case:
 *
 *  * the ids and the answer space are the ones code reads (`fault`,
 *    `match_<fault_id>`, `severity`; candidate ids plus `none_of_these`);
 *  * every path a question names is one it inspects, and every path it
 *    inspects exists (both directions);
 *  * no numeral reaches the model — the only digits in the request are the
 *    register tags and controller codes the manual prints, which name things
 *    rather than rank them;
 *  * each `match_*` criterion asks about the one movement its instruction asks
 *    about, the abstention is neutral and example-free, and the severity
 *    levels describe situations rather than actions;
 *  * each option of the Choice is told apart from the causes beside it in the
 *    catalog's own sentences — its paragraph and note, and its neighbours'
 *    notes where the manual wrote one for both under the symptom — never
 *    quotes another cause's name, and never tells an option it does not apply
 *    to a movement it expects itself, its own defining movement
 *    included: that movement is denied by the reading its word rules out,
 *    never by the normal reading a held, silent, toggling, steady or
 *    fluctuating signal gives;
 *  * the whole request fits its budget, over the fixture cases and over
 *    every condition of the manual's catalog.
 */

import { describe, expect, it } from "vitest";

import { ALARMS, SIGNALS } from "@fdp/contracts";
import type { CatalogEntry } from "@fdp/contracts";

import {
  FIXTURE_CATALOG,
  FIXTURE_LABELS,
  catalogEntry,
} from "../../../test/fixtures/catalog/index.ts";
import {
  MAN_CATALOG,
  asCandidates,
  causesUnder,
  manEntry,
} from "../../../test/fixtures/catalog/man/index.ts";
import { SIGNATURE_A_EVENT } from "../../../test/fixtures/catalog/events.ts";
import { goldenInput, VON_CASES } from "../../../test/fixtures/von/cases.ts";
import { moveTarget } from "../../retrieval/match.ts";
import type { Candidate } from "../../retrieval/types.ts";
import {
  buildState,
  definingMovePath,
  estimateTokens,
  resolveStatePath,
  STATE_TOKEN_BUDGET,
} from "../state.ts";
import type { DecisionState } from "../state.ts";
import { NONE_OF_THESE } from "../types.ts";
import type { DecisionInput } from "../types.ts";
import {
  buildQuestions,
  estimateQuestionTokens,
  FAULT_QUESTION_ID,
  LONGEST_QUESTION_TOKEN_BUDGET,
  longestQuestionTokens,
  matchQuestionId,
  REQUEST_TOKEN_BUDGET,
  SEVERITY_QUESTION_ID,
} from "./questions.ts";
import type { VonQuestions } from "./questions.ts";

/** The instruction object every question of this set carries. */
interface Instructions {
  readonly question: string;
  readonly inspect: readonly string[];
  readonly focus?: string;
  readonly note?: string;
}

/** A contrastive Choice criterion. */
interface ChoiceCriterion {
  readonly what: string;
  readonly signals?: readonly string[];
  readonly not_for?: readonly string[];
  readonly examples?: readonly string[];
}

/**
 * The condition whose notes a decision's criteria quote: the event's symptom,
 * the condition every candidate is offered under. Co-symptoms add none, so the
 * number of rules that fire cannot grow the request.
 */
function shownConditions(input: DecisionInput): readonly string[] {
  return [input.event.symptom_key];
}

/** A cause's per-(condition, cause) notes under those conditions, in that order. */
function notesUnder(entry: CatalogEntry, conditions: readonly string[]): string[] {
  return conditions.flatMap((conditionId) => {
    const note = entry.conditions.find((condition) => condition.condition_id === conditionId)?.note;
    return note === undefined ? [] : [note];
  });
}

/** The note a cause prints after its movement of `target`. */
function remarkOn(entry: CatalogEntry, target: string): string | undefined {
  return entry.signal_moves.find((move) => moveTarget(move) === target)?.note;
}

/** A movement as the catalog keys it: its signal or behaviour and its direction. */
function movementOf(move: CatalogEntry["signal_moves"][number]): string {
  return `${moveTarget(move) ?? ""} ${move.direction}`;
}

/**
 * Every sentence `catalog` attaches to a movement `entry` expects itself.
 *
 * A cause's remark on a movement describes how that movement looks when that
 * cause is behind it. Put in the `not_for` of an option that expects the same
 * movement, it tells the model the option does not apply to evidence the
 * option's own `signals` list: the opposite of a contrast.
 */
function remarksOnOwnMovements(entry: CatalogEntry, catalog: readonly CatalogEntry[]): Set<string> {
  const own = new Set(entry.signal_moves.map((move) => movementOf(move)));
  return new Set(
    catalog.flatMap((other) =>
      other.signal_moves.flatMap((move) =>
        move.note !== undefined && own.has(movementOf(move)) ? [move.note] : [],
      ),
    ),
  );
}

/** Every note any of `entries` attaches to one of its movements. */
function moveNotesOf(entries: readonly CatalogEntry[]): Set<string> {
  return new Set(
    entries.flatMap((entry) =>
      entry.signal_moves.flatMap((move) => (move.note === undefined ? [] : [move.note])),
    ),
  );
}

/** A decision whose candidates `change` rewrote, event and unit untouched. */
function withCandidates(
  input: DecisionInput,
  change: (candidate: Candidate) => Candidate,
): DecisionInput {
  return { ...input, candidates: input.candidates.map(change) };
}

/** One of the contract's "at least one" lists, mapped element by element. */
function mapNonEmpty<T, U>(list: readonly [T, ...T[]], map: (item: T) => U): [U, ...U[]] {
  const [first, ...rest] = list;
  return [map(first), ...rest.map(map)];
}

/** How many signals or behaviours two causes both expect to move. */
function sharedTargets(left: CatalogEntry, right: CatalogEntry): number {
  const targets = new Set(left.signal_moves.map((move) => moveTarget(move)));
  return new Set(right.signal_moves.map((move) => moveTarget(move)).filter((t) => targets.has(t)))
    .size;
}

/** One side of a Noul. */
interface NoulSide {
  readonly what: string;
  readonly examples: readonly string[];
}

function instructionsOf(questions: VonQuestions, id: string): Instructions {
  return questions[id]?.instructions as unknown as Instructions;
}

function choiceCriteria(questions: VonQuestions): Readonly<Record<string, ChoiceCriterion>> {
  return questions[FAULT_QUESTION_ID]?.criteria as unknown as Record<string, ChoiceCriterion>;
}

function noulSides(questions: VonQuestions, id: string): { true: NoulSide; false: NoulSide } {
  return questions[id]?.criteria as unknown as { true: NoulSide; false: NoulSide };
}

/** Every string inside a JSON value, depth first. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsOf(item));
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap((item) => stringsOf(item));
  }
  return [];
}

/**
 * The identifiers that legitimately carry a digit: register tags such as `P4`
 * and controller codes such as `W102`. The manual prints both next to the
 * name they stand for, and a technician reads them as names, never as levels.
 */
const IDENTIFIERS = new RegExp(
  `\\b(?:${[...SIGNALS.map((signal) => signal.label), ...ALARMS.map((alarm) => alarm.code)].join("|")})\\b`,
  "g",
);

/** An index inside a state path, `candidates[1]`: a position, not a quantity. */
const PATH_INDEX = /(?<=[A-Za-z_\]])\[\d+\]/g;

/** What is left of a string once its identifiers and path indexes are taken out. */
function withoutIdentifiers(text: string): string {
  return text.replace(IDENTIFIERS, "").replace(PATH_INDEX, "");
}

/** The backticked paths of an instruction string. */
function backtickedPaths(text: string | undefined): string[] {
  if (text === undefined) return [];
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

/**
 * Whether `path` points inside the part of the state `root` names.
 *
 * `root` itself and anything under it count (`candidates[1].expected_signal_moves[0]`
 * under `candidates[1].expected_signal_moves`), and so does a field every
 * element of an inspected list carries (`expected_signal_moves` under
 * `candidates`), which is how a question names a field of each candidate.
 */
function isInside(state: DecisionState, root: string, path: string): boolean {
  if (path === root || path.startsWith(`${root}.`) || path.startsWith(`${root}[`)) {
    return resolveStatePath(state, path) !== undefined;
  }
  const value = resolveStatePath(state, root);
  if (!Array.isArray(value) || value.length === 0) return false;
  // `resolveStatePath` walks any JSON value; an element is read the same way.
  return value.every(
    (element) => resolveStatePath(element as unknown as DecisionState, path) !== undefined,
  );
}

const STOP_WORDS = new Set(["the", "a", "an", "of", "per", "how", "is", "at", "in", "to"]);

/** The content words of a text, lower-cased. */
function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length > 0 && !STOP_WORDS.has(word)),
  );
}

/** The direction words of the move vocabulary and the bucket vocabulary. */
const DIRECTION_WORDS = [
  "rises",
  "falls",
  "high",
  "low",
  "above",
  "below",
  "higher",
  "lower",
  "faster",
  "slower",
  "longer",
  "shorter",
  "unchanged",
  "rising",
  "falling",
  "fluctuates",
  "stuck",
];

/** Tokens an all-movements criterion used; a single-movement one has none. */
const ALL_MOVES_TOKENS = [/\beach\b/i, /\bat least one\b/i, /\bthe other expected\b/i];

/** How a single-movement criterion names its direction. */
const DIRECTION_PHRASES = [/\bthat direction\b/g, /\bthe other way\b/g];

/** Action policy the severity levels must not carry. */
const POLICY_PHRASES = [
  /\bplan\b/i,
  /\bintervention\b/i,
  /\bschedule\b/i,
  /\bnext service\b/i,
  /\bwithin days\b/i,
  /\bimmediately\b/i,
  /\breplace\b/i,
  /\brepair\b/i,
  /\bcheck\b/i,
];

/** Words that only make sense next to a neighbouring level. */
const RELATIVE_PHRASES = [/\bprevious\b/i, /\bnext level\b/i, /\bworse\b/i, /\bmilder\b/i];

describe.each(VON_CASES)("buildQuestions: $name", ({ input }) => {
  const state = buildState(input, FIXTURE_LABELS);
  const questions = buildQuestions(state, input);
  const candidateIds = state.candidates.map((candidate) => candidate.id);

  it("asks the cause, one movement per candidate and the severity, in that order", () => {
    expect(Object.keys(questions)).toEqual([
      FAULT_QUESTION_ID,
      ...candidateIds.map((id) => matchQuestionId(id)),
      SEVERITY_QUESTION_ID,
    ]);
    expect(questions[FAULT_QUESTION_ID]?.type).toBe("choice");
    for (const id of candidateIds) expect(questions[matchQuestionId(id)]?.type).toBe("noul");
    expect(questions[SEVERITY_QUESTION_ID]?.type).toBe("score");
  });

  it("offers every candidate and the abstention as the Choice's options", () => {
    expect(Object.keys(choiceCriteria(questions))).toEqual([...candidateIds, NONE_OF_THESE]);
  });

  it("inspects only paths that resolve, and names only paths it inspects", () => {
    for (const id of Object.keys(questions)) {
      const instructions = instructionsOf(questions, id);
      expect(instructions.inspect.length, id).toBeGreaterThan(0);
      for (const path of instructions.inspect) {
        expect(resolveStatePath(state, path), `${id} inspects ${path}`).toBeDefined();
      }
      const named = [
        ...backtickedPaths(instructions.question),
        ...backtickedPaths(instructions.focus),
        ...backtickedPaths(instructions.note),
      ];
      expect(named.length, `${id} names no state path`).toBeGreaterThan(0);
      for (const path of named) {
        const covered = instructions.inspect.some((root) => isInside(state, root, path));
        expect(covered, `${id} names ${path} without inspecting it`).toBe(true);
      }
    }
  });

  it("puts no numeral in any criteria, instruction or state string", () => {
    const texts = [...stringsOf(state), ...stringsOf(questions)];
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(withoutIdentifiers(text), text).not.toMatch(/\d/);
  });

  it("fits the whole-request budget", () => {
    const stateTokens = estimateTokens(state);
    expect(stateTokens).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
    expect(stateTokens + estimateQuestionTokens(questions)).toBeLessThanOrEqual(
      REQUEST_TOKEN_BUDGET,
    );
    expect(stateTokens + longestQuestionTokens(questions)).toBeLessThanOrEqual(
      LONGEST_QUESTION_TOKEN_BUDGET,
    );
  });

  it("asks each candidate's Noul about its defining movement only", () => {
    state.candidates.forEach((candidate, index) => {
      const id = matchQuestionId(candidate.id);
      const named = backtickedPaths(instructionsOf(questions, id).question);
      expect(named.filter((path) => path.startsWith("candidates"))).toEqual([
        definingMovePath(index),
      ]);
    });
  });

  it("gives every match criterion one signal and one direction, as its instruction does", () => {
    for (const id of candidateIds) {
      const sides = noulSides(questions, matchQuestionId(id));
      for (const side of [sides.true, sides.false]) {
        expect(side.what.match(/\bsignal\b/gi), side.what).toHaveLength(1);
        const directions = DIRECTION_PHRASES.flatMap((phrase) => side.what.match(phrase) ?? []);
        expect(directions, side.what).toHaveLength(1);
        for (const text of [side.what, ...side.examples]) {
          for (const token of ALL_MOVES_TOKENS) expect(text, text).not.toMatch(token);
        }
      }
    }
  });

  it("keeps the abstention neutral and example-free", () => {
    const abstention = choiceCriteria(questions)[NONE_OF_THESE];
    expect(abstention).toBeDefined();
    expect(abstention).not.toHaveProperty("examples");
    expect(Object.keys(abstention ?? {}).sort()).toEqual(["not_for", "what"]);

    // Nothing in it is a signal or a direction any candidate or observation
    // uses, so it can never be entailed by one candidate's expected movements.
    const specific = new Set([
      ...DIRECTION_WORDS,
      ...state.observations.flatMap((observation) => [...contentWords(observation.label)]),
      ...Object.values(FIXTURE_LABELS).flatMap((label) => [...contentWords(label)]),
    ]);
    for (const text of stringsOf(abstention)) {
      const shared = [...contentWords(text)].filter((word) => specific.has(word));
      expect(shared, text).toEqual([]);
    }
  });

  it("describes situations in the severity levels, not what to do about them", () => {
    const levels = questions[SEVERITY_QUESTION_ID]?.criteria as unknown as readonly {
      summary: string;
      signals: readonly string[];
    }[];
    expect(levels).toHaveLength(4);
    for (const text of levels.flatMap((level) => [level.summary, ...level.signals])) {
      for (const phrase of [...POLICY_PHRASES, ...RELATIVE_PHRASES]) {
        expect(text, text).not.toMatch(phrase);
      }
    }
  });

  it("describes each option by its cause's name, paragraph and notes", () => {
    const conditions = shownConditions(input);
    for (const entry of input.candidates) {
      const what = choiceCriteria(questions)[entry.fault_id]?.what ?? "";
      expect(what.startsWith(`${entry.name}: ${entry.summary}`), what).toBe(true);
      for (const note of notesUnder(entry, conditions))
        expect(what, entry.fault_id).toContain(note);
    }
  });

  it("contrasts an option only with neighbours' notes, and only where the manual noted it too", () => {
    const conditions = shownConditions(input);
    for (const entry of input.candidates) {
      const [negation, ...contrasts] = choiceCriteria(questions)[entry.fault_id]?.not_for ?? [];
      expect(negation, entry.fault_id).toMatch(/^Cases where /);
      if (notesUnder(entry, conditions).length === 0) {
        expect(contrasts, entry.fault_id).toEqual([]);
        continue;
      }
      const neighbours = input.candidates.filter(
        (other) => other.fault_id !== entry.fault_id && sharedTargets(entry, other) > 0,
      );
      for (const contrast of contrasts) {
        const source = neighbours.find((other) => notesUnder(other, conditions).includes(contrast));
        expect(source, `${entry.fault_id}: ${contrast}`).toBeDefined();
      }
    }
  });

  it("carries a neighbour's note into an option the manual noted under the symptom too", () => {
    const conditions = shownConditions(input);
    for (const entry of input.candidates) {
      if (notesUnder(entry, conditions).length === 0) continue;
      const notFor = choiceCriteria(questions)[entry.fault_id]?.not_for ?? [];
      for (const other of input.candidates) {
        if (other.fault_id === entry.fault_id || sharedTargets(entry, other) === 0) continue;
        for (const note of notesUnder(other, conditions)) {
          if (notesUnder(entry, conditions).includes(note)) continue;
          expect(notFor, `${entry.fault_id} beside ${other.fault_id}`).toContain(note);
        }
      }
    }
  });

  it("never tells an option it does not apply to a movement it expects itself", () => {
    for (const entry of input.candidates) {
      const notFor = choiceCriteria(questions)[entry.fault_id]?.not_for ?? [];
      const remarks = remarksOnOwnMovements(entry, [...FIXTURE_CATALOG, ...input.candidates]);
      for (const text of notFor)
        expect(remarks.has(text), `${entry.fault_id}: ${text}`).toBe(false);
    }
  });

  it("quotes no cause's remark on a movement in any option's not_for", () => {
    const remarks = moveNotesOf(input.candidates);
    for (const [option, criterion] of Object.entries(choiceCriteria(questions))) {
      for (const text of [criterion.not_for ?? []].flat()) {
        expect(remarks.has(text), `${option}: ${text}`).toBe(false);
      }
    }
  });

  it("never quotes one cause's name in another option", () => {
    const criteria = choiceCriteria(questions);
    for (const entry of input.candidates) {
      for (const [option, criterion] of Object.entries(criteria)) {
        if (option === entry.fault_id) continue;
        expect(JSON.stringify(criterion), `${entry.name} in ${option}`).not.toContain(entry.name);
      }
    }
  });

  it("is a pure function of the state and the decision it was built from", () => {
    expect(JSON.stringify(buildQuestions(state, input))).toBe(JSON.stringify(questions));
  });
});

describe("buildQuestions: the wording of each question", () => {
  const input = goldenInput();
  const state = buildState(input, FIXTURE_LABELS);
  const questions = buildQuestions(state, input);

  it("asks the fault Choice, inspecting the candidates it points at", () => {
    expect(instructionsOf(questions, FAULT_QUESTION_ID)).toEqual({
      question:
        "Which candidate in `candidates` has `expected_signal_moves` that match the movements " +
        "listed in `observations`?",
      inspect: ["observations", "controller_alarms", "candidates"],
      focus:
        "Match the direction of each movement, not its cause. A candidate whose expected " +
        "movements point the wrong way, or expect a movement that is absent, does not match.",
      note: "Choose none_of_these when no candidate's expected movements fit.",
    });
  });

  it("describes each cause contrastively, from the catalog and the move vocabulary", () => {
    // The golden event's symptom is `continuous_load` (`purge_pressure_high`
    // fires beside it and adds no note). In this fixture only the purge valve
    // has a note under that condition, so the manual wrote no distinction for
    // any pair of the options: each keeps its own note in `what` and its
    // negated defining movement in `not_for`, and quotes nothing of its
    // neighbours'.
    const conditions = ["continuous_load"];
    expect(shownConditions(input)).toEqual(conditions);
    expect(input.event.co_symptoms).toEqual(["purge_pressure_high"]);
    const valve = catalogEntry("dryer_purge_leak");
    const plant = catalogEntry("downstream_air_leak");
    const demand = catalogEntry("high_air_demand");
    for (const entry of input.candidates) {
      const noted = entry.fault_id === valve.fault_id ? 1 : 0;
      expect(notesUnder(entry, conditions), entry.fault_id).toHaveLength(noted);
    }
    expect(choiceCriteria(questions)["dryer_purge_leak"]).toEqual({
      what: `${valve.name}: ${[valve.summary, ...notesUnder(valve, conditions)].join(" ")}`,
      signals: valve.signal_moves_text,
      not_for: ["Cases where dryer purge pressure stays normal"],
    });
    // The busy plant expects the purge pressure unchanged, as the plant leak
    // does. The leak's remark on that movement ("… the dryer is innocent")
    // stays in the leak's own `signals` and never tells the busy plant that it
    // does not apply to a movement it expects itself.
    const innocent = remarkOn(plant, "dryer_purge_pressure");
    expect(innocent).toBeDefined();
    expect(remarksOnOwnMovements(demand, [plant]).has(innocent ?? "")).toBe(true);
    expect(choiceCriteria(questions)["downstream_air_leak"]?.signals?.join(" ")).toContain(
      innocent,
    );
    expect(choiceCriteria(questions)["high_air_demand"]?.not_for).toEqual([
      "Cases where how often the compressor loads per hour stays normal",
    ]);
  });

  it("states a neighbour's note only in an option the manual noted under the symptom too", () => {
    const plant = catalogEntry("downstream_air_leak");
    const valve = catalogEntry("dryer_purge_leak");
    const note = "A sentence the manual wrote to tell this cause from the others here.";
    const noted = withCandidates(input, (candidate) =>
      candidate.fault_id !== plant.fault_id
        ? candidate
        : {
            ...candidate,
            conditions: mapNonEmpty(candidate.conditions, (condition) =>
              condition.condition_id === input.event.symptom_key
                ? { ...condition, note }
                : condition,
            ),
          },
    );
    const criteria = choiceCriteria(buildQuestions(buildState(noted, FIXTURE_LABELS), noted));
    // The valve and the plant leak are both noted under the symptom now, so
    // the manual wrote a distinction for the pair: each carries the other's.
    expect(criteria["dryer_purge_leak"]?.not_for).toEqual([
      "Cases where dryer purge pressure stays normal",
      note,
    ]);
    expect(criteria["downstream_air_leak"]?.not_for?.slice(1)).toEqual(
      notesUnder(valve, [input.event.symptom_key]),
    );
    // No other option has a note of its own there, so neither sentence reaches it.
    for (const entry of noted.candidates) {
      if (entry.fault_id === plant.fault_id || entry.fault_id === valve.fault_id) continue;
      expect(criteria[entry.fault_id]?.not_for, entry.fault_id).toHaveLength(1);
    }
  });

  it("negates a defining movement by the reading that denies its word", () => {
    // A word that moves the signal off its band is denied by the signal
    // staying normal. A word whose own evidence is a normal reading is not: a
    // digital holding its state, giving no pulse or toggling rests at a
    // normal level, `unchanged` is normal and flat, and
    // `fluctuates` is an erratic trend at any level. "Stays normal" would
    // tell the model the option does not apply to the reading its own
    // defining movement produces, so each of those words is negated by the
    // reading the matcher counts against it (`retrieval/match.ts`).
    const valve = catalogEntry("dryer_purge_leak");
    const expected: Readonly<Record<string, string>> = {
      rises: "stays normal",
      falls: "stays normal",
      high: "stays normal",
      low: "stays normal",
      near_zero: "stays normal",
      not_venting: "stays normal",
      on: "stays normal",
      off: "stays normal",
      higher: "stays normal",
      lower: "stays normal",
      longer: "stays normal",
      shorter: "stays normal",
      faster: "stays normal",
      slower: "stays normal",
      not_reached: "stays normal",
      stays_on: "changes state",
      stays_off: "changes state",
      no_pulse: "changes state",
      toggles: "holds one state",
      unchanged: "is above or below normal, or moving",
      fluctuates: "holds steady",
    };
    for (const [direction, denial] of Object.entries(expected)) {
      const moved = withCandidates(input, (candidate) => {
        if (candidate.fault_id !== valve.fault_id) return candidate;
        const [first, ...rest] = candidate.signal_moves;
        return {
          ...candidate,
          signal_moves: [{ ...first, direction: direction as typeof first.direction }, ...rest],
        };
      });
      const criteria = choiceCriteria(buildQuestions(buildState(moved, FIXTURE_LABELS), moved));
      expect(criteria[valve.fault_id]?.not_for?.[0], direction).toBe(
        `Cases where dryer purge pressure ${denial}`,
      );
    }
  });

  it("falls back to the whole signature when the defining signal is not observed", () => {
    const unobserved: DecisionState = { ...state, observations: [] };
    expect(
      choiceCriteria(buildQuestions(unobserved, input))["dryer_purge_leak"]?.not_for?.[0],
    ).toBe("Cases where none of the movements this cause expects appear in the observations");
  });

  it("keeps every move note out of every contrast, the ingested store's words included", () => {
    // The ingested catalog's store writes the onset and phase words into a
    // move's `note`. They are not the manual's remark, and no move note of
    // any kind reaches an option's `not_for`, even where two options are
    // noted under the symptom.
    const stored = withCandidates(input, (candidate) => ({
      ...candidate,
      signal_moves_text: [],
      conditions: mapNonEmpty(candidate.conditions, (condition) =>
        condition.condition_id === input.event.symptom_key
          ? { ...condition, note: `What separates ${candidate.fault_id.replace(/_/g, " ")}.` }
          : condition,
      ),
      signal_moves: mapNonEmpty(candidate.signal_moves, (move) => ({
        ...move,
        note: "sustained, loaded",
      })),
    }));
    const criteria = choiceCriteria(buildQuestions(buildState(stored, FIXTURE_LABELS), stored));
    for (const criterion of Object.values(criteria)) {
      expect([criterion.not_for ?? []].flat(), criterion.what).not.toContain("sustained, loaded");
    }
  });

  it("falls back to the name and the negated movement for a candidate without an entry", () => {
    const bare: DecisionInput = { ...input, candidates: input.candidates.slice(1) };
    const criterion = choiceCriteria(buildQuestions(state, bare))["dryer_purge_leak"];
    expect(criterion).toEqual({
      what: catalogEntry("dryer_purge_leak").name,
      signals: catalogEntry("dryer_purge_leak").signal_moves_text,
      not_for: ["Cases where dryer purge pressure stays normal"],
    });
  });

  it("gives the abstention a contrast and nothing else", () => {
    expect(choiceCriteria(questions)[NONE_OF_THESE]).toEqual({
      what: "No candidate's expected movements match the observations",
      not_for: "Cases where one candidate's expected movements do appear, even partly",
    });
  });

  it("asks each match Noul with single-movement criteria", () => {
    expect(questions[matchQuestionId("purge_silencer_damaged")]).toEqual({
      type: "noul",
      instructions: {
        question:
          "Does `observations` show the movement in `candidates[1].expected_signal_moves[0]`?",
        inspect: ["observations", "candidates[1].expected_signal_moves"],
        focus:
          "Judge that one movement: the same signal moving in the same direction. Ignore the " +
          "other expected movements — code counts those.",
      },
      criteria: {
        true: {
          what: "The observations contain that signal moving in that direction",
          examples: [
            "Expected: line pressure falls faster than normal while unloaded; observed: " +
              "unloaded pressure decay far above normal",
          ],
        },
        false: {
          what: "That signal is absent from the observations, is normal, or moves the other way",
          examples: [
            "Expected: dryer purge pressure far above normal; observed: dryer purge pressure normal",
          ],
        },
      },
    });
  });

  it("asks the severity Score with four situational levels", () => {
    expect(questions[SEVERITY_QUESTION_ID]).toEqual({
      type: "score",
      instructions: {
        question:
          "How serious is the situation described by `observations` and `controller_alarms` " +
          "for the air supply of the plant right now?",
        inspect: ["observations", "controller_alarms", "machine.mode"],
      },
      criteria: [
        {
          summary:
            "Readings drift outside their normal band but the unit still holds line pressure " +
            "and cycles normally",
          signals: [
            "one signal above or below normal",
            "cycle pattern normal",
            "no controller alarm",
          ],
        },
        {
          summary:
            "The unit still holds line pressure but works harder than normal: load cycles more " +
            "frequent or longer, pressure decays faster while unloaded, or a temperature keeps " +
            "rising",
          signals: [
            "load cycle rate above normal",
            "loaded run duration above normal",
            "oil temperature rising",
          ],
        },
        {
          summary:
            "The unit no longer reaches its cut-out pressure or runs loaded continuously, or a " +
            "controller warning is active",
          signals: [
            "loaded run duration far above normal",
            "cut-out not reached",
            "a controller warning is active",
          ],
        },
        {
          summary:
            "Air supply is lost or a shutdown condition is active: line pressure below the " +
            "low-pressure switch, oil temperature far above its limit, or the compressor " +
            "running continuously while line pressure falls",
          signals: [
            "low-pressure switch active",
            "oil temperature far above normal",
            "line pressure falling while loaded",
          ],
        },
      ],
    });
  });
});

/** How much manual text a cause brings into a request: paragraph, movements and notes. */
function textMass(entry: CatalogEntry): number {
  return [
    entry.summary,
    ...entry.signal_moves_text,
    ...entry.conditions.map((condition) => condition.note ?? ""),
  ].join(" ").length;
}

/**
 * Every condition of the manual's catalog, each with the six causes filed under it
 * that bring the most text.
 */
const MAN_CONDITIONS = [
  ...new Set(MAN_CATALOG.flatMap((entry) => entry.conditions.map((c) => c.condition_id))),
].map((conditionId) => {
  const heaviest = [...causesUnder(conditionId)]
    .sort((left, right) => textMass(right) - textMass(left))
    .slice(0, 6);
  // The upper bound on the notes that can apply: every condition any of the
  // six is filed under shown beside the symptom.
  const everyCondition = [
    ...new Set(heaviest.flatMap((entry) => entry.conditions.map((c) => c.condition_id))),
  ].filter((id) => id !== conditionId);
  return { conditionId, causes: asCandidates(heaviest), everyCondition };
});

describe.each(MAN_CONDITIONS)(
  "buildQuestions on the manual's catalog: $conditionId",
  ({ conditionId, causes, everyCondition }) => {
    const variants = [{ co_symptoms: [] as string[] }, { co_symptoms: everyCondition }].map(
      ({ co_symptoms }): DecisionInput => ({
        event: { ...SIGNATURE_A_EVENT, symptom_key: conditionId, co_symptoms },
        candidates: causes,
        unit_id: "cau-7",
      }),
    );

    it.each(
      variants.map((input, index) => ({
        input,
        shown: index === 0 ? "alone" : "with every co-symptom",
      })),
    )("fits the three token budgets with the symptom $shown", ({ input }) => {
      const state = buildState(input, FIXTURE_LABELS);
      const questions = buildQuestions(state, input);
      const stateTokens = estimateTokens(state);
      expect(stateTokens).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
      expect(stateTokens + estimateQuestionTokens(questions)).toBeLessThanOrEqual(
        REQUEST_TOKEN_BUDGET,
      );
      expect(stateTokens + longestQuestionTokens(questions)).toBeLessThanOrEqual(
        LONGEST_QUESTION_TOKEN_BUDGET,
      );
      for (const text of stringsOf(questions)) {
        expect(withoutIdentifiers(text), text).not.toMatch(/\d/);
      }
    });

    it("adds nothing to the Choice for the co-symptoms that fire beside the symptom", () => {
      const [alone, crowded] = variants.map((input) =>
        JSON.stringify(buildQuestions(buildState(input, FIXTURE_LABELS), input)[FAULT_QUESTION_ID]),
      );
      expect(crowded).toBe(alone);
    });

    it("states, in each option the manual noted here, the notes of the causes beside it noted here too", () => {
      const [input] = variants;
      if (input === undefined) throw new Error("no variant");
      const criteria = choiceCriteria(buildQuestions(buildState(input, FIXTURE_LABELS), input));
      for (const entry of causes) {
        const notFor = criteria[entry.fault_id]?.not_for ?? [];
        if (notesUnder(entry, [conditionId]).length === 0) {
          expect(notFor, entry.fault_id).toHaveLength(1);
          continue;
        }
        for (const other of causes) {
          if (other.fault_id === entry.fault_id || sharedTargets(entry, other) === 0) continue;
          for (const note of notesUnder(other, [conditionId])) {
            expect(notFor, `${entry.fault_id} beside ${other.fault_id}`).toContain(note);
          }
        }
      }
    });

    it("never tells an option it does not apply to a movement it expects itself", () => {
      for (const input of variants) {
        const criteria = choiceCriteria(buildQuestions(buildState(input, FIXTURE_LABELS), input));
        for (const entry of causes) {
          const remarks = remarksOnOwnMovements(entry, MAN_CATALOG);
          for (const text of criteria[entry.fault_id]?.not_for ?? []) {
            expect(remarks.has(text), `${entry.fault_id}: ${text}`).toBe(false);
          }
        }
      }
    });

    it("never negates a defining movement with the normal reading it produces itself", () => {
      const [input] = variants;
      if (input === undefined) throw new Error("no variant");
      const criteria = choiceCriteria(buildQuestions(buildState(input, FIXTURE_LABELS), input));
      for (const entry of causes) {
        const [defining] = entry.signal_moves;
        if (!READS_NORMAL.has(defining.direction)) continue;
        expect(criteria[entry.fault_id]?.not_for?.[0], entry.fault_id).not.toMatch(/stays normal$/);
      }
    });
  },
);

/**
 * The move words whose own evidence is a normal reading: a
 * digital holding its state, giving no pulse or toggling rests at a normal
 * level, `unchanged` is normal and flat, and `fluctuates` is an erratic trend
 * whatever the level. "Stays normal" is no negation of any of them.
 */
const READS_NORMAL: ReadonlySet<string> = new Set([
  "stays_on",
  "stays_off",
  "no_pulse",
  "toggles",
  "unchanged",
  "fluctuates",
]);

/**
 * The manual's dryer changeover fault on its own catalog, with the rows the state
 * reads while the towers have stopped changing over: the tower indication and
 * the purge switch rest at their usual value, the purge line is up.
 *
 * The three causes the manual files under the condition all name the tower
 * indication or the purge switch first, with a word whose evidence is that
 * resting reading, and the desiccant beside them names the tower toggling.
 */
describe("buildQuestions on the manual's catalog: the dryer towers stop changing over", () => {
  const causes = [...causesUnder("dryer_changeover_fault"), manEntry("desiccant_exhausted")];
  const input: DecisionInput = {
    event: {
      ...SIGNATURE_A_EVENT,
      symptom_key: "dryer_changeover_fault",
      co_symptoms: [],
      observations: [
        { signal: "dryer_purge_pressure", level: "far_above", trend: "erratic", since: "seconds" },
        { signal: "dryer_tower", level: "normal", trend: "flat", since: "several hours" },
        { signal: "purge_switch", level: "normal", trend: "flat", since: "several hours" },
        { signal: "load_cycle_rate", level: "normal", trend: "flat", since: "several hours" },
      ],
    },
    candidates: asCandidates(causes),
    unit_id: "cau-7",
  };
  const criteria = choiceCriteria(buildQuestions(buildState(input, FIXTURE_LABELS), input));

  it("files the three causes under the condition, each naming a resting signal first", () => {
    expect(causesUnder("dryer_changeover_fault").map((entry) => entry.fault_id)).toEqual([
      "tower_changeover_valve_fault",
      "dryer_controller_fault",
      "purge_switch_fault",
    ]);
    for (const entry of causes) {
      expect(READS_NORMAL.has(entry.signal_moves[0].direction), entry.fault_id).toBe(true);
    }
  });

  it("denies a held tower or a silent switch by a change of state, not by a normal reading", () => {
    expect(criteria["tower_changeover_valve_fault"]?.not_for?.[0]).toBe(
      "Cases where dryer tower in service changes state",
    );
    expect(criteria["dryer_controller_fault"]?.not_for?.[0]).toBe(
      "Cases where dryer tower in service changes state",
    );
    expect(criteria["purge_switch_fault"]?.not_for?.[0]).toBe(
      "Cases where purge pressure switch changes state",
    );
  });

  it("denies a toggling tower by a tower holding one state", () => {
    expect(criteria["desiccant_exhausted"]?.not_for?.[0]).toBe(
      "Cases where dryer tower in service holds one state",
    );
  });
});

/**
 * The hardest negative on the manual's catalog: the network leak offered beside
 * the benign busy plant, under each condition the manual files both under.
 *
 * Their movements are nearly the same, and the manual separates them in words:
 * under `low_line_pressure` it wrote a note for each, so each option carries
 * the other's; elsewhere only the leak is noted, and the leak's sentences stay
 * on the leak's side, where they cannot push the model off the benign cause.
 * Each option still states its own side: the busy plant's remark "… unlike a
 * leak" in its own `signals`.
 */
describe.each(["low_line_pressure", "frequent_cycling", "continuous_load"])(
  "buildQuestions on the manual's catalog: the network leak beside the busy plant under %s",
  (conditionId) => {
    const leak = manEntry("downstream_air_leak");
    const demand = manEntry("high_air_demand");
    const others = causesUnder(conditionId).filter(
      (entry) => entry.fault_id !== leak.fault_id && entry.fault_id !== demand.fault_id,
    );
    const input: DecisionInput = {
      event: { ...SIGNATURE_A_EVENT, symptom_key: conditionId, co_symptoms: [] },
      candidates: asCandidates([leak, demand, ...others.slice(0, 4)]),
      unit_id: "cau-7",
    };
    const criteria = choiceCriteria(buildQuestions(buildState(input, FIXTURE_LABELS), input));
    const leakNotes = notesUnder(leak, [conditionId]);
    const demandNotes = notesUnder(demand, [conditionId]);

    it("files both causes under the condition, and the leak with a note", () => {
      expect(causesUnder(conditionId).map((entry) => entry.fault_id)).toEqual(
        expect.arrayContaining([leak.fault_id, demand.fault_id]),
      );
      expect(leakNotes).toHaveLength(1);
    });

    it("keeps each cause's own note and remarks on its own side", () => {
      for (const note of leakNotes) expect(criteria[leak.fault_id]?.what).toContain(note);
      for (const note of demandNotes) expect(criteria[demand.fault_id]?.what).toContain(note);
      const unlike = remarkOn(demand, "unloaded_pressure_decay");
      expect(unlike).toMatch(/unlike a leak/);
      expect(criteria[demand.fault_id]?.signals?.join(" ")).toContain(unlike);
      expect(criteria[leak.fault_id]?.not_for).not.toContain(unlike);
    });

    it("gives the busy plant a leak's sentence only where the manual noted both", () => {
      const leakSentences = [
        ...leak.conditions.flatMap((condition) =>
          condition.note === undefined ? [] : [condition.note],
        ),
        ...moveNotesOf([leak]),
      ];
      const notFor = criteria[demand.fault_id]?.not_for ?? [];
      if (demandNotes.length === 0) {
        for (const sentence of leakSentences) expect(notFor).not.toContain(sentence);
      } else {
        expect(notFor).toEqual(expect.arrayContaining(leakNotes));
        expect(criteria[leak.fault_id]?.not_for).toEqual(expect.arrayContaining(demandNotes));
        for (const sentence of moveNotesOf([leak])) expect(notFor).not.toContain(sentence);
      }
    });
  },
);

describe("the no-numeral check itself", () => {
  it("lets a register tag, a controller code or a path index through", () => {
    expect(withoutIdentifiers("Dryer purge pressure (P4) is high")).not.toMatch(/\d/);
    expect(withoutIdentifiers("W102 Continuous load time exceeded")).not.toMatch(/\d/);
    expect(withoutIdentifiers("`candidates[1].expected_signal_moves[0]`")).not.toMatch(/\d/);
  });

  it("catches a numeral that stands for a level or a quantity", () => {
    expect(withoutIdentifiers("Rate the severity from 0 to 3")).toMatch(/\d/);
    expect(withoutIdentifiers("line pressure below 6 bar")).toMatch(/\d/);
    expect(withoutIdentifiers("P44 is not a tag")).toMatch(/\d/);
    expect(withoutIdentifiers("choose from [1] to [3]")).toMatch(/\d/);
  });
});
