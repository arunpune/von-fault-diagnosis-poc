// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The committed data against its contract and against docs/dataset.md, record by record. The
// failure table is generated, so the last test here is the one that matters most: it re-runs the
// generator in process and compares the bytes, which is `--check` without a child process.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { renderFailureTable } from "../scripts/build-failure-table.ts";
import { DATA_DIR, loadFailureTable, loadPresets } from "../src/index.ts";

const table = loadFailureTable();
const presets = loadPresets();

describe("metropt3-failures.json", () => {
  it("names its source and its clock", () => {
    expect(table.schema).toBe("urn:fdp:schema:gt-failure-table:v1");
    expect(table.clock).toBe("utc-assumed");
    expect(table.source).toEqual({
      dataset: "MetroPT-3 (UCI 791)",
      doi: "10.24432/C5VW3R",
      license: "CC-BY-4.0",
      csv_sha256: "db30ccb4ea402e3c8bf2c99db06e288d4f2a772f6928f9dbe26a920d69793e24",
      resolved_from: "docs/dataset.md#how-the-windows-were-resolved",
    });
  });

  it("carries the five failure rows with their scoring windows", () => {
    expect(table.failures.map((failure) => [failure.id, failure.start, failure.end])).toEqual([
      ["F1", "2020-04-18T00:00:00.000Z", "2020-04-19T02:00:00.000Z"],
      ["F2", "2020-05-29T23:30:00.000Z", "2020-05-30T06:00:00.000Z"],
      ["F3", "2020-06-05T10:00:00.000Z", "2020-06-07T14:30:00.000Z"],
      ["F4", "2020-07-15T14:30:00.000Z", "2020-07-15T19:00:00.000Z"],
      ["F4b", "2020-07-16T20:00:00.000Z", "2020-07-17T06:00:00.000Z"],
    ]);
  });

  it("keeps the onset of F1 unknown and every other onset known", () => {
    expect(
      Object.fromEntries(table.failures.map((failure) => [failure.id, failure.onset_known])),
    ).toEqual({ F1: false, F2: true, F3: true, F4: true, F4b: true });
    const f1 = table.failures.find((failure) => failure.id === "F1");
    expect(f1?.precursor_from).toBeNull();
    expect(f1?.data_onset).toBe("2020-04-18T00:23:59.000Z");
  });

  it("records the precursor of F4 and no other", () => {
    expect(
      Object.fromEntries(table.failures.map((failure) => [failure.id, failure.precursor_from])),
    ).toEqual({
      F1: null,
      F2: null,
      F3: null,
      F4: "2020-07-14T21:28:00.000Z",
      F4b: null,
    });
  });

  it("verifies only the maintenance note of F4", () => {
    expect(
      Object.fromEntries(
        table.failures.map((failure) => [failure.id, failure.maintenance_verified]),
      ),
    ).toEqual({ F1: false, F2: false, F3: false, F4: true, F4b: false });
    expect(table.failures.find((failure) => failure.id === "F2")?.maintenance).toBe(
      "2020-05-30T12:00:00.000Z",
    );
  });

  it("records the first native alarm inside each window", () => {
    expect(
      Object.fromEntries(table.failures.map((failure) => [failure.id, failure.native_alarm_first])),
    ).toEqual({
      F1: null,
      F2: null,
      F3: "2020-06-06T19:42:19.000Z",
      F4: "2020-07-15T17:20:11.000Z",
      F4b: "2020-07-17T00:56:00.000Z",
    });
  });

  it("assigns the two leak signatures and their accepted causes", () => {
    expect(
      table.failures.map((failure) => [
        failure.id,
        failure.signature,
        failure.fault_id,
        failure.accepted_fault_ids,
      ]),
    ).toEqual([
      ["F1", "A", "dryer_purge_leak", ["dryer_purge_leak", "downstream_air_leak"]],
      ["F2", "A", "dryer_purge_leak", ["dryer_purge_leak", "downstream_air_leak"]],
      ["F3", "A", "dryer_purge_leak", ["dryer_purge_leak", "downstream_air_leak"]],
      ["F4", "B", "downstream_air_leak", ["downstream_air_leak"]],
      ["F4b", "B", "downstream_air_leak", ["downstream_air_leak"]],
    ]);
  });

  it("keeps F4b out of the headline metrics", () => {
    expect(table.failures.filter((failure) => failure.in_headline).map((f) => f.id)).toEqual([
      "F1",
      "F2",
      "F3",
      "F4",
    ]);
  });

  it("lists the twelve unlabelled episodes", () => {
    expect(table.unlabelled_episodes.map((episode) => episode.start)).toEqual([
      "2020-03-06T21:42:25.000Z",
      "2020-03-11T05:15:20.000Z",
      "2020-03-12T00:16:06.000Z",
      "2020-03-26T04:00:30.000Z",
      "2020-03-27T07:12:10.000Z",
      "2020-03-28T07:22:24.000Z",
      "2020-04-12T11:50:31.000Z",
      "2020-05-13T13:44:04.000Z",
      "2020-05-19T10:05:50.000Z",
      "2020-05-19T22:22:17.000Z",
      "2020-06-01T14:49:54.000Z",
      "2020-06-03T10:06:00.000Z",
    ]);
    for (const episode of table.unlabelled_episodes) {
      expect(episode.fault_id_hint).toBe("dryer_purge_leak");
      expect(episode.note.length).toBeGreaterThan(0);
    }
  });

  it("excludes the repairs, the unlabelled episodes, F4b, the frozen blocks and the depot", () => {
    const byReason = new Map<string, number>();
    for (const window of table.excluded_windows) {
      byReason.set(window.reason, (byReason.get(window.reason) ?? 0) + 1);
    }
    expect(Object.fromEntries(byReason)).toEqual({
      repair: 3,
      unlabelled_positive: 12,
      secondary_positive: 1,
      frozen_logger: 9,
      depot_depressurisation: 5,
    });
  });

  it("lists the five depot depressurisations and no alarm inside a failure", () => {
    expect(
      table.excluded_windows
        .filter((window) => window.reason === "depot_depressurisation")
        .map((window) => [window.from, window.to]),
    ).toEqual([
      ["2020-05-19T02:00:15.000Z", "2020-05-19T06:02:59.000Z"],
      ["2020-06-02T19:23:21.000Z", "2020-06-02T20:52:53.000Z"],
      ["2020-06-08T11:48:04.000Z", "2020-06-08T12:28:12.000Z"],
      ["2020-07-14T02:16:26.000Z", "2020-07-14T02:52:16.000Z"],
      ["2020-07-31T01:35:33.000Z", "2020-07-31T06:04:16.000Z"],
    ]);
  });

  it("keeps the excluded windows in chronological order", () => {
    const froms = table.excluded_windows.map((window) => window.from);
    expect([...froms].sort()).toEqual(froms);
  });

  it("copies the nine frozen blocks with their row counts and the 160 long gaps", () => {
    expect(table.frozen_blocks).toHaveLength(9);
    expect(table.frozen_blocks[2]).toEqual({
      start: "2020-04-17T09:20:43.000Z",
      end: "2020-04-18T00:18:07.000Z",
      rows: 4469,
      hours: 14.96,
    });
    expect(table.gaps_over_1h).toHaveLength(160);
    expect(table.gaps_over_1h[0]).toEqual({
      start: "2020-02-01T19:40:04.000Z",
      end: "2020-02-01T23:15:33.000Z",
      seconds: 12929,
    });
  });

  it("is exactly what the generator produces from the statistics", () => {
    const committed = readFileSync(join(DATA_DIR, "metropt3-failures.json"), "utf8");
    expect(renderFailureTable()).toBe(committed);
  });
});

