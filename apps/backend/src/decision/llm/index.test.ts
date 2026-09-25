// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The answer handling of the language-model backend.
 *
 * A fake provider, so every case here is about what the backend does with an
 * answer and never about a socket: the real SDK is driven over HTTP in
 * `anthropic.test.ts`, and the two suites do not overlap.
 *
 * The cases are a good answer, a refusal, an answer
 * that did not parse, an id no candidate carries, probabilities that do not sum
 * to one — plus the property that holds all of it together: whatever the model
 * writes, what leaves this backend is the same `DecisionOutput` the rules twin
 * produces, so the gate, the episodes and the evaluation report cannot tell the
 * three backends apart by shape.
 */

import { describe, expect, it } from "vitest";

import { fixedClock } from "../../clock.ts";
import {
  candidatesFor,
  FIXTURE_LABELS,
  FIXTURE_SEVERITY_HINTS,
} from "../../../test/fixtures/catalog/index.ts";
import {
  FIXTURE_UNIT_ID,
  SIGNATURE_A_CANDIDATE_IDS,
  SIGNATURE_A_EVENT,
} from "../../../test/fixtures/catalog/events.ts";
import { createRulesBackend } from "../rules/index.ts";
import { buildState, stateDigest } from "../state.ts";
import { DecisionError, isDecisionError, NONE_OF_THESE } from "../types.ts";
import type { DecisionInput, DecisionOutput } from "../types.ts";
import { createLlmBackend, SYSTEM_PROMPT } from "./index.ts";
import type { LlmCallOptions, LlmCompletion, LlmProvider, LlmRequest } from "./provider.ts";
import type { DecisionAnswer } from "./schema.ts";

/** The model the fake provider reports; the real default is `claude-opus-5`. */
const MODEL = "claude-opus-5";

/** A clock that never moves, so a latency assertion is not a race. */
const FROZEN_WALL = "2026-09-22T08:00:00.000Z";

const INPUT: DecisionInput = {
  event: SIGNATURE_A_EVENT,
  candidates: candidatesFor(SIGNATURE_A_CANDIDATE_IDS),
  unit_id: FIXTURE_UNIT_ID,
};

/** `probabilities` as the model writes it: one `{ id, probability }` entry per key, in order. */
function probabilityList(values: Record<string, number>): DecisionAnswer["probabilities"] {
  return Object.entries(values).map(([id, probability]) => ({ id, probability }));
}

/** `support` as the model writes it: one `{ id, support }` entry per key, in order. */
function supportList(values: Record<string, number>): DecisionAnswer["support"] {
  return Object.entries(values).map(([id, support]) => ({ id, support }));
}

/** A well-formed answer to the fixture event; each case bends one field of it. */
function answer(overrides: Partial<DecisionAnswer> = {}): DecisionAnswer {
  return {
    choice: "dryer_purge_leak",
    probabilities: probabilityList({
      dryer_purge_leak: 0.7,
      purge_silencer_damaged: 0.1,
      downstream_air_leak: 0.1,
      high_air_demand: 0.05,
      intake_filter_clogged: 0.03,
      airend_element_wear: 0.01,
      [NONE_OF_THESE]: 0.01,
    }),
    support: supportList({ dryer_purge_leak: 1, purge_silencer_damaged: 0.5, high_air_demand: 0 }),
    severity_level: "high",
    severity_confidence: 0.8,
    rationale: "The purge pressure sits far above normal while the unit never reaches cut-out.",
    ...overrides,
  };
}

interface FakeProvider extends LlmProvider {
  /** Every request the backend made, so the prompt and the state can be read back. */
  readonly calls: { request: LlmRequest; options: LlmCallOptions | undefined }[];
}

