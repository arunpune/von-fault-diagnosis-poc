// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading the catalog, and caching it.
 *
 * The statements themselves run against the real schema in
 * `test/integration/retrieval.test.ts`; this file answers them from a fake
 * `Queryable` so it can pin what the loader does with the rows — which
 * document it reads, what it drops, what it keeps for the query builder — and
 * how the 60-second cache behaves under a burst, a refresh and a failure.
 */

import { ALARMS, type CatalogEntry } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import type { Queryable } from "../db/pool.ts";
import { FIXTURE_CATALOG, catalogEntry } from "../../test/fixtures/catalog/index.ts";
import {
  CATALOG_CACHE_TTL_MS,
  EMPTY_CATALOG,
  catalogFromEntries,
  compareIds,
  conditionSymptoms,
  createCachedCatalogLoader,
  loadCatalog,
  type ConditionText,
} from "./catalog.ts";

/** The rows one fake database answers with, by the table a statement reads. */
interface FakeTables {
  activeDocument?: number | string;
  entries?: { fault_id: string; entry: unknown }[];
  conditions?: {
    condition_id: string;
    title: string;
    symptom?: string | null;
    symptoms: string[] | null;
    alarm_codes: string[] | null;
  }[];
  alarms?: { code: string; title: string }[];
}

/** A queryable that answers each of the four statements and counts them. */
function fakeDb(tables: FakeTables): Queryable & { statements: string[]; params: unknown[][] } {
  const statements: string[] = [];
  const params: unknown[][] = [];
  function rowsFor(text: string): unknown[] {
    if (text.includes("app.ingest_runs")) {
      return tables.activeDocument === undefined ? [] : [{ document_id: tables.activeDocument }];
    }
    if (text.includes("app.v_catalog_entries")) return tables.entries ?? [];
    if (text.includes("app.catalog_conditions")) return tables.conditions ?? [];
    if (text.includes("app.catalog_alarms")) return tables.alarms ?? [];
    throw new Error(`unexpected statement: ${text}`);
  }
  return {
    statements,
    params,
    query(text: string, values: unknown[] = []) {
      statements.push(text);
      params.push(values);
      const rows = rowsFor(text);
      return Promise.resolve({
        rows,
        command: "",
        rowCount: rows.length,
        oid: 0,
        fields: [],
      } as never);
    },
  };
}

function entryRows(entries: readonly CatalogEntry[]): { fault_id: string; entry: unknown }[] {
  return entries.map((entry) => ({ fault_id: entry.fault_id, entry }));
}

