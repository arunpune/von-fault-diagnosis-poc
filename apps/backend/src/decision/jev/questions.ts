// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one request Jev answers (docs/decision-backends.md#jev).
 *
 * Three kinds of question travel together over one state, because questions
 * that share a state belong in one request: a Choice that names the cause, one
 * Noul per candidate that judges that candidate's defining movement, and a
 * Score that places the situation on a four-step rubric. Question ids never
 * reach the model; the whole question is in `instructions`.
 *
 * Four rules shape every string below and every one of them is asserted in
 * `questions.test.ts`:
 *
 *  * **A criterion is an extension of its instruction.** A Noul that asks
 *    about one movement while its criteria talk about "each expected
 *    movement" is what makes a Noul hover near 0.5.
 *    Every `match_*` criterion names one signal and one direction, exactly
 *    like the question above it.
 *  * **Options that sit close together are told apart in the manual's words.**
 *    Causes that expect the same movements are the Choice's overlapping options,
 *    which is what gives a Choice low confidence; contrastive criteria are the
 *    fix. Each option's `what` is the cause's own paragraph and
 *    its note under the event's symptom, and its `signals` its own movements as
 *    the catalog renders them, remarks included; its `not_for` carries a
 *    neighbour's note only where the manual wrote a note for both causes under
 *    that symptom, which is a distinction the manual drew between them. Every
 *    sentence of it is the catalog's; code only chooses which ones, and never
 *    names a cause.
 *  * **The abstention is neutral.** `none_of_these` carries no `examples` at
 *    all: a signal-specific one describes a candidate and moves mass onto the
 *    abstention, and the generic replacement was a description of an instance,
 *    while a criterion describes a class, never an instance. What it keeps is a
 *    contrastive `not_for`.
 *  * **Policy lives in code.** The severity levels describe situations. "Plan
 *    an intervention" is a decision the gate and the ticket text make, and a
 *    level that carried it would be asking the model to own it.
 *
 * Every backticked path in a `question`, a `focus` or a `note` points into the
 * part of the state that question's `inspect` lists — `candidates[1]
 * .expected_signal_moves[0]` inside `candidates[1].expected_signal_moves`,
 * `expected_signal_moves` inside every element of `candidates` — which is what
 * lets the shape test check both directions without a model.
 */

import type { ChoiceQuestion, NoulQuestion, Question, ScoreQuestion } from "@typesafe-ai/sdk";

import type { SignalMove } from "@fdp/contracts";

import { moveTarget } from "../../retrieval/match.ts";
import type { Candidate } from "../../retrieval/types.ts";
import {
  CHOICE_INSPECT_PATHS,
  definingMovePath,
  matchInspectPaths,
  SEVERITY_INSPECT_PATHS,
} from "../state.ts";
import type { DecisionState, StateCandidate } from "../state.ts";
import { NONE_OF_THESE } from "../types.ts";
import type { DecisionInput } from "../types.ts";

/** The question set of one decision, keyed the way the answers come back. */
export type JevQuestions = Record<string, Question>;

/** The whole request as the SDK sends it; the golden fixture is this object. */
export interface JevRequestBody {
  readonly state: DecisionState;
  readonly model: string;
  readonly questions: JevQuestions;
}

/** The id of the question that judges one candidate's defining movement. */
export function matchQuestionId(faultId: string): string {
  return `match_${faultId}`;
}

/** The id of the Choice that names the cause. */
export const FAULT_QUESTION_ID = "fault";

/** The id of the Score that places the situation. */
export const SEVERITY_QUESTION_ID = "severity";

/**
 * The whole request must fit this, in the `ceil(chars / 3)` heuristic.
 *
 * The budget is on the request, not the state: the Choice criteria re-emit
 * every candidate's expected movements and one Noul is added per candidate, so
 * the questions grow with retrieval's list exactly as the state does. Growth is
 * a cost regression, because `cost_usd` is computed from the reported
 * `input_tokens` and written to `app.cost_ledger`.
 */
export const REQUEST_TOKEN_BUDGET = 8000;

/** The state plus the longest single question must fit this. */
export const LONGEST_QUESTION_TOKEN_BUDGET = 6000;

/**
 * How many tokens a question or a whole question set costs, as `ceil(chars / 3)`.
 *
 * The same heuristic `decision/state.ts` applies to the state, for the same
 * reason: the budget is there to catch growth, and a real tokenizer would tie
 * the assertion to one provider's vocabulary.
 */
export function estimateQuestionTokens(value: Question | JevQuestions): number {
  return Math.ceil(JSON.stringify(value).length / 3);
}

/** The largest single question of a set, in the same heuristic. */
export function longestQuestionTokens(questions: JevQuestions): number {
  return Math.max(
    0,
    ...Object.values(questions).map((question) => estimateQuestionTokens(question)),
  );
}

/** Whether `sentence` opens with `label` as whole words ("oil level" is not "oil levels"). */
function opensWith(sentence: string, label: string): boolean {
  if (label === "" || !sentence.startsWith(label)) return false;
  const next = sentence.charAt(label.length);
  return next === "" || !/[a-z0-9]/.test(next);
}

/**
 * The label of the signal a candidate's defining movement is about.
 *
 * The manual renders a movement as a sentence that opens with the signal's own
 * name — "Dryer purge pressure (P4) is persistently high while loaded" — and
 * the state lists that name as an observation label, because the state builder
 * keeps every signal a candidate mentions even when it is behaving. Matching
 * the longest label the sentence opens with is therefore a lookup, not a parse:
 * it either finds the name the manual used or it finds nothing.
 */
function definingSignalLabel(state: DecisionState, candidate: StateCandidate): string | undefined {
  const move = candidate.expected_signal_moves[0];
  if (move === undefined) return undefined;
  const opening = move.toLowerCase();
  let best: string | undefined;
  for (const observation of state.observations) {
    const label = observation.label.toLowerCase();
    if (!opensWith(opening, label)) continue;
    if (best === undefined || label.length > best.length) best = label;
  }
  return best;
}

/** How the reading that denies a departure from the band reads: the signal stays in it. */
const STAYS_NORMAL = "stays normal";

/**
 * The reading that denies each word of the move vocabulary, as the
 * state's own words can show it.
 *
 * Most words move a signal off its band, and a signal that stays normal denies
 * them. Five do not, because their own evidence is a normal reading, and for
 * them "stays normal" would tell the model that the option does not apply to
 * what its defining movement looks like on the machine:
 *
 *  * `stays_on`, `stays_off` and `no_pulse` ask a digital not to move. One
 *    resting at its usual value reads normal and flat — the dryer tower that no
 *    longer changes over, the purge switch that no longer drops out — and the
 *    matcher counts any transition against them (`retrieval/match.ts`);
 *  * `toggles` asks for transitions at whatever value, and a digital holding
 *    one state is what denies it;
 *  * `unchanged` is normal and flat itself, denied by any move off the band or
 *    along it;
 *  * `fluctuates` is an erratic trend at any level, denied by a steady one.
 *
 * A record over the contract's whole enum, so a word added to the vocabulary
 * cannot reach the model without a denial of its own.
 */
const DENIAL_OF: Readonly<Record<SignalMove["direction"], string>> = {
  rises: STAYS_NORMAL,
  falls: STAYS_NORMAL,
  high: STAYS_NORMAL,
  low: STAYS_NORMAL,
  near_zero: STAYS_NORMAL,
  not_venting: STAYS_NORMAL,
  on: STAYS_NORMAL,
  off: STAYS_NORMAL,
  higher: STAYS_NORMAL,
  lower: STAYS_NORMAL,
  longer: STAYS_NORMAL,
  shorter: STAYS_NORMAL,
  faster: STAYS_NORMAL,
  slower: STAYS_NORMAL,
  not_reached: STAYS_NORMAL,
  stays_on: "changes state",
  stays_off: "changes state",
  no_pulse: "changes state",
  toggles: "holds one state",
  unchanged: "is above or below normal, or moving",
  fluctuates: "holds steady",
};

/**
 * The negation of a candidate's defining movement.
 *
 * Generated from the move vocabulary rather than written per cause, so a new
 * catalog entry needs no new prose: the signal the movement is about, and the
 * reading that denies its word ({@link DENIAL_OF}). A state candidate without
 * a catalog entry has no word to read, and keeps the denial of a departure
 * from the band. It separates a cause from every neighbour whose defining
 * signal differs; the neighbours that expect the same movements need the
 * manual's own words, which {@link contrastsOf} adds after it where the manual
 * wrote them.
 */
function negatedDefiningMove(
  state: DecisionState,
  candidate: StateCandidate,
  entry: Candidate | undefined,
): string {
  const label = definingSignalLabel(state, candidate);
  if (label === undefined) {
    return "Cases where none of the movements this cause expects appear in the observations";
  }
  const word = entry?.signal_moves[0].direction;
  return `Cases where ${label} ${word === undefined ? STAYS_NORMAL : DENIAL_OF[word]}`;
}

/**
 * The note that tells a cause from the others under the event's symptom.
 *
 * `conditions[].note` is, in the contract's own words, "what distinguishes this
 * cause from the others under the same condition": the troubleshooting table's
 * per-(condition, cause) note. The candidates are offered under the event's
 * symptom — the state names that condition for each of them — so the note under
 * the symptom is the one that separates the options on offer. The notes under
 * the co-symptoms are left out: they separate a cause from other conditions'
 * causes, and taking them would let the number of rules that fire, rather than
 * the catalog, decide how large the request grows.
 */
function distinctionOf(candidate: Candidate, symptomKey: string): string | undefined {
  const note = candidate.conditions
    .find((condition) => condition.condition_id === symptomKey)
    ?.note?.trim();
  return note === "" ? undefined : note;
}

/** The signals and behaviours a cause's expected movements name. */
function targetsOf(candidate: Candidate): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const move of candidate.signal_moves) {
    const target = moveTarget(move);
    if (target !== undefined) targets.add(target);
  }
  return targets;
}

/**
 * How much two causes' expected movements overlap: the signals both name over
 * every signal either names, 0 when they share none.
 */
function overlapOf(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let shared = 0;
  for (const target of right) if (left.has(target)) shared += 1;
  const named = left.size + right.size - shared;
  return named === 0 ? 0 : shared / named;
}

/**
 * What the manual says about the neighbours of one candidate, for its `not_for`.
 *
 * A neighbour is another candidate that expects a movement of a signal this one
 * also expects: those are the options that sit close together, where matching
 * directions cannot decide and a model reading one option at a time needs to
 * be told what the other case looks like.
 * Neighbours come closest first ({@link overlapOf}, then retrieval's order).
 *
 * A neighbour's sentence goes into this option's `not_for` only when the manual
 * wrote a distinction for the pair: a note for this cause and a note for the
 * neighbour, both under the event's symptom, the condition the options are
 * offered under. Two such notes are the manual telling the two causes apart
 * under exactly this condition ("… at night and at the weekend, when no
 * consumer is drawing air" against "… disappears when the plant stops"), so
 * each option can carry the other's as its contrast.
 *
 * Nothing else is taken, because a `not_for` sentence tells the model the
 * option does not apply to what the sentence describes:
 *
 *  * a neighbour's note, when the manual gave this cause none under the
 *    symptom, is the neighbour's own sign under this condition, not a contrast
 *    with this cause, and it may well describe evidence this cause expects too
 *    ("the idle pressure decay is faster …" beside a cause that expects the
 *    same decay). It stays in the neighbour's own `what`;
 *  * a neighbour's remark on a movement describes how that movement looks when
 *    the neighbour is behind it, and when this cause expects the same movement
 *    it would push the model off this option on its own evidence. Every
 *    cause's remarks already reach its own `signals`, where they state its
 *    side of the difference ("… stops when the plant stops, unlike a leak").
 *
 * An option the manual gave no note under the symptom therefore keeps its
 * negated defining movement alone. A neighbour's name is never quoted, so no
 * cause's wording reaches another option's description beyond these sentences.
 */
function contrastsOf(
  candidate: Candidate,
  neighbours: readonly Candidate[],
  symptomKey: string,
): string[] {
  const ownNote = distinctionOf(candidate, symptomKey);
  if (ownNote === undefined) return [];
  const own = targetsOf(candidate);
  const ranked = neighbours
    .map((neighbour, order) => ({
      neighbour,
      order,
      overlap: overlapOf(own, targetsOf(neighbour)),
    }))
    .filter(({ overlap }) => overlap > 0)
    .sort((left, right) => right.overlap - left.overlap || left.order - right.order);

  const contrasts: string[] = [];
  for (const { neighbour } of ranked) {
    const note = distinctionOf(neighbour, symptomKey);
    if (note !== undefined && note !== ownNote && !contrasts.includes(note)) contrasts.push(note);
  }
  return contrasts;
}

/**
 * What one option is: the cause's name, its paragraph and its note.
 *
 * The summary is the manual's "what happens and why"; the note is what
 * separates the cause under the event's symptom. A note the summary already
 * carries is not repeated: the ingested catalog folds the note of the first
 * condition that lists a cause into its summary.
 */
function whatOf(name: string, candidate: Candidate | undefined, symptomKey: string): string {
  if (candidate === undefined) return name;
  const summary = candidate.summary.trim();
  const note = distinctionOf(candidate, symptomKey);
  const body = [summary, note !== undefined && !summary.includes(note) ? note : ""]
    .filter((text) => text !== "")
    .join(" ");
  return body === "" ? name : `${name}: ${body}`;
}

/** One option of the Choice. */
interface ChoiceCriterion {
  readonly what: string;
  readonly signals: string[];
  readonly not_for: string[];
}

/**
 * The Choice that names the cause, or abstains.
 *
 * The criteria are built from the catalog entries retrieval offered, matched to
 * the state's candidates by id; a state candidate without an entry keeps the
 * name and the negated defining movement, which is all the state alone says.
 */
function faultQuestion(state: DecisionState, input: DecisionInput): ChoiceQuestion {
  const entries = new Map(input.candidates.map((entry) => [entry.fault_id, entry]));
  const symptomKey = input.event.symptom_key;
  const criteria: Record<string, ChoiceCriterion> = {};
  for (const candidate of state.candidates) {
    const entry = entries.get(candidate.id);
    const neighbours = input.candidates.filter((other) => other.fault_id !== candidate.id);
    criteria[candidate.id] = {
      what: whatOf(candidate.cause, entry, symptomKey),
      signals: [...candidate.expected_signal_moves],
      not_for: [
        negatedDefiningMove(state, candidate, entry),
        ...(entry === undefined ? [] : contrastsOf(entry, neighbours, symptomKey)),
      ],
    };
  }
  return {
    type: "choice",
    instructions: {
      question:
        "Which candidate in `candidates` has `expected_signal_moves` that match the movements " +
        "listed in `observations`?",
      inspect: [...CHOICE_INSPECT_PATHS],
      focus:
        "Match the direction of each movement, not its cause. A candidate whose expected " +
        "movements point the wrong way, or expect a movement that is absent, does not match.",
      note: "Choose none_of_these when no candidate's expected movements fit.",
    },
    criteria: {
      ...criteria,
      // No `examples`: what the abstention needs is a contrast, not an
      // instance, and every instance written here described a candidate.
      [NONE_OF_THESE]: {
        what: "No candidate's expected movements match the observations",
        not_for: "Cases where one candidate's expected movements do appear, even partly",
      },
    },
  };
}

/**
 * One Noul per candidate, about that candidate's defining movement.
 *
 * The index in every path is the candidate's position in `candidates`, so the
 * question and the state agree literally rather than by description. The
 * question asks about one movement and the criteria describe one movement: that
 * agreement is what `candidates[].support`, the tie-break and the
 * `inconsistent` flag all rest on.
 */
function matchQuestion(index: number): NoulQuestion {
  return {
    type: "noul",
    instructions: {
      question: `Does \`observations\` show the movement in \`${definingMovePath(index)}\`?`,
      inspect: [...matchInspectPaths(index)],
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
  };
}

