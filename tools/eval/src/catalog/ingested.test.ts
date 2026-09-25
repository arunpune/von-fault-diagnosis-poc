// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The ingested catalog source over a fake connection.
//
// The rows the fake answers with are the reference catalog's own: its entries
// as `app.v_catalog_entries` would return them and its condition table as
// `app.catalog_conditions` stores it (`symptom`, `symptoms[]`). Reading them
// back must give the entries and the `EvalCondition` list the `reference`
// source gives for the same document, which is what lets an ablation compare
// the two sources on the catalog alone. The real database, the eval role and
// the view are `test/integration/stack-score.test.ts`.

import { readFileSync } from "node:fs";

import type pg from "pg";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_DOCUMENT_SQL,
  CONDITIONS_SQL,
  ENTRIES_SQL,
  canonicalJson,
  catalogSha256,
  conditionSentences,
  readIngestedCatalog,
} from "./ingested.ts";
import type { Queryable } from "./ingested.ts";
import { REFERENCE_CATALOG_PATH, loadReferenceCatalog } from "./reference.ts";
import type { CatalogEntry } from "./types.ts";

/** What one fake database holds, statement by statement. */
interface FakeRows {
  readonly document?: { id: string; name: string; sha256: string };
  readonly entries?: readonly { fault_id: string; entry: unknown }[];
  readonly conditions?: readonly {
    condition_id: string;
    title: string;
    symptom: string | null;
    symptoms: string[] | null;
  }[];
}

/** A connection that answers the loader's three statements and records what it was asked. */
function fakeDb(rows: FakeRows): Queryable & { readonly asked: string[] } {
  const asked: string[] = [];
  const answer = (text: string): readonly unknown[] => {
    if (text === ACTIVE_DOCUMENT_SQL) return rows.document === undefined ? [] : [rows.document];
    if (text === ENTRIES_SQL) return rows.entries ?? [];
    if (text === CONDITIONS_SQL) return rows.conditions ?? [];
    throw new Error(`unexpected statement: ${text}`);
  };
  return {
    asked,
    query<R extends pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>> {
      asked.push(text);
      return Promise.resolve({ rows: answer(text) } as unknown as pg.QueryResult<R>);
    },
  };
}

const DOCUMENT = { id: "7", name: "cau-7-realistic.pdf", sha256: "a".repeat(64) };

interface ReferenceCondition {
  readonly id: string;
  readonly title: string;
  readonly symptom?: string;
  readonly symptoms?: string[];
}

/** The reference catalog's condition table, as init would have stored it. */
function referenceConditionRows(): FakeRows["conditions"] {
  const document = JSON.parse(readFileSync(REFERENCE_CATALOG_PATH, "utf8")) as {
    conditions: ReferenceCondition[];
  };
  return document.conditions.map((condition) => ({
    condition_id: condition.id,
    title: condition.title,
    symptom: condition.symptom ?? null,
    symptoms: condition.symptoms ?? [],
  }));
}

