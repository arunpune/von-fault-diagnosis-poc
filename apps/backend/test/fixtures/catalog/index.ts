// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * A small fictional CAU-7 fault catalog, for the decision tests.
 *
 * Twelve causes drawn from the manual's fixed registry
 * (`manual/spec/faults.yaml`), written in the manual's own signal-move
 * vocabulary. It is deliberately not the whole catalog: it holds the causes
 * the rules twin's calibration cases need, plus enough
 * neighbours under the same conditions that the winner has to beat something.
 *
 * Everything here is invented. No manufacturer, product line or part number of
 * a real machine appears in it, and no sentence comes from a real manual.
 * The JSON beside this file is annotated CC-BY-4.0 by the
 * repository's `REUSE.toml`, like every other synthetic fixture.
 */

import { readFileSync } from "node:fs";

import { assertValid, SIGNALS } from "@fdp/contracts";
import type { CatalogEntry, SeverityLevel } from "@fdp/contracts";

import type { Candidate, RetrievalScores } from "../../../src/retrieval/types.ts";

/** The catalog, validated entry by entry against `catalog-entry`. */
export const FIXTURE_CATALOG: readonly CatalogEntry[] = loadCatalog();

function loadCatalog(): readonly CatalogEntry[] {
  const raw: unknown = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8"));
  if (!Array.isArray(raw)) throw new Error("catalog.json: expected an array of catalog entries");
  return raw.map((entry) => assertValid("catalog-entry", entry));
}

/** The entry with this `fault_id`; throws so a typo in a test fails loudly. */
export function catalogEntry(faultId: string): CatalogEntry {
  const entry = FIXTURE_CATALOG.find((candidate) => candidate.fault_id === faultId);
  if (entry === undefined) throw new Error(`catalog fixture: no entry with fault_id ${faultId}`);
  return entry;
}

/**
 * Turn catalog entries into the candidates retrieval would have handed over.
 *
 * The retrieval scores are placeholders on a descending ramp: nothing in the
 * decision layer reads them, and a test that depended on them would be testing
 * retrieval's fusion rather than its own subject.
 */
export function candidatesFor(faultIds: readonly string[]): Candidate[] {
  return faultIds.map((faultId, index) => ({
    ...catalogEntry(faultId),
    retrieval: rampScores(index),
  }));
}

function rampScores(index: number): RetrievalScores {
  const rank = index + 1;
  return { catalog: 1 / rank, text: 1 / rank, vector: 1 / rank, rrf: 1 / (60 + rank) };
}

/** The manual's descriptions of the six derived behaviours. */
const BEHAVIOUR_LABELS: Readonly<Record<string, string>> = {
  load_cycle_rate: "how often the compressor loads per hour",
  loaded_run_duration: "how long each loaded run lasts",
  unloaded_pressure_decay: "how fast line pressure falls while the unit is not delivering",
  cut_out_reached: "whether a loaded run ends at the cut-out pressure",
  pressure_rise_while_loaded: "how fast line pressure rises during a loaded run",
  start_current_peak: "the current peak at motor start",
};

/** Every signal and behaviour name a built state may quote. */
export const FIXTURE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(SIGNALS.map((signal) => [signal.tag, signal.name])),
  ...BEHAVIOUR_LABELS,
});

/**
 * The `severity_hint` of every detection rule the fixture events fire.
 *
 * The values are the rule registry's (`detection/rules/`), which owns them;
 * the rules backend only ever reads hints its caller passes in.
 */
export const FIXTURE_SEVERITY_HINTS: Readonly<Record<string, SeverityLevel>> = Object.freeze({
  stuck_loaded: "high",
  purge_pressure_high: "high",
  fast_decay: "medium",
  frequent_cycling: "medium",
  long_loaded_runs: "medium",
  low_pressure_switch: "critical",
  oil_temperature_high: "medium",
  oil_temperature_rising: "low",
  motor_current_low: "medium",
});
