// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `pnpm --filter @fdp/eval test:live [-- --confirm-live] [vitest options]`
//
// The live smoke suite's entry. It runs Vitest on the `live` mode of
// `vitest.integration.config.ts`, which includes `test/live/**` and nothing
// else, and translates `--confirm-live` — a flag Vitest itself would reject —
// into `EVAL_CONFIRM_LIVE=1` for the test workers. Without the flag the
// variable is cleared, whatever the shell exported, so a live test with a key
// refuses instead of calling (`consent.ts`). Every other argument goes to
// Vitest unchanged, and the exit code is Vitest's.

import { spawnSync } from "node:child_process";

import { CONFIRM_LIVE_FLAG, CONSENT_ENV } from "./consent.ts";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const confirmed = args.includes(CONFIRM_LIVE_FLAG);
const forwarded = args.filter((argument) => argument !== CONFIRM_LIVE_FLAG);

const vitest = spawnSync(
  "vitest",
  ["run", "--config", "vitest.integration.config.ts", "--mode", "live", ...forwarded],
  { stdio: "inherit", env: { ...process.env, [CONSENT_ENV]: confirmed ? "1" : "" } },
);
if (vitest.error !== undefined) {
  process.stderr.write(`test:live: vitest could not be started (${vitest.error.message})\n`);
}
process.exitCode = vitest.status ?? 1;
