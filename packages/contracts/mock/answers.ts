// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The wire types of `POST /v1/systemone` and the three named answer policies of the mock TypeSafe
// server.
//
// The types are declared here rather than imported from `von-sdk`: `packages/contracts`
// carries no runtime dependency beyond Ajv, and the SDK is a dev dependency of the compatibility
// test only. `mock/sdk-compat.test.ts` is what keeps the two in step — it sends the SDK's own
// objects and asserts that a hand-built question is byte-identical to the helper's.
//
// Everything here is a pure function of the request. No clock, no randomness, no counters
// except the request index the caller passes in, so the CI stack's decision is reproducible.

import { bestOverlap, type OverlapCandidate } from "./overlap.ts";

/** The SDK's `EntryType`: text, a JSON object or array, or `null`. */
export type Entry = string | Record<string, unknown> | unknown[] | null;

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions?: Entry;
  readonly criteria?: { readonly true?: Entry; readonly false?: Entry } | null;
}

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions?: Entry;
  readonly criteria: Readonly<Record<string, Entry>>;
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions?: Entry;
  readonly criteria: readonly Entry[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** The request body, after it validated against `mock/schemas/systemone-request.schema.json`. */
export interface SystemOneRequest {
  readonly state: Entry;
  readonly model?: string;
  readonly questions: Readonly<Record<string, Question>>;
}

export interface NoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly confidence: number;
  /**
   * The rubric by level index. The live API echoes each level as it was asked, an object level
   * included (the SDK's `ScoreLegend`); the mock's own answers render every level as text.
   */
  readonly legend: Readonly<Record<string, Entry>>;
  readonly probabilities: Readonly<Record<string, number>>;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The response body of `POST /v1/systemone`. */
export interface SystemOneResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

/**
 * A scripted policy: it returns the answers it wants to pin, keyed by question id, and every
 * id it leaves out keeps the answer of the named policy. Ids that name no question in the
 * request are ignored, because the response mirrors the questions that were asked.
 */
export type AnswerPolicy = (
  request: SystemOneRequest,
  index: number,
) => Partial<Record<string, Answer>>;

/** The named policies, selectable by option, CLI flag and `MOCK_ANSWER_POLICY`. */
export const ANSWER_POLICY_NAMES = ["default", "confident-first", "best-overlap"] as const;

export type AnswerPolicyName = (typeof ANSWER_POLICY_NAMES)[number];

/** Narrows an arbitrary string to a policy name. */
export function isAnswerPolicyName(value: string): value is AnswerPolicyName {
  return (ANSWER_POLICY_NAMES as readonly string[]).includes(value);
}

/** The level a `confident-first` or `best-overlap` Score points at, clamped to the rubric. */
const CONFIDENT_LEVEL = 2;

/** The probability the two confident policies put on the candidate they pick. */
const CONFIDENT_MASS = 0.9;

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** Shannon entropy in nats, with the `0 log 0 = 0` convention. */
function entropy(probabilities: readonly number[]): number {
  let total = 0;
  for (const p of probabilities) if (p > 0) total -= p * Math.log(p);
  return total;
}

/**
 * `1 - H(p) / ln(n)`, the mock's confidence heuristic. It is 0 for a uniform vector and 1 when all
 * the mass sits on one label. Thresholds are tuned on the real model, never on this.
 */
export function peakedness(probabilities: readonly number[]): number {
  const n = probabilities.length;
  if (n < 2) return 1;
  return round4(1 - entropy(probabilities) / Math.log(n));
}

/**
 * Rounds a probability vector to four decimals and gives the rounding remainder to
 * `chosenIndex`, so the vector a consumer receives still sums to 1.
 */
function roundVector(values: readonly number[], chosenIndex: number): number[] {
  const rounded = values.map(round4);
  let rest = 0;
  for (let i = 0; i < rounded.length; i += 1) if (i !== chosenIndex) rest += rounded[i] ?? 0;
  rounded[chosenIndex] = round4(1 - rest);
  return rounded;
}

/** A Score level as the `legend` reports it: the string, its `summary`, or its JSON. */
export function legendText(level: Entry): string {
  if (typeof level === "string") return level;
  if (level !== null && !Array.isArray(level) && typeof level === "object") {
    const summary = (level as { summary?: unknown }).summary;
    if (typeof summary === "string") return summary;
  }
  return JSON.stringify(level);
}

function choiceAnswer(labels: readonly string[], probabilities: readonly number[]): ChoiceAnswer {
  let bestIndex = 0;
  for (let i = 1; i < probabilities.length; i += 1) {
    if ((probabilities[i] ?? 0) > (probabilities[bestIndex] ?? 0)) bestIndex = i;
  }
  const rounded = roundVector(probabilities, bestIndex);
  const byLabel: Record<string, number> = {};
  labels.forEach((label, index) => {
    byLabel[label] = rounded[index] ?? 0;
  });
  return {
    type: "choice",
    choice: labels[bestIndex] ?? "",
    confidence: peakedness(probabilities),
    probabilities: byLabel,
  };
}

/** A Score answer with all its mass on `index`. */
function scoreAnswer(levels: readonly Entry[], index: number): ScoreAnswer {
  const legend: Record<string, string> = {};
  const probabilities: Record<string, number> = {};
  levels.forEach((level, i) => {
    legend[String(i)] = legendText(level);
    probabilities[String(i)] = i === index ? 1 : 0;
  });
  return { type: "score", score: index, confidence: 1, legend, probabilities };
}

/** The documented default answers. */
function defaultAnswer(question: Question): Answer {
  switch (question.type) {
    case "noul":
      return { type: "noul", noul: 0.5 };
    case "choice": {
      const labels = Object.keys(question.criteria);
      return choiceAnswer(
        labels,
        labels.map(() => 1 / labels.length),
      );
    }
    case "score": {
      const levels = question.criteria;
      return scoreAnswer(levels, Math.floor((levels.length - 1) / 2));
    }
  }
}

/** The Choice answer both confident policies produce once they picked `chosen`. */
function confidentChoice(labels: readonly string[], chosen: string): ChoiceAnswer {
  const index = Math.max(0, labels.indexOf(chosen));
  const rest = labels.length > 1 ? (1 - CONFIDENT_MASS) / (labels.length - 1) : 0;
  const probabilities = labels.map((_, i) => (i === index ? CONFIDENT_MASS : rest));
  const rounded = roundVector(probabilities, index);
  const byLabel: Record<string, number> = {};
  labels.forEach((label, i) => {
    byLabel[label] = rounded[i] ?? 0;
  });
  return {
    type: "choice",
    choice: labels[index] ?? "",
    confidence: CONFIDENT_MASS,
    probabilities: byLabel,
  };
}

/**
 * Whether a Noul question id names `candidate`. The backend's ids are `match_<fault_id>`, so an id
 * matches when it *is* the candidate id or when the candidate id sits at one end of it behind a
 * separator.
 */
export function noulNamesCandidate(questionId: string, candidate: string): boolean {
  if (questionId === candidate) return true;
  const separators = ["_", "-", ".", ":", "/"];
  return separators.some(
    (separator) =>
      questionId.endsWith(`${separator}${candidate}`) ||
      questionId.startsWith(`${candidate}${separator}`),
  );
}

/** The strings a candidate's `expected_signal_moves` contribute, from state or criteria. */
function movesOf(
  label: string,
  criterion: Entry,
  stateCandidates: ReadonlyMap<string, string[]>,
): string[] {
  const fromState = stateCandidates.get(label);
  if (fromState !== undefined && fromState.length > 0) return fromState;
  if (criterion !== null && !Array.isArray(criterion) && typeof criterion === "object") {
    const signals: unknown = (criterion as { signals?: unknown }).signals;
    if (Array.isArray(signals)) return onlyStrings(signals);
  }
  return collectStrings(criterion);
}

/** The string entries of a list, in order. */
function onlyStrings(values: readonly unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string");
}

/** Every string inside an entry, depth first; the fallback source of a candidate's moves. */
function collectStrings(entry: unknown): string[] {
  if (typeof entry === "string") return [entry];
  if (Array.isArray(entry)) return entry.flatMap((item) => collectStrings(item));
  if (entry !== null && typeof entry === "object") {
    return Object.values(entry).flatMap((item) => collectStrings(item));
  }
  return [];
}

/** `state.candidates[].expected_signal_moves`, keyed by candidate id. */
function candidatesOfState(state: Entry): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (state === null || Array.isArray(state) || typeof state !== "object") return out;
  const candidates = (state as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return out;
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") continue;
    const { id, expected_signal_moves: moves } = candidate as {
      id?: unknown;
      expected_signal_moves?: unknown;
    };
    if (typeof id !== "string") continue;
    out.set(id, Array.isArray(moves) ? onlyStrings(moves) : []);
  }
  return out;
}

