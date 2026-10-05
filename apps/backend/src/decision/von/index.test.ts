// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Von backend over a real socket.
 *
 * Every test here drives `createVonBackend` through `von-sdk` against
 * the contracts' mock TypeSafe server on a free port: the request the SDK
 * actually serialised, the headers it actually sent, the answers the mock
 * scripted and the failures it was told to serve. Nothing reaches the network
 * and no key is real.
 *
 * Every backend is built with `maxRetries: 0` except where a retry is the
 * subject, so a recorded request count is exact, and with an injected
 * wall clock so a latency is a number rather than a race.
 *
 * ## The golden request
 *
 * `test/fixtures/von/f3-request.json` is the request body for the
 * signature-A-like fixture event, pretty-printed with two spaces so a question
 * change reads as a diff. The SDK sends `JSON.stringify(body)`; the file's
 * bytes are compared with `JSON.stringify(body, null, 2)` of what the mock
 * recorded, and because both renderings keep key order and escape strings the
 * same way, the file compacted is the wire body byte for byte: any change to
 * the state, the question set or their order fails the comparison. Beside it,
 * `f3-usage.json` holds the `input_tokens` the mock reported, so question
 * growth — a silent cost regression through `app.cost_ledger` — shows up in
 * the diff. A change to any question regenerates both in the same
 * commit:
 *
 *     pnpm --filter @fdp/backend exec vitest run src/decision/von/index.test.ts --update
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertValid } from "@fdp/contracts";
import { REDACTED } from "@fdp/contracts/mock";

import { Secret } from "../../config/secret.ts";
import { FIXTURE_LABELS, FIXTURE_SEVERITY_HINTS } from "../../../test/fixtures/catalog/index.ts";
import {
  ADVERSARIAL_CAUSE,
  ADVERSARIAL_FAULT_ID,
  adversarialCandidates,
  goldenInput,
} from "../../../test/fixtures/von/cases.ts";
import { withSlack } from "../../../test/helpers/timing.ts";
import { MOCK_MODEL, startTypeSafeHarness } from "../../../test/helpers/typesafe.ts";
import type { TypeSafeHarness } from "../../../test/helpers/typesafe.ts";
import { moveTarget } from "../../retrieval/match.ts";
import { toDecisionMessage } from "../message.ts";
import type { DecisionMessageContext } from "../message.ts";
import { createRulesBackend } from "../rules/index.ts";
import { estimateTokens, STATE_TOKEN_BUDGET } from "../state.ts";
import { DecisionError, NONE_OF_THESE } from "../types.ts";
import type { DecisionBackend, DecisionInput, DecisionOutput, DecisionUsage } from "../types.ts";
import { createVonBackend } from "./index.ts";
import type { VonBackendOptions, VonWarn } from "./index.ts";
import type { VonRequestBody } from "./questions.ts";
import {
  estimateQuestionTokens,
  FAULT_QUESTION_ID,
  LONGEST_QUESTION_TOKEN_BUDGET,
  longestQuestionTokens,
  REQUEST_TOKEN_BUDGET,
} from "./questions.ts";

/** A throwaway bearer the mock accepts; nothing like a real key. */
const API_KEY = "mock-key-von";

const GOLDEN_REQUEST = "../../../test/fixtures/von/f3-request.json";
const GOLDEN_USAGE = "../../../test/fixtures/von/f3-usage.json";

/** A wall clock that moves 125 ms per reading, so a latency is exact. */
function steppingWall(): () => number {
  let now = 1_700_000_000_000;
  return () => {
    now += 125;
    return now;
  };
}

function vonBackend(url: string, overrides: Partial<VonBackendOptions> = {}): DecisionBackend {
  return createVonBackend({
    apiKey: new Secret(API_KEY),
    baseURL: url,
    model: MOCK_MODEL,
    maxRetries: 0,
    labels: FIXTURE_LABELS,
    wall: steppingWall(),
    ...overrides,
  });
}

/** Run a decision that must fail and hand back its `DecisionError`. */
async function failure(backend: DecisionBackend, input: DecisionInput): Promise<DecisionError> {
  const error: unknown = await backend.decide(input).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DecisionError);
  return error as DecisionError;
}

/** A `VonWarn` that remembers what it was told. */
function recordingWarn(): {
  warn: VonWarn;
  lines: { fields: Readonly<Record<string, string | number>>; message: string }[];
} {
  const lines: { fields: Readonly<Record<string, string | number>>; message: string }[] = [];
  return { warn: (fields, message) => lines.push({ fields, message }), lines };
}

