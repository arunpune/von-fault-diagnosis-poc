// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline end to end, in process.
 *
 * Every test pushes telemetry batches through `createPipeline` exactly as a
 * host would and reads nothing but the outputs: the retriever is the
 * database-free catalog retriever over the fictional fixture catalog, and the
 * decision backend is either the rules twin or the real Jev backend talking to
 * the contracts' mock TypeSafe server on a free port, with `maxRetries: 0` so a
 * scripted failure is exactly one failed call. No test reaches the
 * network and no key is real.
 *
 * Two sources feed the same machinery:
 *
 *   * **synthetic telemetry** from `test/fixtures/synthetic/`, built from the
 *     first-month numbers of MetroPT-3. These run everywhere, offline and
 *     without the dataset, and pin every lifecycle rule exactly: one symptom
 *     key for the open, re-decide, promote, close and abort cases, two keys
 *     for the merge;
 *   * **the MetroPT-3 fixtures** that `make fixtures` and `pnpm --filter
 *     @fdp/backend fixtures` cut on this machine: the unlabelled
 *     continuous-load episode of 19 May, the February baseline and the
 *     synthetic jump. Those tests skip when the files are absent and
 *     `test/global-setup.ts` fails the run instead under
 *     `FDP_REQUIRE_DATASET=1`. No assertion here encodes a labelled failure
 *     window; onset timing belongs to `tools/eval`.
 *
 * The mock is scripted by cause rather than by request: it answers the cause
 * the test named, with the confidence the test named, whenever that cause is
 * among the candidates retrieval offered, and a quiet `none_of_these` when it
 * is not — which is what a real model would have to do with a list that does
 * not contain the answer.
 */

import { ALARMS, simMinutesBetween, validate } from "@fdp/contracts";
import type { Decision, Sample, TelemetrySamples, Ticket, ValidationResult } from "@fdp/contracts";
import { MOCK_MODEL, startMockTypeSafe } from "@fdp/contracts/mock";
import type { Answer, AnswerPolicy, MockTypeSafe } from "@fdp/contracts/mock";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "../clock.ts";
import { createEpisodeStore, toEpisodeMessage } from "../episodes/index.ts";
import { TicketClosedError, UnknownTicketError } from "../tickets/index.ts";
import { FIXTURE_CATALOG, FIXTURE_LABELS } from "../../test/fixtures/catalog/index.ts";
import {
  baseline,
  frequentCycling,
  longLoadedRuns,
  runBatches,
  scenarioBatches,
} from "../../test/fixtures/synthetic/index.ts";
import { hasFixture, loadFixture } from "../../test/helpers/fixtures.ts";
import {
  NONE_OF_THESE,
  Secret,
  createCatalogRetriever,
  createJevBackend,
  createPipeline,
  createRulesBackend,
} from "./index.ts";
import type {
  DecisionBackend,
  Pipeline,
  PipelineConfig,
  PipelineOutput,
  PipelinePorts,
  PipelineSnapshot,
  Prices,
  Retriever,
  TicketRecord,
} from "./index.ts";

/** A throwaway bearer the mock accepts; nothing like a real key. */
const API_KEY = "mock-key-pipeline";

/** A price per million input tokens for Jev and no output price. */
const JEV_PRICES: Prices = {
  price_input_per_mtok: 0.042,
  price_output_per_mtok: 0,
  prices_as_of: "2026-09-19",
};

/** The wall instant every pipeline of this file starts at. */
const WALL_START = "2026-09-22T08:00:00.000Z";

/** The confidence of the abstention the mock gives when the scripted cause is not offered. */
const UNOFFERED_CONFIDENCE = 0.3;

/** The cause the synthetic signatures are scripted to; every candidate list of theirs holds it. */
const SYNTHETIC_FAULT = "downstream_air_leak";

/** The cause the 19 May episode is scripted to. */
const MAY_FAULT = "dryer_purge_leak";

/**
 * A pipeline that decides every episode at once, without persistence before the
 * first decision (`GATE_PERSIST_SIM_MIN=0`), for the tests that pin the order
 * and the timing of that path rather than the persistence rule.
 */
const NO_PERSISTENCE: Partial<PipelineConfig> = { persistSimMin: 0 };

// ---------------------------------------------------------------------------
// The scripted mock TypeSafe server
// ---------------------------------------------------------------------------

interface JevScript {
  readonly fault: string;
  readonly confidence: number;
}

/** A Choice answer over `labels`: the scripted cause when offered, a quiet abstention otherwise. */
function choiceAnswer(labels: readonly string[], script: JevScript): Answer {
  const offered = labels.includes(script.fault);
  const choice = offered ? script.fault : NONE_OF_THESE;
  const confidence = offered ? script.confidence : UNOFFERED_CONFIDENCE;
  const rest = labels.length > 1 ? (1 - confidence) / (labels.length - 1) : 0;
  const probabilities = Object.fromEntries(
    labels.map((label) => [label, label === choice ? confidence : rest]),
  );
  return { type: "choice", choice, confidence, probabilities };
}

/**
 * The policy the mock runs: only the Choice is scripted.
 *
 * The Nouls and the severity Score keep the mock's documented defaults, which
 * are well-formed answers; a test here is about what the pipeline does with a
 * choice and its confidence, not about how Jev weighs the evidence.
 */
function scriptedPolicy(current: () => JevScript): AnswerPolicy {
  return (request) => {
    const answers: Partial<Record<string, Answer>> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      if (question.type === "choice") {
        answers[id] = choiceAnswer(Object.keys(question.criteria), current());
      }
    }
    return answers;
  };
}

interface ScriptedJev {
  readonly mock: MockTypeSafe;
  /** Answer `fault` with `confidence` from the next request on. */
  answer(fault: string, confidence: number): void;
  /** Drop the recorded requests and queued failures; keep answering the script. */
  reset(): void;
}

async function startScriptedJev(): Promise<ScriptedJev> {
  let script: JevScript = { fault: NONE_OF_THESE, confidence: UNOFFERED_CONFIDENCE };
  const policy = scriptedPolicy(() => script);
  const mock = await startMockTypeSafe({ port: 0, apiKey: API_KEY, answer: policy });
  return {
    mock,
    answer(fault, confidence) {
      script = { fault, confidence };
    },
    reset() {
      mock.reset();
      mock.script(policy);
    },
  };
}

// ---------------------------------------------------------------------------
// Pipelines and replays
// ---------------------------------------------------------------------------

/**
 * A pipeline over the fixture catalog and the Jev backend pointed at the mock.
 *
 * `wrap` lets a test put something between the pipeline and that backend.
 */
