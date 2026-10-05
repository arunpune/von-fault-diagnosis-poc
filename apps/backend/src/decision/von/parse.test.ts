// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading Von's answers.
 *
 * Scripted answers go in as the literals a response body would carry, and
 * what comes out is compared field by field: the Choice read back, the Nouls
 * as per-candidate support, the severity level taken from the argmax of its
 * distribution rather than from the reported mean, the 0.05 tie-break and the
 * `inconsistent` flag. An answer that cannot be read is a `validation`
 * failure — never a default that travels on into a ticket.
 */

import { describe, expect, it } from "vitest";

import { DecisionError, NONE_OF_THESE } from "../types.ts";
import {
  INCONSISTENT_BELOW_SUPPORT,
  parseAnswers,
  readResponse,
  SEVERITY_ORDER,
  TIE_BREAK_MARGIN,
} from "./parse.ts";
import { FAULT_QUESTION_ID, matchQuestionId, SEVERITY_QUESTION_ID } from "./questions.ts";

const CANDIDATES = ["dryer_purge_leak", "downstream_air_leak", "high_air_demand"] as const;

const LEGEND = {
  "0": "Readings drift outside their normal band",
  "1": "The unit works harder than normal",
  "2": "The unit no longer reaches its cut-out pressure",
  "3": "Air supply is lost or a shutdown condition is active",
};

/** A peaked choice on the purge leak, with every Noul and a severity. */
function answers(
  overrides: {
    choice?: string;
    probabilities?: Record<string, number>;
    confidence?: number;
    nouls?: Partial<Record<(typeof CANDIDATES)[number], number>>;
    severity?: Record<string, number>;
  } = {},
): Record<string, unknown> {
  const nouls = { dryer_purge_leak: 0.9, downstream_air_leak: 0.2, high_air_demand: 0.1 };
  Object.assign(nouls, overrides.nouls);
  return {
    [FAULT_QUESTION_ID]: {
      type: "choice",
      choice: overrides.choice ?? "dryer_purge_leak",
      confidence: overrides.confidence ?? 0.88,
      probabilities: overrides.probabilities ?? {
        dryer_purge_leak: 0.82,
        downstream_air_leak: 0.08,
        high_air_demand: 0.05,
        [NONE_OF_THESE]: 0.05,
      },
    },
    ...Object.fromEntries(
      Object.entries(nouls).map(([id, noul]) => [matchQuestionId(id), { type: "noul", noul }]),
    ),
    [SEVERITY_QUESTION_ID]: {
      type: "score",
      score: 1.9,
      confidence: 0.7,
      legend: LEGEND,
      probabilities: overrides.severity ?? { "0": 0.05, "1": 0.15, "2": 0.65, "3": 0.15 },
    },
  };
}

function validationError(run: () => unknown): DecisionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DecisionError);
    expect((error as DecisionError).kind).toBe("validation");
    return error as DecisionError;
  }
  throw new Error("expected a validation DecisionError");
}

describe("parseAnswers: scripted answers", () => {
  const parsed = parseAnswers(CANDIDATES, answers());

  it("reads the Choice as it was answered", () => {
    expect(parsed.choice).toBe("dryer_purge_leak");
    expect(parsed.confidence).toBe(0.88);
    expect(parsed.probabilities).toEqual({
      dryer_purge_leak: 0.82,
      downstream_air_leak: 0.08,
      high_air_demand: 0.05,
      [NONE_OF_THESE]: 0.05,
    });
    expect(parsed.tie_broken).toBe(false);
  });

  it("reads every candidate's Noul as its support", () => {
    expect(parsed.support).toEqual({
      dryer_purge_leak: 0.9,
      downstream_air_leak: 0.2,
      high_air_demand: 0.1,
    });
  });

  it("maps the severity distribution's argmax to a level and keeps the legend", () => {
    expect(parsed.severity).toEqual({
      level: "high",
      score: 2,
      probabilities: { "0": 0.05, "1": 0.15, "2": 0.65, "3": 0.15 },
      confidence: 0.7,
      legend: [LEGEND["0"], LEGEND["1"], LEGEND["2"], LEGEND["3"]],
    });
  });

  it("reads an abstention as the abstention", () => {
    const abstained = parseAnswers(
      CANDIDATES,
      answers({
        choice: NONE_OF_THESE,
        probabilities: {
          dryer_purge_leak: 0.1,
          downstream_air_leak: 0.1,
          high_air_demand: 0.1,
          [NONE_OF_THESE]: 0.7,
        },
      }),
    );
    expect(abstained.choice).toBe(NONE_OF_THESE);
    expect(abstained.inconsistent).toBe(false);
  });
});