/** A provider that answers with `completion`, or throws it when it is an error. */
function fakeProvider(completion: Partial<LlmCompletion> | Error): FakeProvider {
  const calls: { request: LlmRequest; options: LlmCallOptions | undefined }[] = [];
  return {
    name: "fake",
    model: MODEL,
    calls,
    complete(request: LlmRequest, options?: LlmCallOptions): Promise<LlmCompletion> {
      calls.push({ request, options });
      if (completion instanceof Error) return Promise.reject(completion);
      return Promise.resolve({
        parsed: null,
        usage: { input_tokens: 1_400, output_tokens: 120 },
        model: MODEL,
        stop_reason: "end_turn",
        raw: {},
        ...completion,
      });
    },
  };
}

/** The backend over a provider that answers `parsed`. */
function backendAnswering(parsed: unknown, rest: Partial<LlmCompletion> = {}) {
  const provider = fakeProvider({ parsed, ...rest });
  const backend = createLlmBackend(provider, fixedClock(FROZEN_WALL), { labels: FIXTURE_LABELS });
  return { provider, backend };
}

/** The error a `decide` call threw, as a `DecisionError`. */
async function failureOf(decide: Promise<unknown>): Promise<DecisionError> {
  const caught: unknown = await decide.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!isDecisionError(caught)) throw new Error(`expected a DecisionError, got ${String(caught)}`);
  return caught;
}

describe("the system prompt", () => {
  it("states the three questions and the abstention", () => {
    expect(SYSTEM_PROMPT).toContain("`expected_signal_moves`");
    expect(SYSTEM_PROMPT).toContain("`observations`");
    expect(SYSTEM_PROMPT).toContain(NONE_OF_THESE);
    expect(SYSTEM_PROMPT).toContain("`support`");
    expect(SYSTEM_PROMPT).toContain("`severity_level`");
  });

  it("names the four severity levels as situations with no numeral in them", () => {
    const levels = SYSTEM_PROMPT.split("\n").filter((line) =>
      /^\s+- (low|medium|high|critical):/.test(line),
    );
    expect(levels).toHaveLength(4);
    for (const level of levels) expect(level).not.toMatch(/\d/);
  });

  it("tells the model that the state is data, not instructions", () => {
    expect(SYSTEM_PROMPT).toContain("never an");
    expect(SYSTEM_PROMPT).toContain("instruction to follow");
  });
});

