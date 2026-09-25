// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The `stack-setup` project of playwright.config.ts: it runs once before the `stack` project's
// tour, against the Compose stack at `E2E_BASE_URL`, which `scripts/smoke.sh --mode ci --keep`
// leaves running. It waits until the stack is ready and puts the replay back where the README tour
// starts, so a second `make e2e` on the same stack starts from the same point as the first:
//
//   1. `GET /api/health` answers 200 with status ok (it answers 503 while a link is down);
//   2. `GET /api/status` holds the simulator's retained status;
//   3. `POST /api/sim/reset` rewinds the replay to the first row of the dataset, paused, which
//      also ends the injections and the episodes an earlier run left open;
//   4. `POST /api/sim/speed` sets the README's 600×: `make smoke` replays its own tour at 3600×.
//
// The records of earlier runs stay in the database; the tour tells its own apart by what arrives
// after its jump. Nothing here uses the fake backend's `/__test/*` control API.

import type { APIRequestContext } from "@playwright/test";

import { expect, test as setup, timingSlack } from "./helpers.ts";

import type {
  ApiHealth,
  ApiSimCommandResult,
  ApiStatus,
  SimCommandArgs,
  SimCommandSegment,
  StatusSim,
} from "@/api/types";

/** How long a stack that has just come up may take to answer healthy, before FDP_TIMING_SLACK. */
const READY_TIMEOUT_MS = 120_000;

/** The README's replay speed: ten simulated minutes per wall second. */
const README_SPEED = 600;

/** Sends one simulator command and returns the replay status its acknowledgement carries. */
async function simCommand<S extends SimCommandSegment>(
  request: APIRequestContext,
  cmd: S,
  args: SimCommandArgs[S],
): Promise<StatusSim> {
  const response = await request.post(`/api/sim/${cmd}`, { data: { args } });
  expect(response.status(), `POST /api/sim/${cmd}: ${await response.text()}`).toBe(202);
  const { accepted, ack } = (await response.json()) as ApiSimCommandResult;
  expect(accepted, `the backend did not publish ${cmd}`).toBe(true);
  if (ack === null) {
    throw new Error(`the simulator did not acknowledge ${cmd} within the backend's wait`);
  }
  expect(ack.error, `the simulator refused ${cmd}`).toBeNull();
  expect(ack.ok).toBe(true);
  return ack.status;
}

setup("the stack is healthy and its replay rewound to the start", async ({ request, mode }) => {
  expect(mode, "stack.setup.ts prepares the Compose stack only").toBe("stack");

  await setup.step("GET /api/health answers ok", async () => {
    await expect
      .poll(
        async () => {
          const response = await request.get("/api/health");
          if (response.status() !== 200 && response.status() !== 503) {
            return `HTTP ${response.status()}`;
          }
          return ((await response.json()) as ApiHealth).status;
        },
        { timeout: READY_TIMEOUT_MS * timingSlack(), intervals: [1_000] },
      )
      .toBe("ok");
  });

  await setup.step("GET /api/status holds the simulator's status", async () => {
    const response = await request.get("/api/status");
    expect(response.status()).toBe(200);
    const { sim } = (await response.json()) as ApiStatus;
    expect(sim, "the simulator has not reported a status yet").not.toBeNull();
  });

  await setup.step("POST /api/sim/reset rewinds the replay", async () => {
    const status = await simCommand(request, "reset", {});
    expect(status.state, "the replay waits for the tour's Play").not.toBe("playing");
    expect(status.sim_ts).toBe(status.dataset.first_ts);
  });

  await setup.step(`POST /api/sim/speed sets ${README_SPEED}×`, async () => {
    const status = await simCommand(request, "speed", { speed: README_SPEED });
    expect(status.speed).toBe(README_SPEED);
  });
});
