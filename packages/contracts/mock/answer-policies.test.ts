// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The three named answer policies, the `answerPolicy` option and `MOCK_ANSWER_POLICY`. The
// `--answer-policy` flag is covered in `mock/cli.test.ts`, beside the rest of the command line.
//
// `best-overlap` is the one the CI Compose stack runs, so the point of this suite is that its
// answer is a function of the request: the same body answers the same way, a tie falls to the
// lower candidate id, and nothing here reads a clock or a random number.

import { describe, expect, it } from "vitest";

import { answerWithPolicy, type Answer, type Question, type SystemOneRequest } from "./answers.ts";
import { rankByOverlap } from "./overlap.ts";
import { answerPolicyFromEnv, startMockTypeSafe, type MockTypeSafe } from "./typesafe-mock.ts";

const CANDIDATES = {
  air_leak_dryer_purge: {
    what: "Dryer purge valve not seating",
    signals: ["dryer purge pressure rises far above normal while loaded"],
  },
  high_air_demand: { what: "Heavy air demand", signals: ["load cycles become more frequent"] },
  none_of_these: { what: "No candidate matches the observations" },
};

const STATE = {
  observations: [
    {
      signal: "p_dryer_purge",
      label: "dryer purge pressure",
      level: "far above normal",
      trend: "flat",
    },
    { signal: "t_oil", label: "oil temperature", level: "above normal", trend: "rising" },
  ],
  candidates: [
    {
      id: "high_air_demand",
      expected_signal_moves: [
        "load cycles become more frequent",
        "line pressure falls faster while unloaded",
      ],
    },
    {
      id: "air_leak_dryer_purge",
      expected_signal_moves: [
        "dryer purge pressure rises far above normal while loaded",
        "oil temperature rises gradually",
      ],
    },
  ],
};

const QUESTIONS: Record<string, Question> = {
  fault: { type: "choice", instructions: "Which candidate matches?", criteria: CANDIDATES },
  match_air_leak_dryer_purge: { type: "noul", instructions: "Does the purge move?" },
  match_high_air_demand: { type: "noul", instructions: "Does the demand move?" },
  severity: {
    type: "score",
    instructions: "How serious?",
    criteria: ["drifting", "working harder", "losing pressure", "stopping"],
  },
};

const REQUEST: SystemOneRequest = { state: STATE, questions: QUESTIONS };

function choiceOf(answers: Record<string, Answer>): {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
} {
  const answer = answers.fault;
  if (answer?.type !== "choice") throw new Error("expected a choice answer");
  return { ...answer, probabilities: { ...answer.probabilities } };
}

function noulOf(answers: Record<string, Answer>, id: string): number {
  const answer = answers[id];
  if (answer?.type !== "noul") throw new Error(`expected a noul answer for ${id}`);
  return answer.noul;
}

function scoreOf(answers: Record<string, Answer>): number {
  const answer = answers.severity;
  if (answer?.type !== "score") throw new Error("expected a score answer");
  return answer.score;
}

describe("the default policy", () => {
  it("spreads the mass evenly and sits in the middle of the rubric", () => {
    const answers = answerWithPolicy(REQUEST, "default");
    const choice = choiceOf(answers);
    expect(choice.choice).toBe("air_leak_dryer_purge");
    expect(choice.confidence).toBe(0);
    expect(Object.values(choice.probabilities)).toEqual([0.3334, 0.3333, 0.3333]);
    expect(noulOf(answers, "match_high_air_demand")).toBe(0.5);
    expect(scoreOf(answers)).toBe(1);
  });
});

describe("the confident-first policy", () => {
  it("backs the first candidate, its noul and level index 2", () => {
    const answers = answerWithPolicy(REQUEST, "confident-first");
    const choice = choiceOf(answers);
    expect(choice.choice).toBe("air_leak_dryer_purge");
    expect(choice.confidence).toBe(0.9);
    expect(choice.probabilities).toEqual({
      air_leak_dryer_purge: 0.9,
      high_air_demand: 0.05,
      none_of_these: 0.05,
    });
    expect(noulOf(answers, "match_air_leak_dryer_purge")).toBe(0.9);
    expect(noulOf(answers, "match_high_air_demand")).toBe(0.1);
    expect(scoreOf(answers)).toBe(2);
  });

  it("clamps the severity to the last level of a shorter rubric", () => {
    const answers = answerWithPolicy(
      {
        state: STATE,
        questions: {
          fault: QUESTIONS.fault as Question,
          severity: { type: "score", instructions: "?", criteria: ["calm", "loud"] },
        },
      },
      "confident-first",
    );
    expect(scoreOf(answers)).toBe(1);
  });
});

