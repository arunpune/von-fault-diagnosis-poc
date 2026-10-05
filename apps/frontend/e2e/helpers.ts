// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The `mode` fixture of the end-to-end suite. One spec runs against two backends: the fake of
// e2e/fake-backend (`mock`, the `mock` and `perf` projects) and the Compose stack (`stack`). Each
// project sets `mode` in its `use` block; a spec imports `test` and `expect` from here instead of
// from @playwright/test and reads the differences from two fixtures:
//
//   * `profile` — how long to wait: the stack decides only after its decision interval, up to
//     `DECISION_INTERVAL_SIM_MIN` × 60 / speed seconds after the symptom plus retrieval, so its
//     bounds are generous (120 s). Every wall-clock bound is multiplied by `FDP_TIMING_SLACK`
//     (1 locally, 3 in CI). Both backends answer the tour with von-1.13.0 and open tickets: the
//     stack's mock TypeSafe server runs the `best-overlap` policy, which answers at 0.9 and so
//     always clears the 0.85 ticket gate.
//   * `fakeBackend` — the control API of the fake (`/__test/*`), or null in stack mode, where a
//     spec skips the steps that need it (the stream, the WebSocket restart, the rules backend).
//
// The stack keeps what earlier runs recorded (`make smoke`'s own tour, an earlier `make e2e`), so
// `listDecisions` lets a spec tell its own decisions from theirs. stack.setup.ts, the `stack`
// project's dependency, waits for the stack and rewinds its replay before the tour.

import { test as base, expect, type APIRequestContext, type APIResponse } from "@playwright/test";

import type { ApiDecisions, Decision } from "@/api/types";
import type { ServerFrame } from "@/api/ws-types";

export { expect };

export type E2EMode = "mock" | "stack";

/** The option each project sets in its `use` block (playwright.config.ts). */
export interface E2EOptions {
  mode: E2EMode;
}

/** The decision backends the fake can play. */
export type FakeDecisionBackend = "von" | "rules";

export interface ModeProfile {
  readonly mode: E2EMode;
  /** Wall time the pipeline may take to answer a jump or an injection with a decision. */
  readonly decisionTimeoutMs: number;
  /** Wall time the WebSocket may take to come back after a restart. */
  readonly reconnectTimeoutMs: number;
}

/** `FDP_TIMING_SLACK`: 1 unless the environment widens every wall-clock bound. */
export function timingSlack(): number {
  const slack = Number(process.env.FDP_TIMING_SLACK ?? "1");
  return Number.isFinite(slack) && slack >= 1 ? slack : 1;
}

export function profileFor(mode: E2EMode): ModeProfile {
  const slack = timingSlack();
  return mode === "mock"
    ? { mode, decisionTimeoutMs: 30_000 * slack, reconnectTimeoutMs: 15_000 * slack }
    : { mode, decisionTimeoutMs: 120_000 * slack, reconnectTimeoutMs: 30_000 * slack };
}

async function expectOk(response: APIResponse, what: string): Promise<void> {
  if (!response.ok()) {
    throw new Error(`${what} answered ${response.status()}: ${await response.text()}`);
  }
}

/** The page size `listDecisions` asks for: the routes' cap. */
const DECISIONS_PAGE = 200;

/**
 * Every decision the backend holds, newest data time first, read page by page. A spec takes the
 * ids before it acts and looks for the decisions that came after: the alerts feed orders by data
 * time, so on the stack a decision an earlier run took later in the same simulated day sits
 * above this run's.
 */
export async function listDecisions(request: APIRequestContext): Promise<Decision[]> {
  const decisions: Decision[] = [];
  let before: string | null = null;
  do {
    const cursor = before === null ? "" : `&before=${encodeURIComponent(before)}`;
    const response = await request.get(`/api/decisions?limit=${DECISIONS_PAGE}${cursor}`);
    await expectOk(response, "GET /api/decisions");
    const page = (await response.json()) as ApiDecisions;
    decisions.push(...page.items);
    before = page.next_cursor;
  } while (before !== null);
  return decisions;
}

type Emitted<F> = F extends ServerFrame
  ? Pick<F, "type" | "payload"> & Partial<Pick<F, "schema" | "unit_id" | "wall_ts">>
  : never;

/** A frame for `/__test/emit`; the fake completes `schema`, `unit_id` and `wall_ts`. */
export type EmittedFrame = Emitted<ServerFrame>;

/** The fake backend's control API (e2e/fake-backend/server.ts). */
export interface FakeBackendControl {
  /** A fresh scenario; `rules` plays the rules backend, whose tickets open in review. */
  reset(backend?: FakeDecisionBackend): Promise<void>;
  /** Push any frame to every connected socket. */
  emit(frame: EmittedFrame): Promise<void>;
  /** Replay at `samplesPerS` for `seconds` of wall time, whatever the speed (the perf test). */
  stream(samplesPerS: number, seconds: number): Promise<void>;
  /** Close every socket; the page has to reconnect. */
  restartWs(): Promise<void>;
}

function controlOf(request: APIRequestContext): FakeBackendControl {
  return {
    async reset(backend = "von") {
      await expectOk(await request.post("/__test/reset", { data: { backend } }), "/__test/reset");
    },
    async emit(frame) {
      await expectOk(await request.post("/__test/emit", { data: frame }), "/__test/emit");
    },
    async stream(samplesPerS, seconds) {
      const data = { samples_per_s: samplesPerS, seconds };
      await expectOk(await request.post("/__test/stream", { data }), "/__test/stream");
    },
    async restartWs() {
      await expectOk(await request.post("/__test/restart-ws"), "/__test/restart-ws");
    },
  };
}

export interface E2EFixtures {
  profile: ModeProfile;
  fakeBackend: FakeBackendControl | null;
}

// Playwright calls a fixture's second argument `use`; it is named `provide` here because the
// React hooks lint rule, which covers every file of this package, reads `use(…)` as a hook call.
export const test = base.extend<E2EFixtures & E2EOptions>({
  mode: ["mock", { option: true }],
  profile: async ({ mode }, provide) => {
    await provide(profileFor(mode));
  },
  fakeBackend: async ({ mode, playwright }, provide) => {
    if (mode !== "mock") {
      await provide(null);
      return;
    }
    const baseURL = process.env.FAKE_BACKEND_URL;
    if (baseURL === undefined || baseURL === "") {
      throw new Error(
        "FAKE_BACKEND_URL is not set: the mock projects start the fake through e2e/launch.ts",
      );
    }
    const request = await playwright.request.newContext({ baseURL });
    await provide(controlOf(request));
    await request.dispose();
  },
});
