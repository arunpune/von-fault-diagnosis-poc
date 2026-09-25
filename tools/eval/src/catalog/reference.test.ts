// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The reference-catalog loader, on both document shapes.
//
// The committed mini fixture is the legacy shape, an early sketch where the
// symptom table is separate and a cause points at it by id: it is there so that
// the (cause, condition) expansion has a test that does not depend on
// `make manual` having run. The real `fixtures/catalog.json` is the contracts
// `catalog` document `make manual` writes, whose causes already are catalog
// entries; when it is present on the machine it is checked too, because E1 asks
// for exactly that and a locally regenerated manual must not quietly break it.

import { describe, expect, it } from "vitest";

import {
  MINI_CATALOG_PATH,
  REFERENCE_CATALOG_PATH,
  byFaultId,
  loadReferenceCatalog,
  referenceCatalogExists,
} from "./reference.ts";
import { CatalogError, DIRECTION_MAP, DIRECTIONS, SUBSYSTEMS } from "./types.ts";
import type { CatalogEntry } from "./types.ts";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const directories: string[] = [];

/** Writes a document to a throwaway file and returns its path. */
function asFile(document: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-catalog-"));
  directories.push(directory);
  const path = join(directory, "catalog.json");
  writeFileSync(path, JSON.stringify(document), "utf8");
  return path;
}

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function everyDirection(entries: readonly CatalogEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.signal_moves.map((move) => move.direction)))];
}

