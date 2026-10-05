// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The mock TypeSafe server, scripted the way the decision tests think.
 *
 * `@fdp/contracts/mock` gives a faithful HTTP stand-in for
 * `POST /v1/systemone`: it validates the request against the committed schema,
 * answers with a pure function of it and can be told to fail. What it does not
 * give is a vocabulary — a scripted `AnswerPolicy` has to build a whole
 * `ChoiceAnswer` from labels the test cannot know until the request arrives.
 *
 * This harness closes that gap. A test says "the cause is `dryer_purge_leak`
 * with this confidence", "these candidates' movements are present", "this is
 * how serious it is", and the policy builds the wire answers from the question
 * set that actually turned up — so a test never restates the request it is
 * testing, and a renamed question id fails loudly instead of being answered by
 * a stale literal.
 *
 * Every instance binds port 0, so parallel Vitest workers never collide, and
 * nothing here reaches the network.
 */

import type { SeverityLevel } from "@fdp/contracts";
import { startMockTypeSafe } from "@fdp/contracts/mock";
import type {
  Answer,
  ChoiceQuestion,
  Entry,
  FailStatus,
  MockTypeSafe,
  RecordedRequest,
  ScoreQuestion,
  SystemOneRequest,
} from "@fdp/contracts/mock";

import { SEVERITY_ORDER } from "../../src/decision/von/parse.ts";
import { matchQuestionId } from "../../src/decision/von/questions.ts";

/** The pinned model the mock answers with; the backend's requests must name it. */
export { MOCK_MODEL } from "@fdp/contracts/mock";

/** What a test may script, in the vocabulary of the Von question set. */
export interface TypeSafeHarness {
  /** The base URL the backend is pointed at. */
  readonly url: string;
  /** Every request the mock received, newest last; bearer values are redacted. */
  readonly requests: readonly RecordedRequest[];
  /**
   * The cause the Choice names.
   *
   * With no `probabilities` the named option takes `confidence` of the mass and
   * the rest is split evenly, which is the shape a peaked answer has. A test
   * about the tie-break passes the vector it means.
   */
  answerFault(
    id: string,
    confidence: number,
    probabilities?: Readonly<Record<string, number>>,
  ): void;
  /** The Noul of each candidate, keyed by `fault_id`; an absent one stays at a half. */
  answerNouls(nouls: Readonly<Record<string, number>>): void;
  /** The severity level, with all the Score's mass on it, and its confidence. */
  answerSeverity(level: SeverityLevel, confidence: number): void;
  /** Answer the next `times` requests with `status` before anything else runs. */
  fail(status: FailStatus, times?: number): void;
  /** Drop the recorded requests and every scripted answer. */
  reset(): void;
  close(): Promise<void>;
}

export interface TypeSafeHarnessOptions {
  /** The single accepted bearer token; any other one is a 401. */
  readonly apiKey?: string;
  /** The model every response reports, for the mismatch warning. */
  readonly model?: string;
  /** Delay before each answer, for reproducing a timeout. */
  readonly latencyMs?: number;
}

/** The unscripted Noul of the mock's documented default policy. */
const UNDECIDED_NOUL = 0.5;

/** What a test scripted so far. */
interface Script {
  fault?: { id: string; confidence: number; probabilities?: Readonly<Record<string, number>> };
  nouls?: Readonly<Record<string, number>>;
  severity?: { level: number; confidence: number };
}

function isChoice(question: unknown): question is ChoiceQuestion {
  return (
    typeof question === "object" &&
    question !== null &&
    (question as { type?: unknown }).type === "choice"
  );
}

function isScore(question: unknown): question is ScoreQuestion {
  return (
    typeof question === "object" &&
    question !== null &&
    (question as { type?: unknown }).type === "score"
  );
}

