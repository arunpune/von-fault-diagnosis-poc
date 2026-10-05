// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The local server a cassette run's Von backend talks to
// (tools/eval/CASSETTES.md).
//
// It is the contracts' mock TypeSafe server with one scripted policy: the
// digest of each incoming `{ model, state, questions }` is looked up among the
// recorded cassettes, and a hit answers with the recorded answers. So the Von
// backend is the real one in cassette mode too — the same state, the same
// questions, the same SDK, the same parser — and only the answers come from a
// file instead of from the model.
//
// A request the recording run sent several times has several answers, and the
// n-th arrival of it is answered with the n-th (`cassette.ts`), so a replay of
// the recorded profile gets every decision the live run got. An arrival past
// the last recorded answer — a cassette recorded before repeats were kept, or a
// run that asks more often than the recording did — gets the last one again
// and is counted as `reused`: a hit, but not necessarily the answer the live
// run got at that point, which the report says.
//
// A resample replays the same recording with each repeated request's answers
// rotated (`resample`, `fdp-eval run --resample <r>`): the arrival that
// resample 0 answers with answer i gets answer (i + r) mod k, k being how many
// answers the cassette holds. Every resample is therefore a permutation of what
// the model really answered, and over k resamples every arrival of a repeated
// request is served every answer the recording holds — which is how the
// pre-registered threshold sweep reads each alternative answer without a new
// call (tools/eval/records/von-thresholds-preregistration.md). A request with
// one answer gets it in every resample. `answersMax` says how many answers the
// fullest cassette the run hit held: the number of resamples it can give.
//
// A server told a GATE_PERSIST_SIM_MIN (`persistSimMin`, the run's own) serves
// each cassette's recording made at that value, and only it: the Von
// thresholds pre-registration's amendment of 2026-09-24 records the tuning
// list at N = 0 and at N = 1 into one store, and judges each N on its own
// recording (`cassette.ts`). A cassette that holds recordings at other values
// only is a miss at this one. A cassette recorded before recordings were told
// apart serves any value, except to a server told `ownRecordingOnly` (the
// pre-registered sweep's replays), where it is a miss.
//
// A miss is not an error. The policy returns nothing, the mock's own answers
// apply (the `best-overlap` policy mock mode uses), and the miss is
// counted and its digest kept, so the report can say how many decisions of the
// run were not the model's and which requests they were. Misses mean the
// backend's state or questions changed since the recording: the signal to
// re-record.
//
// The mock accepts one bearer, `eval-cassette`, so a real key can never reach
// it, and it reports the cassette model as the answering one.
//
// Every recorded answer is checked against the mock's response schema before
// the server listens. The mock checks each response it serves, and a recording
// it cannot serve would otherwise answer 500 to every request that hits it —
// the SDK retries, the decision fails, and a whole run of real answers turns
// into failed decisions. A recording the mock cannot serve is a
// `CassetteError` naming its file instead.

import { startMockTypeSafe, systemOneResponseIssue } from "@fdp/contracts/mock";
import type { AnswerPolicy, SystemOneRequest } from "@fdp/contracts/mock";

import { CassetteError, recordingsOf, responsesAt, responsesOf } from "./cassette.ts";
import type { Cassette, CassetteResponse, CassetteStore } from "./cassette.ts";
import { requestDigest } from "./digest.ts";
import { DEFAULT_MOCK_POLICY } from "./mock.ts";

/** The bearer the harness sends its cassette server; never a real key. */
export const CASSETTE_API_KEY = "eval-cassette";

/** What the server has answered so far; a live view that moves as the run decides. */
export interface CassetteServerStats {
  readonly hits: number;
  readonly misses: number;
  /** The digest of every request that had no cassette, in the order they arrived. */
  readonly missDigests: readonly string[];
  /**
   * Hits past the last answer their cassette recorded, answered with that last answer again:
   * the recording holds fewer answers of the request than the run asked for.
   */
  readonly reused: number;
  /** The rotation of recorded answers this server serves; 0 is the recording's own order. */
  readonly resample: number;
  /** The most answers any cassette hit so far holds; 0 before the first hit. */
  readonly answersMax: number;
}

/** A running cassette server. */
export interface CassetteServer {
  readonly url: string;
  readonly stats: CassetteServerStats;
  /** The recorded exchange of `digest`, or `undefined` when none was loaded. */
  recorded(digest: string): Cassette | undefined;
  /** The recorded answer the server served last for `digest`, or `undefined` before any hit. */
  answered(digest: string): CassetteResponse | undefined;
  /** Stops the server; safe to call twice. */
  close(): Promise<void>;
}

