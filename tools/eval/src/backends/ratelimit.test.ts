// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The live queue: one call at a time, a token bucket at 600 requests per
// minute, and one more attempt after the SDK gave up on a rate limit. Time is a
// fake clock that moves only when the limiter sleeps, so every wait is asserted
// to the millisecond without waiting for it.

import { DecisionError } from "@fdp/backend/pipeline";
import type { DecisionBackend, DecisionInput, DecisionOutput } from "@fdp/backend/pipeline";
import { describe, expect, it } from "vitest";

import {
  createRateLimiter,
  isRateLimited,
  LIVE_REQUESTS_PER_MINUTE,
  RATE_LIMIT_PAUSE_MS,
  rateLimited,
} from "./ratelimit.ts";
import type { LimiterClock } from "./ratelimit.ts";

/** A clock that stands still until the limiter sleeps, and records every sleep. */
function fakeClock(): LimiterClock & { readonly sleeps: number[]; advance(ms: number): void } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

const rateLimit = () => new DecisionError("rate_limit", "429", { status: 429 });

describe("createRateLimiter", () => {
  it("defaults to half the documented limit, one second of it as the burst", async () => {
    expect(LIVE_REQUESTS_PER_MINUTE).toBe(600);
    const clock = fakeClock();
    const limiter = createRateLimiter({ clock });
    for (let call = 0; call < 10; call += 1) await limiter.run(() => Promise.resolve(call));
    expect(clock.sleeps).toEqual([]);

    await limiter.run(() => Promise.resolve("eleventh"));
    expect(clock.sleeps).toEqual([100]);
    expect(limiter.stats).toMatchObject({ calls: 11, retries: 0, waitedMs: 100 });
  });

  it("refills the bucket with time, never above its size", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ clock, requestsPerMinute: 60, burst: 2 });
    await limiter.run(() => Promise.resolve(1));
    await limiter.run(() => Promise.resolve(2));
    await limiter.run(() => Promise.resolve(3));
    expect(clock.sleeps).toEqual([1000]);

    clock.advance(10_000);
    await limiter.run(() => Promise.resolve(4));
    await limiter.run(() => Promise.resolve(5));
    await limiter.run(() => Promise.resolve(6));
    expect(clock.sleeps).toEqual([1000, 1000]);
    expect(limiter.stats.waitedMs).toBe(2000);
  });

  it("runs one call at a time, in the order they were queued", async () => {
    const limiter = createRateLimiter({ clock: fakeClock() });
    const events: string[] = [];
    let release: () => void = () => undefined;
    const first = limiter.run(
      () =>
        new Promise<void>((resolve) => {
          events.push("first started");
          release = () => {
            events.push("first finished");
            resolve();
          };
        }),
    );
    const second = limiter.run(() => {
      events.push("second started");
      return Promise.resolve();
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(["first started"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first started", "first finished", "second started"]);
  });

  it("waits the pause after a rate limit and tries once more", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ clock });
    let attempts = 0;
    const answer = await limiter.run(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(rateLimit()) : Promise.resolve("answered");
    });
    expect(answer).toBe("answered");
    expect(clock.sleeps).toEqual([RATE_LIMIT_PAUSE_MS]);
    expect(limiter.stats).toMatchObject({ calls: 2, retries: 1, waitedMs: RATE_LIMIT_PAUSE_MS });
  });

  it("gives up after the one retry and passes the rate limit on", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ clock, pauseMs: 30_000 });
    const failure = rateLimit();
    await expect(limiter.run(() => Promise.reject(failure))).rejects.toBe(failure);
    expect(clock.sleeps).toEqual([30_000]);
    expect(limiter.stats).toMatchObject({ calls: 2, retries: 1 });
  });

  it("does not retry any other failure, and keeps the queue running after one", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ clock });
    const timeout = new DecisionError("timeout", "no answer");
    await expect(limiter.run(() => Promise.reject(timeout))).rejects.toBe(timeout);
    await expect(limiter.run(() => Promise.resolve("next"))).resolves.toBe("next");
    expect(clock.sleeps).toEqual([]);
    expect(limiter.stats).toMatchObject({ calls: 2, retries: 0, waitedMs: 0 });
  });

  it("refuses a rate, a burst or a pause that is not above zero", () => {
    expect(() => createRateLimiter({ requestsPerMinute: 0 })).toThrow(RangeError);
    expect(() => createRateLimiter({ burst: -1 })).toThrow(/burst/);
    expect(() => createRateLimiter({ pauseMs: Number.NaN })).toThrow(/pauseMs/);
  });
});

describe("isRateLimited", () => {
  it("is true for a rate limit and an overload only", () => {
    expect(isRateLimited(rateLimit())).toBe(true);
    expect(isRateLimited(new DecisionError("overloaded", "529", { status: 529 }))).toBe(true);
    expect(isRateLimited(new DecisionError("auth", "401", { status: 401 }))).toBe(false);
    expect(isRateLimited(new Error("429"))).toBe(false);
  });
});

describe("rateLimited", () => {
  it("keeps the backend's name and model and paces every decision", async () => {
    const output = { choice: "none_of_these" } as DecisionOutput;
    const backend: DecisionBackend = {
      name: "von",
      model: "von-1.13.0",
      decide: () => Promise.resolve(output),
    };
    const limiter = createRateLimiter({ clock: fakeClock() });
    const paced = rateLimited(backend, limiter);
    expect(paced.name).toBe("von");
    expect(paced.model).toBe("von-1.13.0");
    await expect(paced.decide({} as DecisionInput)).resolves.toBe(output);
    expect(limiter.stats.calls).toBe(1);
  });
});
