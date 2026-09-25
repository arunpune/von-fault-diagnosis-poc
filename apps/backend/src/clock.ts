// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wall-clock time, as a port.
 *
 * The backend runs on two clocks and never mixes them: `sim_ts` comes from the
 * replayed row and drives windows, episodes, tickets and chart axes, while
 * wall time drives heartbeats, cost timestamps and log lines. Wall time is the
 * one a test cannot control from the data, so it arrives through this port and
 * every test passes {@link fixedClock} instead of waiting for real seconds.
 */

/** The wall clock the runtime and the pipeline read. */
export interface WallClock {
  now(): Date;
}

/** The process clock. The only implementation that reads the host. */
export const systemClock: WallClock = {
  now: () => new Date(),
};

/**
 * A clock that stands still, or moves exactly as far as a test tells it to.
 *
 * `advance` returns the new instant so a test can assert on it without reading
 * the clock again.
 */
export function fixedClock(start: Date | string): WallClock & { advance(ms: number): Date } {
  let currentMs = typeof start === "string" ? Date.parse(start) : start.getTime();
  if (Number.isNaN(currentMs)) {
    throw new TypeError(`fixedClock: ${String(start)} is not an instant`);
  }
  return {
    now: () => new Date(currentMs),
    advance(ms: number): Date {
      currentMs += ms;
      return new Date(currentMs);
    },
  };
}
