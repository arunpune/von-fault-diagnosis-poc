// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The optional language-model column of a report (docs/decision-backends.md).
//
// It is the pipeline's own `createLlmBackend` over the Anthropic provider,
// with `LLM_MODEL` and the dated `LLM_PRICE_*` prices the report bills it at.
// It exists for comparison only: its confidence is a self-report, never set
// beside Von's without both names on the page, and it has no cassettes,
// so it runs live or not at all.
//
// It runs only when `--backends` names `llm` and `LLM_API_KEY` is set;
// without the key `select.ts` drops it with a warning before this file is
// reached. Like every live backend it goes through the serial, rate-limited
// queue of `ratelimit.ts`: the SDK retries a 429 or a 529 twice itself, the
// runner once more after a pause. Its latencies read the process clock, as
// every live answer's does.

import { Secret, createAnthropicProvider, createLlmBackend } from "@fdp/backend/pipeline";
import type { WallClock } from "@fdp/backend/pipeline";

import { ConfigError } from "../config.ts";
import type { EvalConfig } from "../config.ts";
import { createRateLimiter, rateLimited } from "./ratelimit.ts";
import type { RateLimiter } from "./ratelimit.ts";
import { counted, liveStats, newStats, SIGNAL_LABELS } from "./types.ts";
import type { BackendHandle } from "./types.ts";

/** The process clock, for the latency of a live answer. */
const PROCESS_CLOCK: WallClock = { now: () => new Date() };

/** What building the LLM handle needs beyond the configuration. */
export interface LlmHandleDeps {
  /** The live queue; a fresh one at `LIVE_REQUESTS_PER_MINUTE` by default. */
  readonly limiter?: RateLimiter;
  /**
   * Where the Messages API lives; the SDK's default when left out. The harness reads no
   * variable for it: a test points it at the contracts' Anthropic mock.
   */
  readonly baseURL?: string;
}

/**
 * Builds the live LLM handle.
 *
 * @throws ConfigError naming `LLM_API_KEY` when the key is not set.
 */
export function createLlmHandle(
  cfg: Pick<EvalConfig, "llmModel" | "secrets">,
  deps: LlmHandleDeps = {},
): BackendHandle {
  const key = cfg.secrets.llmApiKey;
  if (key === undefined) {
    throw new ConfigError(
      "LLM_API_KEY",
      "the llm backend calls the Messages API and needs the key",
    );
  }
  const limiter = deps.limiter ?? createRateLimiter();
  const provider = createAnthropicProvider({
    apiKey: new Secret(key),
    model: cfg.llmModel,
    ...(deps.baseURL === undefined ? {} : { baseURL: deps.baseURL }),
  });
  const backend = createLlmBackend(provider, PROCESS_CLOCK, { labels: SIGNAL_LABELS });

  const counter = newStats();
  return {
    name: "llm",
    model: cfg.llmModel,
    mode: "live",
    backend: counted(rateLimited(backend, limiter), counter),
    stats: liveStats(counter, limiter),
    close: () => Promise.resolve(),
  };
}
