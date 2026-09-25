// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The held-out set against its seal (tools/eval/records/heldout-seal.md).
//
// The seal lists the sha256 of every held-out scenario file and of every
// held-out slice entry of data/fixtures/metropt3-slices.json. This test
// recomputes each one from the committed bytes. It fails when a held-out file
// or slice entry changes, and when one is added or removed without a new seal.
// A new seal is a deliberate decision, recorded in the seal file with its
// reason.
//
// It reads the files and the definitions only: it binds nothing, cuts nothing
// and replays nothing, so it runs in any checkout, without the dataset.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/backends/digest.ts";
import { HELDOUT_SEAL_FILE, isHeldout, isHeldoutSlice } from "../src/heldout.ts";
import { loadAll } from "../src/scenario/index.ts";
import { REPO_ROOT, SLICE_DEFINITIONS_FILE } from "../src/slices.ts";

/** The prefix a slice entry's line carries in the seal, beside the scenario files' paths. */
const ENTRY_PREFIX = "slice-entry:";

/** Where the committed scenario files live, relative to the repository root. */
const SCENARIOS_PATH = "tools/eval/scenarios/";

/** One `<sha256>  <name>` line of the seal's fenced blocks. */
const SEAL_LINE = /^([0-9a-f]{64}) {2}(\S+)$/;

const seal = readFileSync(join(REPO_ROOT, HELDOUT_SEAL_FILE), "utf8");

/** Every sealed name with its hash, in the order the seal lists them. */
const sealed: ReadonlyMap<string, string> = new Map(
  seal
    .split("\n")
    .map((line) => SEAL_LINE.exec(line))
    .flatMap((match) => (match === null ? [] : [[match[2] ?? "", match[1] ?? ""] as const])),
);

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface SliceEntry {
  readonly name: string;
}

const definitions = JSON.parse(readFileSync(join(REPO_ROOT, SLICE_DEFINITIONS_FILE), "utf8")) as {
  readonly slices: readonly SliceEntry[];
};

const heldoutScenarios = loadAll().filter(isHeldout);
const heldoutEntries = definitions.slices.filter((entry) => isHeldoutSlice(entry.name));

describe("the held-out set against tools/eval/records/heldout-seal.md", () => {
  it("states the one-run rule", () => {
    expect(seal.replace(/\s+/g, " ").toLowerCase()).toContain(
      "the held-out set runs once, after the jev thresholds are fixed under the pre-registration",
    );
  });

  it("seals exactly the committed held-out scenario files", () => {
    const files = [...sealed.keys()].filter((name) => name.startsWith(SCENARIOS_PATH)).sort();
    expect(files).toEqual(
      heldoutScenarios.map((scenario) => `${SCENARIOS_PATH}${scenario.id}.json`).sort(),
    );
    expect(files).toHaveLength(6);
  });

  it.each(heldoutScenarios.map((scenario) => scenario.id))("%s matches its seal", (id) => {
    const path = `${SCENARIOS_PATH}${id}.json`;
    expect(sha256(readFileSync(join(REPO_ROOT, path)))).toBe(sealed.get(path));
  });

  it("seals exactly the held-out slice entries of the definitions", () => {
    const entries = [...sealed.keys()]
      .filter((name) => name.startsWith(ENTRY_PREFIX))
      .map((name) => name.slice(ENTRY_PREFIX.length))
      .sort();
    expect(entries).toEqual(heldoutEntries.map((entry) => entry.name).sort());
    expect(entries).toHaveLength(6);
  });

  it.each(heldoutEntries.map((entry) => [entry.name, entry] as const))(
    "the %s entry matches its seal",
    (name, entry) => {
      expect(sha256(canonicalJson(entry))).toBe(sealed.get(`${ENTRY_PREFIX}${name}`));
    },
  );

  it("gives every held-out slice to exactly one held-out scenario", () => {
    const replayed = heldoutScenarios.map((scenario) =>
      scenario.source.kind === "slice" ? scenario.source.name : "",
    );
    expect(replayed.sort()).toEqual(heldoutEntries.map((entry) => entry.name).sort());
  });

  it("holds four positives on four injection definitions and two negatives", () => {
    const positives = heldoutScenarios.filter((scenario) => scenario.positive);
    expect(positives).toHaveLength(4);
    expect(
      new Set(positives.flatMap((scenario) => scenario.injections ?? []).map((i) => i.injection_id))
        .size,
    ).toBe(4);
    expect(heldoutScenarios.filter((scenario) => !scenario.positive)).toHaveLength(2);
  });
});
