// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The read-only catalog repository of the dashboard routes: the causes come
// from retrieval's loader (one active document, one cache), the normal bands
// from `app.catalog_signals` of that same document, through a parameterised
// statement. The statements run against the real schema in the retrieval and
// persistence integration tests; here the pool is a double.

import type { CatalogEntry } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { fakePool } from "../persistence/fake-pool.test-helper.ts";
import { catalogFromEntries, type Catalog, type CatalogLoader } from "../retrieval/catalog.ts";
import { contract } from "./fake-deps.test-helper.ts";
import { createCatalogRepo } from "./repo-catalog.ts";

const ENTRIES = [
  contract<CatalogEntry>("catalog-entry", "valid-benign-high-ambient.json"),
  contract<CatalogEntry>("catalog-entry", "valid-downstream-air-leak.json"),
];

/** A loader answering one fixed catalog, counting its calls. */
function loaderOf(catalog: Catalog): CatalogLoader & { calls: number } {
  const loader = {
    calls: 0,
    async load() {
      loader.calls += 1;
      return catalog;
    },
  };
  return loader;
}

const ACTIVE: Catalog = { ...catalogFromEntries(ENTRIES), documentId: 7 };

describe("createCatalogRepo", () => {
  it("answers the loader's entries, in fault_id order, and finds one by fault_id", async () => {
    const loader = loaderOf(ACTIVE);
    const repo = createCatalogRepo({ db: fakePool().pool, loader });

    const faults = await repo.faults();
    expect(faults.map((entry) => entry.fault_id)).toEqual([
      "downstream_air_leak",
      "high_ambient_temperature",
    ]);
    expect((await repo.fault("downstream_air_leak"))?.fault_id).toBe("downstream_air_leak");
    expect(await repo.fault("no_such_cause")).toBeUndefined();
    expect(loader.calls).toBe(3);
  });

  it("reads the bands of the active document, dropping the empty ones", async () => {
    const db = fakePool(() => ({
      rows: [
        { signal_id: "line_pressure", normal_bands: { loaded: [8.4, 9.8] } },
        { signal_id: "load_valve", normal_bands: {} },
        { signal_id: "oil_temperature", normal_bands: null },
      ],
    }));
    const repo = createCatalogRepo({ db: db.pool, loader: loaderOf(ACTIVE) });

    const bands = await repo.normalBands();
    expect([...bands.entries()]).toEqual([["line_pressure", { loaded: [8.4, 9.8] }]]);
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]?.text).toContain("FROM app.catalog_signals WHERE document_id = $1");
    expect(db.statements[0]?.params).toEqual([7]);
  });

  it("answers no bands and runs no statement before init has ingested a manual", async () => {
    const db = fakePool();
    const repo = createCatalogRepo({ db: db.pool, loader: loaderOf(catalogFromEntries([])) });
    expect((await repo.normalBands()).size).toBe(0);
    expect(await repo.faults()).toEqual([]);
    expect(db.statements).toEqual([]);
  });
});
