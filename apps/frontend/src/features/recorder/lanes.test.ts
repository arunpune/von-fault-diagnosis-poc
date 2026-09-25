// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { LANE_TABLE, resolveLayout } from "@/features/recorder/lanes";
import { fixtures } from "@/test/msw/fixtures";

const SIGNALS = fixtures.signals.signals;

describe("resolveLayout", () => {
  it("resolves every lane by recording column, ambient by tag id", () => {
    const layout = resolveLayout(SIGNALS);

    expect(layout.lanes.map((lane) => lane.id)).toEqual([
      "TP3",
      "H1",
      "Oil_temperature",
      "Motor_current",
    ]);
    expect(layout.lanes.map((lane) => lane.series.map((series) => series.tag))).toEqual([
      ["line_pressure", "discharge_pressure"],
      ["separator_discharge_pressure", "dryer_purge_pressure"],
      ["oil_temperature", "ambient_temperature"],
      ["motor_current"],
    ]);
    expect(layout.missing).toEqual([]);
  });

  it("labels, colours and units each lane from the registry", () => {
    const [pressure, , oil] = resolveLayout(SIGNALS).lanes;

    expect(pressure).toMatchObject({
      title: "Line pressure",
      unit: "bar",
      domain: [-0.5, 11],
      guides: [8.05, 10.03],
      decimals: 2,
    });
    expect(pressure?.series[0]).toEqual({
      key: "TP3",
      tag: "line_pressure",
      label: "Line pressure",
      color: "var(--series-line-pressure)",
    });
    expect(pressure?.chartConfig).toEqual({
      TP3: { label: "Line pressure", color: "var(--series-line-pressure)" },
      TP2: { label: "Discharge pressure", color: "var(--series-discharge)" },
    });
    expect(oil?.unit).toBe("°C");
    expect(oil?.series[1]?.key).toBe("ambient_temperature");
  });

  it("resolves the rows and tells the store every tag it charts or derives from", () => {
    const { strips, config } = resolveLayout(SIGNALS);

    expect(strips).toEqual({ state: true, lps: "low_pressure_switch", towers: "dryer_tower" });
    expect(config.strips).toEqual({ lps: "low_pressure_switch", towers: "dryer_tower" });
    expect(config.signals).toBe(SIGNALS);
    expect([...config.tags].sort()).toEqual(
      [
        "ambient_temperature",
        "discharge_pressure",
        "dryer_purge_pressure",
        "dryer_tower",
        "intake_closed",
        "line_pressure",
        "load_valve",
        "low_pressure_switch",
        "motor_current",
        "oil_temperature",
        "separator_discharge_pressure",
      ].sort(),
    );
  });

  it("drops the optional ambient series when the registry has none", () => {
    const signals = SIGNALS.filter((signal) => signal.signal_id !== "ambient_temperature");

    const oil = resolveLayout(signals).lanes.find((lane) => lane.id === "Oil_temperature");

    expect(oil?.series.map((series) => series.tag)).toEqual(["oil_temperature"]);
  });

  it("hides a lane or row whose signals are missing and names it", () => {
    const signals = SIGNALS.filter(
      (signal) => !["H1", "COMP", "Towers"].includes(signal.metropt_column ?? ""),
    );

    const layout = resolveLayout(signals);

    expect(layout.lanes.map((lane) => lane.id)).toEqual([
      "TP3",
      "Oil_temperature",
      "Motor_current",
    ]);
    expect(layout.strips).toEqual({ state: false, lps: "low_pressure_switch", towers: null });
    expect(layout.missing).toEqual(["Separator and purge", "Machine state", "Dryer towers"]);
  });

  it("names every lane and row for an empty registry", () => {
    const layout = resolveLayout([]);

    expect(layout.lanes).toEqual([]);
    expect(layout.missing).toEqual([
      ...LANE_TABLE.map((lane) => lane.title),
      "Machine state",
      "Low-pressure switch",
      "Dryer towers",
    ]);
    expect(layout.config.tags).toEqual([]);
  });
});
