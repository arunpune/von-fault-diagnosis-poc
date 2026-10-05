// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What `selectBackends` does with the handle modules, seen from outside them:
// it never leaves a started backend behind when a later one cannot be built,
// and it never so much as constructs the LLM handle when `LLM_API_KEY` is not
// set.
//
// The Von and LLM handle modules are replaced by stand-ins whose factories are
// spies, because the point is what the selector does with a handle, not what
// a server does when it is closed (`select.test.ts` and `handles.test.ts`
// cover that).

import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.ts";
import { createLogger } from "../log.ts";
import { createFakeWallClock } from "../runner/host.ts";
import { selectBackends } from "./select.ts";
import type { LivePlanner } from "./select.ts";
import type { BackendHandle } from "./types.ts";

const { close, createLlmHandle } = vi.hoisted(() => ({
  close: vi.fn(() => Promise.resolve()),
  createLlmHandle: vi.fn((): never => {
    throw new Error("stand-in failure of the llm handle");
  }),
}));

vi.mock("./von.ts", () => ({
  createVonHandle: (): Promise<BackendHandle> =>
    Promise.resolve({
      name: "von",
      model: "von-1.13.0",
      mode: "mock",
      backend: {
        name: "von",
        model: "von-1.13.0",
        decide: () => Promise.reject(new Error("unused")),
      },
      stats: { calls: 0, failures: 0, cassetteMisses: 0 },
      close,
    }),
}));

vi.mock("./llm.ts", () => ({ createLlmHandle }));

const quiet = createLogger({ env: {}, stream: { write: () => true } });

/** A plan with nothing in it, so no test here replays a scenario. */
const noPlan: LivePlanner = () => Promise.resolve({ scenarios: 0, rows: [] });

beforeEach(() => {
  close.mockClear();
  createLlmHandle.mockClear();
});

describe("selectBackends on failure", () => {
  it("closes the handles it had built before the one that failed", async () => {
    const cfg = loadConfig(
      ["--backends", "rules,von,llm", "--confirm-live"],
      { LLM_API_KEY: "sk-test-cleanup-0003" },
      { cwd: "/tmp" },
    );
    const error = await selectBackends(cfg, {
      wall: createFakeWallClock(),
      log: quiet,
      plan: noPlan,
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("stand-in failure of the llm handle");
    expect(createLlmHandle).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes nothing when every backend was built", async () => {
    const cfg = loadConfig(["--backends", "rules,von"], {}, { cwd: "/tmp" });
    const handles = await selectBackends(cfg, { wall: createFakeWallClock(), log: quiet });
    expect(handles.map((handle) => handle.name)).toEqual(["rules", "von"]);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("selectBackends without LLM_API_KEY", () => {
  it("drops the llm backend without constructing it", async () => {
    const cfg = loadConfig(["--backends", "rules,von,llm"], {}, { cwd: "/tmp" });
    const handles = await selectBackends(cfg, { wall: createFakeWallClock(), log: quiet });
    expect(handles.map((handle) => handle.name)).toEqual(["rules", "von"]);
    expect(createLlmHandle).not.toHaveBeenCalled();
  });
});
