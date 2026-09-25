// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The fake backend's static data:
//
//   * catalog.json — the overlay catalog the "Jump to" and "Inject fault" menus and the failure
//     bands are drawn from: the nine presets with their verbatim labels and lead-ins, the nine
//     injection menu entries and the MetroPT-3 failure table F1–F4b. Its recording-gap list is
//     empty and its dataset counts no gaps, because the synthetic waveform has none.
//   * signals.json — the register map as `GET /api/signals` serves it: the fifteen MetroPT-3
//     columns and the synthetic ambient temperature under the fictional tag ids.
//   * faults.json — the catalog entries of the faults the scripted pipeline names, for
//     `GET /api/catalog/faults/:id`.
//
// A JSON file reads as `unknown`, so each one is cast to its contract type here. The cast is
// checked where it matters: e2e/fake-backend/server.spec.ts validates every body the server
// answers with against the contract schemas.

import { readFileSync } from "node:fs";

import type {
  ApiSignals,
  CatalogEntry,
  InjectionDef,
  OverlayCatalog,
  PresetDef,
  SignalDef,
} from "@/api/types";

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8")) as unknown;
}

export const OVERLAY_CATALOG = readJson("./catalog.json") as OverlayCatalog;

export const SIGNALS: readonly SignalDef[] = (readJson("./signals.json") as ApiSignals).signals;

const FAULTS: readonly CatalogEntry[] = readJson("./faults.json") as CatalogEntry[];

/** The replayed dataset as the overlay catalog and every `status.sim` describe it. */
export const DATASET = OVERLAY_CATALOG.dataset;

export function findPreset(presetId: string): PresetDef | undefined {
  return OVERLAY_CATALOG.presets.presets.find((preset) => preset.preset_id === presetId);
}

export function findInjection(injectionId: string): InjectionDef | undefined {
  return OVERLAY_CATALOG.injections.find((entry) => entry.injection_id === injectionId);
}

export function findFault(faultId: string): CatalogEntry | undefined {
  return FAULTS.find((entry) => entry.fault_id === faultId);
}

/** The catalog entry of a fault the scripted pipeline names; a missing one is a data bug. */
export function requireFault(faultId: string): CatalogEntry {
  const entry = findFault(faultId);
  if (entry === undefined) {
    throw new Error(`faults.json has no entry for ${faultId}`);
  }
  return entry;
}

/** The tag id the register map gives a MetroPT-3 column, or the synthetic tag's own id. */
export function tagOf(column: string): string {
  const signal = SIGNALS.find(
    (entry) =>
      entry.metropt_column === column ||
      (entry.metropt_column === null && entry.signal_id === column),
  );
  if (signal === undefined) {
    throw new Error(`signals.json maps no tag to ${column}`);
  }
  return signal.signal_id;
}

export function signalOf(tag: string): SignalDef | undefined {
  return SIGNALS.find((entry) => entry.signal_id === tag);
}
