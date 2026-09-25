// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The explicit tuning list and its guard.
//
// The list is read against the committed scenario files and the committed
// failure table, so a scenario that changes split or ground truth under it
// fails here rather than in a tuning run.

import { describe, expect, it } from "vitest";

import { ConfigError } from "./config.ts";
import { CORE_10_SCENARIO_IDS } from "./metrics/index.ts";
import { headlineFailureIds } from "./runner/run.ts";
import { loadAll } from "./scenario/index.ts";
import { TUNING_SCENARIOS, selectTuning, sharedSlices, tuningRejections } from "./tuning.ts";

const ALL = loadAll();
const HEADLINE = headlineFailureIds();

/** The four dev injections that replay `baseline-feb03`, the day five core-10 scenarios replay. */
const DEV_INJECTIONS = [
  "inject_dryer_tower_switching_failure",
  "inject_intake_valve_sticking",
  "inject_motor_overload",
  "inject_separator_drain_blocked",
];

/** The dev twin of the core-10 downstream leak, on the summer slice no core-10 scenario replays. */
const LEAK_TWIN = "inject_air_leak_downstream_jul05";

/** The ConfigError `run` throws. */
function configError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("TUNING_SCENARIOS", () => {
  it("is the nine original scenarios and the leak's dev twin", () => {
    expect([...TUNING_SCENARIOS].sort()).toEqual(
      [
        "summer_normal_jul05",
        "frozen_logger_jun22",
        "f4b_recurrence_jul17",
        "unlabelled_leak_may19",
        "august_oil_level_aug10",
        ...DEV_INJECTIONS,
        LEAK_TWIN,
      ].sort(),
    );
  });

  it("holds the twin, not the core-10 leak it mirrors", () => {
    expect(TUNING_SCENARIOS).toContain(LEAK_TWIN);
    expect(TUNING_SCENARIOS).not.toContain("inject_air_leak_downstream");
    expect(tuningRejections([LEAK_TWIN], ALL, HEADLINE)).toEqual([]);
  });

  it("holds no core-10 id, no f4_precursor_jul14 and no metropt3_full", () => {
    for (const id of CORE_10_SCENARIO_IDS) expect(TUNING_SCENARIOS).not.toContain(id);
    expect(TUNING_SCENARIOS).not.toContain("f4_precursor_jul14");
    expect(TUNING_SCENARIOS).not.toContain("metropt3_full");
  });

  it("passes the guard, in list order, all of it dev split", () => {
    expect(tuningRejections(TUNING_SCENARIOS, ALL, HEADLINE)).toEqual([]);
    const selected = selectTuning(ALL, HEADLINE);
    expect(selected.map((scenario) => scenario.id)).toEqual(TUNING_SCENARIOS);
    for (const scenario of selected) expect(scenario.split).toBe("dev");
  });
});

describe("the tuning guard", () => {
  it.each([...CORE_10_SCENARIO_IDS])("rejects the core-10 scenario %s", (id) => {
    expect(tuningRejections([id], ALL, HEADLINE)).toEqual([
      { id, reason: "a core-10 scenario (the test split)" },
    ]);
  });

  it("rejects f4_precursor_jul14, which is dev split but bound to the headline failure F4", () => {
    expect(tuningRejections(["f4_precursor_jul14"], ALL, HEADLINE)).toEqual([
      { id: "f4_precursor_jul14", reason: "bound to the headline failure F4" },
    ]);
  });

  it("rejects metropt3_full, a recording of every headline failure", () => {
    expect(tuningRejections(["metropt3_full"], ALL, HEADLINE)).toEqual([
      { id: "metropt3_full", reason: "a recording that replays every headline failure" },
    ]);
  });

  it("reads the failure table's in_headline flag rather than a fixed list of ids", () => {
    // F4b is a secondary positive, so the committed table keeps it out of the headline.
    expect(tuningRejections(["f4b_recurrence_jul17"], ALL, HEADLINE)).toEqual([]);
    const f4bHeadline = new Set(["F4b"]);
    expect(tuningRejections(["f4b_recurrence_jul17"], ALL, f4bHeadline)).toHaveLength(1);
    expect(tuningRejections(["f4_precursor_jul14"], ALL, f4bHeadline)).toEqual([]);
  });

  it("refuses a list that adds any of them with one ConfigError naming every id", () => {
    const ids = [...TUNING_SCENARIOS, "f3_air_leak_jun05", "f4_precursor_jul14", "metropt3_full"];
    const error = configError(() => selectTuning(ALL, HEADLINE, ids));
    expect(error.flag).toBe("--tuning");
    expect(error.exitCode).toBe(1);
    for (const id of ["f3_air_leak_jun05", "f4_precursor_jul14", "metropt3_full"]) {
      expect(error.message).toContain(id);
    }
    for (const id of TUNING_SCENARIOS) expect(error.message).not.toContain(`${id} (`);
  });

  it("refuses an id that names no scenario", () => {
    expect(tuningRejections(["no_such_scenario"], ALL, HEADLINE)).toEqual([
      { id: "no_such_scenario", reason: "no scenario of that name" },
    ]);
  });
});

describe("sharedSlices", () => {
  const shared = sharedSlices(selectTuning(ALL, HEADLINE), ALL);

  it("names exactly the four dev injections, which replay the core-10's baseline day", () => {
    expect(shared.map((entry) => entry.scenario)).toEqual(DEV_INJECTIONS);
    for (const entry of shared) {
      expect(entry.slice).toBe("baseline-feb03");
      expect(entry.core10).toEqual([
        "baseline_feb03_normal",
        "inject_air_leak_downstream",
        "inject_high_ambient_benign",
        "inject_oil_cooler_fouling",
        "inject_oil_temperature_sensor_fault",
      ]);
    }
  });

  it("leaves the leak's twin out: no core-10 scenario replays the summer slice", () => {
    expect(shared.map((entry) => entry.scenario)).not.toContain(LEAK_TWIN);
    expect(sharedSlices(selectTuning(ALL, HEADLINE, [LEAK_TWIN]), ALL)).toEqual([]);
  });

  it("reports them without refusing them (the dev/test split allows them)", () => {
    expect(tuningRejections(DEV_INJECTIONS, ALL, HEADLINE)).toEqual([]);
  });
});