describe("presets.json", () => {
  it("carries the nine presets with unique ids", () => {
    expect(presets.schema).toBe("urn:fdp:schema:gt-presets:v1");
    const ids = presets.presets.map((preset) => preset.preset_id);
    expect(ids).toEqual([
      "baseline_feb",
      "f1_air_leak_apr18",
      "f2_air_leak_may30",
      "f3_air_leak_jun05",
      "f4_precursor_jul14",
      "f4_air_leak_jul15",
      "unlabelled_leak_may19",
      "frozen_logger_jun22",
      "depot_lps_jul31",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows the README label verbatim, with an en dash and a four-hour lead-in", () => {
    const tour = presets.presets.find((preset) => preset.preset_id === "f3_air_leak_jun05");
    expect(tour?.label).toBe("Air leak – 5 Jun 2020");
    expect(tour?.lead_in_min).toBe(240);
    expect(tour?.sim_ts).toBe("2020-06-05T10:00:00.000Z");
  });

  it("writes every label with an en dash and no hyphen separator", () => {
    for (const preset of presets.presets) {
      expect(preset.label).toContain("–");
      expect(preset.label).not.toContain(" - ");
    }
  });

  it("targets the instant and the lead-in of each preset", () => {
    expect(
      presets.presets.map((preset) => [
        preset.preset_id,
        preset.kind,
        preset.sim_ts,
        preset.lead_in_min,
        preset.failure_id,
      ]),
    ).toEqual([
      ["baseline_feb", "baseline", "2020-02-01T00:00:00.000Z", 0, null],
      ["f1_air_leak_apr18", "failure", "2020-04-18T00:00:00.000Z", 120, "F1"],
      ["f2_air_leak_may30", "failure", "2020-05-29T23:30:00.000Z", 330, "F2"],
      ["f3_air_leak_jun05", "failure", "2020-06-05T10:00:00.000Z", 240, "F3"],
      ["f4_precursor_jul14", "precursor", "2020-07-14T21:30:00.000Z", 0, "F4"],
      ["f4_air_leak_jul15", "failure", "2020-07-15T14:30:00.000Z", 90, "F4"],
      ["unlabelled_leak_may19", "diagnostic", "2020-05-19T22:22:00.000Z", 142, null],
      ["frozen_logger_jun22", "diagnostic", "2020-06-22T15:06:00.000Z", 66, null],
      ["depot_lps_jul31", "diagnostic", "2020-07-31T01:35:00.000Z", 30, null],
    ]);
  });

  it("references only failures the table carries", () => {
    const known = new Set(table.failures.map((failure) => failure.id));
    for (const preset of presets.presets) {
      if (preset.failure_id !== null) expect(known).toContain(preset.failure_id);
    }
  });

  it("gives every preset a note", () => {
    for (const preset of presets.presets) expect(preset.note.length).toBeGreaterThan(0);
  });
});