/**
 * The observed movements: `state.observations` when the state carries them (the shape
 * `decision/state.ts` builds), the whole state when it is plain text, nothing otherwise. An
 * observation object contributes every string it holds, so both `"line pressure below normal"`
 * and `{ label: "line pressure", level: "below normal", trend: "flat" }` are read the same way.
 */
export function observationsOf(state: Entry): string[] {
  if (typeof state === "string") return [state];
  if (state === null || Array.isArray(state) || typeof state !== "object") return [];
  const observations = (state as { observations?: unknown }).observations;
  if (!Array.isArray(observations)) return [];
  return observations.map((observation) => collectStrings(observation).join(" "));
}

/** The Choice question of a request, if it has one; the confident policies hang off it. */
function firstChoice(
  request: SystemOneRequest,
): { readonly id: string; readonly question: ChoiceQuestion } | undefined {
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === "choice") return { id, question };
  }
  return undefined;
}

/** The candidate a named policy settles on, or `undefined` when the request has no Choice. */
function chosenCandidate(request: SystemOneRequest, policy: AnswerPolicyName): string | undefined {
  const choice = firstChoice(request);
  if (choice === undefined) return undefined;
  const labels = Object.keys(choice.question.criteria);
  if (policy !== "best-overlap") return labels[0];
  const stateCandidates = candidatesOfState(request.state);
  const candidates: OverlapCandidate[] = labels.map((label) => ({
    id: label,
    moves: movesOf(label, choice.question.criteria[label] ?? null, stateCandidates),
  }));
  return bestOverlap(candidates, observationsOf(request.state)) ?? labels[0];
}

