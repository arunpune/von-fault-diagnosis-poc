// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The manual's whole catalog, for the rules twin's calibration.
 *
 * The shared fixture beside this directory is twelve hand-made causes, and the
 * decision tests rest on it, so it stays as it is. This one is the manual's
 * own catalog: the 39 causes of its fixed registry, exported from the
 * manual build's reference catalog by
 * `tools/eval/scripts/export-man-fixture.ts` and guarded by that package's drift
 * test. It is generated and never edited by hand; a manual change reaches it by
 * running the script again.
 *
 * Everything in it is the fictional CAU-7's, and the JSON is
 * annotated CC-BY-4.0 by the repository's `REUSE.toml`, like every fixture.
 */

import { readFileSync } from "node:fs";

import { assertValid } from "@fdp/contracts";
import type { CatalogEntry } from "@fdp/contracts";

import type { Candidate, RetrievalScores } from "../../../../src/retrieval/types.ts";

/** The manual's 39 causes, validated entry by entry against `catalog-entry`. */
export const MAN_CATALOG: readonly CatalogEntry[] = loadCatalog();

function loadCatalog(): readonly CatalogEntry[] {
  const raw: unknown = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error("man/catalog.json: expected an array of catalog entries");
  }
  return raw.map((entry) => assertValid("catalog-entry", entry));
}

/** The cause with this `fault_id`; throws so a typo in a test fails loudly. */
export function manEntry(faultId: string): CatalogEntry {
  const entry = MAN_CATALOG.find((candidate) => candidate.fault_id === faultId);
  if (entry === undefined) throw new Error(`manual catalog fixture: no cause ${faultId}`);
  return entry;
}

/**
 * The causes the manual files under one condition, in the catalog's order.
 *
 * This is what the calibration offers the rules twin in place of retrieval:
 * the table then measures the twin on the manual's own candidate
 * list, and a retrieval change cannot move it.
 */
export function causesUnder(conditionId: string): CatalogEntry[] {
  return MAN_CATALOG.filter((entry) =>
    entry.conditions.some((condition) => condition.condition_id === conditionId),
  );
}

/** The causes the manual calls benign: the machine is sound, its surroundings changed. */
export function benignCauses(): CatalogEntry[] {
  return MAN_CATALOG.filter((entry) => entry.benign);
}

/**
 * Catalog entries as the candidates retrieval would have handed over.
 *
 * The retrieval scores are placeholders on a descending ramp, as in the shared
 * fixture: the decision layer never reads them.
 */
export function asCandidates(entries: readonly CatalogEntry[]): Candidate[] {
  return entries.map((entry, index) => ({ ...entry, retrieval: rampScores(index) }));
}

function rampScores(index: number): RetrievalScores {
  const rank = index + 1;
  return { catalog: 1 / rank, text: 1 / rank, vector: 1 / rank, rrf: 1 / (60 + rank) };
}
