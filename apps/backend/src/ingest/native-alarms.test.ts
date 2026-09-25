// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Alarm transitions: the edges of the controller's own alarm list.
 *
 * The codes are taken from the register map rather than written out, so the
 * test keeps working when the alarm table grows, and the ordering assertion
 * uses two codes whose bits are known to differ.
 */

import { ALARMS } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { decodedSample } from "./fixture.test-helper.ts";
import { createAlarmTracker } from "./native-alarms.ts";

/** Two declared alarms, the lower bit first. */
const [LOW, HIGH] = [...ALARMS].sort((a, b) => a.bit - b.bit);
if (LOW === undefined || HIGH === undefined) throw new Error("the register map declares alarms");

describe("createAlarmTracker", () => {
  it("says nothing while the alarm list does not change", () => {
    const tracker = createAlarmTracker();
    expect(tracker.push(decodedSample(0))).toEqual([]);
    expect(tracker.push(decodedSample(1))).toEqual([]);

    tracker.push(decodedSample(2, { alarms: [LOW.code] }));
    expect(tracker.push(decodedSample(3, { alarms: [LOW.code] }))).toEqual([]);
  });

  it("raises a code the moment it appears and clears it when it goes", () => {
    const tracker = createAlarmTracker();
    expect(tracker.push(decodedSample(0, { alarms: [LOW.code] }))).toEqual([
      { code: LOW.code, state: "raised", sim_ts: "2020-02-03T00:00:00.000Z", seq: 1 },
    ]);
    expect(tracker.push(decodedSample(1, { alarms: [] }))).toEqual([
      { code: LOW.code, state: "cleared", sim_ts: "2020-02-03T00:00:10.000Z", seq: 2 },
    ]);
  });

  it("carries the seq and the sim_ts of the sample that changed", () => {
    const tracker = createAlarmTracker();
    const [transition] = tracker.push(decodedSample(41, { seq: 4_711, alarms: [HIGH.code] }));
    expect(transition).toMatchObject({ seq: 4_711, sim_ts: "2020-02-03T00:06:50.000Z" });
  });

  it("reports several changes of one sample in ascending bit order", () => {
    const tracker = createAlarmTracker();
    tracker.push(decodedSample(0, { alarms: [HIGH.code] }));
    const transitions = tracker.push(decodedSample(1, { alarms: [LOW.code] }));
    expect(transitions.map((transition) => [transition.code, transition.state])).toEqual([
      [LOW.code, "raised"],
      [HIGH.code, "cleared"],
    ]);
  });

  it("accepts a code the register map does not declare, after the declared ones", () => {
    const tracker = createAlarmTracker();
    const transitions = tracker.push(decodedSample(0, { alarms: ["W901", LOW.code] }));
    expect(transitions.map((transition) => transition.code)).toEqual([LOW.code, "W901"]);
    expect(transitions.every((transition) => transition.state === "raised")).toBe(true);
  });

  it("keeps the active set for detection and gives it in declared order", () => {
    const tracker = createAlarmTracker();
    expect(tracker.active()).toEqual([]);
    tracker.push(decodedSample(0, { alarms: [HIGH.code, LOW.code] }));
    expect(tracker.active()).toEqual([LOW.code, HIGH.code]);
    tracker.push(decodedSample(1, { alarms: [HIGH.code] }));
    expect(tracker.active()).toEqual([HIGH.code]);
  });

  it("forgets the active set on reset, so a replay raises everything again", () => {
    const tracker = createAlarmTracker();
    tracker.push(decodedSample(0, { alarms: [LOW.code] }));
    tracker.reset();
    expect(tracker.active()).toEqual([]);
    expect(tracker.push(decodedSample(1, { alarms: [LOW.code] }))).toEqual([
      { code: LOW.code, state: "raised", sim_ts: "2020-02-03T00:00:10.000Z", seq: 2 },
    ]);
  });
});
