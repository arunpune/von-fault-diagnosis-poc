// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// One real LLM decision through the harness's live handle.
//
// Opt-in twice over: skipped without `LLM_API_KEY`, and refused without
// `--confirm-live` (`pnpm --filter @fdp/eval test:live -- --confirm-live`). It
// is a paid call, run by hand and never by CI. It asks `LLM_MODEL` about the F3
// scenario's first suspect event, asserts only the shape of the answer, the
// model id and billed input tokens, and prints the cost. Nothing else is
// logged, and the key never leaves `EvalSecrets`.

import { describe, expect, it } from "vitest";

import { createLlmHandle } from "../../src/backends/llm.ts";
import { loadConfig } from "../../src/config.ts";
import { hasKey, requireConsent } from "./consent.ts";
import { expectLiveShape, firstSuspectInput, LIVE_TIMEOUT_MS, printCost } from "./smoke.ts";

describe.skipIf(!hasKey("LLM_API_KEY"))("the LLM backend against the live Messages API", () => {
  it(
    "answers the F3 scenario's first suspect event with the configured model",
    async () => {
      requireConsent("Anthropic Messages");
      const cfg = loadConfig([], process.env);
      const input = await firstSuspectInput(cfg);
      const handle = createLlmHandle(cfg);

      const output = await handle.backend.decide(input);

      expect(output.backend).toBe("llm");
      // The provider reports the model that answered, which may carry a dated suffix.
      expect(output.model.startsWith(cfg.llmModel)).toBe(true);
      expectLiveShape(output, input);
      printCost("llm", output, cfg, input);
    },
    LIVE_TIMEOUT_MS,
  );
});
