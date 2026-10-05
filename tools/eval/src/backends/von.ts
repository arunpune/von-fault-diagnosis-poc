// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The Von handle, by mode.
//
// Three modes reach the same `createVonBackend` from the pipeline and differ
// only in where its requests go:
//
//   live      the TypeSafe API at TYPESAFE_BASE_URL, with the key, through
//             the serial rate-limited queue of `ratelimit.ts`; with
//             `--record` every answered call is written as a cassette
//   cassette  a local cassette server (`cassette-server.ts`) replaying the
//             recorded answers, with the fixed bearer `eval-cassette`
//   mock      the contracts' mock with its best-overlap answers (`mock.ts`)
//
// Whether a live mode may call at all is decided before a handle is built
// (`select.ts`): building one here never calls anything.
//
// Two choices are this file's.
//
// **A live decision's latency is real.** The mock and cassette modes stamp
// latencies with the run's fake wall clock, so a replay is byte-identical;
// a live latency is the API's own answer time, so the live handle gives the
// backend the process clock.
//
// **A cassette hit reproduces the recorded decision, usage included.** The
// cassette server answers with the recorded answers, but it is the contracts
// mock underneath, and the mock bills the documented estimate
// `ceil(bytes / 4)` rather than what the model billed. A hit therefore gets
// its recorded `usage` and answering `model` back from the cassette, so the
// cost of a cassette run is the cost of the live run it replays.

import { MOCK_MODEL } from "@fdp/contracts/mock";
import { Secret, VERSION, createVonBackend } from "@fdp/backend/pipeline";
import type { DecisionBackend } from "@fdp/backend/pipeline";

import { ConfigError } from "../config.ts";
import type { EvalConfig, VonMode } from "../config.ts";
import { CassetteStore, cassetteOf, withRecording, withRepeat } from "./cassette.ts";
import type { Cassette } from "./cassette.ts";
import { CASSETTE_API_KEY, startCassetteServer } from "./cassette-server.ts";
import type { CassetteServer } from "./cassette-server.ts";
import { requestDigest } from "./digest.ts";
import type { DigestedRequest } from "./digest.ts";
import { createMockVonHandle, VON_TIMEOUT_MS } from "./mock.ts";
import type { MockOptions } from "./mock.ts";
import { createRateLimiter, rateLimited } from "./ratelimit.ts";
import type { RateLimiter } from "./ratelimit.ts";
import { counted, liveStats, millisecondsOf, newStats, SIGNAL_LABELS } from "./types.ts";
import type { BackendHandle, BackendStats, HandleDeps } from "./types.ts";

/** A mode after `auto` has been resolved (`select.ts`). */
export type ResolvedVonMode = Exclude<VonMode, "auto">;

/** What the Von handles read from the configuration. */
export type VonHandleConfig = Pick<
  EvalConfig,
  "vonModel" | "typesafeBaseUrl" | "record" | "secrets"
> &
  Partial<Pick<EvalConfig, "resample" | "persistSimMin" | "cassetteOwnRecordingOnly">>;

/** What building a Von handle needs beyond the configuration. */
export interface VonHandleDeps extends HandleDeps {
  /** The cassette root, `<root>/<model>/<digest>.json`; `CASSETTES_DIR` by default. */
  readonly cassettesDir?: string;
  /** The live queue; a fresh one at `LIVE_REQUESTS_PER_MINUTE` by default. */
  readonly limiter?: RateLimiter;
  /** When a cassette is recorded; the process clock by default. */
  readonly now?: () => Date;
}

/** The cassette handle, with its server exposed so a test can read what it answered. */
export interface CassetteVonHandle extends BackendHandle {
  readonly server: CassetteServer;
}

/** Whether a provider body is a request the digest can name. */
function isDigestible(value: unknown): value is DigestedRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { model?: unknown }).model === "string"
  );
}

/**
 * The same backend, writing every answered call to `store` before it returns.
 *
 * A request this handle already recorded gets its new answer appended to its cassette rather
 * than replacing it (`withRepeat`), because the model answers a repeated request differently
 * and the replay must serve each arrival the answer it got live. On the first answer of this
 * run, the recording an earlier run made at the same GATE_PERSIST_SIM_MIN is replaced, never
 * mixed with, and the recordings made at other values stay (`withRecording`): the Von thresholds
 * pre-registration records the tuning list at N = 0 and N = 1 into one store, and the two runs
 * send many of the same requests.
 *
 * A cassette that cannot be written is an error of the run, not of the decision: it rejects
 * the push that met it, because a recording run that silently records nothing would be worse
 * than one that stops.
 */
function recording(
  backend: DecisionBackend,
  store: CassetteStore,
  context: { readonly model: string; readonly now: () => Date; readonly persistSimMin?: number },
): DecisionBackend {
  const { model, now, persistSimMin } = context;
  const recorded = new Map<string, Cassette>();
  return {
    name: backend.name,
    model: backend.model,
    async decide(input, options) {
      const output = await backend.decide(input, options);
      const answer = cassetteOf(output.raw, {
        model,
        recordedAt: now(),
        backendVersion: VERSION,
        ...(persistSimMin === undefined ? {} : { persistSimMin }),
      });
      const earlier = recorded.get(answer.request_digest);
      const cassette =
        earlier === undefined
          ? withRecording(store.get(answer.request_digest), answer)
          : withRepeat(earlier, answer);
      store.put(cassette);
      recorded.set(cassette.request_digest, cassette);
      return output;
    },
  };
}

