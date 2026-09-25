// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The label logic: the window boundaries, the precedence of a failure window over an excluded one,
// the secondary positive, and the catalog the simulator publishes.

import { assertValid, toIsoMs } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import {
  buildGtCatalog,
  getInjection,
  getPreset,
  isExcluded,
  labelAt,
  loadFailureTable,
  loadInjections,
  loadPresets,
  precursorFrom,
  scoringWindows,
} from "../src/index.ts";

const table = loadFailureTable();

/** One millisecond before an instant, as a canonical `iso_ts`. */
function justBefore(instant: string): string {
  return toIsoMs(new Date(new Date(instant).getTime() - 1));
}

describe("labelAt", () => {
  it("starts a failure window inclusively and ends it exclusively", () => {
    for (const failure of table.failures.filter((row) => row.in_headline)) {
      expect(labelAt(failure.start).failure_id).toBe(failure.id);
      expect(labelAt(justBefore(failure.end)).failure_id).toBe(failure.id);
      expect(labelAt(failure.end).failure_id).not.toBe(failure.id);
      expect(labelAt(justBefore(failure.start)).failure_id).not.toBe(failure.id);
    }
  });

  it("names the cause and the accepted causes inside a window", () => {
    expect(labelAt("2020-06-06T00:00:00.000Z")).toEqual({
      failure_id: "F3",
      fault_id: "dryer_purge_leak",
      accepted_fault_ids: ["dryer_purge_leak", "downstream_air_leak"],
      excluded: false,
      reason: null,
      in_headline: true,
    });
  });

  it("accepts a Date and a shorter ISO string for the same instant", () => {
    const iso = labelAt("2020-06-06T00:00:00.000Z");
    expect(labelAt(new Date("2020-06-06T00:00:00Z"))).toEqual(iso);
    expect(labelAt("2020-06-06T00:00Z")).toEqual(iso);
  });

  it("excludes F4b unless the caller asks for the secondary positives", () => {
    const inside = "2020-07-17T01:00:00.000Z";
    expect(labelAt(inside)).toEqual({
      failure_id: null,
      fault_id: null,
      accepted_fault_ids: [],
      excluded: true,
      reason: "secondary_positive",
      in_headline: false,
    });
    expect(labelAt(inside, { includeSecondary: true })).toEqual({
      failure_id: "F4b",
      fault_id: "downstream_air_leak",
      accepted_fault_ids: ["downstream_air_leak"],
      excluded: false,
      reason: null,
      in_headline: false,
    });
  });

  it("gives the failure window precedence over the frozen block that reaches into it", () => {
    // The logger is frozen from 17 April 09:20 until 18 April 00:18, and F1 starts at midnight.
    expect(labelAt("2020-04-17T18:00:00.000Z")).toMatchObject({
      excluded: true,
      reason: "frozen_logger",
      failure_id: null,
    });
    expect(labelAt("2020-04-18T00:10:00.000Z")).toMatchObject({
      excluded: false,
      failure_id: "F1",
    });
  });

  it("excludes a depot depressurisation, the abstention case", () => {
    expect(labelAt("2020-05-19T03:00:00.000Z")).toMatchObject({
      excluded: true,
      reason: "depot_depressurisation",
    });
  });

  it("excludes an unlabelled episode and a repair period", () => {
    expect(labelAt("2020-03-12T06:00:00.000Z")).toMatchObject({
      excluded: true,
      reason: "unlabelled_positive",
    });
    expect(labelAt("2020-04-19T02:30:00.000Z")).toMatchObject({
      excluded: true,
      reason: "repair",
    });
  });

  it("returns the negative label for ordinary operation", () => {
    expect(labelAt("2020-02-02T12:00Z")).toEqual({
      failure_id: null,
      fault_id: null,
      accepted_fault_ids: [],
      excluded: false,
      reason: null,
      in_headline: false,
    });
  });

  it("refuses a string that denotes no instant", () => {
    expect(() => labelAt("not a timestamp")).toThrowError(TypeError);
  });
});

describe("isExcluded", () => {
  it("is the raw window lookup, without the failure precedence", () => {
    expect(isExcluded("2020-04-18T00:10:00.000Z")).toEqual({
      excluded: true,
      reason: "frozen_logger",
    });
    expect(isExcluded("2020-02-02T12:00:00.000Z")).toEqual({ excluded: false, reason: null });
  });
});

describe("scoringWindows", () => {
  it("lists the four headline failures, and five with the secondary positive", () => {
    expect(scoringWindows().map((window) => window.failure_id)).toEqual(["F1", "F2", "F3", "F4"]);
    expect(scoringWindows({ includeSecondary: true }).map((window) => window.failure_id)).toEqual([
      "F1",
      "F2",
      "F3",
      "F4",
      "F4b",
    ]);
  });

  it("hands out Date bounds that match the table", () => {
    const [first] = scoringWindows();
    expect(first?.from.toISOString()).toBe("2020-04-18T00:00:00.000Z");
    expect(first?.to.toISOString()).toBe("2020-04-19T02:00:00.000Z");
    expect(first?.fault_id).toBe("dryer_purge_leak");
  });
});

describe("precursorFrom", () => {
  it("knows the seventeen-hour precursor of F4 and nothing for the others", () => {
    expect(precursorFrom("F4")?.toISOString()).toBe("2020-07-14T21:28:00.000Z");
    expect(precursorFrom("F1")).toBeNull();
  });

  it("refuses an unknown failure id", () => {
    expect(() => precursorFrom("F9")).toThrowError(/unknown failure id/);
  });
});

describe("lookups", () => {
  it("finds a preset by id", () => {
    expect(getPreset("f3_air_leak_jun05")?.label).toBe("Air leak – 5 Jun 2020");
    expect(getPreset("no_such_preset")).toBeUndefined();
  });

  it("finds no injection while the catalog is absent", () => {
    if (loadInjections() === null) expect(getInjection("oil_cooler_fouling")).toBeUndefined();
  });

  it("freezes what it hands out", () => {
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(table.failures)).toBe(true);
    expect(Object.isFrozen(loadPresets().presets[0])).toBe(true);
  });

  it("reads each file once", () => {
    expect(loadFailureTable()).toBe(table);
    expect(loadPresets()).toBe(loadPresets());
  });
});

describe("buildGtCatalog", () => {
  const catalog = buildGtCatalog();

  it("validates against the gt-catalog contract", () => {
    expect(() => assertValid("gt-catalog", catalog)).not.toThrow();
  });

  it("forwards the presets and the failure table verbatim", () => {
    expect(catalog.presets).toEqual(loadPresets());
    expect(catalog.failures).toEqual(table);
  });

  it("defaults to the only unit of the proof of concept and takes another on request", () => {
    expect(catalog.unit_id).toBe("cau-7");
    expect(buildGtCatalog("cau-8").unit_id).toBe("cau-8");
  });

  it("takes the dataset the simulator reports", () => {
    const dataset = {
      first_ts: "2020-06-05T06:00:00.000Z",
      last_ts: "2020-06-08T18:00:00.000Z",
      rows: 27358,
      gaps: 2,
    };
    expect(buildGtCatalog("cau-7", dataset).dataset).toEqual(dataset);
  });

  it("carries an empty injection menu while the catalog is absent", () => {
    if (loadInjections() === null) expect(catalog.injections).toEqual([]);
  });

  it("digests the data files it shipped", () => {
    expect(catalog.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(buildGtCatalog().source_sha256).toBe(catalog.source_sha256);
  });
});