/**
 * How serious the situation is, on four situational levels.
 *
 * Each level stands alone — the model judges every one of them separately and
 * sees neither its number nor its neighbours — carries no numeral, and
 * describes what the machine is doing rather than what anyone should do about
 * it. The rare extreme has its own level because code treats it differently.
 */
function severityQuestion(): ScoreQuestion {
  return {
    type: "score",
    instructions: {
      question:
        "How serious is the situation described by `observations` and `controller_alarms` " +
        "for the air supply of the plant right now?",
      inspect: [...SEVERITY_INSPECT_PATHS],
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
          "low-pressure switch, oil temperature far above its limit, or the compressor running " +
          "continuously while line pressure falls",
        signals: [
          "low-pressure switch active",
          "oil temperature far above normal",
          "line pressure falling while loaded",
        ],
      },
    ],
  };
}

/**
 * Build the question set of one decision.
 *
 * `state` is what the model reads; `input` is the decision it was built from,
 * whose catalog entries carry the summaries and notes the Choice's criteria
 * quote. The state carries only what the questions point at, so that text
 * stays in the criteria, where the description of an option belongs.
 *
 * The insertion order — the Choice, then one Noul per candidate in the order
 * retrieval offered them, then the Score — is the order the request body
 * carries, which is what makes the golden fixture a byte comparison rather than
 * a deep one.
 */
export function buildQuestions(state: DecisionState, input: DecisionInput): JevQuestions {
  const questions: JevQuestions = { [FAULT_QUESTION_ID]: faultQuestion(state, input) };
  state.candidates.forEach((candidate, index) => {
    questions[matchQuestionId(candidate.id)] = matchQuestion(index);
  });
  questions[SEVERITY_QUESTION_ID] = severityQuestion();
  return questions;
}
