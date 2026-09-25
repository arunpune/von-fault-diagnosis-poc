// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// How a run calls a live API.
//
// Three rules, in the order a call meets them.
//
// **One call at a time.** Live calls go through a serial queue, so the
// harness never has two requests in flight however the host is driven: a
// global concurrency of 1.
//
// **A token bucket at half the documented limit.** TypeSafe documents about
// 1,200 requests per minute (as published by TypeSafe, September 2026) and says
// the limits adjust dynamically; the bucket refills at 600 per minute and holds
// one second of that budget, so a run stays well inside the limit even when the
// calls are fast.
//
// **One more attempt after a rate limit.** The SDK already retries a 429 or a
// 529 twice with backoff and honours the server's `retry-after` on each. When
// the error still reaches the harness, the runner waits once more and tries a
// last time; a second failure is left to the pipeline, which records the
// decision as failed. The `DecisionError` the backend throws carries the status
// but no header (the backend drops them, so no provider body or key echo leaves
// the backend), so the runner cannot read the server's own `retry-after` there:
// it waits one full window of the per-minute limit, which is the longest a
// `retry-after` of that limit can ask for.
//
// The clock is injected, so the tests move time instead of waiting for it.

import { isDecisionError } from "@fdp/backend/pipeline";
import type { DecisionBackend } from "@fdp/backend/pipeline";

/** Half of TypeSafe's documented 1,200 requests per minute (September 2026). */
export const LIVE_REQUESTS_PER_MINUTE = 600;

/** The runner's own wait after the SDK gave up on a rate limit: one per-minute window. */
export const RATE_LIMIT_PAUSE_MS = 60_000;

const MS_PER_MINUTE = 60_000;

/** The time a limiter reads and waits on. */
export interface LimiterClock {
  /** Milliseconds on any monotonic scale. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The process clock: `performance.now()` and a timer. */
export const systemLimiterClock: LimiterClock = {
  now: () => performance.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** What a limiter has done so far; a live view the report copies at the end of a run. */
export interface RateLimitStats {
  /** Calls let through to the API, retries included. */
  readonly calls: number;
  /** Calls the runner repeated after the SDK had given up on a rate limit. */
  readonly retries: number;
  /** Time spent waiting, on the bucket and on rate-limit pauses. */
  readonly waitedMs: number;
}

/** How a limiter paces. */
export interface RateLimiterOptions {
  /** Refill rate of the bucket; `LIVE_REQUESTS_PER_MINUTE` by default. */
  readonly requestsPerMinute?: number;
  /** Bucket size; one second of the refill rate by default. */
  readonly burst?: number;
  /** The wait before the runner's last attempt; `RATE_LIMIT_PAUSE_MS` by default. */
  readonly pauseMs?: number;
  readonly clock?: LimiterClock;
}

/** A serial queue with a token bucket and one rate-limit retry. */
export interface RateLimiter {
  readonly stats: RateLimitStats;
  /** Runs `call` when its turn and a token come, repeating it once after a rate limit. */
  run<T>(call: () => Promise<T>): Promise<T>;
}

/** Whether an error is a rate limit or an overload the SDK has already retried. */
export function isRateLimited(error: unknown): boolean {
  return isDecisionError(error) && (error.kind === "rate_limit" || error.kind === "overloaded");
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`createRateLimiter: ${name} must be above zero, not ${value}`);
  }
  return value;
}

/**
 * Builds a limiter.
 *
 * @throws RangeError when a rate, a burst or a pause is not above zero.
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const perMinute = positive(
    options.requestsPerMinute ?? LIVE_REQUESTS_PER_MINUTE,
    "requestsPerMinute",
  );
  const burst = positive(options.burst ?? perMinute / 60, "burst");
  const pauseMs = positive(options.pauseMs ?? RATE_LIMIT_PAUSE_MS, "pauseMs");
  const clock = options.clock ?? systemLimiterClock;
  const refillPerMs = perMinute / MS_PER_MINUTE;

  const counters = { calls: 0, retries: 0, waitedMs: 0 };
  let tokens = burst;
  let refilledAt = clock.now();
  let tail: Promise<unknown> = Promise.resolve();

  function refill(): void {
    const now = clock.now();
    tokens = Math.min(burst, tokens + (now - refilledAt) * refillPerMs);
    refilledAt = now;
  }

  async function wait(ms: number): Promise<void> {
    counters.waitedMs += ms;
    await clock.sleep(ms);
  }

  async function takeToken(): Promise<void> {
    refill();
    if (tokens < 1) {
      await wait((1 - tokens) / refillPerMs);
      refill();
    }
    tokens = Math.max(0, tokens - 1);
  }

  async function attempt<T>(call: () => Promise<T>): Promise<T> {
    await takeToken();
    counters.calls += 1;
    return await call();
  }

  async function withRetry<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await attempt(call);
    } catch (error) {
      if (!isRateLimited(error)) throw error;
      await wait(pauseMs);
      counters.retries += 1;
      return await attempt(call);
    }
  }

  return {
    stats: {
      get calls() {
        return counters.calls;
      },
      get retries() {
        return counters.retries;
      },
      get waitedMs() {
        return counters.waitedMs;
      },
    },
    run<T>(call: () => Promise<T>): Promise<T> {
      const turn = tail.then(() => withRetry(call));
      tail = turn.catch(() => undefined);
      return turn;
    },
  };
}

/** The same backend, every call of it paced and retried by `limiter`. */
export function rateLimited(backend: DecisionBackend, limiter: RateLimiter): DecisionBackend {
  return {
    name: backend.name,
    model: backend.model,
    decide: (input, options) => limiter.run(() => backend.decide(input, options)),
  };
}