function jevPipeline(
  url: string,
  cfg: Partial<PipelineConfig> = {},
  ports: Partial<PipelinePorts> = {},
  wrap: (backend: DecisionBackend) => DecisionBackend = (backend) => backend,
): Pipeline {
  const wall = fixedClock(WALL_START);
  return createPipeline(
    {
      wall,
      retriever: createCatalogRetriever(FIXTURE_CATALOG),
      decision: wrap(
        createJevBackend({
          apiKey: new Secret(API_KEY),
          baseURL: url,
          model: MOCK_MODEL,
          maxRetries: 0,
          labels: FIXTURE_LABELS,
          wall: () => wall.now().getTime(),
        }),
      ),
      prices: JEV_PRICES,
      ...ports,
    },
    cfg,
  );
}

/** What a lost database connection says; nothing in it is specific to PostgreSQL. */
const LOST_CONNECTION = "Connection terminated unexpectedly";

/** The fixture catalog's retriever, failing its `failing`-th call the way a lost pool does. */
function retrieverFailingOn(failing: number): Retriever {
  const catalog = createCatalogRetriever(FIXTURE_CATALOG);
  let calls = 0;
  return {
    retrieve(event) {
      calls += 1;
      if (calls === failing) return Promise.reject(new Error(LOST_CONNECTION));
      return catalog.retrieve(event);
    },
  };
}

/**
 * `backend`, throwing a plain `TypeError` on its `failing`-th call.
 *
 * Not a `DecisionError`: this is a backend with a defect in it, not one whose
 * provider was unreachable, and the pipeline must reject the push that met it.
 */
function backendFailingOn(failing: number, backend: DecisionBackend): DecisionBackend {
  let calls = 0;
  return {
    name: backend.name,
    model: backend.model,
    decide(input, options) {
      calls += 1;
      if (calls === failing) return Promise.reject(new TypeError("the backend has a defect"));
      return backend.decide(input, options);
    },
  };
}

/** `backend`, noting the sim instant of every event it is asked about. */
function backendNoting(asked: string[], backend: DecisionBackend): DecisionBackend {
  return {
    name: backend.name,
    model: backend.model,
    decide(input, options) {
      asked.push(input.event.sim_ts);
      return backend.decide(input, options);
    },
  };
}

/** The part of a snapshot a push changes on the host's behalf: its episodes and tickets. */
function diagnosis(snapshot: PipelineSnapshot): Pick<PipelineSnapshot, "episodes" | "tickets"> {
  return { episodes: snapshot.episodes, tickets: snapshot.tickets };
}

/** The most samples one `telemetry-samples` batch carries. */
const BATCH_SIZE = 25;

/**
 * The samples of `batches` cut again into full batches, one of them opening at `simTs`.
 *
 * Batching changes nothing detection or the episodes see (ingest reads neither
 * the envelope's wall time nor the poll); it decides only how much of a batch
 * is left when a push fails on that sample.
 */
function startingAt(batches: readonly TelemetrySamples[], simTs: string): TelemetrySamples[] {
  const [envelope] = batches;
  if (envelope === undefined) return [];
  const samples = batches.flatMap((batch) => batch.samples);
  const at = samples.findIndex((sample) => sample.sim_ts === simTs);
  if (at < 0) throw new Error(`no sample at ${simTs}`);
  const cuts = [...(at % BATCH_SIZE > 0 ? [0] : [])];
  for (let start = at % BATCH_SIZE; start < samples.length; start += BATCH_SIZE) cuts.push(start);
  return cuts.map((start, index) => ({
    ...envelope,
    samples: samples.slice(start, cuts[index + 1] ?? samples.length) as TelemetrySamples["samples"],
  }));
}

/** `batch` with its last sample carrying the gateway's discontinuity flag. */
function withJumpAtEnd(batch: TelemetrySamples): TelemetrySamples {
  const samples = batch.samples.map((sample, index) =>
    index === batch.samples.length - 1
      ? { ...sample, flags: { ...sample.flags, discontinuity: true } }
      : sample,
  );
  return { ...batch, samples: samples as TelemetrySamples["samples"] };
}

interface Rejected {
  /** Every output of the pushes that resolved before the rejection. */
  readonly outputs: PipelineOutput[];
  /** What the push rejected with. */
  readonly error: unknown;
  /** The snapshot the rejected push started from. */
  readonly before: PipelineSnapshot;
  /** The index of the batch whose push was rejected. */
  readonly at: number;
}

/** Push `batches` in order until one push is rejected. */
async function untilRejected(
  pipeline: Pipeline,
  batches: readonly TelemetrySamples[],
): Promise<Rejected> {
  const outputs: PipelineOutput[] = [];
  for (const [at, batch] of batches.entries()) {
    const before = pipeline.snapshot();
    try {
      outputs.push(...(await pipeline.push(batch)));
    } catch (error: unknown) {
      return { outputs, error, before, at };
    }
  }
  throw new Error("no push was rejected");
}

/** A pipeline over the fixture catalog and the rules twin, with the registry's severity hints. */
function rulesPipeline(): Pipeline {
  return createPipeline({
    wall: fixedClock(WALL_START),
    retriever: createCatalogRetriever(FIXTURE_CATALOG),
    decision: createRulesBackend({ labels: FIXTURE_LABELS }),
  });
}

interface Replay {
  readonly outputs: PipelineOutput[];
  /** The batches not pushed because `until` held first. */
  readonly rest: readonly TelemetrySamples[];
}

/** Push `batches` in order; stop after the batch whose outputs make `until` hold. */
async function replay(
  pipeline: Pipeline,
  batches: readonly TelemetrySamples[],
  until?: (outputs: readonly PipelineOutput[]) => boolean,
): Promise<Replay> {
  const outputs: PipelineOutput[] = [];
  for (const [index, batch] of batches.entries()) {
    outputs.push(...(await pipeline.push(batch)));
    if (until?.(outputs) === true) return { outputs, rest: batches.slice(index + 1) };
  }
  return { outputs, rest: [] };
}

type OutputOf<T extends PipelineOutput["type"]> = Extract<PipelineOutput, { type: T }>;

function ofType<T extends PipelineOutput["type"]>(
  outputs: readonly PipelineOutput[],
  type: T,
): OutputOf<T>[] {
  return outputs.filter((output): output is OutputOf<T> => output.type === type);
}

function decisions(outputs: readonly PipelineOutput[]): Decision[] {
  return ofType(outputs, "decision").map((output) => output.decision);
}

