// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The one time format of this system. Go and Python format the same way; the fixtures pin it for
// all three, and these tests pin the TypeScript side.

import { describe, expect, it } from "vitest";

import { ISO_MS_PATTERN, parseIsoMs, simMinutesBetween, toIsoMs } from "../src/time.ts";

describe("toIsoMs", () => {
  it("always writes milliseconds and a literal Z", () => {
    expect(toIsoMs(new Date(Date.UTC(2026, 5, 5, 9, 41, 12)))).toBe("2026-06-05T09:41:12.000Z");
    expect(toIsoMs(new Date(Date.UTC(2020, 0, 1, 0, 0, 0, 7)))).toBe("2020-01-01T00:00:00.007Z");
  });

  it("matches the iso_ts pattern of common.schema.json", () => {
    expect(ISO_MS_PATTERN.test(toIsoMs(new Date(0)))).toBe(true);
  });

  it("refuses an invalid date and a year outside the four-digit range", () => {
    expect(() => toIsoMs(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => toIsoMs(new Date(Date.UTC(275760, 8, 13)))).toThrow(RangeError);
  });
});

describe("parseIsoMs", () => {
  it("round-trips with toIsoMs", () => {
    const text = "2020-06-05T09:41:12.345Z";
    expect(toIsoMs(parseIsoMs(text))).toBe(text);
  });

  it("refuses a string that does not match the pattern", () => {
    for (const text of [
      "2020-06-05T09:41:12Z",
      "2020-06-05T09:41:12.345+00:00",
      "2020-06-05 09:41:12.345Z",
      "2020-06-05T09:41:12.3456Z",
      "",
    ]) {
      expect(() => parseIsoMs(text)).toThrow(TypeError);
    }
  });

  it("refuses a well-formed string that names no instant", () => {
    expect(() => parseIsoMs("2020-02-30T00:00:00.000Z")).toThrow(RangeError);
  });
});

describe("simMinutesBetween", () => {
  it("counts forward, backward and fractionally", () => {
    expect(simMinutesBetween("2020-06-05T09:00:00.000Z", "2020-06-05T09:30:00.000Z")).toBe(30);
    expect(simMinutesBetween("2020-06-05T09:30:00.000Z", "2020-06-05T09:00:00.000Z")).toBe(-30);
    expect(simMinutesBetween("2020-06-05T09:00:00.000Z", "2020-06-05T09:00:30.000Z")).toBe(0.5);
  });

  it("accepts Date objects and strings alike", () => {
    const from = new Date(Date.UTC(2020, 5, 5, 9, 0, 0));
    expect(simMinutesBetween(from, "2020-06-05T10:00:00.000Z")).toBe(60);
    expect(simMinutesBetween("2020-06-05T09:00:00.000Z", from)).toBe(0);
  });
});
