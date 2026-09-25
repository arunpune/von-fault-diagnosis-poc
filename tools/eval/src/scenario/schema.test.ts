// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The scenario schema, from both sides: every committed file goes through it,
// and seven documents that each break one rule of the scenario format are
// refused.
//
// The negative cases are built here rather than committed as fixtures. A broken
// scenario file under `scenarios/` would be picked up by `fdp-eval validate`
// and by the runner, so the only safe place for one is a temporary directory.
//
// Six of the seven are refused by the schema itself; the seventh — a replay
// range that does not move forward — is a rule JSON Schema cannot state, and
// `loadScenario` is what refuses it. Both paths end in the same
// `ScenarioError`, which is why the table below goes through the loader.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ScenarioError, loadScenario, scenarioFiles } from "./load.ts";
import { SCENARIO_SCHEMA_ID, validateScenario } from "./schema.ts";

/** A valid document to break in one place at a time. */
function valid(): Record<string, unknown> {
  return {
    schema: SCENARIO_SCHEMA_ID,
    id: "example_case",
    title: "An example",
    group: "negative",
    profiles: ["dev"],
    split: "dev",
    positive: false,
    source: { kind: "slice", name: "baseline-feb03" },
    replay: { from: "2020-02-03T00:00:00.000Z", to: "2020-02-04T00:00:00.000Z" },
    ground_truth: { kind: "negative" },
    expect: { tickets: "none", fault: "benign_or_none", pass_level: "detection" },
    seed: 7,
    notes: "An example document, valid until one rule is broken.",
  };
}

function broken(mutate: (document: Record<string, unknown>) => void): Record<string, unknown> {
  const document = valid();
  mutate(document);
  return document;
}

const directories: string[] = [];

/** Writes `document` as `<id>.json` in a fresh directory and returns the path. */
function asFile(document: Record<string, unknown>, stem = "example_case"): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-scenario-"));
  directories.push(directory);
  const path = join(directory, `${stem}.json`);
  writeFileSync(path, JSON.stringify(document, null, 2), "utf8");
  return path;
}

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe("the schema", () => {
  it("accepts a minimal valid document and fills its defaults", () => {
    const result = validateScenario(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warmup_min).toBe(60);
    expect(result.value.expect.max_false_tickets).toBe(0);
  });

  it.each([
    [
      "a bad id",
      broken((document) => {
        document["id"] = "F1";
      }),
    ],
    [
      "an unknown group",
      broken((document) => {
        document["group"] = "surprise";
      }),
    ],
    [
      "a replay range that does not move forward",
      broken((document) => {
        document["replay"] = { from: "2020-02-04T00:00:00.000Z", to: "2020-02-03T00:00:00.000Z" };
      }),
    ],
    [
      "an unknown ground-truth kind",
      broken((document) => {
        document["ground_truth"] = { kind: "guess" };
      }),
    ],
    [
      "an injection without an instant",
      broken((document) => {
        document["injections"] = [{ injection_id: "air_leak_downstream" }];
      }),
    ],
    [
      "an expect block without a pass level",
      broken((document) => {
        document["expect"] = { tickets: "none", fault: "benign_or_none" };
      }),
    ],
    [
      "an extra property",
      broken((document) => {
        document["hurry"] = true;
      }),
    ],
  ])("refuses %s", (_what, document) => {
    const path = asFile(document);
    expect(() => loadScenario(path)).toThrow(ScenarioError);
  });

  it("refuses a file whose stem is not its id", () => {
    const path = asFile(valid(), "another_name");
    expect(() => loadScenario(path)).toThrow(/declares id example_case/);
  });
});

describe("the design target", () => {
  /** A diagnostic dev scenario, the only kind that may carry a design target. */
  function diagnostic(target: unknown): Record<string, unknown> {
    return broken((document) => {
      document["group"] = "diagnostic";
      document["positive"] = true;
      document["ground_truth"] = { kind: "diagnostic", note: "an unlabelled episode" };
      document["expect"] = { tickets: "at_least_one", fault: "any", pass_level: "detection" };
      document["design_target"] = target;
    });
  }

  const TARGET = { accepted: ["dryer_purge_leak"], provenance: "inferred, unverified" };

  it("is an optional member a diagnostic dev scenario may carry", () => {
    expect(loadScenario(asFile(diagnostic(TARGET))).design_target).toEqual(TARGET);
    expect(loadScenario(asFile(valid())).design_target).toBeUndefined();
  });

  it.each([
    ["no accepted cause", { accepted: [], provenance: "inferred" }],
    ["no provenance", { accepted: ["dryer_purge_leak"] }],
    ["a cause that is not an identifier", { accepted: ["Dryer Purge"], provenance: "inferred" }],
    ["an extra member", { ...TARGET, window: "2020-05-19T22:22:17.000Z" }],
  ])("refuses a target with %s", (_what, target) => {
    expect(() => loadScenario(asFile(diagnostic(target)))).toThrow(ScenarioError);
  });

  it("is refused on a scenario that is scored, so no gate can read it", () => {
    const negative = broken((document) => {
      document["design_target"] = TARGET;
    });
    expect(() => loadScenario(asFile(negative))).toThrow(
      expect.objectContaining({ name: "ScenarioError", code: "ground_truth" }) as Error,
    );
    expect(() => loadScenario(asFile(negative))).toThrow(/only for a diagnostic scenario/);
  });

  it("is refused on a test-split scenario", () => {
    const test = broken((document) => {
      Object.assign(document, diagnostic(TARGET));
      document["split"] = "test";
      document["profiles"] = ["core"];
    });
    expect(() => loadScenario(asFile(test))).toThrow(
      /only for a diagnostic scenario of the dev split/,
    );
  });
});

describe("the committed scenarios", () => {
  const files = scenarioFiles();

  it("are the 21 original files, the leak's dev twin and the six held-out files", () => {
    // The twin joined the tuning list later; the held-out files are sealed
    // (tools/eval/records/heldout-seal.md).
    expect(files).toHaveLength(28);
  });

  it.each(files)("%s validates and loads", (file) => {
    const scenario = loadScenario(file);
    expect(scenario.schema).toBe(SCENARIO_SCHEMA_ID);
    expect(scenario.notes.length).toBeGreaterThan(40);
  });
});