function tickets(outputs: readonly PipelineOutput[]): Ticket[] {
  return ofType(outputs, "ticket").map((output) => output.ticket);
}

const hasTicket = (outputs: readonly PipelineOutput[]): boolean =>
  outputs.some((output) => output.type === "ticket");

/** The first ticket output, which the test that asks for it requires to exist. */
function firstTicket(outputs: readonly PipelineOutput[]): OutputOf<"ticket"> {
  const found = ofType(outputs, "ticket")[0];
  if (found === undefined) throw new Error("the replay produced no ticket");
  return found;
}

/** Where the first output of `type` (and `action`, for episodes) sits in the history. */
function indexOf(
  outputs: readonly PipelineOutput[],
  type: PipelineOutput["type"],
  action?: string,
): number {
  return outputs.findIndex(
    (output) => output.type === type && (action === undefined || actionOf(output) === action),
  );
}

function actionOf(output: PipelineOutput): string | undefined {
  if (output.type === "episode") return output.action;
  if (output.type === "ticket") return output.ticket.action;
  return undefined;
}

/**
 * The contract check of one output, or `undefined` for one that has none.
 *
 * The episode is checked through the `api-episodes` page it is served in; an
 * alarm transition is not a message of its own (it becomes an
 * `app.native_alarms` row and a WS `alarm.native` frame downstream).
 */
function contractCheck(output: PipelineOutput): ValidationResult<unknown> | undefined {
  switch (output.type) {
    case "suspect":
      return validate("suspect-event", output.event);
    case "decision":
      return validate("decision", output.decision);
    case "ticket":
      return validate("ticket", output.ticket);
    case "episode":
      return validate("api-episodes", {
        items: [toEpisodeMessage(output.episode)],
        next_cursor: null,
      });
    case "alarm":
      return undefined;
  }
}

/** Every output that fails its contract, as one line each. */
function offContract(outputs: readonly PipelineOutput[]): string[] {
  const issues: string[] = [];
  for (const output of outputs) {
    const result = contractCheck(output);
    if (result !== undefined && !result.ok) {
      issues.push(`${output.type}: ${result.errors.map((issue) => issue.text).join("; ")}`);
    }
  }
  return issues;
}

/** `batch` with its first sample carrying the gateway's discontinuity flag. */
function withJump(batch: TelemetrySamples): TelemetrySamples {
  const [first, ...others] = batch.samples;
  const jumped: Sample = { ...first, flags: { ...first.flags, discontinuity: true } };
  return { ...batch, samples: [jumped, ...others] };
}

/** One symptom key only: long loaded runs fire `frequent_cycling` for five sim hours. */
const oneSymptom = (): TelemetrySamples[] => scenarioBatches(longLoadedRuns(20));

/** Two symptom keys: `frequent_cycling` first, then the faster decay's `low_line_pressure`. */
const twoSymptoms = (): TelemetrySamples[] => scenarioBatches(frequentCycling(20));

// ---------------------------------------------------------------------------
// Offline: synthetic telemetry
// ---------------------------------------------------------------------------