/**
 * Every answer of one request under a named policy.
 *
 * `default` answers with the documented defaults. `confident-first` puts 0.9 on the first candidate
 * and `best-overlap` on the candidate whose expected movements match the observations best; both
 * raise the Noul of that candidate to 0.9, drop the others to 0.1, and put the severity mass on
 * level index 2. A request without a Choice question has no candidate, so their Nouls fall back to
 * the documented 0.5.
 */
export function answerWithPolicy(
  request: SystemOneRequest,
  policy: AnswerPolicyName,
): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  if (policy === "default") {
    for (const [id, question] of Object.entries(request.questions)) {
      answers[id] = defaultAnswer(question);
    }
    return answers;
  }
  const chosen = chosenCandidate(request, policy);
  for (const [id, question] of Object.entries(request.questions)) {
    switch (question.type) {
      case "choice":
        answers[id] =
          chosen === undefined
            ? defaultAnswer(question)
            : confidentChoice(Object.keys(question.criteria), chosen);
        break;
      case "score":
        answers[id] = scoreAnswer(
          question.criteria,
          Math.min(CONFIDENT_LEVEL, question.criteria.length - 1),
        );
        break;
      case "noul":
        answers[id] =
          chosen === undefined
            ? defaultAnswer(question)
            : { type: "noul", noul: noulNamesCandidate(id, chosen) ? 0.9 : 0.1 };
        break;
    }
  }
  return answers;
}

/** `ceil(bytes(JSON(state)) + bytes(JSON(questions)) / 4)`, the documented token estimate. */
export function estimateInputTokens(request: SystemOneRequest): number {
  const bytes =
    Buffer.byteLength(JSON.stringify(request.state), "utf8") +
    Buffer.byteLength(JSON.stringify(request.questions), "utf8");
  return Math.ceil(bytes / 4);
}