describe("loadCatalog", () => {
  it("reads nothing more once no ingest run has succeeded", async () => {
    const db = fakeDb({});
    await expect(loadCatalog(db)).resolves.toBe(EMPTY_CATALOG);
    expect(db.statements).toHaveLength(1);
  });

  it("reads the active document's entries, conditions and alarm titles", async () => {
    const db = fakeDb({
      activeDocument: "7",
      entries: entryRows(FIXTURE_CATALOG),
      conditions: [
        {
          condition_id: "continuous_load",
          title: "Compressor stays loaded and does not reach cut-out",
          symptoms: ["The unit runs loaded without pause.", "Line pressure never reaches cut-out."],
          alarm_codes: ["W102"],
        },
        {
          condition_id: "water_in_air",
          title: "Water in the delivered air",
          symptoms: null,
          alarm_codes: null,
        },
      ],
      alarms: [{ code: "W102", title: "Continuous load time exceeded" }],
    });

    const catalog = await loadCatalog(db);

    expect(catalog.documentId).toBe(7);
    expect(catalog.entries.map((entry) => entry.fault_id)).toEqual(
      FIXTURE_CATALOG.map((entry) => entry.fault_id),
    );
    expect(catalog.invalid).toEqual([]);
    expect(catalog.conditions.get("continuous_load")?.symptoms).toEqual([
      "The unit runs loaded without pause.",
      "Line pressure never reaches cut-out.",
    ]);
    expect(catalog.conditions.get("water_in_air")).toEqual({
      condition_id: "water_in_air",
      title: "Water in the delivered air",
      symptoms: [],
      alarm_codes: [],
    });
    expect(catalog.alarmTitles.get("W102")).toBe("Continuous load time exceeded");
    // Every statement after the first is scoped to the active document.
    expect(db.params.slice(1)).toEqual([[7], [7], [7]]);
  });

  it("reads a condition's symptom sentence ahead of its further wordings", async () => {
    const db = fakeDb({
      activeDocument: 2,
      entries: entryRows(FIXTURE_CATALOG),
      conditions: [
        {
          condition_id: "oil_temperature_high",
          title: "Oil temperature high",
          symptom: "The cooling air leaving the unit is warm.",
          symptoms: [
            "The cooler outlet is hot to the touch.",
            "The cooling air leaving the unit is warm.",
          ],
          alarm_codes: ["W104"],
        },
        {
          condition_id: "continuous_load",
          title: "Compressor stays loaded and does not reach cut-out",
          symptom: "The unit runs loaded without pause.",
          symptoms: null,
          alarm_codes: ["W102"],
        },
      ],
    });

    const catalog = await loadCatalog(db);

    expect(db.statements.find((text) => text.includes("app.catalog_conditions"))).toContain(
      "c.symptom,",
    );
    expect(catalog.conditions.get("oil_temperature_high")?.symptoms).toEqual([
      "The cooling air leaving the unit is warm.",
      "The cooler outlet is hot to the touch.",
    ]);
    expect(catalog.conditions.get("continuous_load")?.symptoms).toEqual([
      "The unit runs loaded without pause.",
    ]);
  });

  it("drops an entry that does not validate and reports why", async () => {
    const broken = { ...catalogEntry("oil_level_low"), subsystem: "hydraulics" };
    const db = fakeDb({
      activeDocument: 3,
      entries: [
        ...entryRows([catalogEntry("oil_cooler_fouled")]),
        { fault_id: "oil_level_low", entry: broken },
      ],
    });

    const catalog = await loadCatalog(db);

    expect(catalog.entries.map((entry) => entry.fault_id)).toEqual(["oil_cooler_fouled"]);
    expect(catalog.invalid).toHaveLength(1);
    expect(catalog.invalid[0]?.fault_id).toBe("oil_level_low");
    expect(catalog.invalid[0]?.issues.join(" ")).toMatch(/subsystem/);
  });
});

describe("catalogFromEntries", () => {
  const catalog = catalogFromEntries([...FIXTURE_CATALOG].reverse());

  it("orders the entries by fault_id, whatever order they came in", () => {
    const ids = catalog.entries.map((entry) => entry.fault_id);
    expect(ids).toEqual([...ids].sort(compareIds));
    expect(ids).toHaveLength(FIXTURE_CATALOG.length);
  });

  it("recovers every condition the entries list, with the union of their alarm codes", () => {
    const lowLine = catalog.conditions.get("low_line_pressure");
    expect(lowLine?.title).toBe("Line pressure below setpoint");
    expect(lowLine?.alarm_codes).toEqual(["S305", "W101"]);
    expect(lowLine?.symptoms).toEqual([]);
    expect(catalog.conditions.has("oil_temperature_high")).toBe(true);
  });

  it("names the controller alarms from the contracts registry", () => {
    expect(catalog.alarmTitles.get("W103")).toBe("Dryer purge pressure high");
    expect(catalogFromEntries(FIXTURE_CATALOG, []).alarmTitles.size).toBe(0);
  });
});