describe("createPipeline over synthetic telemetry (offline)", () => {
  let jev: ScriptedJev;

  beforeAll(async () => {
    jev = await startScriptedJev();
  });

  afterAll(async () => {
    await jev.mock.close();
  });

  beforeEach(() => {
    jev.reset();
  });

  it("emits nothing at all for normal cycling", async () => {
    const { outputs } = await replay(rulesPipeline(), scenarioBatches(baseline(20)));
    expect(outputs).toEqual([]);
  });

  it("opens a ticket with status open: suspect → decision → episode opened → ticket", async () => {
    // The order when nothing waits for persistence (GATE_PERSIST_SIM_MIN=0);
    // the deferred order is the "persistence before the ticket" block's.
    jev.answer(SYNTHETIC_FAULT, 0.9);
    const { outputs } = await replay(
      jevPipeline(jev.mock.url, NO_PERSISTENCE),
      oneSymptom(),
      hasTicket,
    );

    expect(outputs.map((output) => [output.type, actionOf(output)])).toEqual([
      ["suspect", undefined],
      ["decision", undefined],
      ["episode", "opened"],
      ["ticket", "opened"],
    ]);
    const [suspect, decided, opened, ticketed] = outputs as [
      OutputOf<"suspect">,
      OutputOf<"decision">,
      OutputOf<"episode">,
      OutputOf<"ticket">,
    ];
    expect(decided.decision).toMatchObject({
      status: "ok",
      backend: "jev",
      model: MOCK_MODEL,
      choice: SYNTHETIC_FAULT,
      confidence: 0.9,
      event_id: suspect.event.event_id,
      episode_id: opened.episode.episode_id,
      gate: { outcome: "ticket", ticket_min_confidence: 0.85, review_min_confidence: 0.6 },
      error: null,
    });
    expect(decided.gate).toMatchObject({ outcome: "ticket", abstained: false });
    expect(decided.output?.state_digest).toBe(decided.decision.state_digest);
    expect(opened.episode).toMatchObject({
      status: "open",
      symptom_key: suspect.event.symptom_key,
      first_event_id: suspect.event.event_id,
      decision_count: 1,
      ticket_id: null,
    });
    expect(ticketed.ticket).toMatchObject({
      action: "opened",
      status: "open",
      fault_id: SYNTHETIC_FAULT,
      episode_id: opened.episode.episode_id,
      latest_decision_id: decided.decision.decision_id,
      update_count: 0,
    });
    expect(ticketed.record.ticket_id).toBe(ticketed.ticket.ticket_id);
    expect(ticketed.closure).toBeNull();
    expect(offContract(outputs)).toEqual([]);
  });

  it("bills the decision at input_tokens × 0.042 / 1e6 in its cost block", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.9);
    const { outputs } = await replay(jevPipeline(jev.mock.url), oneSymptom(), hasTicket);

    const [decided] = decisions(outputs);
    expect(decided?.usage.input_tokens).toBeGreaterThan(0);
    expect(decided?.cost).toEqual({
      usd: expect.closeTo(((decided?.usage.input_tokens ?? 0) * 0.042) / 1e6, 12) as number,
      price_input_per_mtok: 0.042,
      price_output_per_mtok: 0,
      prices_as_of: "2026-09-19",
    });
    expect(jev.mock.requests).toHaveLength(1);
  });

  it("re-decides a symptom that keeps firing every 30 sim minutes and updates the ticket", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.9);
    const pipeline = jevPipeline(jev.mock.url, NO_PERSISTENCE);
    const { outputs } = await replay(pipeline, oneSymptom(), (so_far) =>
      tickets(so_far).some((ticket) => ticket.action === "updated"),
    );

    const [first, second] = decisions(outputs);
    const updated = tickets(outputs).at(-1);
    expect(first?.episode_id).toBe(second?.episode_id);
    expect(simMinutesBetween(first?.sim_ts ?? "", second?.sim_ts ?? "")).toBeGreaterThanOrEqual(30);
    expect(simMinutesBetween(first?.sim_ts ?? "", second?.sim_ts ?? "")).toBeLessThan(32);
    expect(updated).toMatchObject({
      action: "updated",
      status: "open",
      update_count: 1,
      latest_decision_id: second?.decision_id,
      updated_sim_ts: second?.sim_ts,
    });
    expect(ofType(outputs, "suspect")).toHaveLength(2);
    expect(offContract(outputs)).toEqual([]);
  });

  it("opens a review ticket at 0.7 and promotes the same ticket to open at 0.9", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.7);
    const pipeline = jevPipeline(jev.mock.url);
    const opening = await replay(pipeline, oneSymptom(), hasTicket);
    const review = firstTicket(opening.outputs).ticket;
    expect(review).toMatchObject({ action: "opened", status: "review", fault_id: SYNTHETIC_FAULT });
    expect(ofType(opening.outputs, "decision").at(-1)?.gate?.outcome).toBe("review");

    jev.answer(SYNTHETIC_FAULT, 0.9);
    const later = await replay(pipeline, opening.rest, (so_far) =>
      tickets(so_far).some((ticket) => ticket.status === "open"),
    );
    const promoted = tickets(later.outputs).find((ticket) => ticket.status === "open");
    expect(promoted).toMatchObject({
      ticket_id: review.ticket_id,
      action: "updated",
      status: "open",
      update_count: 1,
    });
    expect(offContract([...opening.outputs, ...later.outputs])).toEqual([]);
  });

  it("logs a confident none_of_these as an abstention and opens no ticket", async () => {
    jev.answer(NONE_OF_THESE, 0.8);
    const { outputs } = await replay(jevPipeline(jev.mock.url), oneSymptom());

    const answered = ofType(outputs, "decision");
    expect(answered.length).toBeGreaterThan(5);
    for (const { decision, gate } of answered) {
      expect(decision).toMatchObject({ status: "ok", choice: NONE_OF_THESE, confidence: 0.8 });
      expect(decision.gate).toMatchObject({ outcome: "log", abstained: true });
      expect(gate).toMatchObject({ outcome: "log", abstained: true });
    }
    expect(ofType(outputs, "episode").map((output) => output.action)).toEqual(["opened"]);
    expect(tickets(outputs)).toEqual([]);
    expect(offContract(outputs)).toEqual([]);
  });

  it("merges a second symptom key that decides the same fault into the first ticket", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.9);
    const { outputs } = await replay(jevPipeline(jev.mock.url), twoSymptoms());

    const opened = ofType(outputs, "episode").filter((output) => output.action === "opened");
    expect(opened.map((output) => output.episode.symptom_key)).toEqual([
      "frequent_cycling",
      "low_line_pressure",
    ]);
    const [owner, follower] = opened.map((output) => output.episode);
    const merged = ofType(outputs, "episode").filter((output) => output.action === "merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]?.episode).toMatchObject({
      episode_id: follower?.episode_id,
      merged_into: owner?.episode_id,
      status: "open",
      ticket_id: null,
    });

    const ticketIds = new Set(tickets(outputs).map((ticket) => ticket.ticket_id));
    expect(ticketIds.size).toBe(1);
    expect(tickets(outputs).every((ticket) => ticket.episode_id === owner?.episode_id)).toBe(true);

    // The follower's decisions drive the owner's ticket.
    const followerDecision = decisions(outputs).find(
      (decision) => decision.episode_id === follower?.episode_id,
    );
    const update = tickets(outputs).find(
      (ticket) => ticket.latest_decision_id === followerDecision?.decision_id,
    );
    expect(update).toMatchObject({ action: "updated", episode_id: owner?.episode_id });
    expect(offContract(outputs)).toEqual([]);
  });

  it("closes a ticket on a technician's verdict and keeps later decisions off it", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.9);
    const pipeline = jevPipeline(jev.mock.url);
    const opening = await replay(pipeline, oneSymptom(), hasTicket);
    const open = firstTicket(opening.outputs).ticket;
    const now = pipeline.ingest.latest()?.sim_ts;

    const closing = await pipeline.closeTicket(open.ticket_id, {
      verdict: "correct",
      note: "the drain valve was found open",
      closed_by: "technician-1",
    });
    expect(closing).toHaveLength(1);
    const [closed] = ofType(closing, "ticket");
    expect(closed?.ticket).toMatchObject({
      ticket_id: open.ticket_id,
      action: "closed",
      status: "closed",
      close_reason: "technician",
      closure: {
        verdict: "correct",
        note: "the drain valve was found open",
        closed_by: "technician-1",
      },
    });
    expect(closed?.closure).toMatchObject({
      ticket_id: open.ticket_id,
      verdict: "correct",
      sim_ts: now,
    });
    expect(closed?.record.resolved_sim_ts).toBe(now);
    expect(pipeline.snapshot().episodes[0]?.closed_by_technician).toBe(true);

    const later = await replay(pipeline, opening.rest);
    expect(decisions(later.outputs).length).toBeGreaterThan(0);
    expect(tickets(later.outputs)).toEqual([]);

    await expect(pipeline.closeTicket(open.ticket_id, { verdict: "wrong" })).rejects.toBeInstanceOf(
      TicketClosedError,
    );
    await expect(
      pipeline.closeTicket("no-such-ticket", { verdict: "wrong" }),
    ).rejects.toBeInstanceOf(UnknownTicketError);
    expect(offContract([...opening.outputs, ...closing, ...later.outputs])).toEqual([]);
  });

  it("aborts the open episode on a discontinuity and resolves its ticket", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.9);
    const pipeline = jevPipeline(jev.mock.url);
    const opening = await replay(pipeline, oneSymptom(), hasTicket);
    const open = firstTicket(opening.outputs).ticket;
    const [next, ...after] = opening.rest;
    if (next === undefined) throw new Error("the scenario ended with its first ticket");
    const lastBeforeJump = pipeline.ingest.latest()?.sim_ts;
    expect(lastBeforeJump).toBeDefined();

    const jumped = await pipeline.push(withJump(next));
    expect(jumped.slice(0, 2).map((output) => [output.type, actionOf(output)])).toEqual([
      ["episode", "aborted"],
      ["ticket", "resolved"],
    ]);
    const [aborted, resolved] = jumped as [OutputOf<"episode">, OutputOf<"ticket">];
    expect(aborted.episode).toMatchObject({
      status: "aborted",
      close_reason: "discontinuity",
      closed_sim_ts: lastBeforeJump,
    });
    expect(resolved.ticket).toMatchObject({
      ticket_id: open.ticket_id,
      status: "resolved",
      close_reason: "discontinuity",
      resolved_sim_ts: lastBeforeJump,
    });

    // Detection starts over; the symptom that is still there opens a fresh episode.
    const rest = await replay(pipeline, after, hasTicket);
    const reopened = ofType(rest.outputs, "episode").find((output) => output.action === "opened");
    expect(reopened?.episode.episode_id).not.toBe(aborted.episode.episode_id);
    expect(firstTicket(rest.outputs).ticket.ticket_id).not.toBe(open.ticket_id);
    expect(offContract([...opening.outputs, ...jumped, ...rest.outputs])).toEqual([]);
  });

  it("closes an episode after 120 silent sim minutes and resolves its ticket", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.9);
    const batches = runBatches([...longLoadedRuns(12).phases, ...baseline(10).phases]);
    const { outputs } = await replay(jevPipeline(jev.mock.url), batches);

    const ended = ofType(outputs, "episode").filter((output) => output.action !== "opened");
    expect(ended.map((output) => output.action)).toEqual(["closed"]);
    const closedEpisode = ended[0]?.episode;
    expect(closedEpisode).toMatchObject({ status: "closed", close_reason: "silence" });
    const resolved = tickets(outputs).at(-1);
    expect(resolved).toMatchObject({
      status: "resolved",
      action: "resolved",
      close_reason: "silence",
      resolved_sim_ts: closedEpisode?.closed_sim_ts,
    });
    const lastDecision = decisions(outputs).at(-1);
    expect(
      simMinutesBetween(lastDecision?.sim_ts ?? "", closedEpisode?.closed_sim_ts ?? ""),
    ).toBeGreaterThanOrEqual(120);
    expect(offContract(outputs)).toEqual([]);
  });

  it("emits a failed call as the error form of the decision and waits for the next interval", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.9);
    jev.mock.failNext(529, 1);
    const pipeline = jevPipeline(jev.mock.url, NO_PERSISTENCE);
    const { outputs } = await replay(pipeline, oneSymptom(), hasTicket);

    const [failed, answered] = ofType(outputs, "decision");
    expect(failed?.decision).toMatchObject({
      status: "failed",
      choice: NONE_OF_THESE,
      confidence: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      cost: { usd: 0 },
      gate: { outcome: "log" },
      error: { kind: "overloaded", status: 529 },
    });
    expect(failed?.output).toBeNull();
    expect(failed?.gate).toBeNull();
    expect(outputs[2]).toMatchObject({ type: "episode", action: "opened" });
    expect(outputs[2]).toMatchObject({ episode: { decision_count: 1, ticket_id: null } });

    // The episode waited out the interval instead of asking again at once.
    expect(answered?.decision.status).toBe("ok");
    expect(
      simMinutesBetween(failed?.decision.sim_ts ?? "", answered?.decision.sim_ts ?? ""),
    ).toBeGreaterThanOrEqual(30);
    expect(firstTicket(outputs).ticket.latest_decision_id).toBe(answered?.decision.decision_id);
    expect(jev.mock.requests).toHaveLength(2);
    expect(offContract(outputs)).toEqual([]);
  });

  it("turns a failed retrieval into a failed decision and finishes the batch", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.9);
    const pipeline = jevPipeline(jev.mock.url, NO_PERSISTENCE, {
      retriever: retrieverFailingOn(1),
    });
    const { outputs } = await replay(pipeline, oneSymptom(), hasTicket);

    // The event retrieval could not serve is still suspect → decision → episode opened.
    expect(outputs.slice(0, 3).map((output) => [output.type, actionOf(output)])).toEqual([
      ["suspect", undefined],
      ["decision", undefined],
      ["episode", "opened"],
    ]);
    const [suspect, failed, opened] = outputs as [
      OutputOf<"suspect">,
      OutputOf<"decision">,
      OutputOf<"episode">,
    ];
    expect(failed.decision).toMatchObject({
      status: "failed",
      event_id: suspect.event.event_id,
      episode_id: opened.episode.episode_id,
      choice: NONE_OF_THESE,
      confidence: 0,
      candidates: [],
      gate: { outcome: "log" },
      error: { kind: "unknown", message: `retrieval failed: ${LOST_CONNECTION}` },
    });
    expect(failed.output).toBeNull();
    expect(failed.gate).toBeNull();
    expect(opened.episode).toMatchObject({
      status: "open",
      first_event_id: suspect.event.event_id,
      decision_count: 1,
      ticket_id: null,
    });

    // Nothing was cut short: the episode was never aborted, it waited out the
    // interval like any failed decision, and its next decision opened the ticket.
    expect(ofType(outputs, "episode").map((output) => output.action)).toEqual(["opened"]);
    const answered = decisions(outputs)[1];
    expect(answered).toMatchObject({ status: "ok", episode_id: opened.episode.episode_id });
    expect(
      simMinutesBetween(failed.decision.sim_ts, answered?.sim_ts ?? ""),
    ).toBeGreaterThanOrEqual(30);
    expect(firstTicket(outputs).ticket.latest_decision_id).toBe(answered?.decision_id);
    // The backend was never asked about the event retrieval could not serve.
    expect(jev.mock.requests).toHaveLength(1);
    expect(offContract(outputs)).toEqual([]);
  });

  it("changes no episode and no ticket in a push it rejects", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.9);
    // The episode opens in the push whose decision fails when nothing waits
    // for persistence; with GATE_PERSIST_SIM_MIN it would open a push earlier.
    const pipeline = jevPipeline(jev.mock.url, NO_PERSISTENCE, {}, (backend) =>
      backendFailingOn(1, backend),
    );
    const batches = oneSymptom();

    const { outputs, error, before, at } = await untilRejected(pipeline, batches);
    expect(error).toBeInstanceOf(TypeError);
    // The rejected push opened an episode and emitted nothing about it; it is gone again.
    expect(diagnosis(pipeline.snapshot())).toEqual(diagnosis(before));
    expect(outputs).toEqual([]);

    const later = await replay(pipeline, batches.slice(at + 1), hasTicket);
    // Every episode the host hears of starts on an event the host was given.
    const events = new Set(ofType(later.outputs, "suspect").map((output) => output.event.event_id));
    const episodes = ofType(later.outputs, "episode");
    expect(episodes.length).toBeGreaterThan(0);
    for (const { episode } of episodes) expect(events).toContain(episode.first_event_id);
    for (const episode of pipeline.snapshot().episodes) {
      expect(events).toContain(episode.first_event_id);
    }
    expect(firstTicket(later.outputs).ticket).toMatchObject({ action: "opened", status: "open" });
    expect(offContract(later.outputs)).toEqual([]);
  });

  it("puts an episode's counts and its ticket back when a re-decision's push is rejected", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.7);
    const pipeline = jevPipeline(jev.mock.url, {}, {}, (backend) => backendFailingOn(2, backend));
    const opening = await replay(pipeline, oneSymptom(), hasTicket);
    const review = firstTicket(opening.outputs).ticket;
    expect(review).toMatchObject({ action: "opened", status: "review" });

    // The second call is the re-decision half an hour on, which would promote the ticket.
    jev.answer(SYNTHETIC_FAULT, 0.9);
    const { error, before, at } = await untilRejected(pipeline, opening.rest);
    expect(error).toBeInstanceOf(TypeError);
    expect(diagnosis(pipeline.snapshot())).toEqual(diagnosis(before));
    expect(pipeline.snapshot().tickets).toEqual([
      expect.objectContaining({ ticket_id: review.ticket_id, status: "review" }),
    ]);

    // The episode is still due, so the next frame asks again and promotes the same ticket.
    const later = await replay(pipeline, opening.rest.slice(at + 1), (so_far) =>
      tickets(so_far).some((ticket) => ticket.status === "open"),
    );
    expect(tickets(later.outputs).find((ticket) => ticket.status === "open")).toMatchObject({
      ticket_id: review.ticket_id,
      action: "updated",
      update_count: 1,
    });
    expect(offContract(later.outputs)).toEqual([]);
  });

  it("shows detection the rest of a rejected batch, so the next batch is no jump", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.9);
    // Where the second decision falls, from a run whose backend never fails.
    const asked: string[] = [];
    await replay(
      jevPipeline(jev.mock.url, {}, {}, (backend) => backendNoting(asked, backend)),
      oneSymptom(),
      (so_far) => decisions(so_far).length >= 2,
    );
    const failingAt = asked[1] ?? "";
    jev.reset();

    // That decision opens its batch, so the rejected push leaves 24 samples —
    // four sim minutes — that detection would otherwise never see.
    const batches = startingAt(oneSymptom(), failingAt);
    const pipeline = jevPipeline(jev.mock.url, {}, {}, (backend) => backendFailingOn(2, backend));
    const { outputs, error, before, at } = await untilRejected(pipeline, batches);
    expect(error).toBeInstanceOf(TypeError);
    expect(batches[at]?.samples[0]?.sim_ts).toBe(failingAt);
    expect(batches[at]?.samples.length).toBe(25);
    const owner = firstTicket(outputs).ticket;
    expect(diagnosis(pipeline.snapshot())).toEqual(diagnosis(before));

    const later = await replay(
      pipeline,
      batches.slice(at + 1),
      (so_far) => decisions(so_far).length > 0,
    );
    expect(ofType(later.outputs, "episode")).toEqual([]);
    expect(decisions(later.outputs)[0]).toMatchObject({
      status: "ok",
      episode_id: owner.episode_id,
    });
    expect(firstTicket(later.outputs).ticket).toMatchObject({
      ticket_id: owner.ticket_id,
      action: "updated",
      status: "open",
    });
  });

  it("aborts the episodes at a jump a rejected batch held, on the next push", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.9);
    const asked: string[] = [];
    await replay(
      jevPipeline(jev.mock.url, {}, {}, (backend) => backendNoting(asked, backend)),
      oneSymptom(),
      (so_far) => decisions(so_far).length >= 2,
    );
    const failingAt = asked[1] ?? "";
    jev.reset();

    // The gateway flags a jump at the end of the batch the push fails in.
    const batches = startingAt(oneSymptom(), failingAt);
    const failing = batches.findIndex((batch) => batch.samples[0]?.sim_ts === failingAt);
    batches[failing] = withJumpAtEnd(batches[failing] as TelemetrySamples);
    const beforeJump = batches[failing]?.samples.at(-2)?.sim_ts;

    const pipeline = jevPipeline(jev.mock.url, {}, {}, (backend) => backendFailingOn(2, backend));
    const { outputs, error, before, at } = await untilRejected(pipeline, batches);
    expect(error).toBeInstanceOf(TypeError);
    expect(at).toBe(failing);
    const owner = firstTicket(outputs).ticket;
    expect(diagnosis(pipeline.snapshot())).toEqual(diagnosis(before));

    // Detection reset at the jump; the next push announces what that ended, first.
    const next = await pipeline.push(batches[at + 1] as TelemetrySamples);
    expect(next.slice(0, 2).map((output) => [output.type, actionOf(output)])).toEqual([
      ["episode", "aborted"],
      ["ticket", "resolved"],
    ]);
    const [aborted, resolved] = next as [OutputOf<"episode">, OutputOf<"ticket">];
    expect(aborted.episode).toMatchObject({
      episode_id: owner.episode_id,
      status: "aborted",
      close_reason: "discontinuity",
      closed_sim_ts: beforeJump,
    });
    expect(resolved.ticket).toMatchObject({
      ticket_id: owner.ticket_id,
      status: "resolved",
      close_reason: "discontinuity",
      resolved_sim_ts: beforeJump,
    });
    expect(pipeline.snapshot().episodes.every((episode) => episode.status !== "open")).toBe(true);
    expect(offContract(next)).toEqual([]);
  });

  it("emits a controller alarm on the sample that raised it and on the one that cleared it", async () => {
    const code = ALARMS[0]?.code ?? "W001";
    let index = 0;
    const batches = scenarioBatches(baseline(2)).map((batch) => {
      const samples = batch.samples.map((sample) => {
        index += 1;
        return { ...sample, alarms: index >= 10 && index < 20 ? [code] : [] };
      });
      return { ...batch, samples: samples as TelemetrySamples["samples"] };
    });
    const allSamples = batches.flatMap((batch) => batch.samples);

    const { outputs } = await replay(rulesPipeline(), batches);
    expect(outputs).toEqual([
      {
        type: "alarm",
        transition: {
          code,
          state: "raised",
          seq: allSamples[9]?.seq,
          sim_ts: allSamples[9]?.sim_ts,
        },
      },
      {
        type: "alarm",
        transition: {
          code,
          state: "cleared",
          seq: allSamples[19]?.seq,
          sim_ts: allSamples[19]?.sim_ts,
        },
      },
    ]);
  });

  it("serialises concurrent pushes and survives a batch that does not validate", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.9);
    const batches = oneSymptom().slice(0, 12);
    const sequential = await replay(jevPipeline(jev.mock.url), batches);

    jev.reset();
    const pipeline = jevPipeline(jev.mock.url);
    const invalid = { schema: "not-a-batch" } as unknown as TelemetrySamples;
    const pushes = [
      ...batches.slice(0, 6).map((batch) => pipeline.push(batch)),
      pipeline.push(invalid),
      ...batches.slice(6).map((batch) => pipeline.push(batch)),
    ];
    const settled = await Promise.allSettled(pushes);

    expect(settled[6]?.status).toBe("rejected");
    const concurrent = settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    const shape = (outputs: readonly PipelineOutput[]) =>
      outputs.map((output) => [output.type, actionOf(output), JSON.stringify(simTsOf(output))]);
    expect(shape(concurrent)).toEqual(shape(sequential.outputs));
    expect(concurrent.length).toBeGreaterThan(0);
  });

  it("continues a hydrated episode's ticket instead of opening a second one", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.9);
    const store = createEpisodeStore();
    const first = jevPipeline(jev.mock.url, {}, { store });
    const opening = await replay(first, oneSymptom(), hasTicket);
    const { record } = firstTicket(opening.outputs);

    // A restart: the same store and the ticket as `app.tickets` gave it back.
    const hydrated: readonly TicketRecord[] = [record];
    const second = jevPipeline(jev.mock.url, {}, { store, tickets: hydrated });
    const later = await replay(second, opening.rest, hasTicket);

    expect(ofType(later.outputs, "episode")).toEqual([]);
    expect(firstTicket(later.outputs).ticket).toMatchObject({
      ticket_id: record.ticket_id,
      action: "updated",
      update_count: 1,
    });
  });

  it("shows every episode and ticket in its snapshot, as the contract carries them", async () => {
    jev.answer(SYNTHETIC_FAULT, 0.9);
    const pipeline = jevPipeline(jev.mock.url);
    expect(pipeline.snapshot()).toEqual({ episodes: [], tickets: [], frame: undefined });

    const { outputs } = await replay(pipeline, twoSymptoms());
    const snapshot = pipeline.snapshot();

    expect(snapshot.episodes.map((episode) => episode.symptom_key)).toEqual([
      "frequent_cycling",
      "low_line_pressure",
    ]);
    const lastMessage = tickets(outputs).at(-1);
    expect(snapshot.tickets).toEqual([lastMessage]);
    expect(snapshot.frame?.sim_ts).toBe(pipeline.detector.frame()?.sim_ts);
    for (const ticket of snapshot.tickets) expect(validate("ticket", ticket).ok).toBe(true);
  });
});