describe("parseAnswers: severity is the argmax, never the mean", () => {
  it("does not interpolate a level from a mean that falls between two", () => {
    // Mass split between the ends: the reported mean would land on `medium`
    // or `high`, and neither is what the model said.
    const split = parseAnswers(
      CANDIDATES,
      answers({ severity: { "0": 0.4, "1": 0, "2": 0, "3": 0.6 } }),
    );
    expect(split.severity.level).toBe("critical");
    expect(split.severity.score).toBe(3);
  });

  it("keeps the lower level on an exact tie", () => {
    const tied = parseAnswers(
      CANDIDATES,
      answers({ severity: { "0": 0, "1": 0.5, "2": 0.5, "3": 0 } }),
    );
    expect(tied.severity.level).toBe("medium");
  });

  it.each(SEVERITY_ORDER.map((level, index) => ({ level, index })))(
    "maps index $index to $level",
    ({ level, index }) => {
      const severity = { "0": 0, "1": 0, "2": 0, "3": 0, [String(index)]: 1 };
      expect(parseAnswers(CANDIDATES, answers({ severity })).severity.level).toBe(level);
    },
  );
});

describe("parseAnswers: the tie-break on the Nouls", () => {
  const close = {
    dryer_purge_leak: 0.4,
    downstream_air_leak: 0.37,
    high_air_demand: 0.13,
    [NONE_OF_THESE]: 0.1,
  };

  it("lets the higher Noul decide when the top two are within the margin", () => {
    const parsed = parseAnswers(
      CANDIDATES,
      answers({ probabilities: close, nouls: { dryer_purge_leak: 0.3, downstream_air_leak: 0.8 } }),
    );
    expect(parsed.choice).toBe("downstream_air_leak");
    expect(parsed.tie_broken).toBe(true);
    // The gate still reads the Choice's own confidence: the tie-break moves
    // the label, never the quantity the thresholds are tuned on.
    expect(parsed.confidence).toBe(0.88);
  });

  it("keeps the Choice when the Nouls agree with it", () => {
    const parsed = parseAnswers(CANDIDATES, answers({ probabilities: close }));
    expect(parsed.choice).toBe("dryer_purge_leak");
    expect(parsed.tie_broken).toBe(false);
  });

  it("treats a gap of exactly the margin as a tie", () => {
    const edge = { ...close, downstream_air_leak: 0.4 - TIE_BREAK_MARGIN };
    const parsed = parseAnswers(
      CANDIDATES,
      answers({ probabilities: edge, nouls: { dryer_purge_leak: 0.3, downstream_air_leak: 0.8 } }),
    );
    expect(parsed.choice).toBe("downstream_air_leak");
  });

  it("leaves a clear Choice alone whatever the Nouls say", () => {
    const parsed = parseAnswers(
      CANDIDATES,
      answers({ nouls: { dryer_purge_leak: 0.3, downstream_air_leak: 0.95 } }),
    );
    expect(parsed.choice).toBe("dryer_purge_leak");
    expect(parsed.tie_broken).toBe(false);
  });

  it("never breaks a tie with the abstention, which has no Noul", () => {
    const parsed = parseAnswers(
      CANDIDATES,
      answers({
        choice: NONE_OF_THESE,
        probabilities: {
          dryer_purge_leak: 0.39,
          downstream_air_leak: 0.1,
          high_air_demand: 0.09,
          [NONE_OF_THESE]: 0.42,
        },
        nouls: { dryer_purge_leak: 0.99 },
      }),
    );
    expect(parsed.choice).toBe(NONE_OF_THESE);
    expect(parsed.tie_broken).toBe(false);
  });
});