describe("the mini fixture (the legacy shape)", () => {
  const catalog = loadReferenceCatalog(MINI_CATALOG_PATH);

  it("is read as the pdf shape and keeps its digest", () => {
    expect(catalog.shape).toBe("pdf");
    expect(catalog.source).toBe("reference");
    expect(catalog.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(catalog.conditions).toBe(4);
  });

  it("emits one entry per (cause, condition) pair", () => {
    // Six causes over eleven pairs: two leaks with two conditions each, two benign causes with
    // one and two, the cooler with one and the sensor fault with one.
    expect(byFaultId(catalog.entries).size).toBe(6);
    expect(catalog.entries.length).toBeGreaterThan(6);
    for (const entry of catalog.entries) {
      expect(entry.conditions).toHaveLength(1);
    }
  });

  it("covers both leak signatures, the cooler, the two benign causes and the sensor fault", () => {
    expect([...byFaultId(catalog.entries).keys()].sort()).toEqual([
      "downstream_air_leak",
      "dryer_purge_leak",
      "high_air_demand",
      "high_ambient_temperature",
      "oil_cooler_fouled",
      "oil_temperature_sensor_fault",
    ]);
    const benign = [...byFaultId(catalog.entries).values()].filter((entry) => entry.benign);
    expect(benign.map((entry) => entry.fault_id).sort()).toEqual([
      "high_air_demand",
      "high_ambient_temperature",
    ]);
  });

  it("carries the condition title, the alarms and the manual page across", () => {
    const leak = catalog.entries.find(
      (entry) =>
        entry.fault_id === "downstream_air_leak" &&
        entry.conditions[0].condition_id === "low_line_pressure",
    );
    expect(leak?.conditions[0].title).toBe("Line pressure below setpoint");
    expect(leak?.conditions[0].alarms).toEqual(["W101"]);
    expect(leak?.related_alarms).toContain("W101");
    expect(leak?.manual_ref).toEqual({ section: "8.3", page_start: 27 });
    expect(leak?.name).toBe("Leak in the distribution network");
    expect(leak?.source).toBe("yaml");
  });

  it("uses only mapped directions and declared subsystems", () => {
    for (const direction of everyDirection(catalog.entries)) {
      expect(DIRECTION_MAP[direction]).toBe(direction);
    }
    for (const entry of catalog.entries) {
      expect(SUBSYSTEMS).toContain(entry.subsystem);
    }
  });
});

describe("the reference catalog (the contracts shape)", () => {
  const present = referenceCatalogExists();

  it.skipIf(!present)("maps every cause to a contracts-valid entry", () => {
    const catalog = loadReferenceCatalog();
    expect(catalog.shape).toBe("pdf");
    expect(catalog.entries.length).toBeGreaterThan(0);
    expect(byFaultId(catalog.entries).size).toBe(catalog.entries.length);
    for (const entry of catalog.entries) {
      expect(entry.signal_moves.length).toBeGreaterThan(0);
      expect(SUBSYSTEMS).toContain(entry.subsystem);
    }
  });

  it.skipIf(!present)("uses no direction word outside the vocabulary", () => {
    const words = everyDirection(loadReferenceCatalog().entries);
    expect(words.length).toBeGreaterThan(0);
    expect(words.filter((word) => !(DIRECTIONS as readonly string[]).includes(word))).toEqual([]);
  });

  it.skipIf(!present)("reads a bare entries[] list the same way", () => {
    const entries = loadReferenceCatalog().entries.slice(0, 3);
    const catalog = loadReferenceCatalog(asFile({ entries }));
    expect(catalog.shape).toBe("contracts");
    expect(catalog.entries.map((entry) => entry.fault_id)).toEqual(
      entries.map((entry) => entry.fault_id),
    );
  });
});

describe("the condition table the retrieval query reads", () => {
  const present = referenceCatalogExists();

  it("reads the legacy shape's symptoms[]", () => {
    const catalog = loadReferenceCatalog(MINI_CATALOG_PATH);
    expect(catalog.conditionTable).toHaveLength(catalog.conditions);
    expect(catalog.conditionTable[0]).toEqual({
      condition_id: "low_line_pressure",
      title: "Line pressure below setpoint",
      symptoms: ["The line never reaches the cut-out pressure.", "Tools downstream run slowly."],
    });
    for (const condition of catalog.conditionTable) {
      expect(condition.symptoms.length).toBeGreaterThan(0);
    }
  });

  it.skipIf(!present)("reads the contracts document's one-sentence symptom", () => {
    const catalog = loadReferenceCatalog();
    expect(catalog.conditionTable.length).toBeGreaterThan(0);
    expect(catalog.conditionTable).toHaveLength(catalog.conditions);
    for (const condition of catalog.conditionTable) {
      expect(condition.title).not.toBe("");
      expect(condition.symptoms).toHaveLength(1);
    }
    const named = new Set(catalog.conditionTable.map((condition) => condition.condition_id));
    for (const entry of catalog.entries) {
      for (const condition of entry.conditions) expect(named).toContain(condition.condition_id);
    }
  });

  it("puts `symptom` first, then `symptoms[]`, without blanks or repeats", () => {
    const document = JSON.parse(readFileSync(MINI_CATALOG_PATH, "utf8")) as {
      conditions: { symptom?: string; symptoms: string[] }[];
    };
    const first = document.conditions[0];
    if (first === undefined) throw new Error("the mini fixture declares no condition");
    first.symptom = " The pressure never recovers. ";
    first.symptoms = ["The pressure never recovers.", "", ...first.symptoms];

    const [condition] = loadReferenceCatalog(asFile(document)).conditionTable;
    expect(condition?.symptoms).toEqual([
      "The pressure never recovers.",
      "The line never reaches the cut-out pressure.",
      "Tools downstream run slowly.",
    ]);
  });

  it.skipIf(!present)("has no table for a bare entries[] list", () => {
    const entries = loadReferenceCatalog().entries.slice(0, 3);
    const catalog = loadReferenceCatalog(asFile({ entries }));
    expect(catalog.conditionTable).toEqual([]);
    expect(catalog.conditions).toBe(0);
  });
});

/** One cause of the mini fixture, as a mutable object the rejection tests break. */
interface MiniCause {
  fault_id: string;
  subsystem: string;
  conditions: string[];
  signal_moves: { direction: string }[];
}

/** The mini fixture, parsed fresh so that one test's damage never reaches the next. */
function miniCauses(): { causes: MiniCause[] } {
  const document = JSON.parse(readFileSync(MINI_CATALOG_PATH, "utf8")) as { causes: MiniCause[] };
  expect(document.causes.length).toBeGreaterThan(1);
  return document;
}

/** The `index`-th cause, with the index checked rather than assumed. */
function cause(document: { causes: MiniCause[] }, index: number): MiniCause {
  const found = document.causes[index];
  if (found === undefined) throw new Error(`the mini fixture has no cause #${String(index)}`);
  return found;
}

describe("rejections", () => {
  it("names every unmapped direction word and the cause that used it", () => {
    const document = miniCauses();
    const [first, second] = [cause(document, 0), cause(document, 1)];
    const firstMove = first.signal_moves[0];
    const secondMove = second.signal_moves[0];
    if (firstMove === undefined || secondMove === undefined) throw new Error("no signal moves");
    firstMove.direction = "wobbles";
    secondMove.direction = "creeps";

    try {
      loadReferenceCatalog(asFile(document));
      expect.unreachable("loadReferenceCatalog should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogError);
      expect((error as CatalogError).unmapped).toEqual([
        { fault_id: "downstream_air_leak", direction: "wobbles" },
        { fault_id: "dryer_purge_leak", direction: "creeps" },
      ]);
      expect((error as CatalogError).message).toContain("wobbles");
    }
  });

  it("refuses a cause that names a condition the document does not declare", () => {
    const document = miniCauses();
    cause(document, 0).conditions = ["no_such_condition"];
    expect(() => loadReferenceCatalog(asFile(document))).toThrow(/no_such_condition/);
  });

  it("refuses a cause with a subsystem outside the ten", () => {
    const document = miniCauses();
    cause(document, 0).subsystem = "downstream";
    expect(() => loadReferenceCatalog(asFile(document))).toThrow(/downstream_air_leak/);
  });

  it("refuses a document with neither entries[] nor causes[]", () => {
    expect(() => loadReferenceCatalog(asFile({ schema: "urn:fdp:schema:catalog:v1" }))).toThrow(
      CatalogError,
    );
  });

  it("refuses a file that is not there", () => {
    expect(() => loadReferenceCatalog(join(tmpdir(), "fdp-no-such-catalog.json"))).toThrow(
      CatalogError,
    );
  });
});

describe("the vocabulary", () => {
  it("maps every word of the contracts enum to itself", () => {
    for (const word of DIRECTIONS) expect(DIRECTION_MAP[word]).toBe(word);
    expect(Object.keys(DIRECTION_MAP)).toHaveLength(DIRECTIONS.length);
  });

  it("has no up/down/flat/erratic/missing vocabulary, which the contracts never had", () => {
    for (const absent of ["up", "down", "flat", "erratic", "missing", "cycling_faster"]) {
      expect(DIRECTION_MAP[absent]).toBeUndefined();
    }
  });

  it("points at the committed reference document", () => {
    expect(REFERENCE_CATALOG_PATH.endsWith("/fixtures/catalog.json")).toBe(true);
  });
});