/** The sim instant an output is about, for comparing two histories. */
function simTsOf(output: PipelineOutput): string | null {
  switch (output.type) {
    case "suspect":
      return output.event.sim_ts;
    case "decision":
      return output.decision.sim_ts;
    case "episode":
      return output.episode.closed_sim_ts ?? output.episode.opened_sim_ts;
    case "ticket":
      return output.ticket.updated_sim_ts;
    case "alarm":
      return output.transition.sim_ts;
  }
}

// ---------------------------------------------------------------------------
// The MetroPT-3 fixtures (generated on this machine, never committed)
// ---------------------------------------------------------------------------

const HAS_MAY = hasFixture("unlabelled-may19");

describe.skipIf(!HAS_MAY)("createPipeline over the unlabelled 19 May episode", () => {
  let jev: ScriptedJev;
  let may: readonly TelemetrySamples[];

  beforeAll(async () => {
    jev = await startScriptedJev();
    may = loadFixture("unlabelled-may19").batches;
  });

  afterAll(async () => {
    await jev.mock.close();
  });

  beforeEach(() => {
    jev.reset();
  });

  it("emits suspect → episode opened → decision → a review or open ticket with the rules twin", async () => {
    const { outputs } = await replay(rulesPipeline(), may);

    // The episode opens on its first event; its first decision waits until the
    // evidence has persisted for GATE_PERSIST_SIM_MIN.
    const suspect = indexOf(outputs, "suspect");
    const opened = indexOf(outputs, "episode", "opened");
    const decided = indexOf(outputs, "decision");
    const ticketed = indexOf(outputs, "ticket", "opened");
    expect(suspect).toBe(0);
    expect(opened).toBeGreaterThan(suspect);
    expect(decided).toBeGreaterThan(opened);
    expect(ticketed).toBeGreaterThan(decided);

    const first = firstTicket(outputs);
    expect(["review", "open"]).toContain(first.ticket.status);
    expect(first.ticket.backend).toBe("rules");
    // The ticket belongs to an episode that opened before it, on the decision just before it.
    const owner = ofType(outputs.slice(0, ticketed), "episode").find(
      (output) => output.episode.episode_id === first.ticket.episode_id,
    );
    expect(owner?.action).toBe("opened");
    const [previous] = ofType(outputs.slice(0, ticketed), "decision").slice(-1);
    expect(previous?.decision.decision_id).toBe(first.ticket.latest_decision_id);
    expect(previous?.decision.cost.usd).toBe(0);
    expect(offContract(outputs)).toEqual([]);
  });

  it("opens a ticket with status open and bills it at input_tokens × 0.042 / 1e6 with Jev", async () => {
    jev.answer(MAY_FAULT, 0.9);
    const { outputs } = await replay(jevPipeline(jev.mock.url), may, hasTicket);

    const first = firstTicket(outputs);
    expect(first.ticket).toMatchObject({ action: "opened", status: "open", fault_id: MAY_FAULT });
    const decided = decisions(outputs).find(
      (decision) => decision.decision_id === first.ticket.latest_decision_id,
    );
    expect(decided).toMatchObject({ status: "ok", model: MOCK_MODEL, choice: MAY_FAULT });
    expect(decided?.usage.input_tokens).toBeGreaterThan(0);
    expect(decided?.cost.usd).toBeCloseTo(((decided?.usage.input_tokens ?? 0) * 0.042) / 1e6, 12);
    expect(indexOf(outputs, "suspect")).toBe(0);
    expect(indexOf(outputs, "episode", "opened")).toBeLessThan(indexOf(outputs, "decision"));
    expect(decided?.gate.persist_sim_min).toBe(1);
    expect(offContract(outputs)).toEqual([]);
  });

  it("keeps one ticket while the other symptom keys decide the same fault", async () => {
    jev.answer(MAY_FAULT, 0.9);
    const { outputs } = await replay(jevPipeline(jev.mock.url), may);

    const owner = firstTicket(outputs).ticket;
    const merged = ofType(outputs, "episode").filter((output) => output.action === "merged");
    expect(merged.length).toBeGreaterThan(0);
    for (const output of merged) expect(output.episode.merged_into).toBe(owner.episode_id);

    // Until the owner's ticket leaves the live states, every ticket output is that ticket.
    const history = tickets(outputs);
    const end = history.findIndex(
      (ticket) => ticket.ticket_id === owner.ticket_id && ticket.action === "resolved",
    );
    const live = end === -1 ? history : history.slice(0, end + 1);
    expect(new Set(live.map((ticket) => ticket.ticket_id))).toEqual(new Set([owner.ticket_id]));
    expect(live.filter((ticket) => ticket.action === "updated").length).toBeGreaterThan(0);
    expect(offContract(outputs)).toEqual([]);
  });

  it("re-decides an episode no sooner than 30 sim minutes after its last decision", async () => {
    jev.answer(MAY_FAULT, 0.9);
    const { outputs } = await replay(jevPipeline(jev.mock.url), may);

    const byEpisode = new Map<string, Decision[]>();
    for (const decision of decisions(outputs)) {
      byEpisode.set(decision.episode_id, [...(byEpisode.get(decision.episode_id) ?? []), decision]);
    }
    const redecisions = new Set<string>();
    for (const own of byEpisode.values()) {
      for (const [index, decision] of own.slice(1).entries()) {
        const previous = own[index] as Decision;
        expect(simMinutesBetween(previous.sim_ts, decision.sim_ts)).toBeGreaterThanOrEqual(30);
        redecisions.add(decision.decision_id);
      }
    }
    expect(redecisions.size).toBeGreaterThan(10);

    // A re-decision updates the live ticket it drives in place. (A resolved
    // message repeats the last decision's id too, so only updates count here.)
    const updates = tickets(outputs).filter(
      (ticket) => ticket.action === "updated" && redecisions.has(ticket.latest_decision_id),
    );
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) expect(update.update_count).toBeGreaterThanOrEqual(1);
  });

  it("opens a review ticket at 0.7 and promotes it to open when Jev reaches 0.9", async () => {
    jev.answer(MAY_FAULT, 0.7);
    const pipeline = jevPipeline(jev.mock.url);
    const opening = await replay(pipeline, may, hasTicket);
    const review = firstTicket(opening.outputs).ticket;
    expect(review).toMatchObject({ action: "opened", status: "review" });

    jev.answer(MAY_FAULT, 0.9);
    const later = await replay(pipeline, opening.rest, (so_far) =>
      tickets(so_far).some((ticket) => ticket.status === "open"),
    );
    expect(tickets(later.outputs).find((ticket) => ticket.status === "open")).toMatchObject({
      ticket_id: review.ticket_id,
      action: "updated",
    });
  });

  it("opens no ticket when Jev confidently answers none_of_these", async () => {
    jev.answer(NONE_OF_THESE, 0.8);
    const { outputs } = await replay(jevPipeline(jev.mock.url), may);

    expect(decisions(outputs).length).toBeGreaterThan(10);
    for (const decision of decisions(outputs)) {
      expect(decision.gate).toMatchObject({ outcome: "log", abstained: true });
    }
    expect(tickets(outputs)).toEqual([]);
  });

  it("closes the ticket on a verdict and emits nothing more for it", async () => {
    jev.answer(MAY_FAULT, 0.9);
    const pipeline = jevPipeline(jev.mock.url);
    const opening = await replay(pipeline, may, hasTicket);
    const open = firstTicket(opening.outputs).ticket;

    const [closed] = tickets(await pipeline.closeTicket(open.ticket_id, { verdict: "correct" }));
    expect(closed).toMatchObject({
      action: "closed",
      status: "closed",
      closure: { verdict: "correct" },
    });

    const later = await replay(pipeline, opening.rest);
    expect(decisions(later.outputs).length).toBeGreaterThan(0);
    expect(tickets(later.outputs).filter((ticket) => ticket.ticket_id === open.ticket_id)).toEqual(
      [],
    );
    expect(
      tickets(later.outputs).filter((ticket) => ticket.episode_id === open.episode_id),
    ).toEqual([]);
  });

  it.skipIf(!hasFixture("gap-jump"))(
    "aborts the open episode at the jump of gap-jump.json and resolves its ticket",
    async () => {
      jev.answer(MAY_FAULT, 0.9);
      const pipeline = jevPipeline(jev.mock.url);
      const opening = await replay(pipeline, may, hasTicket);
      const open = firstTicket(opening.outputs).ticket;
      const beforeJump = pipeline.ingest.latest()?.sim_ts;

      const gap = loadFixture("gap-jump").batches;
      const jumpAt = gap.findIndex((batch) =>
        batch.samples.some((sample) => sample.flags.discontinuity),
      );
      expect(jumpAt).toBeGreaterThan(0);
      const { outputs } = await replay(pipeline, gap.slice(jumpAt));

      const aborted = ofType(outputs, "episode").filter((output) => output.action === "aborted");
      expect(aborted.map((output) => output.episode.episode_id)).toContain(open.episode_id);
      for (const output of aborted) {
        expect(output.episode).toMatchObject({
          status: "aborted",
          close_reason: "discontinuity",
          closed_sim_ts: beforeJump,
        });
      }
      const resolved = tickets(outputs).find((ticket) => ticket.ticket_id === open.ticket_id);
      expect(resolved).toMatchObject({
        action: "resolved",
        status: "resolved",
        close_reason: "discontinuity",
        resolved_sim_ts: beforeJump,
      });
      // The aborts come first: nothing of the old episodes outlives the jump.
      expect(outputs.slice(0, aborted.length).every((output) => output.type === "episode")).toBe(
        true,
      );
      expect(offContract(outputs)).toEqual([]);
    },
  );
});

describe.skipIf(!hasFixture("baseline-feb"))("createPipeline over the February baseline", () => {
  it("emits nothing for a first-month morning", async () => {
    const { outputs } = await replay(rulesPipeline(), loadFixture("baseline-feb").batches);
    expect(outputs).toEqual([]);
  });
});
