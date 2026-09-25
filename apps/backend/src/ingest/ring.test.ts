// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The ring buffer: wrapping, windows, segments and alarm bits.
 *
 * The capacity here is eight samples, not 65,536, because every interesting
 * case of a ring is a case about its edges and eight of them are easy to count
 * by hand.
 */

import { ALARMS } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import {
  decodedRun,
  decodedSample,
  START_MS,
  STEP_MS,
  TEST_SIGNALS,
} from "./fixture.test-helper.ts";
import { RING_CAPACITY, RingBuffer, alarmBitsOf } from "./ring.ts";

function smallRing(capacity = 8): RingBuffer {
  return new RingBuffer({ signals: TEST_SIGNALS, capacity });
}

describe("RingBuffer capacity", () => {
  it("refuses a capacity that is not a positive power of two", () => {
    expect(() => new RingBuffer({ capacity: 10 })).toThrow(RangeError);
    expect(() => new RingBuffer({ capacity: 0 })).toThrow(RangeError);
  });

  it("defaults to 65,536 samples", () => {
    expect(new RingBuffer({ signals: TEST_SIGNALS }).capacity).toBe(RING_CAPACITY);
    expect(RING_CAPACITY).toBe(65_536);
  });

  it("is empty before the first sample", () => {
    const ring = smallRing();
    expect(ring.size).toBe(0);
    expect(ring.latest()).toEqual([]);
    expect(ring.segments()).toEqual([]);
    expect(ring.range(START_MS, START_MS + STEP_MS)).toEqual([]);
  });
});

describe("RingBuffer wrapping", () => {
  it("keeps the newest `capacity` samples and forgets the rest", () => {
    const ring = smallRing();
    for (const sample of decodedRun(20)) ring.push(sample);

    expect(ring.size).toBe(8);
    expect(ring.oldestPosition).toBe(12);
    expect(ring.newestPosition).toBe(19);
    expect(ring.holds(11)).toBe(false);
    expect(ring.holds(12)).toBe(true);
    expect(ring.latest(3).map((sample) => sample.seq)).toEqual([18, 19, 20]);
  });

  it("reads back the values it was given, digitals as 0 and 1", () => {
    const ring = smallRing();
    ring.push(
      decodedSample(0, {
        values: { line_pressure: 9.5, load_valve: 1, dryer_purge_pressure: 0.2 },
      }),
    );
    const [stored] = ring.latest();
    expect(stored?.values.load_valve).toBe(1);
    expect(stored?.values.line_pressure).toBeCloseTo(9.5, 5);
    expect(stored?.values.dryer_purge_pressure).toBeCloseTo(0.2, 5);
  });

  it("refuses to read a position it no longer holds", () => {
    const ring = smallRing();
    for (const sample of decodedRun(20)) ring.push(sample);
    expect(() => ring.simTsAt(11)).toThrow(RangeError);
  });
});

describe("RingBuffer.range", () => {
  it("returns the positions whose data time falls inside the window, bounds included", () => {
    const ring = smallRing(64);
    for (const sample of decodedRun(30)) ring.push(sample);

    const [range] = ring.range(START_MS + 5 * STEP_MS, START_MS + 9 * STEP_MS);
    expect(range).toEqual({ segment: 0, start: 5, end: 10 });
  });

  it("returns nothing for a window that ends before the data starts", () => {
    const ring = smallRing(64);
    for (const sample of decodedRun(30)) ring.push(sample);
    expect(ring.range(START_MS - 10 * STEP_MS, START_MS - STEP_MS)).toEqual([]);
    expect(ring.range(START_MS + 100 * STEP_MS, START_MS + 200 * STEP_MS)).toEqual([]);
  });

  it("returns nothing when the window is inverted", () => {
    const ring = smallRing(64);
    for (const sample of decodedRun(4)) ring.push(sample);
    expect(ring.range(START_MS + STEP_MS, START_MS)).toEqual([]);
  });
});