describe("parseAnswers: the inconsistent flag", () => {
  it("is raised when the named cause's own Noul is under the floor", () => {
    const parsed = parseAnswers(CANDIDATES, answers({ nouls: { dryer_purge_leak: 0.2 } }));
    expect(parsed.choice).toBe("dryer_purge_leak");
    expect(parsed.inconsistent).toBe(true);
  });

  it("is not raised at the floor itself", () => {
    const parsed = parseAnswers(
      CANDIDATES,
      answers({ nouls: { dryer_purge_leak: INCONSISTENT_BELOW_SUPPORT } }),
    );
    expect(parsed.inconsistent).toBe(false);
  });

  it("does not change the choice or the confidence", () => {
    const parsed = parseAnswers(CANDIDATES, answers({ nouls: { dryer_purge_leak: 0.05 } }));
    expect(parsed.choice).toBe("dryer_purge_leak");
    expect(parsed.confidence).toBe(0.88);
  });
});

describe("parseAnswers: answers that cannot be read", () => {
  it("refuses a cause that was never offered", () => {
    const error = validationError(() =>
      parseAnswers(CANDIDATES, answers({ choice: "oil_cooler_fouled" })),
    );
    expect(error.message).toContain("oil_cooler_fouled");
  });

  it("refuses a probability for an option that was never offered", () => {
    validationError(() =>
      parseAnswers(CANDIDATES, answers({ probabilities: { dryer_purge_leak: 0.9, other: 0.1 } })),
    );
  });

  it("refuses a missing Noul instead of reading it as zero", () => {
    const partial = answers();
    delete partial[matchQuestionId("high_air_demand")];
    validationError(() => parseAnswers(CANDIDATES, partial));
  });

  it("refuses a missing Choice or Score", () => {
    for (const id of [FAULT_QUESTION_ID, SEVERITY_QUESTION_ID]) {
      const partial = answers();
      delete partial[id];
      validationError(() => parseAnswers(CANDIDATES, partial));
    }
  });

  it("refuses a probability that is not a finite number", () => {
    validationError(() =>
      parseAnswers(CANDIDATES, answers({ probabilities: { dryer_purge_leak: Number.NaN } })),
    );
    validationError(() =>
      parseAnswers(CANDIDATES, answers({ confidence: Number.POSITIVE_INFINITY })),
    );
  });

  it("refuses a severity level outside the rubric", () => {
    validationError(() => parseAnswers(CANDIDATES, answers({ severity: { "4": 1 } })));
    validationError(() => parseAnswers(CANDIDATES, answers({ severity: { high: 1 } })));
  });
});

describe("readResponse", () => {
  const body = {
    model: "von-1.13.0",
    answers: answers(),
    usage: { input_tokens: 812, output_tokens: 0 },
  };

  it("keeps the model, the answers and the usage", () => {
    expect(readResponse(body)).toEqual(body);
  });

  it("refuses a body without a model, answers or usage", () => {
    validationError(() => readResponse(undefined));
    validationError(() => readResponse({ ...body, model: "" }));
    validationError(() => readResponse({ ...body, answers: null }));
    validationError(() => readResponse({ model: body.model, answers: body.answers }));
  });

  it("refuses a token count the ledger could not price", () => {
    validationError(() => readResponse({ ...body, usage: { input_tokens: -1, output_tokens: 0 } }));
    validationError(() =>
      readResponse({ ...body, usage: { input_tokens: 1.5, output_tokens: 0 } }),
    );
    validationError(() => readResponse({ ...body, usage: { input_tokens: 10 } }));
  });
});