/** What the server replays. */
export interface CassetteServerOptions {
  readonly store: CassetteStore;
  /** The pinned model the run asks for and the server answers as. */
  readonly model: string;
  /**
   * Which rotation of each repeated request's answers to serve; 0 (the default) serves the n-th
   * arrival the n-th answer, as the recording run received them.
   */
  readonly resample?: number;
  /**
   * The run's GATE_PERSIST_SIM_MIN: each cassette is served its recording made at this value, and
   * a cassette without one is a miss. Absent, each cassette's own recording is served.
   */
  readonly persistSimMin?: number;
  /**
   * With `persistSimMin`: serve only a recording that says it was made at that value, so a
   * cassette recorded before recordings were told apart is a miss, not an answer from an unknown
   * run. The pre-registered sweep sets it (each N on its own recording and no other).
   */
  readonly ownRecordingOnly?: boolean;
}

/**
 * The index of the answer served to the `arrival`-th arrival (0-based) of a request whose
 * cassette holds `count` answers, under resample `resample`.
 *
 * Resample 0 is the recording: the n-th arrival gets the n-th answer, and an arrival past the
 * last one gets the last one again. Resample r rotates that index by r, modulo `count`.
 */
export function answerIndex(arrival: number, count: number, resample: number): number {
  if (count <= 0) throw new RangeError("a cassette holds at least one answer");
  return (Math.min(arrival, count - 1) + resample) % count;
}

/**
 * Refuses a recording holding an answer the mock underneath would refuse to serve.
 *
 * @throws CassetteError naming the cassette's file, the answer and the first problem.
 */
function checkServable(store: CassetteStore, cassette: Cassette): void {
  recordingsOf(cassette).forEach((recording, which) => {
    const answers = [recording.response, ...(recording.repeat_responses ?? [])];
    answers.forEach(({ model, answers: answered, usage }, index) => {
      const issue = systemOneResponseIssue({ model, answers: answered, usage });
      if (issue === undefined) return;
      const where =
        which === 0
          ? `answer ${index + 1}`
          : `answer ${index + 1} of the recording at GATE_PERSIST_SIM_MIN ${String(recording.persist_sim_min)}`;
      throw new CassetteError(
        store.pathOf(cassette.request_digest),
        `${where} is not a response the mock can serve (${issue}); a recording is what the API answered, so it is the mock's response schema that is out of step, never the cassette to edit`,
      );
    });
  });
}

/**
 * Loads every cassette of the store and starts the server on a free local port.
 *
 * @throws CassetteError when a cassette file is not a valid cassette filed under its digest, or
 * holds answers the mock cannot serve, before anything listens.
 */
export async function startCassetteServer(options: CassetteServerOptions): Promise<CassetteServer> {
  const { store, model } = options;
  const resample = options.resample ?? 0;
  if (!Number.isInteger(resample) || resample < 0) {
    throw new RangeError(`resample ${resample} is not a whole number at or above 0`);
  }
  const recordings = new Map(store.list().map((cassette) => [cassette.request_digest, cassette]));
  for (const cassette of recordings.values()) checkServable(store, cassette);
  const counters = { hits: 0, misses: 0, reused: 0, answersMax: 0, missDigests: [] as string[] };
  /** How many times each recorded request has arrived, and the answer it got last. */
  const arrivals = new Map<string, number>();
  const lastServed = new Map<string, CassetteResponse>();

  const policy: AnswerPolicy = (request: SystemOneRequest) => {
    const digest = requestDigest({
      model: request.model ?? model,
      state: request.state,
      questions: request.questions,
    });
    const recorded = recordings.get(digest);
    const responses =
      recorded === undefined
        ? undefined
        : options.persistSimMin === undefined
          ? responsesOf(recorded)
          : responsesAt(recorded, options.persistSimMin, {
              ownRecordingOnly: options.ownRecordingOnly === true,
            });
    if (recorded === undefined || responses === undefined) {
      counters.misses += 1;
      counters.missDigests.push(digest);
      return {};
    }
    counters.hits += 1;
    counters.answersMax = Math.max(counters.answersMax, responses.length);
    const arrival = arrivals.get(digest) ?? 0;
    arrivals.set(digest, arrival + 1);
    if (arrival >= responses.length) counters.reused += 1;
    const [first] = responses;
    const response = responses[answerIndex(arrival, responses.length, resample)] ?? first;
    if (response === undefined) throw new RangeError("a recording holds at least one answer");
    lastServed.set(digest, response);
    // The cassette schema checks answers as objects only; `checkServable` checked every one
    // against the mock's own response schema when the server started, so a hit is served.
    return response.answers as unknown as ReturnType<AnswerPolicy>;
  };

  const server = await startMockTypeSafe({
    port: 0,
    apiKey: CASSETTE_API_KEY,
    model,
    answerPolicy: DEFAULT_MOCK_POLICY,
    answer: policy,
  });

  let closed: Promise<void> | undefined;
  return {
    url: server.url,
    stats: {
      get hits() {
        return counters.hits;
      },
      get misses() {
        return counters.misses;
      },
      get missDigests() {
        return [...counters.missDigests];
      },
      get reused() {
        return counters.reused;
      },
      resample,
      get answersMax() {
        return counters.answersMax;
      },
    },
    recorded: (digest) => recordings.get(digest),
    answered: (digest) => lastServed.get(digest),
    close: () => {
      closed ??= server.close();
      return closed;
    },
  };
}