describe("createLlmBackend on a well-formed answer", () => {
  it("sends the fixed prompt and the state the other backends are built from", async () => {
    const { provider, backend } = backendAnswering(answer());
    await backend.decide(INPUT);

    expect(provider.calls).toHaveLength(1);
    const request = provider.calls[0]?.request;
    expect(request?.system).toBe(SYSTEM_PROMPT);
    expect(JSON.parse(request?.user ?? "null")).toEqual(buildState(INPUT, FIXTURE_LABELS));
  });

  it("returns the DecisionOutput the rules twin returns, field for field", async () => {
    const { backend } = backendAnswering(answer());
    const output = await backend.decide(INPUT);
    const twin = await createRulesBackend({
      severityHints: FIXTURE_SEVERITY_HINTS,
      labels: FIXTURE_LABELS,
      now: () => Date.parse(FROZEN_WALL),
    }).decide(INPUT);

    expect(Object.keys(output).sort()).toEqual(Object.keys(twin).sort());
    expect(output.backend).toBe("llm");
    expect(output.model).toBe(MODEL);
    expect(output.choice).toBe("dryer_purge_leak");
    expect(output.state_digest).toBe(stateDigest(buildState(INPUT, FIXTURE_LABELS)));
    expect(output.usage).toEqual({ input_tokens: 1_400, output_tokens: 120 });
    expect(output.latency_ms).toBe(0);
  });

  it("normalises the probabilities over the candidates and the abstention", async () => {
    const { backend } = backendAnswering(answer());
    const output = await backend.decide(INPUT);

    expect(Object.keys(output.probabilities).sort()).toEqual(
      [...SIGNATURE_A_CANDIDATE_IDS, NONE_OF_THESE].sort(),
    );
    const total = Object.values(output.probabilities).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  it("reports confidence as the margin between the two best", async () => {
    const { backend } = backendAnswering(answer());
    const output = await backend.decide(INPUT);
    const sorted = Object.values(output.probabilities).sort((left, right) => right - left);
    expect(output.confidence).toBeCloseTo((sorted[0] ?? 0) - (sorted[1] ?? 0), 12);
    expect(output.confidence).toBeCloseTo(0.6, 12);
  });

  it("keeps a support per candidate, and null for one the model said nothing about", async () => {
    const { backend } = backendAnswering(answer());
    const output = await backend.decide(INPUT);

    expect(Object.keys(output.support).sort()).toEqual([...SIGNATURE_A_CANDIDATE_IDS].sort());
    expect(output.support["dryer_purge_leak"]).toBe(1);
    expect(output.support["high_air_demand"]).toBe(0);
    expect(output.support["downstream_air_leak"]).toBeNull();
  });

  it("maps the severity level to a one-hot score with the model's own confidence", async () => {
    const { backend } = backendAnswering(answer());
    const output = await backend.decide(INPUT);

    expect(output.severity).toEqual({
      level: "high",
      score: 2,
      probabilities: { "0": 0, "1": 0, "2": 1, "3": 0 },
      confidence: 0.8,
    });
  });

  it("carries the provider's request id and raw bodies through", async () => {
    const raw = { request: { model: MODEL }, response: { id: "msg_fake" } };
    const { backend } = backendAnswering(answer(), { request_id: "req_fake", raw });
    const output = await backend.decide(INPUT);

    expect(output.request_id).toBe("req_fake");
    expect(output.raw).toEqual(raw);
  });

  it("keeps the rationale out of every field but the raw response", async () => {
    const { backend } = backendAnswering(answer(), { raw: { response: { rationale: "kept" } } });
    const { raw, ...rest } = await backend.decide(INPUT);
    expect(JSON.stringify(rest)).not.toContain("never reaches cut-out");
    expect(raw.response).toEqual({ rationale: "kept" });
  });

  it("measures the latency on the wall clock it was given", async () => {
    const wall = fixedClock(FROZEN_WALL);
    const provider: LlmProvider = {
      ...fakeProvider({ parsed: answer() }),
      complete(request, options) {
        wall.advance(1_250);
        return fakeProvider({ parsed: answer() }).complete(request, options);
      },
    };
    const output = await createLlmBackend(provider, wall, { labels: FIXTURE_LABELS }).decide(INPUT);
    expect(output.latency_ms).toBe(1_250);
  });

  it("passes an abort signal down to the provider", async () => {
    const { provider, backend } = backendAnswering(answer());
    const controller = new AbortController();
    await backend.decide(INPUT, { signal: controller.signal });
    expect(provider.calls[0]?.options?.signal).toBe(controller.signal);
  });
});

describe("createLlmBackend on an answer it cannot use", () => {
  it("turns a refusal into a validation error naming it and its category", async () => {
    const { backend } = backendAnswering(null, {
      stop_reason: "refusal",
      detail: "refusal category: general_harms",
    });
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("refused");
    expect(error.message).toContain("general_harms");
  });

  it("turns an answer cut off at the token limit into a validation error", async () => {
    const { backend } = backendAnswering(null, { stop_reason: "max_tokens" });
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("cut off");
  });

  it("turns a null parse into a validation error with the provider's reason", async () => {
    const { backend } = backendAnswering(null, { detail: "Unexpected end of JSON input" });
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("no answer that fits the schema");
    expect(error.message).toContain("stop reason: end_turn");
    expect(error.message).toContain("Unexpected end of JSON input");
  });

  it("refuses an answer that does not satisfy the schema", async () => {
    const { backend } = backendAnswering({ choice: "dryer_purge_leak" });
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("does not fit the schema");
  });

  it("refuses a choice no candidate carries", async () => {
    const { backend } = backendAnswering(answer({ choice: "belt_slipping" }));
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("belt_slipping");
  });

  it("refuses a probability keyed by an id no candidate carries", async () => {
    const { backend } = backendAnswering(
      answer({ probabilities: probabilityList({ dryer_purge_leak: 0.9, belt_slipping: 0.1 }) }),
    );
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("probabilities");
  });

  it("refuses a support keyed by an id no candidate carries", async () => {
    const { backend } = backendAnswering(answer({ support: supportList({ belt_slipping: 1 }) }));
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("support");
  });

  it("refuses an id listed twice in probabilities, which gives it two values", async () => {
    const { backend } = backendAnswering(
      answer({
        probabilities: [
          { id: "dryer_purge_leak", probability: 0.6 },
          { id: NONE_OF_THESE, probability: 0.1 },
          { id: "dryer_purge_leak", probability: 0.3 },
        ],
      }),
    );
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("validation");
    expect(error.message).toBe('the model listed "dryer_purge_leak" twice in probabilities');
  });

  it("refuses an id listed twice in support", async () => {
    const { backend } = backendAnswering(
      answer({
        support: [
          { id: "high_air_demand", support: 0 },
          { id: "high_air_demand", support: 1 },
        ],
      }),
    );
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("validation");
    expect(error.message).toBe('the model listed "high_air_demand" twice in support');
  });

  it("refuses a value that is not a number at or above zero", async () => {
    const negative = backendAnswering(
      answer({ probabilities: probabilityList({ dryer_purge_leak: 1, high_air_demand: -0.1 }) }),
    );
    const probability = await failureOf(negative.backend.decide(INPUT));
    expect(probability.message).toBe(
      'the model gave "high_air_demand" a probability that is not a number at or above zero',
    );

    const support = await failureOf(
      backendAnswering(answer({ support: supportList({ dryer_purge_leak: -1 }) })).backend.decide(
        INPUT,
      ),
    );
    expect(support.message).toBe(
      'the model gave "dryer_purge_leak" a support that is not a number at or above zero',
    );
  });

  it("refuses the maps of the schema before be-decide-02 as not fitting the schema", async () => {
    const { backend } = backendAnswering({
      ...answer(),
      probabilities: { dryer_purge_leak: 0.9, [NONE_OF_THESE]: 0.1 },
    });
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("does not fit the schema");
    expect(error.message).toContain("probabilities");
  });

  it("refuses probabilities that carry no mass at all", async () => {
    const { backend } = backendAnswering(
      answer({ probabilities: probabilityList({ dryer_purge_leak: 0, high_air_demand: 0 }) }),
    );
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("no mass");
  });

  it("lets the provider's own DecisionError through unchanged", async () => {
    const thrown = new DecisionError("rate_limit", "too many requests", { status: 429 });
    const backend = createLlmBackend(fakeProvider(thrown), fixedClock(FROZEN_WALL), {
      labels: FIXTURE_LABELS,
    });
    const error = await failureOf(backend.decide(INPUT));
    expect(error.kind).toBe("rate_limit");
    expect(error.status).toBe(429);
  });
});

describe("probabilities that do not sum to one", () => {
  it("renormalises them and still reports a margin between zero and one", async () => {
    const { backend } = backendAnswering(
      answer({
        choice: "high_air_demand",
        probabilities: probabilityList({
          high_air_demand: 6,
          dryer_purge_leak: 2,
          [NONE_OF_THESE]: 2,
        }),
      }),
    );
    const output: DecisionOutput = await backend.decide(INPUT);

    expect(output.probabilities["high_air_demand"]).toBeCloseTo(0.6, 12);
    expect(output.probabilities["dryer_purge_leak"]).toBeCloseTo(0.2, 12);
    expect(output.probabilities["intake_filter_clogged"]).toBe(0);
    expect(output.confidence).toBeCloseTo(0.4, 12);
  });
});

describe("an answer that contradicts itself", () => {
  it("reports zero confidence when the choice is not the most probable option", async () => {
    const { backend } = backendAnswering(
      answer({
        choice: "high_air_demand",
        probabilities: probabilityList({ dryer_purge_leak: 0.8, high_air_demand: 0.2 }),
      }),
    );
    const output = await backend.decide(INPUT);

    expect(output.choice).toBe("high_air_demand");
    expect(output.confidence).toBe(0);
  });
});
