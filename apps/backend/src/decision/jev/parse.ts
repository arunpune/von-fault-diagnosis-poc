// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading Jev's answers (docs/decision-backends.md#reading-the-answers).
 *
 * Every answer stays inside the options the request supplied, so nothing here
 * parses prose: it reads a label, a probability vector and a handful of numbers
 * and applies the two policies that belong to code.
 *
 * **The tie-break.** When the top two options sit within {@link TIE_BREAK_MARGIN}
 * of each other the Choice has not separated them, and the per-candidate Nouls
 * have: each one judged one movement in isolation, which is the judgment the
 * Choice had to make six times at once. Code picks the candidate with the
 * higher Noul rather than rewording the Choice, because policy belongs in code.
 *
 * **The inconsistency flag.** A Choice that names a candidate whose own Noul
 * sits under {@link INCONSISTENT_BELOW_SUPPORT} answered two questions two
 * ways. That is worth recording and worth a log line, and it is deliberately
 * not worth changing the gate over: the gate reads `confidence`, and a second
 * quantity silently moving it would make the evaluation harness measure
 * something the report does not describe.
 *
 * This module holds no SDK type on purpose. It is handed the plain answer
 * objects, so it can be exercised with a literal and never needs a server.
 */

import type { SeverityLevel } from "@fdp/contracts";

import { DecisionError, NONE_OF_THESE } from "../types.ts";
import type { DecisionSeverity, DecisionUsage, FaultChoice } from "../types.ts";
import { FAULT_QUESTION_ID, matchQuestionId, SEVERITY_QUESTION_ID } from "./questions.ts";

/** Within this, the Choice has not separated the top two and the Nouls decide. */
export const TIE_BREAK_MARGIN = 0.05;

/** A named candidate whose own Noul is under this contradicts the Choice. */
export const INCONSISTENT_BELOW_SUPPORT = 0.4;

/** The four severity levels, in the order the Score's indexes use. */
export const SEVERITY_ORDER: readonly SeverityLevel[] = ["low", "medium", "high", "critical"];

/** The parts of a `POST /v1/systemone` response the backend keeps. */
export interface JevResponse {
  /** The versioned id that answered; compared with the pinned `JEV_MODEL`. */
  readonly model: string;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly usage: DecisionUsage;
}

/** What {@link parseAnswers} made of one response. */
export interface ParsedAnswers {
  readonly choice: FaultChoice;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  /** One entry per candidate, from that candidate's Noul. */
  readonly support: Readonly<Record<string, number>>;
  readonly severity: DecisionSeverity;
  /** The Nouls moved the choice off the label the Choice answered with. */
  readonly tie_broken: boolean;
  /** The named candidate's own Noul contradicts the Choice. */
  readonly inconsistent: boolean;
}