describe("the best-overlap policy", () => {
  it("picks the candidate whose expected moves match the observations", () => {
    const answers = answerWithPolicy(REQUEST, "best-overlap");
    const choice = choiceOf(answers);
    expect(choice.choice).toBe("air_leak_dryer_purge");
    expect(choice.confidence).toBe(0.9);
    expect(choice.probabilities.air_leak_dryer_purge).toBe(0.9);
    expect(noulOf(answers, "match_air_leak_dryer_purge")).toBe(0.9);
    expect(noulOf(answers, "match_high_air_demand")).toBe(0.1);
    expect(scoreOf(answers)).toBe(2);
  });

  it("follows the observations, not the order of the candidates", () => {
    const demandObserved: SystemOneRequest = {
      state: {
        ...STATE,
        observations: [
          { signal: "load_cycle_rate", label: "load cycle rate", level: "above normal" },
          { signal: "p_line", label: "line pressure", level: "below normal", trend: "falling" },
        ],
      },
      questions: QUESTIONS,
    };
    expect(choiceOf(answerWithPolicy(demandObserved, "best-overlap")).choice).toBe(
      "high_air_demand",
    );
  });

  it("breaks a tie by the lower candidate id", () => {
    const moves = ["oil temperature rises above normal"];
    const ranking = rankByOverlap(
      [
        { id: "zeta_fault", moves },
        { id: "alpha_fault", moves },
      ],
      ["oil temperature above normal rising"],
    );
    expect(ranking.map((entry) => entry.id)).toEqual(["alpha_fault", "zeta_fault"]);
    expect(ranking[0]?.score).toBe(ranking[1]?.score);
  });

  it("answers the same request the same way every time", () => {
    const first = answerWithPolicy(REQUEST, "best-overlap");
    const second = answerWithPolicy(structuredClone(REQUEST), "best-overlap");
    expect(second).toEqual(first);
  });

  it("falls back to the documented noul when the request has no choice question", () => {
    const answers = answerWithPolicy(
      { state: STATE, questions: { match_air_leak_dryer_purge: { type: "noul" } } },
      "best-overlap",
    );
    expect(noulOf(answers, "match_air_leak_dryer_purge")).toBe(0.5);
  });
});

describe("selecting a policy", () => {
  async function ask(mock: MockTypeSafe): Promise<Record<string, Answer>> {
    const response = await fetch(`${mock.url}/v1/systemone`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify(REQUEST),
    });
    const body = (await response.json()) as { answers: Record<string, Answer> };
    return body.answers;
  }

  it("takes the policy from the option and from `setNamedPolicy`", async () => {
    const mock = await startMockTypeSafe({ port: 0, answerPolicy: "confident-first" });
    try {
      expect(mock.answerPolicy).toBe("confident-first");
      expect(choiceOf(await ask(mock)).confidence).toBe(0.9);
      mock.setNamedPolicy("default");
      expect(choiceOf(await ask(mock)).confidence).toBe(0);
      mock.setNamedPolicy("best-overlap");
      expect(choiceOf(await ask(mock)).choice).toBe("air_leak_dryer_purge");
    } finally {
      await mock.close();
    }
  });

  it("reads MOCK_ANSWER_POLICY and refuses a name it does not know", () => {
    expect(answerPolicyFromEnv(undefined)).toEqual({ policy: "default" });
    expect(answerPolicyFromEnv("")).toEqual({ policy: "default" });
    expect(answerPolicyFromEnv("best-overlap")).toEqual({ policy: "best-overlap" });
    expect(answerPolicyFromEnv("guessing")).toEqual({ error: "unknown answer policy guessing" });
  });
});
