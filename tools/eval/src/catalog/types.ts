// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What the harness means by "the catalog", and the one vocabulary question it
// has to answer.
//
// The catalog is `CatalogEntry[]` from @fdp/contracts, whatever it was read
// from: the reference document `make manual` writes or the rows init
// extracted from the PDF and stored in `app.v_catalog_entries`. Both
// sources end here, so the retriever and the scorer never learn which one they
// are looking at.
//
// The direction vocabulary is the manual's and the contracts schema declares it
// verbatim: `rises`, `falls`, `higher`, `faster`, `not_reached` and the rest are
// the words, and an `up | down | flat | erratic | missing | cycling_*` set an
// early sketch used does not exist. The mapping below is therefore the identity
// — but it is written down rather than skipped, because the point of the table
// is to fail on a word that is in neither vocabulary, which is what E1 asks
// `fdp-eval validate` to report.

import type { CatalogEntry, SignalMove } from "@fdp/contracts";

export type { CatalogEntry, SignalMove } from "@fdp/contracts";

/** The direction words of `signal_move` (common.schema.json). */
export const DIRECTIONS = [
  "rises",
  "falls",
  "high",
  "low",
  "unchanged",
  "fluctuates",
  "near_zero",
  "not_venting",
  "on",
  "off",
  "stays_on",
  "stays_off",
  "toggles",
  "no_pulse",
  "higher",
  "lower",
  "longer",
  "shorter",
  "faster",
  "slower",
  "not_reached",
] as const;

export type Direction = SignalMove["direction"];

/**
 * The manual's words to the contracts vocabulary: the identity, because the contracts schema
 * declares the manual's words verbatim.
 *
 * It is a table rather than a membership test so that the day a catalog source arrives with
 * a second spelling, the alias is one line here and no caller changes.
 */
export const DIRECTION_MAP: Readonly<Record<string, Direction>> = Object.freeze(
  Object.fromEntries(DIRECTIONS.map((word) => [word, word])) as Record<string, Direction>,
);

/** The ten subsystems of the manual's component list. */
export const SUBSYSTEMS = [
  "compressor",
  "intake_unloading",
  "oil",
  "cooling",
  "separator_drain",
  "dryer",
  "reservoirs",
  "distribution",
  "control",
  "electrical",
] as const;

export type Subsystem = CatalogEntry["subsystem"];

/** Which document shape the reference catalog was written in. */
export type CatalogShape = "contracts" | "pdf";

/** One word a catalog used that is in neither vocabulary. */
export interface UnmappedDirection {
  readonly fault_id: string;
  readonly direction: string;
}

/** A reference catalog that cannot be mapped, with every word that is missing a mapping. */
export class CatalogError extends Error {
  readonly path: string;
  readonly unmapped: readonly UnmappedDirection[];

  constructor(path: string, message: string, unmapped: readonly UnmappedDirection[] = []) {
    super(`${path}: ${message}`);
    this.name = "CatalogError";
    this.path = path;
    this.unmapped = unmapped;
  }
}

/**
 * One condition of a catalog document's fault-finding table, with the symptom sentences the
 * retrieval query reads.
 *
 * The entries carry a condition's title but never its sentences, so every catalog source hands
 * the table to the retriever beside them, as production reads `app.catalog_conditions`.
 */
export interface EvalCondition {
  readonly condition_id: string;
  readonly title: string;
  /** The condition's `symptom` sentence, then the further wordings of `symptoms[]`. */
  readonly symptoms: readonly string[];
}

/** The reference catalog, as `loadReferenceCatalog` returns it. */
export interface ReferenceCatalog {
  readonly entries: readonly CatalogEntry[];
  /** SHA-256 of the file as it sits on disk; the report records it. */
  readonly sha256: string;
  readonly source: "reference";
  readonly shape: CatalogShape;
  readonly path: string;
  /** How many symptom conditions the document declares, for the E1 report. */
  readonly conditions: number;
  /** The document's conditions with their symptom sentences, in document order. */
  readonly conditionTable: readonly EvalCondition[];
}
