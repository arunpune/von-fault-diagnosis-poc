// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { fixedClock, systemClock } from "./clock.ts";

describe("systemClock", () => {
  it("reads the host clock", () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe("fixedClock", () => {
  it("stands still until it is told to move", () => {
    const clock = fixedClock("2026-09-21T08:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-09-21T08:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-09-21T08:00:00.000Z");
    expect(clock.advance(1_500).toISOString()).toBe("2026-09-21T08:00:01.500Z");
    expect(clock.now().toISOString()).toBe("2026-09-21T08:00:01.500Z");
  });

  it("accepts a Date and hands out copies, not its own instant", () => {
    const clock = fixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const first = clock.now();
    first.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("refuses a start that is not an instant", () => {
    expect(() => fixedClock("not a date")).toThrow(TypeError);
  });
});