describe("readIngestedCatalog", () => {
  const reference = loadReferenceCatalog();

  it("gives the reference source's entries and conditions for the reference rows", async () => {
    const db = fakeDb({
      document: DOCUMENT,
      entries: reference.entries.map((entry) => ({ fault_id: entry.fault_id, entry })),
      conditions: referenceConditionRows(),
    });
    const catalog = await readIngestedCatalog(db);

    expect(catalog.source).toBe("ingested");
    expect(catalog.document).toEqual({ name: DOCUMENT.name, sha256: DOCUMENT.sha256 });
    expect(catalog.invalid).toEqual([]);
    expect(catalog.entries).toEqual(reference.entries);
    const byId = (left: { condition_id: string }, right: { condition_id: string }) =>
      left.condition_id.localeCompare(right.condition_id);
    expect([...catalog.conditions].sort(byId)).toEqual([...reference.conditionTable].sort(byId));
    expect(catalog.conditions.every((condition) => condition.symptoms.length > 0)).toBe(true);
    expect(db.asked).toEqual([ACTIVE_DOCUMENT_SQL, ENTRIES_SQL, CONDITIONS_SQL]);
  });

  it("reads a condition's symptom first, then its further wordings, blanks and repeats dropped", async () => {
    const catalog = await readIngestedCatalog(
      fakeDb({
        document: DOCUMENT,
        conditions: [
          {
            condition_id: "oil_temperature_high",
            title: "Oil temperature high",
            symptom: " The oil runs hot under load. ",
            symptoms: ["", "The oil runs hot under load.", "The cooler outlet is warm."],
          },
          { condition_id: "no_symptom", title: "Quiet", symptom: null, symptoms: null },
        ],
      }),
    );
    expect(catalog.conditions).toEqual([
      {
        condition_id: "oil_temperature_high",
        title: "Oil temperature high",
        symptoms: ["The oil runs hot under load.", "The cooler outlet is warm."],
      },
      { condition_id: "no_symptom", title: "Quiet", symptoms: [] },
    ]);
  });

  it("drops a row that is not a catalog-entry and names it, as the backend does", async () => {
    const [first] = reference.entries;
    if (first === undefined) throw new Error("the reference catalog has no entry");
    const catalog = await readIngestedCatalog(
      fakeDb({
        document: DOCUMENT,
        entries: [
          { fault_id: first.fault_id, entry: first },
          { fault_id: "mangled", entry: { fault_id: "mangled" } },
        ],
      }),
    );
    expect(catalog.entries).toEqual([first]);
    expect(catalog.invalid.map((entry) => entry.fault_id)).toEqual(["mangled"]);
    expect(catalog.invalid[0]?.issues.length).toBeGreaterThan(0);
  });

  it("is empty, with no document, when no ingest run has succeeded", async () => {
    const db = fakeDb({});
    const catalog = await readIngestedCatalog(db);
    expect(catalog).toMatchObject({ entries: [], conditions: [], document: null, invalid: [] });
    expect(catalog.sha256).toBe(catalogSha256([]));
    expect(db.asked).toEqual([ACTIVE_DOCUMENT_SQL]);
  });

  it("only ever reads", () => {
    for (const statement of [ACTIVE_DOCUMENT_SQL, ENTRIES_SQL, CONDITIONS_SQL]) {
      expect(statement.trim()).toMatch(/^SELECT\b/);
      expect(statement).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
    }
  });
});

describe("the ingested catalog's digest", () => {
  const entries = loadReferenceCatalog().entries;

  it("does not depend on the order the rows came in or on the order of an entry's keys", () => {
    const reversed = [...entries].reverse();
    const reordered = entries.map(
      (entry) => Object.fromEntries(Object.entries(entry).reverse()) as unknown as CatalogEntry,
    );
    expect(catalogSha256(reversed)).toBe(catalogSha256(entries));
    expect(catalogSha256(reordered)).toBe(catalogSha256(entries));
    expect(catalogSha256(entries)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when an entry does", () => {
    const [first, ...rest] = entries;
    if (first === undefined) throw new Error("the reference catalog has no entry");
    const renamed = { ...first, name: `${first.name} (edited)` };
    expect(catalogSha256([renamed, ...rest])).not.toBe(catalogSha256(entries));
  });

  it("writes canonical JSON: sorted keys, no whitespace, undefined members left out", () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: "x", c: undefined }] })).toBe(
      '{"a":[true,null,{"d":"x"}],"b":1}',
    );
  });
});

describe("conditionSentences", () => {
  it("puts the symptom first and keeps the first spelling of a repeat", () => {
    expect(conditionSentences("One.", ["Two.", "One.", "  "])).toEqual(["One.", "Two."]);
    expect(conditionSentences(undefined, undefined)).toEqual([]);
  });
});
