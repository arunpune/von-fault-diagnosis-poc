// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { Observation } from "@/api/types";
import {
  describeObservation,
  evidenceItemRows,
  observationRows,
  suspectEventRows,
  ticketEvidenceRows,
} from "@/lib/evidence";
import { fixtures } from "@/test/msw/fixtures";

function eventAt(index: number) {
  const event = fixtures.events.items[index];
  if (event === undefined) {
    throw new Error(`events.json has no item ${index}`);
  }
  return event;
}

describe("describeObservation", () => {
  it("puts the level and trend buckets into words", () => {
    const observation: Observation = { signal: "line_pressure", level: "far_above", trend: "flat" };
    expect(describeObservation(observation)).toBe("Far above normal, steady");
    expect(describeObservation({ ...observation, level: "normal", trend: "erratic" })).toBe(
      "Normal, erratic",
    );
    expect(describeObservation({ ...observation, level: "unknown", trend: "unknown" })).toBe(
      "Level unknown, trend unknown",
    );
  });

  it("reads a bucket this build does not know as its own name", () => {
    const future = {
      signal: "x",
      level: "off_scale",
      trend: "oscillating",
    } as unknown as Observation;
    expect(describeObservation(future)).toBe("Off scale, oscillating");
  });
});

describe("evidence rows", () => {
  it("keeps the sentences of a suspect event with their values and durations", () => {
    const [first] = evidenceItemRows(eventAt(1).evidence);
    expect(first).toEqual({
      signal: "loaded_run_duration",
      statement: "The unit has been loaded without reaching cut-out for about an hour.",
      value: 5322,
      unit: "s",
      baseline: 186,
      window: "about an hour",
    });
  });

  it("turns observations into rows with a phrase for the buckets", () => {
    const rows = observationRows(eventAt(1).observations);
    expect(rows[0]).toEqual({
      signal: "line_pressure",
      statement: "Below normal, steady",
      value: 8.34,
      unit: "bar",
      window: "about an hour",
    });
    expect(rows).toHaveLength(eventAt(1).observations.length);
  });

  it("states each signal of a suspect event once, sentences first", () => {
    const event = eventAt(1);
    const rows = suspectEventRows(event);
    expect(rows.slice(0, event.evidence.length).map((row) => row.statement)).toEqual(
      event.evidence.map((item) => item.observation),
    );
    const signals = rows.map((row) => row.signal);
    expect(new Set(signals).size).toBe(signals.length);
    expect(signals).toEqual([
      "loaded_run_duration",
      "dryer_purge_pressure",
      "line_pressure",
      "oil_temperature",
      "motor_current",
      "cut_out_reached",
    ]);
  });

  it("gives a ticket the sentences of its suspect events", () => {
    const rows = ticketEvidenceRows(fixtures.ticket);
    expect(rows.map((row) => row.signal)).toEqual(["loaded_run_duration", "dryer_purge_pressure"]);
    expect(rows[1]?.baseline).toBe(0.02);
  });
});
