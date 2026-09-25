// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { RunningInstance } from "@/api/types";
import { buildOverlayModel, listRange } from "@/features/recorder/overlay-model";
import type { RecorderAxis } from "@/store/telemetry-store";
import { fixtures } from "@/test/msw/fixtures";

const HOUR_MS = 3_600_000;

function axisEnding(iso: string, windowMs: number): RecorderAxis {
  const to = Date.parse(iso);
  return { from: to - windowMs, to, ticks: [], withDate: false };
}

const SOURCES = {
  catalog: fixtures.overlayCatalog,
  intervals: fixtures.overlayInjections.items,
  active: [] as RunningInstance[],
  markers: fixtures.overlayMarkers.items,
};

describe("buildOverlayModel", () => {
  it("keeps the failure and injection windows inside the axis, clipped to it", () => {
    const axis = axisEnding("2020-06-05T12:00:00.000Z", 6 * HOUR_MS);

    const { bands } = buildOverlayModel(SOURCES, axis);

    expect(bands).toEqual([
      {
        id: "F3",
        kind: "failure",
        from: Date.parse("2020-06-05T10:00:00.000Z"),
        to: axis.to,
        title: "Dataset failure F3",
      },
      {
        id: "inj-7f3a-1",
        kind: "injection",
        from: Date.parse("2020-06-05T08:00:00.000Z"),
        to: axis.to,
        title: "Injected fault: Oil cooler fouling",
      },
    ]);
  });

  it("draws an excluded window and the unlabelled episode on the same span once", () => {
    const axis = axisEnding("2020-03-07T00:00:00.000Z", 24 * HOUR_MS);

    const { bands } = buildOverlayModel(SOURCES, axis);

    expect(bands).toEqual([
      {
        id: "excluded-2020-03-06T21:42:25.000Z",
        kind: "excluded",
        from: Date.parse("2020-03-06T21:42:25.000Z"),
        to: Date.parse("2020-03-06T22:59:53.000Z"),
        title: "Excluded: Unlabelled positive",
      },
    ]);
  });

  it("lets a running injection win over its stored row and runs an open one to the axis end", () => {
    const axis = axisEnding("2020-06-05T20:00:00.000Z", 24 * HOUR_MS);
    const running: RunningInstance = {
      instance_id: "inj-7f3a-2",
      injection_id: "motor_overload",
      fault_id: "motor_overload",
      started_sim_ts: "2020-06-05T19:00:00.000Z",
      ends_sim_ts: "2020-06-06T19:00:00.000Z",
      params: { magnitude: 1, duration_sim_min: 1_440 },
    };
    const open = { ...fixtures.overlayInjections.items[1]!, end_sim_ts: null };

    const { bands } = buildOverlayModel({ ...SOURCES, intervals: [open], active: [running] }, axis);

    expect(bands.filter((entry) => entry.kind === "injection")).toEqual([
      {
        id: "inj-7f3a-1",
        kind: "injection",
        from: Date.parse("2020-06-05T08:00:00.000Z"),
        to: axis.to,
        title: "Injected fault: Oil cooler fouling",
      },
      {
        id: "inj-7f3a-2",
        kind: "injection",
        from: Date.parse("2020-06-05T19:00:00.000Z"),
        to: axis.to,
        title: "Injected fault: Motor overload",
      },
    ]);
  });

  it("keeps the markers inside the axis as lines at their target", () => {
    const inside = buildOverlayModel(SOURCES, axisEnding("2020-06-05T07:00:00.000Z", HOUR_MS));
    const outside = buildOverlayModel(SOURCES, axisEnding("2020-06-05T12:00:00.000Z", HOUR_MS));

    expect(inside.markers).toEqual([
      {
        id: "jump-2020-06-05T06:00:00.000Z",
        at: Date.parse("2020-06-05T06:00:00.000Z"),
        title: "Jump to 2020-06-05 06:00:00",
      },
    ]);
    expect(outside.markers).toEqual([]);
  });

  it("draws two jumps to the same instant as one line", () => {
    const [jump] = fixtures.overlayMarkers.items;
    const again = { ...jump!, wall_ts: "2026-09-23T10:00:00.000Z" };
    const axis = axisEnding("2020-06-05T07:00:00.000Z", HOUR_MS);

    const { markers } = buildOverlayModel({ ...SOURCES, markers: [jump!, again] }, axis);

    expect(markers.map((marker) => marker.id)).toEqual(["jump-2020-06-05T06:00:00.000Z"]);
  });

  it("has only the live windows while the catalog is not loaded", () => {
    const axis = axisEnding("2020-06-05T12:00:00.000Z", 6 * HOUR_MS);

    const model = buildOverlayModel({ ...SOURCES, catalog: undefined, markers: [] }, axis);

    expect(model.bands.map((entry) => [entry.id, entry.title])).toEqual([
      ["inj-7f3a-1", "Injected fault: Oil cooler fouling"],
    ]);
  });
});

describe("listRange", () => {
  it("spans the sim day before and the day of `now`, whole days only", () => {
    const range = listRange(Date.parse("2020-06-05T12:34:56.000Z"));

    expect(range).toEqual({
      from: Date.parse("2020-06-04T00:00:00.000Z"),
      to: Date.parse("2020-06-06T00:00:00.000Z"),
    });
    expect(listRange(Date.parse("2020-06-05T23:59:59.000Z"))).toEqual(range);
  });
});