/** The same backend, a cassette hit carrying the model and usage of the answer it replayed. */
function withRecordedUsage(backend: DecisionBackend, server: CassetteServer): DecisionBackend {
  return {
    name: backend.name,
    model: backend.model,
    async decide(input, options) {
      const output = await backend.decide(input, options);
      const request = output.raw.request;
      const answered = isDigestible(request) ? server.answered(requestDigest(request)) : undefined;
      if (answered === undefined) return output;
      const { model, usage } = answered;
      return { ...output, model, usage, raw: { request, response: answered } };
    },
  };
}

/**
 * The live handle: the real API through the rate-limited queue, recording when `cfg.record`.
 *
 * @throws ConfigError naming `TYPESAFE_API_KEY` when the key is not set.
 */
export function createLiveVonHandle(cfg: VonHandleConfig, deps: VonHandleDeps): BackendHandle {
  const key = cfg.secrets.typesafeApiKey;
  if (key === undefined) {
    throw new ConfigError("TYPESAFE_API_KEY", "live mode calls the TypeSafe API and needs the key");
  }
  const limiter = deps.limiter ?? createRateLimiter();
  const von = createVonBackend({
    apiKey: new Secret(key),
    baseURL: cfg.typesafeBaseUrl,
    model: cfg.vonModel,
    timeoutMs: VON_TIMEOUT_MS,
    labels: SIGNAL_LABELS,
    wall: () => Date.now(),
  });
  const paced = rateLimited(von, limiter);
  const backend = cfg.record
    ? recording(paced, CassetteStore.forModel(cfg.vonModel, deps.cassettesDir), {
        model: cfg.vonModel,
        now: deps.now ?? (() => new Date()),
        ...(cfg.persistSimMin === undefined ? {} : { persistSimMin: cfg.persistSimMin }),
      })
    : paced;

  const counter = newStats();
  return {
    name: "von",
    model: cfg.vonModel,
    mode: "live",
    backend: counted(backend, counter),
    stats: liveStats(counter, limiter),
    close: () => Promise.resolve(),
  };
}

/**
 * The cassette handle: the real Von backend against a local server replaying the recordings.
 *
 * @throws ConfigError naming `EVAL_VON_MODE` when the model has no cassettes, and `VON_MODEL`
 * when it names a version the contracts mock underneath the server does not answer; and
 * CassetteError when a cassette file is not valid.
 */
export async function createCassetteVonHandle(
  cfg: Pick<EvalConfig, "vonModel"> &
    Partial<Pick<EvalConfig, "resample" | "persistSimMin" | "cassetteOwnRecordingOnly">>,
  deps: VonHandleDeps,
): Promise<CassetteVonHandle> {
  if (cfg.vonModel !== MOCK_MODEL) {
    throw new ConfigError(
      "VON_MODEL",
      `cassette mode replays through the contracts mock, which answers only ${MOCK_MODEL}`,
    );
  }
  const store = CassetteStore.forModel(cfg.vonModel, deps.cassettesDir);
  if (store.count === 0) {
    throw new ConfigError(
      "EVAL_VON_MODE",
      `cassette mode replays recorded answers and ${store.dir} holds none; record them with fdp-eval record`,
    );
  }
  const server = await startCassetteServer({
    store,
    model: cfg.vonModel,
    resample: cfg.resample ?? 0,
    // The run's own value: a replay at N is served the recording made at N (cassette.ts).
    ...(cfg.persistSimMin === undefined ? {} : { persistSimMin: cfg.persistSimMin }),
    // The pre-registered sweep: a cassette that does not say its value is a miss, never served.
    ...(cfg.cassetteOwnRecordingOnly === true ? { ownRecordingOnly: true } : {}),
  });
  const von = createVonBackend({
    apiKey: new Secret(CASSETTE_API_KEY),
    baseURL: server.url,
    model: cfg.vonModel,
    timeoutMs: VON_TIMEOUT_MS,
    labels: SIGNAL_LABELS,
    wall: millisecondsOf(deps.wall),
  });

  const counter = newStats();
  const stats: BackendStats = {
    get calls() {
      return counter.calls;
    },
    get failures() {
      return counter.failures;
    },
    get cassetteMisses() {
      return server.stats.misses;
    },
    get cassetteHits() {
      return server.stats.hits;
    },
    get cassetteMissDigests() {
      return server.stats.missDigests;
    },
    get cassetteReused() {
      return server.stats.reused;
    },
    get cassetteResample() {
      return server.stats.resample;
    },
    get cassetteAnswersMax() {
      return server.stats.answersMax;
    },
  };
  return {
    name: "von",
    model: cfg.vonModel,
    mode: "cassette",
    backend: counted(withRecordedUsage(von, server), counter),
    stats,
    server,
    close: () => server.close(),
  };
}

/**
 * Builds the Von handle for one resolved mode.
 *
 * @throws ConfigError when the configuration cannot drive the mode: no key for `live`, no
 * cassettes for `cassette`, a model the mock does not answer for `cassette` and `mock`.
 */
export async function createVonHandle(
  cfg: VonHandleConfig,
  mode: ResolvedVonMode,
  deps: VonHandleDeps,
  mockOptions: MockOptions = {},
): Promise<BackendHandle> {
  switch (mode) {
    case "mock":
      return await createMockVonHandle(cfg, deps, mockOptions);
    case "live":
      return createLiveVonHandle(cfg, deps);
    case "cassette":
      return await createCassetteVonHandle(cfg, deps);
  }
}