/** One Score level as the `legend` reports it: the string, its `summary`, or its JSON. */
function legendText(level: Entry): string {
  if (typeof level === "string") return level;
  if (level !== null && !Array.isArray(level) && typeof level === "object") {
    const summary = (level as { summary?: unknown }).summary;
    if (typeof summary === "string") return summary;
  }
  return JSON.stringify(level);
}

/** The scripted Choice, built from the labels the request actually carried. */
function choiceAnswer(question: ChoiceQuestion, scripted: NonNullable<Script["fault"]>): Answer {
  const labels = Object.keys(question.criteria);
  const probabilities: Record<string, number> = {};
  if (scripted.probabilities === undefined) {
    const rest = labels.length > 1 ? (1 - scripted.confidence) / (labels.length - 1) : 0;
    for (const label of labels) {
      probabilities[label] = label === scripted.id ? scripted.confidence : rest;
    }
  } else {
    for (const label of labels) probabilities[label] = scripted.probabilities[label] ?? 0;
  }
  return {
    type: "choice",
    choice: scripted.id,
    confidence: scripted.confidence,
    probabilities,
  };
}

/** The scripted Score: all the mass on one level, with the rubric echoed back. */
function scoreAnswer(question: ScoreQuestion, scripted: NonNullable<Script["severity"]>): Answer {
  const legend: Record<string, string> = {};
  const probabilities: Record<string, number> = {};
  question.criteria.forEach((level, index) => {
    legend[String(index)] = legendText(level);
    probabilities[String(index)] = index === scripted.level ? 1 : 0;
  });
  return {
    type: "score",
    score: scripted.level,
    confidence: scripted.confidence,
    legend,
    probabilities,
  };
}

/** `match_<fault_id>` back to the `fault_id` a test keyed its map by. */
function faultIdOf(questionId: string): string | undefined {
  const prefix = matchQuestionId("");
  return questionId.startsWith(prefix) ? questionId.slice(prefix.length) : undefined;
}

/**
 * Start the mock and wrap it.
 *
 * The scripted policy is installed once and reads a record the setters mutate,
 * so a test can script the cause, the Nouls and the severity in any order and
 * in any number of steps without replacing what it scripted before.
 */
export async function startTypeSafeHarness(
  options: TypeSafeHarnessOptions = {},
): Promise<TypeSafeHarness> {
  const script: Script = {};
  const mock: MockTypeSafe = await startMockTypeSafe({
    port: 0,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.latencyMs === undefined ? {} : { latencyMs: options.latencyMs }),
  });

  function policy(request: SystemOneRequest): Partial<Record<string, Answer>> {
    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      if (isChoice(question) && script.fault !== undefined) {
        answers[id] = choiceAnswer(question, script.fault);
        continue;
      }
      if (isScore(question) && script.severity !== undefined) {
        answers[id] = scoreAnswer(question, script.severity);
        continue;
      }
      const faultId = faultIdOf(id);
      if (question.type === "noul" && faultId !== undefined && script.nouls !== undefined) {
        answers[id] = { type: "noul", noul: script.nouls[faultId] ?? UNDECIDED_NOUL };
      }
    }
    return answers;
  }

  mock.script(policy);

  return {
    url: mock.url,
    requests: mock.requests,
    answerFault(id, confidence, probabilities): void {
      script.fault = { id, confidence, ...(probabilities === undefined ? {} : { probabilities }) };
    },
    answerNouls(nouls): void {
      script.nouls = nouls;
    },
    answerSeverity(level, confidence): void {
      script.severity = { level: SEVERITY_ORDER.indexOf(level), confidence };
    },
    fail(status, times = 1): void {
      mock.failNext(status, times);
    },
    reset(): void {
      delete script.fault;
      delete script.nouls;
      delete script.severity;
      // `reset` drops the mock's scripted policy along with the recorded
      // requests, so the harness reinstalls its own.
      mock.reset();
      mock.script(policy);
    },
    close(): Promise<void> {
      return mock.close();
    },
  };
}
