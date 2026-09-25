// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SPEED,
  nearestSpeedIndex,
  speedAt,
  SPEED_STEPS,
} from "@/features/simulation/speed";

describe("SPEED_STEPS", () => {
  it("runs from real time to one hour per second, the simulator's bounds, in order", () => {
    expect(SPEED_STEPS[0]).toBe(1);
    expect(SPEED_STEPS.at(-1)).toBe(3600);
    expect(SPEED_STEPS.toSorted((a, b) => a - b)).toEqual(SPEED_STEPS);
    expect(SPEED_STEPS).toContain(DEFAULT_SPEED);
  });
});

describe("speedAt", () => {
  it("reads the speed at a slider position and clamps positions off the scale", () => {
    expect(speedAt(8)).toBe(600);
    expect(speedAt(-3)).toBe(1);
    expect(speedAt(99)).toBe(3600);
    expect(speedAt(7.6)).toBe(600);
  });
});

describe("nearestSpeedIndex", () => {
  it("finds every step at its own position", () => {
    SPEED_STEPS.forEach((step, index) => {
      expect(nearestSpeedIndex(step)).toBe(index);
    });
  });

  it("puts a speed between two steps at the nearer one on a log scale", () => {
    expect(speedAt(nearestSpeedIndex(450))).toBe(600);
    expect(speedAt(nearestSpeedIndex(400))).toBe(300);
    expect(speedAt(nearestSpeedIndex(5000))).toBe(3600);
  });

  it("puts a speed that is not positive at the first step", () => {
    expect(nearestSpeedIndex(0)).toBe(0);
    expect(nearestSpeedIndex(Number.NaN)).toBe(0);
  });
});