/** The body the mock recorded for request `index`, as the bytes the SDK sent. */
function wireBody(harness: TypeSafeHarness, index: number): string {
  const recorded = harness.requests[index];
  if (recorded === undefined) throw new Error(`the mock recorded no request ${String(index)}`);
  return JSON.stringify(recorded.body);
}

/** Two-space JSON with a final newline: the layout of the committed fixtures. */
function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe("createVonBackend against the mock TypeSafe server", () => {
  let harness: TypeSafeHarness;

  beforeAll(async () => {
    harness = await startTypeSafeHarness({ apiKey: API_KEY });
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.reset();
  });

  describe("the golden request", () => {
    it("is byte-identical across two runs and to the committed fixture", async () => {
      const first = await vonBackend(harness.url).decide(goldenInput());
      const second = await vonBackend(harness.url).decide(goldenInput());

      expect(harness.requests).toHaveLength(2);
      const wire = wireBody(harness, 0);
      expect(wireBody(harness, 1)).toBe(wire);
      expect(JSON.stringify(first.raw.request)).toBe(wire);
      expect(JSON.stringify(second.raw.request)).toBe(wire);

      const golden = pretty(JSON.parse(wire));
      expect(JSON.stringify(JSON.parse(golden))).toBe(wire);
      await expect(golden).toMatchFileSnapshot(GOLDEN_REQUEST);
    });

    it("commits the input tokens the mock reports for it", async () => {
      const decision = await vonBackend(harness.url).decide(goldenInput());
      expect(decision.usage.input_tokens).toBeGreaterThan(0);
      await expect(pretty({ input_tokens: decision.usage.input_tokens })).toMatchFileSnapshot(
        GOLDEN_USAGE,
      );
    });

    it("fits the three token budgets as it went over the wire", async () => {
      await vonBackend(harness.url).decide(goldenInput());
      const body = harness.requests[0]?.body as VonRequestBody;
      const stateTokens = estimateTokens(body.state);
      expect(stateTokens).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
      expect(stateTokens + estimateQuestionTokens(body.questions)).toBeLessThanOrEqual(
        REQUEST_TOKEN_BUDGET,
      );
      expect(stateTokens + longestQuestionTokens(body.questions)).toBeLessThanOrEqual(
        LONGEST_QUESTION_TOKEN_BUDGET,
      );
    });

    it("carries every signal a candidate names, ahead of any it does not", async () => {
      const input = goldenInput();
      await vonBackend(harness.url).decide(input);
      const body = harness.requests[0]?.body as VonRequestBody;
      const named = new Set(
        input.candidates.flatMap((candidate) => candidate.signal_moves.map(moveTarget)),
      );
      const observed = input.event.observations
        .map((observation) => observation.signal)
        .filter((signal) => named.has(signal));
      const sent = body.state.observations.map((observation) => observation.signal);

      expect(observed.length).toBeGreaterThan(0);
      expect(sent.slice(0, observed.length).sort()).toEqual([...observed].sort());
    });

    it("names the pinned model and the three question kinds on the wire", async () => {
      await vonBackend(harness.url).decide(goldenInput());
      const request = harness.requests[0];
      expect(request?.method).toBe("POST");
      expect(request?.path).toBe("/v1/systemone");
      const body = request?.body as VonRequestBody;
      expect(Object.keys(body)).toEqual(["model", "state", "questions"]);
      expect(body.model).toBe("von-1.13.0");
      expect(Object.keys(body.questions)).toEqual([
        "fault",
        "match_dryer_purge_leak",
        "match_purge_silencer_damaged",
        "match_downstream_air_leak",
        "match_high_air_demand",
        "match_intake_filter_clogged",
        "match_airend_element_wear",
        "severity",
      ]);
    });
  });

  describe("the bearer", () => {
    it("reaches the mock as Authorization: Bearer <key>, and nothing records its value", async () => {
      await vonBackend(harness.url).decide(goldenInput());
      const headers = harness.requests[0]?.headers ?? {};
      // The mock accepts exactly `Bearer mock-key-von` and answers 401 to
      // anything else, so a 200 is the proof the key travelled; the recording
      // itself keeps only the header name.
      expect(headers["authorization"]).toBe(REDACTED);
      expect(headers["content-type"]).toBe("application/json");
      expect(JSON.stringify(harness.requests)).not.toContain(API_KEY);
    });

    it("is refused when it is the wrong one, as an auth failure", async () => {
      const wrong = createVonBackend({
        apiKey: new Secret("another-mock-key"),
        baseURL: harness.url,
        model: MOCK_MODEL,
        maxRetries: 0,
        labels: FIXTURE_LABELS,
      });
      const error = await failure(wrong, goldenInput());
      expect(error.kind).toBe("auth");
      expect(error.status).toBe(401);
      expect(harness.requests).toHaveLength(1);
    });
  });

  describe("scripted answers", () => {
    it("come back as a DecisionOutput carrying the mock's model and usage", async () => {
      harness.answerFault("dryer_purge_leak", 0.91);
      harness.answerNouls({ dryer_purge_leak: 0.93, downstream_air_leak: 0.2 });
      harness.answerSeverity("high", 0.8);

      const decision = await vonBackend(harness.url).decide(goldenInput());

      expect(decision.backend).toBe("von");
      expect(decision.model).toBe(MOCK_MODEL);
      expect(decision.choice).toBe("dryer_purge_leak");
      expect(decision.confidence).toBe(0.91);
      expect(decision.probabilities["dryer_purge_leak"]).toBe(0.91);
      expect(Object.keys(decision.probabilities)).toEqual([
        ...goldenInput().candidates.map((candidate) => candidate.fault_id),
        NONE_OF_THESE,
      ]);
      expect(decision.support).toEqual({
        dryer_purge_leak: 0.93,
        purge_silencer_damaged: 0.5,
        downstream_air_leak: 0.2,
        high_air_demand: 0.5,
        intake_filter_clogged: 0.5,
        airend_element_wear: 0.5,
      });
      expect(decision.severity).toMatchObject({ level: "high", score: 2, confidence: 0.8 });
      expect(decision.severity.legend).toHaveLength(4);

      // Scripted answers do not change the request, so the tokens are the
      // golden request's.
      expect(decision.usage.input_tokens).toBeGreaterThan(0);
      expect(decision.usage.output_tokens).toBe(0);
      expect(decision.latency_ms).toBe(125);
      expect(decision.state_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(decision.raw.response).toMatchObject({ model: MOCK_MODEL, usage: decision.usage });
    });

    it("let the Nouls break a tie the Choice left open", async () => {
      harness.answerFault("dryer_purge_leak", 0.4, {
        dryer_purge_leak: 0.4,
        purge_silencer_damaged: 0.38,
        [NONE_OF_THESE]: 0.22,
      });
      harness.answerNouls({ dryer_purge_leak: 0.35, purge_silencer_damaged: 0.85 });
      harness.answerSeverity("medium", 0.6);

      const decision = await vonBackend(harness.url).decide(goldenInput());
      expect(decision.choice).toBe("purge_silencer_damaged");
      expect(decision.confidence).toBe(0.4);
    });

    it("warn when the Choice names a cause its own Noul contradicts", async () => {
      harness.answerFault("dryer_purge_leak", 0.9);
      harness.answerNouls({ dryer_purge_leak: 0.1 });
      harness.answerSeverity("high", 0.8);
      const { warn, lines } = recordingWarn();

      const decision = await vonBackend(harness.url, { warn }).decide(goldenInput());
      expect(decision.choice).toBe("dryer_purge_leak");
      expect(lines).toEqual([
        {
          fields: { choice: "dryer_purge_leak", support: 0.1 },
          message: "von chose a cause whose own movement check stays low",
        },
      ]);
    });

    it("warn about nothing on an ordinary answer", async () => {
      const { warn, lines } = recordingWarn();
      await vonBackend(harness.url, { warn }).decide(goldenInput());
      expect(lines).toEqual([]);
    });
  });

  describe("the adversarial cause", () => {
    it("travels as data in the state and alters no question", async () => {
      const input = { ...goldenInput(), candidates: adversarialCandidates() };
      await vonBackend(harness.url).decide(goldenInput());
      await vonBackend(harness.url).decide(input);
      const plain = harness.requests[0]?.body as VonRequestBody;
      const steered = harness.requests[1]?.body as VonRequestBody;

      const index = steered.state.candidates.findIndex(
        (candidate) => candidate.id === ADVERSARIAL_FAULT_ID,
      );
      expect(steered.state.candidates[index]?.cause).toBe(ADVERSARIAL_CAUSE);

      // Same ids, same instructions, same Nouls and Score, byte for byte.
      expect(Object.keys(steered.questions)).toEqual(Object.keys(plain.questions));
      for (const [id, question] of Object.entries(steered.questions)) {
        expect(JSON.stringify(question.instructions), id).toBe(
          JSON.stringify(plain.questions[id]?.instructions),
        );
        if (id !== FAULT_QUESTION_ID) {
          expect(JSON.stringify(question), id).toBe(JSON.stringify(plain.questions[id]));
        }
      }

      // In the Choice only the renamed option's own name moved: the rest of its
      // description, its signals and contrast, every other option and the
      // abstention did not. No option quotes another cause's name, so the
      // renamed cause cannot reach its neighbours' descriptions.
      const plainCriteria = plain.questions[FAULT_QUESTION_ID]?.criteria as Record<
        string,
        Record<string, unknown>
      >;
      const steeredCriteria = steered.questions[FAULT_QUESTION_ID]?.criteria as Record<
        string,
        Record<string, unknown>
      >;
      const originalName =
        goldenInput().candidates.find((candidate) => candidate.fault_id === ADVERSARIAL_FAULT_ID)
          ?.name ?? "";
      for (const [option, criterion] of Object.entries(steeredCriteria)) {
        if (option === ADVERSARIAL_FAULT_ID) {
          const plainWhat = String(plainCriteria[option]?.["what"]);
          expect(plainWhat.startsWith(`${originalName}: `)).toBe(true);
          expect(criterion).toEqual({
            ...plainCriteria[option],
            what: `${ADVERSARIAL_CAUSE}${plainWhat.slice(originalName.length)}`,
          });
        } else {
          expect(criterion, option).toEqual(plainCriteria[option]);
        }
      }

      // Outside the state it is one option's `what` and nothing else.
      const questionsText = JSON.stringify(steered.questions);
      expect(questionsText.split(ADVERSARIAL_CAUSE)).toHaveLength(2);
    });
  });

  describe("failures", () => {
    it.each([
      { status: 401 as const, kind: "auth" },
      { status: 422 as const, kind: "validation" },
      { status: 429 as const, kind: "rate_limit" },
      { status: 529 as const, kind: "overloaded" },
      { status: 500 as const, kind: "unknown" },
    ])("map a $status to $kind after exactly one request", async ({ status, kind }) => {
      harness.fail(status);
      const error = await failure(vonBackend(harness.url), goldenInput());
      expect(error.kind).toBe(kind);
      expect(error.status).toBe(status);
      expect(harness.requests).toHaveLength(1);
    });

    it("retry a 529 twice with maxRetries 2, then give up after three requests", async () => {
      harness.fail(529, 3);
      const backend = vonBackend(harness.url, {
        maxRetries: 2,
        backoffInitialMs: 1,
        backoffMaxMs: 2,
      });
      const error = await failure(backend, goldenInput());
      expect(error.kind).toBe("overloaded");
      expect(harness.requests).toHaveLength(3);
    });

    it("recover from one 429 with maxRetries 2 in two requests", async () => {
      harness.fail(429, 1);
      const backend = vonBackend(harness.url, {
        maxRetries: 2,
        backoffInitialMs: 1,
        backoffMaxMs: 2,
      });
      const decision = await backend.decide(goldenInput());
      expect(decision.model).toBe(MOCK_MODEL);
      expect(harness.requests).toHaveLength(2);
    });

    it("never carry the provider's body, and never the key", async () => {
      harness.fail(429);
      const error = await failure(vonBackend(harness.url), goldenInput());
      expect(error).not.toHaveProperty("body");
      expect(error.message).not.toContain("Rate limit exceeded");
      expect(error.message).not.toContain("rate_limit_error");
      for (const text of [error.message, String(error), JSON.stringify(error), error.stack ?? ""]) {
        expect(text).not.toContain(API_KEY);
      }
    });

    it("map an attempt that outlives its timeout to timeout after one request", async () => {
      // The mock records a request once its whole body has arrived, so the
      // timeout must leave the body room to arrive on a loaded host;
      // the answer's latency stays ten times longer than the timeout.
      const timeoutMs = withSlack(250);
      const slow = await startTypeSafeHarness({ apiKey: API_KEY, latencyMs: 10 * timeoutMs });
      try {
        const error = await failure(vonBackend(slow.url, { timeoutMs }), goldenInput());
        expect(error.kind).toBe("timeout");
        expect(slow.requests).toHaveLength(1);
      } finally {
        await slow.close();
      }
    });

    it("map an aborted decision to timeout", async () => {
      const controller = new AbortController();
      controller.abort();
      const error: unknown = await vonBackend(harness.url)
        .decide(goldenInput(), { signal: controller.signal })
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );
      expect(error).toBeInstanceOf(DecisionError);
      expect((error as DecisionError).kind).toBe("timeout");
    });

    it("map a server that is not there to network", async () => {
      const gone = await startTypeSafeHarness({ apiKey: API_KEY });
      const url = gone.url;
      await gone.close();
      const error = await failure(vonBackend(url), goldenInput());
      expect(error.kind).toBe("network");
    });

    it("refuse an answer for a cause that was never offered", async () => {
      harness.answerFault("oil_cooler_fouled", 0.9);
      const error = await failure(vonBackend(harness.url), goldenInput());
      expect(error.kind).toBe("validation");
    });
  });

  describe("the model the response reports", () => {
    it("is stored and warned about when it is not the pinned one", async () => {
      const moved = await startTypeSafeHarness({ apiKey: API_KEY, model: "von-1.14.0" });
      try {
        const { warn, lines } = recordingWarn();
        const decision = await vonBackend(moved.url, { warn }).decide(goldenInput());
        expect(decision.model).toBe("von-1.14.0");
        expect((moved.requests[0]?.body as VonRequestBody).model).toBe(MOCK_MODEL);
        expect(lines).toEqual([
          {
            fields: { model: "von-1.14.0", pinned: MOCK_MODEL },
            message: "von answered with a model other than the pinned one",
          },
        ]);
      } finally {
        await moved.close();
      }
    });
  });

  describe("shape parity with the rules backend", () => {
    /** What the cost ledger would compute; the message only repeats it. */
    function prices(usage: DecisionUsage) {
      return {
        usd: (usage.input_tokens * 0.042) / 1e6,
        price_input_per_mtok: 0.042,
        price_output_per_mtok: 0,
        prices_as_of: "2026-09-19",
      };
    }

    function contextFor(output: DecisionOutput, input: DecisionInput): DecisionMessageContext {
      return {
        unit_id: input.unit_id,
        decision_id: "aaaaaaaa-0000-4000-8000-000000000015",
        episode_id: "bbbbbbbb-0000-4000-8000-000000000015",
        event_id: input.event.event_id,
        sim_ts: input.event.sim_ts,
        wall_ts: "2026-09-22T08:00:00.000Z",
        backend: output.backend,
        model: output.model,
        symptom_key: input.event.symptom_key,
        candidates: input.candidates,
        gate: { ticketMin: 0.85, reviewMin: 0.6 },
        prices,
      };
    }

    /**
     * The structure of an output with the values left out.
     *
     * `severity.legend` is the one optional field the interface gives a
     * backend with a Score to fill; the twin has no Score, so it is compared
     * separately below rather than through the key list.
     */
    function shapeOf(output: DecisionOutput): unknown {
      return {
        keys: Object.fromEntries(
          Object.entries(output)
            .map(([key, value]) => [key, typeof value] as const)
            .sort(([left], [right]) => (left < right ? -1 : 1)),
        ),
        probabilityIds: Object.keys(output.probabilities).sort(),
        supportIds: Object.keys(output.support).sort(),
        supportTypes: [...new Set(Object.values(output.support).map((value) => typeof value))],
        severity: Object.keys(output.severity)
          .filter((key) => key !== "legend")
          .sort(),
        severityLevels: Object.keys(output.severity.probabilities).sort(),
        usage: Object.keys(output.usage).sort(),
      };
    }

    it("answers the same input with the same shape, the same state and a valid message", async () => {
      const input = goldenInput();
      const von = await vonBackend(harness.url).decide(input);
      const rules = await createRulesBackend({
        severityHints: FIXTURE_SEVERITY_HINTS,
        labels: FIXTURE_LABELS,
        now: () => 0,
      }).decide(input);

      expect(shapeOf(von)).toEqual(shapeOf(rules));
      expect(von.state).toEqual(rules.state);
      expect(von.state_digest).toBe(rules.state_digest);
      expect(von.severity.legend?.every((line) => typeof line === "string")).toBe(true);

      const vonMessage = assertValid("decision", toDecisionMessage(von, contextFor(von, input)));
      const rulesMessage = assertValid(
        "decision",
        toDecisionMessage(rules, contextFor(rules, input)),
      );
      expect(Object.keys(vonMessage).sort()).toEqual(Object.keys(rulesMessage).sort());
    });
  });
});