/** An answer that could not be read is a validation failure, never a guess. */
function invalid(detail: string): DecisionError {
  return new DecisionError("validation", `jev answered with ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A token count, which the cost ledger multiplies by a price. */
function tokenCount(value: unknown, which: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalid(`a ${which} token count that is not a whole number`);
  }
  return value;
}

/**
 * Check the envelope of a response before a single answer is read.
 *
 * The SDK hands the body over as parsed JSON without looking at it, so a
 * missing `usage` would otherwise surface as a `TypeError` deep inside the
 * pipeline instead of as a decision that failed validation.
 */
export function readResponse(body: unknown): JevResponse {
  if (!isRecord(body)) throw invalid("a body that is not an object");
  const { model, answers, usage } = body;
  if (typeof model !== "string" || model === "") throw invalid("no model id");
  if (!isRecord(answers)) throw invalid("no answers");
  if (!isRecord(usage)) throw invalid("no usage");
  return {
    model,
    answers,
    usage: {
      input_tokens: tokenCount(usage.input_tokens, "input"),
      output_tokens: tokenCount(usage.output_tokens, "output"),
    },
  };
}

/** A probability vector, checked entry by entry so a NaN never reaches the gate. */
function probabilityMap(value: unknown, where: string): Record<string, number> {
  if (!isRecord(value)) throw invalid(`no probabilities for ${where}`);
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw invalid(`a non-numeric probability for ${where}`);
    }
    out[key] = entry;
  }
  if (Object.keys(out).length === 0) throw invalid(`an empty probability vector for ${where}`);
  return out;
}

function probability(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`a non-numeric ${where}`);
  }
  return value;
}

/** Whether `label` is one of the options the `fault` Choice offered. */
function isOffered(label: string, candidateIds: readonly string[]): boolean {
  return label === NONE_OF_THESE || candidateIds.includes(label);
}

/** The Choice answer, with every label checked against the options that were sent. */
function readChoice(
  answers: Readonly<Record<string, unknown>>,
  candidateIds: readonly string[],
): { choice: FaultChoice; probabilities: Record<string, number>; confidence: number } {
  const answer = answers[FAULT_QUESTION_ID];
  if (!isRecord(answer) || answer.type !== "choice")
    throw invalid("no choice answer for the cause");
  const choice = answer.choice;
  if (typeof choice !== "string") throw invalid("a choice that is not a label");
  if (!isOffered(choice, candidateIds)) throw invalid(`the unknown cause ${choice}`);
  const probabilities = probabilityMap(answer.probabilities, "the cause");
  for (const label of Object.keys(probabilities)) {
    if (!isOffered(label, candidateIds))
      throw invalid(`a probability for the unknown cause ${label}`);
  }
  return {
    choice,
    probabilities,
    confidence: probability(answer.confidence, "confidence for the cause"),
  };
}

/** One Noul per candidate; a missing one is a validation failure, not a zero. */
function readSupport(
  answers: Readonly<Record<string, unknown>>,
  candidateIds: readonly string[],
): Record<string, number> {
  const support: Record<string, number> = {};
  for (const faultId of candidateIds) {
    const id = matchQuestionId(faultId);
    const answer = answers[id];
    if (!isRecord(answer) || answer.type !== "noul") throw invalid(`no noul answer for ${faultId}`);
    support[faultId] = probability(answer.noul, `noul for ${faultId}`);
  }
  return support;
}

/** The rubric as the decision sheet shows it: one sentence per level, in order. */
function readLegend(value: unknown, levels: number): string[] | undefined {
  if (!isRecord(value)) return undefined;
  const legend: string[] = [];
  for (let index = 0; index < levels; index += 1) {
    const entry = value[String(index)];
    if (typeof entry !== "string") return undefined;
    legend.push(entry);
  }
  return legend;
}

/** The index carrying the most mass; ties keep the lower level. */
function argmax(probabilities: Readonly<Record<string, number>>): number {
  let best = -1;
  let bestMass = Number.NEGATIVE_INFINITY;
  for (const [key, mass] of Object.entries(probabilities)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0)
      throw invalid("a severity level that is not an index");
    if (mass > bestMass || (mass === bestMass && index < best)) {
      best = index;
      bestMass = mass;
    }
  }
  return best;
}

/**
 * The severity Score, mapped to a level.
 *
 * The reported `score` is a probability-weighted mean and can fall between two
 * levels: it is not a quantity. The level
 * comes from `argmax(probabilities)` and `score` carries that level's index, the
 * way the `decision` contract and the rules twin both define it.
 */
function readSeverity(answers: Readonly<Record<string, unknown>>): DecisionSeverity {
  const answer = answers[SEVERITY_QUESTION_ID];
  if (!isRecord(answer) || answer.type !== "score") throw invalid("no score answer for severity");
  const probabilities = probabilityMap(answer.probabilities, "severity");
  const score = argmax(probabilities);
  const level = SEVERITY_ORDER[score];
  if (level === undefined) throw invalid(`the severity level index ${String(score)}`);
  const legend = readLegend(answer.legend, SEVERITY_ORDER.length);
  const severity: DecisionSeverity = {
    level,
    score,
    probabilities,
    confidence: probability(answer.confidence, "confidence for severity"),
  };
  return legend === undefined ? severity : { ...severity, legend };
}

/** The two options carrying the most mass, best first. */
function topTwo(probabilities: Readonly<Record<string, number>>): [string, number][] {
  return Object.entries(probabilities)
    .sort(([leftId, left], [rightId, right]) =>
      right !== left ? right - left : leftId < rightId ? -1 : 1,
    )
    .slice(0, 2);
}

/**
 * Break a tie between the top two options on their Nouls.
 *
 * Only a tie between two candidates is broken: the abstention has no Noul, and
 * inventing one for it would be code deciding what "no cause fits" is worth.
 */
function tieBreak(
  choice: FaultChoice,
  probabilities: Readonly<Record<string, number>>,
  support: Readonly<Record<string, number>>,
): FaultChoice {
  const ranked = topTwo(probabilities);
  const [first, second] = ranked;
  if (first === undefined || second === undefined) return choice;
  if (first[1] - second[1] > TIE_BREAK_MARGIN) return choice;
  const firstSupport = support[first[0]];
  const secondSupport = support[second[0]];
  if (firstSupport === undefined || secondSupport === undefined) return choice;
  if (secondSupport > firstSupport) return second[0];
  if (firstSupport > secondSupport) return first[0];
  return choice;
}

/**
 * Read one response into the fields {@link DecisionOutput} carries.
 *
 * `candidateIds` is the list the request was built from, in its order: it is
 * what makes a missing Noul or an invented cause id a
 * {@link DecisionError} of kind `validation` rather than a hole that travels on
 * into a ticket.
 */
export function parseAnswers(
  candidateIds: readonly string[],
  answers: Readonly<Record<string, unknown>>,
): ParsedAnswers {
  const { choice, probabilities, confidence } = readChoice(answers, candidateIds);
  const support = readSupport(answers, candidateIds);
  const severity = readSeverity(answers);

  const decided = tieBreak(choice, probabilities, support);
  const named = decided === NONE_OF_THESE ? undefined : support[decided];

  return {
    choice: decided,
    probabilities,
    confidence,
    support,
    severity,
    tie_broken: decided !== choice,
    inconsistent: named !== undefined && named < INCONSISTENT_BELOW_SUPPORT,
  };
}
