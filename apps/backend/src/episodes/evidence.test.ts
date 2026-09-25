// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The persistence clock: how long each symptom key's evidence has
// held without a break, measured from the rule's own `since_sim_ts`.

import { describe, expect, it } from "vitest";

import { createEvidenceClock, type EvidenceHit } from "./evidence.ts";

/** 11:00 on a data day plus `minutes`, as an `iso_ts`. */
function at(minutes: number): string {
  return new Date(Date.parse("2020-03-09T11:00:00.000Z") + minutes * 60_000).toISOString();
}

function hit(symptom_key: string, sinceMinutes: number): EvidenceHit {
  return { symptom_key, since_sim_ts: at(sinceMinutes) };
}

describe("createEvidenceClock", () => {
  it("measures a run from the rule's own start, hold included", () => {
    const clock = createEvidenceClock();
    // A rule that waited out a 30-minute hold reports the instant its condition first held.
    clock.observe([hit("oil_temperature_high", 0)]);
    expect(clock.since("oil_temperature_high")).toBe(at(0));
    expect(clock.persistedSimMin("oil_temperature_high", at(30))).toBe(30);
  });

  it("reads 0 for a key that is not firing", () => {
    const clock = createEvidenceClock();
    expect(clock.since("purge_pressure_high")).toBeUndefined();
    expect(clock.persistedSimMin("purge_pressure_high", at(10))).toBe(0);
  });

  it("keeps the run going while the key keeps firing, and ends it on the first report without it", () => {
    const clock = createEvidenceClock();
    clock.observe([hit("purge_pressure_high", 0)]);
    clock.observe([hit("purge_pressure_high", 0)]);
    expect(clock.persistedSimMin("purge_pressure_high", at(1.5))).toBe(1.5);

    clock.observe([]);
    expect(clock.since("purge_pressure_high")).toBeUndefined();

    // Firing again is a new run: nothing of the first one is carried over.
    clock.observe([hit("purge_pressure_high", 40)]);
    expect(clock.persistedSimMin("purge_pressure_high", at(41))).toBe(1);
  });

  it("treats overlapping rules of one key as one run, even after the first one stops", () => {
    const clock = createEvidenceClock();
    clock.observe([hit("low_line_pressure", 0)]);
    clock.observe([hit("low_line_pressure", 0), hit("low_line_pressure", 5)]);
    // The rule that started the run stops; the other one keeps the key firing.
    clock.observe([hit("low_line_pressure", 5)]);
    expect(clock.since("low_line_pressure")).toBe(at(0));
    expect(clock.persistedSimMin("low_line_pressure", at(12))).toBe(12);
  });

  it("takes the earliest start when two rules of a key begin a run together", () => {
    const clock = createEvidenceClock();
    clock.observe([hit("frequent_cycling", 3), hit("frequent_cycling", 1)]);
    expect(clock.since("frequent_cycling")).toBe(at(1));
  });

  it("times every key on its own", () => {
    const clock = createEvidenceClock();
    clock.observe([hit("continuous_load", 10), hit("purge_pressure_high", 0)]);
    expect(clock.persistedSimMin("continuous_load", at(12))).toBe(2);
    expect(clock.persistedSimMin("purge_pressure_high", at(12))).toBe(12);

    clock.observe([hit("purge_pressure_high", 0)]);
    expect(clock.since("continuous_load")).toBeUndefined();
    expect(clock.since("purge_pressure_high")).toBe(at(0));
  });

  it("forgets every run on reset", () => {
    const clock = createEvidenceClock();
    clock.observe([hit("purge_pressure_high", 0), hit("continuous_load", 0)]);
    clock.reset();
    expect(clock.since("purge_pressure_high")).toBeUndefined();
    expect(clock.since("continuous_load")).toBeUndefined();
  });

  it("never reads a negative persistence, even for an instant before the run", () => {
    const clock = createEvidenceClock();
    clock.observe([hit("purge_pressure_high", 5)]);
    expect(clock.persistedSimMin("purge_pressure_high", at(4))).toBe(0);
  });
});
