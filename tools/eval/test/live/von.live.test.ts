// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// One real Von decision through the harness's live handle.
//
// Opt-in twice over: skipped without `TYPESAFE_API_KEY`, and refused without
// `--confirm-live` (`pnpm --filter @fdp/eval test:live -- --confirm-live`). It
// is a paid call, run by hand and never by CI. It asks about the F3 scenario's
// first suspect event, asserts only the shape of the answer, the pinned model
// id and billed input tokens, and prints the cost. Nothing else is logged, and
// the key never leaves `EvalSecrets`.

import { describe, expect, it } from "vitest";

import { createLiveVonHandle } from "../../src/backends/von.ts";
import { loadConfig } from "../../src/config.ts";
import { createFakeWallClock } from "../../src/runner/host.ts";
import { hasKey, requireConsent } from "./consent.ts";
import { expectLiveShape, firstSuspectInput, LIVE_TIMEOUT_MS, printCost } from "./smoke.ts";

/** The pinned model the answer must report. */
const PINNED_MODEL = "von-1.13.0";

describe.skipIf(!hasKey("TYPESAFE_API_KEY"))("the Von backend against the live API", () => {
  it(
    "answers the F3 scenario's first suspect event with the pinned model",
    async () => {
      requireConsent("TypeSafe");
      const cfg = loadConfig([], process.env);
      const input = await firstSuspectInput(cfg);
      const handle = createLiveVonHandle(cfg, { wall: createFakeWallClock() });

      const output = await handle.backend.decide(input);

      expect(output.backend).toBe("von");
      expect(output.model).toBe(PINNED_MODEL);
      expectLiveShape(output, input);
      printCost("von", output, cfg, input);
    },
    LIVE_TIMEOUT_MS,
  );
});
