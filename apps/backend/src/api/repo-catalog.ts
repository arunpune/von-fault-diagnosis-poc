// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The fault catalog, read only, for `GET /api/catalog/faults` and the normal
 * bands of `GET /api/signals`.
 *
 * The causes come from `app.v_catalog_entries` through retrieval's loader
 * (`retrieval/catalog.ts`), so the decision sheet expands exactly the entry the
 * decision backend was shown: the same active document, the same validation
 * against `catalog-entry`, the same 60-second cache. The runtime passes the
 * loader its retriever already holds, and the two share one read.
 *
 * The bands come from `app.catalog_signals` of that same document. A band is
 * whatever shape the manual declares (an interval per machine state for an
 * analog signal, a level for a digital one), so it is passed through as an
 * object; the empty object the column defaults to means "no band" and is left
 * out.
 */

import type { CatalogEntry } from "@fdp/contracts";

import { query, type Queryable } from "../db/pool.ts";
import { createCachedCatalogLoader, type CatalogLoader } from "../retrieval/catalog.ts";
import type { CatalogReader } from "./deps.ts";

/** The declared bands of one document, one row per signal. */
const NORMAL_BANDS_SQL = `
SELECT signal_id, normal_bands
  FROM app.catalog_signals
 WHERE document_id = $1
 ORDER BY signal_id`;

type BandRow = { signal_id: string; normal_bands: unknown };

export interface CatalogRepoOptions {
  /** A connection holding the `app_rw` credential. */
  readonly db: Queryable;
  /** The retriever's cached loader, so both read one catalog; a fresh one by default. */
  readonly loader?: CatalogLoader;
}

/** A band worth reporting: a non-empty JSON object. */
function isBand(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

/** The catalog reader of the dashboard routes over one `app_rw` queryable. */
export function createCatalogRepo(options: CatalogRepoOptions): CatalogReader {
  const loader = options.loader ?? createCachedCatalogLoader({ db: options.db });

  return {
    async faults(): Promise<readonly CatalogEntry[]> {
      return (await loader.load()).entries;
    },

    async fault(faultId: string): Promise<CatalogEntry | undefined> {
      return (await loader.load()).entries.find((entry) => entry.fault_id === faultId);
    },

    async normalBands() {
      const { documentId } = await loader.load();
      const bands = new Map<string, Readonly<Record<string, unknown>>>();
      if (documentId === null) return bands;
      const rows = await query<BandRow>(options.db, NORMAL_BANDS_SQL, [documentId]);
      for (const row of rows) {
        if (isBand(row.normal_bands)) bands.set(row.signal_id, row.normal_bands);
      }
      return bands;
    },
  };
}