describe("RingBuffer segments", () => {
  it("opens a segment on a discontinuity and keeps the samples before it", () => {
    const ring = smallRing(64);
    for (const sample of decodedRun(5)) ring.push(sample);
    const jumpMs = START_MS + 3_600_000;
    ring.push(decodedSample(5, { simTsMs: jumpMs, discontinuity: true }));
    for (let offset = 1; offset < 4; offset += 1) {
      ring.push(decodedSample(5 + offset, { simTsMs: jumpMs + offset * STEP_MS }));
    }

    const segments = ring.segments();
    expect(segments.map((segment) => [segment.segment, segment.start, segment.end])).toEqual([
      [0, 0, 5],
      [1, 5, 9],
    ]);
    expect(ring.size).toBe(9);
    expect(ring.discontinuityAt(5)).toBe(true);
    expect(ring.segmentAt(4)).toBe(0);
    expect(ring.segmentAt(5)).toBe(1);
  });

  it("does not open a second segment for the very first sample", () => {
    const ring = smallRing(64);
    ring.push(decodedSample(0, { discontinuity: true }));
    ring.push(decodedSample(1));
    expect(ring.segments()).toHaveLength(1);
    expect(ring.segmentAt(0)).toBe(0);
  });

  it("searches each segment separately when data time jumped backwards", () => {
    const ring = smallRing(64);
    for (const sample of decodedRun(5)) ring.push(sample);
    const backMs = START_MS - 3_600_000;
    ring.push(decodedSample(5, { simTsMs: backMs, discontinuity: true }));
    ring.push(decodedSample(6, { simTsMs: backMs + STEP_MS }));

    expect(ring.range(backMs, backMs + STEP_MS)).toEqual([{ segment: 1, start: 5, end: 7 }]);
    expect(ring.range(START_MS, START_MS + 4 * STEP_MS)).toEqual([
      { segment: 0, start: 0, end: 5 },
    ]);
  });

  it("forgets a segment once every one of its samples has been overwritten", () => {
    const ring = smallRing();
    for (const sample of decodedRun(4)) ring.push(sample);
    ring.push(decodedSample(4, { simTsMs: START_MS + 3_600_000, discontinuity: true }));
    for (const sample of decodedRun(16, () => ({}), 5)) ring.push(sample);

    expect(ring.segments()).toHaveLength(1);
    expect(ring.segments()[0]?.segment).toBe(1);
  });
});

describe("RingBuffer.at", () => {
  it("finds a sample by its sequence number", () => {
    const ring = smallRing(64);
    for (const sample of decodedRun(30)) ring.push(sample);
    expect(ring.at(17)?.position).toBe(16);
    expect(ring.at(17)?.simTsMs).toBe(START_MS + 16 * STEP_MS);
  });

  it("returns undefined for a sequence number the ring does not hold", () => {
    const ring = smallRing();
    for (const sample of decodedRun(20)) ring.push(sample);
    expect(ring.at(3)).toBeUndefined();
    expect(ring.at(999)).toBeUndefined();
  });

  it("finds a sequence number that restarted after a discontinuity", () => {
    const ring = smallRing(64);
    for (const sample of decodedRun(5)) ring.push(sample);
    const restartMs = START_MS + 86_400_000;
    ring.push(decodedSample(0, { seq: 1, simTsMs: restartMs, discontinuity: true }));
    ring.push(decodedSample(1, { seq: 2, simTsMs: restartMs + STEP_MS }));

    // The newest segment answers first, so the restarted counter wins.
    expect(ring.at(1)?.simTsMs).toBe(restartMs);
    expect(ring.at(4)?.simTsMs).toBe(START_MS + 3 * STEP_MS);
  });
});

describe("alarmBitsOf", () => {
  it("sets the bit the register map gives each code", () => {
    const [first, second] = ALARMS;
    if (first === undefined || second === undefined) throw new Error("the register map has alarms");
    expect(alarmBitsOf([first.code])).toBe(1 << first.bit);
    expect(alarmBitsOf([first.code, second.code])).toBe((1 << first.bit) | (1 << second.bit));
  });

  it("ignores a code the register map does not declare", () => {
    expect(alarmBitsOf(["W999"])).toBe(0);
    expect(alarmBitsOf([])).toBe(0);
  });

  it("stores the bit field on the sample", () => {
    const ring = smallRing();
    const [alarm] = ALARMS;
    if (alarm === undefined) throw new Error("the register map has alarms");
    ring.push(decodedSample(0, { alarms: [alarm.code] }));
    expect(ring.alarmBitsAt(0)).toBe(1 << alarm.bit);
  });
});

describe("RingBuffer.kindOf", () => {
  it("knows which tags it stores and how", () => {
    const ring = smallRing();
    expect(ring.kindOf("line_pressure")).toBe("analog");
    expect(ring.kindOf("load_valve")).toBe("digital");
    expect(ring.kindOf("motor_current")).toBeUndefined();
    expect(ring.has("motor_current")).toBe(false);
  });
});
