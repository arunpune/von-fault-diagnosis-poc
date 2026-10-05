// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * One real decision of the Von backend.
 *
 * Opt-in: it runs only through `pnpm --filter @fdp/backend test:live`
 * and only when `TYPESAFE_API_KEY` is set; a live run is a paid call, so run
 * it on purpose. Without the key it is skipped, so the suite stays green
 * offline and in CI. The model is pinned: `VON_MODEL`, `von-1.13.0` by
 * default, never an alias.
 *
 * The backend is `createVonBackend`, built as production builds it:
 * the system clock and the SDK's default retries.
 */

import { describe, expect, it } from "vitest";

import { systemClock } from "../../src/clock.ts";
import { loadEnv } from "../../src/config/env.ts";
import { createVonBackend } from "../../src/decision/von/index.ts";
import { hasKey, LIVE_INPUT, assertLiveShape, writeLiveReport } from "./smoke.ts";

/** The deadline of one Von call. */
const VON_TIMEOUT_MS = 10_000;

describe.skipIf(!hasKey("TYPESAFE_API_KEY"))("the von backend against the live API", () => {
  it(
    "answers the F3-like event with a decision of the contract's shape",
    async () => {
      const env = loadEnv();
      const apiKey = env.typesafeApiKey;
      if (apiKey === null) throw new Error("TYPESAFE_API_KEY is not set");

      const backend = createVonBackend({
        apiKey,
        baseURL: env.typesafeBaseUrl,
        model: env.vonModel,
        timeoutMs: VON_TIMEOUT_MS,
        wall: () => systemClock.now().getTime(),
      });
      const output = await backend.decide(LIVE_INPUT);

      const message = assertLiveShape(output, env, { backend: "von", model: env.vonModel });
      expect(message.model).toMatch(/^von-\d+\.\d+\.\d+$/);
      writeLiveReport("von", message, [apiKey]);
    },
    VON_TIMEOUT_MS * 6,
  );
});
