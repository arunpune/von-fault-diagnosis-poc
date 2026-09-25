// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { NO_VALUE } from "@/lib/format";
import {
  fmtDuration,
  fmtSim,
  fmtSimShort,
  fmtWall,
  parseIso,
  spansUtcDays,
  toIsoMs,
} from "@/lib/time";

const JUMP_TARGET = "2020-06-05T09:48:20.000Z";
const JUMP_TARGET_MS = Date.UTC(2020, 5, 5, 9, 48, 20);

describe("sim time", () => {
  it("parses and writes the contracts' iso_ts", () => {
    expect(parseIso(JUMP_TARGET)).toBe(JUMP_TARGET_MS);
    expect(parseIso("not a time")).toBeNaN();
    expect(toIsoMs(JUMP_TARGET_MS)).toBe(JUMP_TARGET);
  });

  it("shows a sim instant in UTC from an ISO text or epoch milliseconds", () => {
    expect(fmtSim(JUMP_TARGET)).toBe("2020-06-05 09:48:20");
    expect(fmtSim(JUMP_TARGET_MS)).toBe("2020-06-05 09:48:20");
    expect(fmtSim("2020-06-05T11:48:20+02:00")).toBe("2020-06-05 09:48:20");
  });

  it("shows axis ticks with the date only when asked", () => {
    expect(fmtSimShort(JUMP_TARGET)).toBe("09:48");
    expect(fmtSimShort(JUMP_TARGET_MS, true)).toBe("06-05 09:48");
  });

  it("tells whether a window crosses a UTC midnight", () => {
    expect(spansUtcDays("2020-06-05T00:00:00.000Z", "2020-06-05T23:59:59.999Z")).toBe(false);
    expect(spansUtcDays("2020-06-04T22:00:00.000Z", JUMP_TARGET_MS)).toBe(true);
    expect(spansUtcDays("nonsense", JUMP_TARGET)).toBe(false);
  });

  it("shows a dash for anything that is not an instant", () => {
    expect(fmtSim("nonsense")).toBe(NO_VALUE);
    expect(fmtSim(Number.NaN)).toBe(NO_VALUE);
    expect(fmtSim(1e20)).toBe(NO_VALUE);
    expect(fmtSimShort("nonsense")).toBe(NO_VALUE);
  });
});

describe("fmtDuration", () => {
  it.each([
    [0, "0 s"],
    [45_000, "45 s"],
    [90_000, "1 min 30 s"],
    [14 * 60_000, "14 min"],
    [3_600_000, "1 h"],
    [(2 * 3600 + 14 * 60) * 1000, "2 h 14 min"],
    [86_400_000, "1 d"],
    [(27 * 3600 + 20 * 60) * 1000, "1 d 3 h"],
  ])("formats %s ms as %s", (ms, expected) => {
    expect(fmtDuration(ms)).toBe(expected);
  });

  it("takes seconds when told", () => {
    expect(fmtDuration(5322, "s")).toBe("1 h 28 min");
  });

  it("shows a dash for a negative or non-finite length", () => {
    expect(fmtDuration(-1)).toBe(NO_VALUE);
    expect(fmtDuration(Number.NaN)).toBe(NO_VALUE);
  });
});

describe("fmtWall", () => {
  it("shows a wall instant in the given zone with the zone named", () => {
    expect(fmtWall("2026-06-05T09:41:12.000Z", "UTC")).toBe("2026-06-05 09:41:12 UTC");
    expect(fmtWall(Date.UTC(2026, 5, 5, 9, 41, 12), "Europe/Lisbon")).toBe(
      "2026-06-05 10:41:12 GMT+1",
    );
  });

  it("uses the viewer's zone by default", () => {
    expect(fmtWall("2026-06-05T09:41:12.000Z")).toMatch(/^2026-06-0\d \d\d:\d\d:12 \S+$/);
  });

  it("shows a dash for anything that is not an instant", () => {
    expect(fmtWall("nonsense", "UTC")).toBe(NO_VALUE);
    expect(fmtWall(-1e20, "UTC")).toBe(NO_VALUE);
  });
});
