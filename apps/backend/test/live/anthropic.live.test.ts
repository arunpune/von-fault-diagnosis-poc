// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * One real decision of the language-model backend.
 *
 * Opt-in: it runs only through `pnpm --filter @fdp/backend test:live`
 * and only when `LLM_API_KEY` is set; a live run is a paid call, so run it
 * on purpose. Without the key it is skipped, so the suite stays green
 * offline and in CI. It goes through the same two factories the
 * composition root uses, with the SDK's default retries, against `LLM_MODEL`
 * (and `LLM_BASE_URL` when one is configured).
 */

import { describe, expect, it } from "vitest";

import { systemClock } from "../../src/clock.ts";
import { loadEnv } from "../../src/config/env.ts";
import { createAnthropicProvider, createLlmBackend } from "../../src/decision/llm/index.ts";
import { FIXTURE_LABELS } from "../fixtures/catalog/index.ts";
import { assertLiveShape, hasKey, LIVE_INPUT, writeLiveReport } from "./smoke.ts";

/** A generous deadline: one reply carries three judgments and a sentence. */
const LIVE_TIMEOUT_MS = 120_000;

describe.skipIf(!hasKey("LLM_API_KEY"))("the llm backend against the live API", () => {
  it(
    "answers the F3-like event with a decision of the contract's shape",
    async () => {
      const env = loadEnv();
      const apiKey = env.llmApiKey;
      if (apiKey === null) throw new Error("LLM_API_KEY is not set");

      const provider = createAnthropicProvider({
        apiKey,
        model: env.llmModel,
        timeoutMs: LIVE_TIMEOUT_MS,
        ...(env.llmBaseUrl === null ? {} : { baseURL: env.llmBaseUrl }),
      });
      const backend = createLlmBackend(provider, systemClock, { labels: FIXTURE_LABELS });
      const output = await backend.decide(LIVE_INPUT);

      const message = assertLiveShape(output, env, { backend: "llm", model: env.llmModel });
      expect(message.cost.price_output_per_mtok).toBe(env.prices.llmOutputPerMtok);
      writeLiveReport("llm", message, [apiKey]);
    },
    LIVE_TIMEOUT_MS * 2,
  );
});