describe("catalogFromEntries with the document's conditions", () => {
  const conditions: readonly ConditionText[] = [
    {
      condition_id: "low_line_pressure",
      title: "Line pressure below setpoint",
      symptoms: ["Consumers downstream lose pressure.", " ", "Consumers downstream lose pressure."],
    },
    { condition_id: "oil_temperature_high", title: "", symptoms: ["The cooler outlet is hot."] },
    {
      condition_id: "no_flow_signal",
      title: "Flow signal missing",
      symptoms: ["No flow pulse reaches the controller."],
    },
  ];
  const catalog = catalogFromEntries(FIXTURE_CATALOG, ALARMS, conditions);

  it("keeps the symptom sentences, blanks and repeats dropped", () => {
    expect(catalog.conditions.get("low_line_pressure")?.symptoms).toEqual([
      "Consumers downstream lose pressure.",
    ]);
    expect(catalog.conditions.get("oil_temperature_high")?.symptoms).toEqual([
      "The cooler outlet is hot.",
    ]);
  });

  it("keeps the alarm codes the entries list, and their title when the document's is blank", () => {
    const lowLine = catalog.conditions.get("low_line_pressure");
    expect(lowLine?.alarm_codes).toEqual(["S305", "W101"]);
    expect(lowLine?.title).toBe("Line pressure below setpoint");
    const oil = catalog.conditions.get("oil_temperature_high");
    expect(oil?.title).toBe(
      FIXTURE_CATALOG.flatMap((entry) => entry.conditions).find(
        (condition) => condition.condition_id === "oil_temperature_high",
      )?.title,
    );
  });

  it("adds a condition no entry names, so an event keyed on it still reads its words", () => {
    expect(catalog.conditions.get("no_flow_signal")).toEqual({
      condition_id: "no_flow_signal",
      title: "Flow signal missing",
      symptoms: ["No flow pulse reaches the controller."],
      alarm_codes: [],
    });
  });

  it("leaves every condition without sentences when no list is given", () => {
    const bare = catalogFromEntries(FIXTURE_CATALOG);
    for (const condition of bare.conditions.values()) expect(condition.symptoms).toEqual([]);
    expect(bare.conditions.size).toBe(
      catalogFromEntries(FIXTURE_CATALOG, ALARMS, []).conditions.size,
    );
  });
});

describe("conditionSymptoms", () => {
  it("puts the one-sentence symptom first and drops blanks and repeats", () => {
    expect(
      conditionSymptoms(" The unit runs hot. ", ["It smells of oil.", "The unit runs hot."]),
    ).toEqual(["The unit runs hot.", "It smells of oil."]);
    expect(conditionSymptoms(null, null)).toEqual([]);
    expect(conditionSymptoms(undefined, ["", "Only this."])).toEqual(["Only this."]);
  });
});

describe("compareIds", () => {
  it("orders by code unit, the tie-breaker of every ordering in retrieval", () => {
    expect(["b", "a_b", "a"].sort(compareIds)).toEqual(["a", "a_b", "b"]);
    expect(compareIds("x", "x")).toBe(0);
  });
});

describe("createCachedCatalogLoader", () => {
  function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
    let current = start;
    return { now: () => current, advance: (ms) => (current += ms) };
  }

  const tables: FakeTables = {
    activeDocument: 1,
    entries: entryRows([catalogEntry("dryer_purge_leak")]),
  };

  it("reads the tables once per minute", async () => {
    const db = fakeDb(tables);
    const time = clock();
    const loader = createCachedCatalogLoader({ db, now: time.now });

    const first = await loader.load();
    time.advance(CATALOG_CACHE_TTL_MS - 1);
    expect(await loader.load()).toBe(first);
    expect(db.statements).toHaveLength(4);

    time.advance(1);
    const second = await loader.load();
    expect(second).not.toBe(first);
    expect(db.statements).toHaveLength(8);
  });

  it("lets a burst of callers share one read", async () => {
    const db = fakeDb(tables);
    const loader = createCachedCatalogLoader({ db, now: clock().now });
    const loads = await Promise.all([loader.load(), loader.load(), loader.load()]);
    expect(new Set(loads).size).toBe(1);
    expect(db.statements).toHaveLength(4);
  });

  it("does not cache a failure, and keeps the last catalog when a refresh fails", async () => {
    let failing = true;
    const healthy = fakeDb(tables);
    const db: Queryable = {
      query(text: string, values?: unknown[]) {
        if (failing) return Promise.reject(new Error("connection refused"));
        return healthy.query(text, values);
      },
    };
    const time = clock();
    const loader = createCachedCatalogLoader({ db, now: time.now });

    await expect(loader.load()).rejects.toThrow("connection refused");

    failing = false;
    const loaded = await loader.load();
    expect(loaded.entries).toHaveLength(1);

    failing = true;
    time.advance(CATALOG_CACHE_TTL_MS);
    await expect(loader.load()).resolves.toBe(loaded);
  });
});
