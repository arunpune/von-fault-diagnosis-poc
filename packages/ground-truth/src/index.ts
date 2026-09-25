// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The public API of `@fdp/ground-truth`.
//
// Ground-truth isolation: this package is ground truth. Only the evaluation harness and the
// simulator may reach it — `apps/backend` and `apps/frontend` never list it as a dependency, and
// `test/no-consumers.test.ts` keeps that true. The overlay of the user interface gets the same data
// from the broker, never from here.
//
// Each file is read once, validated against its contract schema and frozen, so a caller cannot
// hand a mutated failure table to the next one.

import { DEFAULT_UNIT_ID, assertValid, toIsoMs } from "@fdp/contracts";
import type { SchemaType } from "@fdp/contracts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  isExcluded as isExcludedIn,
  labelAt as labelAtIn,
  precursorFrom as precursorFromIn,
  scoringWindows as scoringWindowsIn,
} from "./labels.ts";
import type { ExclusionReason, Label, LabelOptions, ScoringWindow } from "./labels.ts";

export type {
  ExclusionReason,
  GtExcludedWindow,
  GtFailure,
  GtFailureTable,
  Label,
  LabelOptions,
  ScoringWindow,
} from "./labels.ts";

/** The presets document, `data/presets.json`. */
export type GtPresets = SchemaType<"gt-presets">;

/** One entry of the simulator's jump menu. */
export type GtPresetDef = GtPresets["presets"][number];

/** The injection catalog document, `data/injections.json` (authored by the simulator's owner). */
export type GtInjections = SchemaType<"gt-injections">;

/** One injection type of the simulator. */
export type GtInjectionDef = GtInjections["injections"][number];

/** The retained catalog message the simulator publishes on `gt/{unit_id}/catalog`. */
export type GtCatalog = SchemaType<"gt-catalog">;

/** The failure-table document, `data/metropt3-failures.json`. */
type FailureTable = SchemaType<"gt-failure-table">;

const FAILURES_FILE = "metropt3-failures.json";
const PRESETS_FILE = "presets.json";
const INJECTIONS_FILE = "injections.json";

function findDataDir(start: string): string {
  let directory = start;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, "data", PRESETS_FILE))) return join(directory, "data");
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`@fdp/ground-truth: no data directory with ${PRESETS_FILE} above ${start}`);
}

/**
 * Absolute path of the data directory.
 *
 * The simulator's image copies the files out of it and the evaluation scripts read them by
 * path, so it resolves the same whether this module runs from `src/` or from `dist/`.
 */
export const DATA_DIR: string = findDataDir(import.meta.dirname);

/** Freezes a parsed document and everything under it, so one caller cannot edit another's copy. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function readDocument<N extends "gt-failure-table" | "gt-presets" | "gt-injections">(
  schema: N,
  file: string,
): SchemaType<N> {
  const parsed: unknown = JSON.parse(readFileSync(join(DATA_DIR, file), "utf8"));
  return deepFreeze(assertValid(schema, parsed));
}

let failureTable: FailureTable | undefined;
let presets: GtPresets | undefined;
let injections: GtInjections | null | undefined;

/** The corrected MetroPT-3 failure table, validated and frozen on the first call. */
export function loadFailureTable(): FailureTable {
  failureTable ??= readDocument("gt-failure-table", FAILURES_FILE);
  return failureTable;
}

/** The replay presets, validated and frozen on the first call. */
export function loadPresets(): GtPresets {
  presets ??= readDocument("gt-presets", PRESETS_FILE);
  return presets;
}

/**
 * The injection catalog, or `null` while `data/injections.json` does not exist.
 *
 * The simulator's owner writes that file and validates it with this package's test suite; while it
 * is absent every caller sees an empty menu rather than a crash, and the absence is logged once.
 */
export function loadInjections(): GtInjections | null {
  if (injections === undefined) {
    if (existsSync(join(DATA_DIR, INJECTIONS_FILE))) {
      injections = readDocument("gt-injections", INJECTIONS_FILE);
    } else {
      injections = null;
      process.stderr.write(
        `@fdp/ground-truth: ${INJECTIONS_FILE} is absent; the injection menu is empty until ` +
          "the simulator's catalog is written\n",
      );
    }
  }
  return injections;
}

/** The preset with this id, or `undefined`. */
export function getPreset(id: string): GtPresetDef | undefined {
  return loadPresets().presets.find((preset) => preset.preset_id === id);
}

/** The injection definition with this id, or `undefined` (also while the catalog is absent). */
export function getInjection(id: string): GtInjectionDef | undefined {
  return loadInjections()?.injections.find((injection) => injection.injection_id === id);
}

/** The label of one instant of the replay. */
export function labelAt(simTs: string | Date, options: LabelOptions = {}): Label {
  return labelAtIn(loadFailureTable(), simTs, options);
}

/** Every window a positive is scored in. */
export function scoringWindows(options: LabelOptions = {}): ScoringWindow[] {
  return scoringWindowsIn(loadFailureTable(), options);
}

/** Whether an instant falls in an excluded window, and why. */
export function isExcluded(simTs: string | Date): {
  excluded: boolean;
  reason: ExclusionReason | null;
} {
  return isExcludedIn(loadFailureTable(), simTs);
}

/** The instant a failure's signature becomes measurable ahead of its window, or `null`. */
export function precursorFrom(failureId: string): Date | null {
  return precursorFromIn(loadFailureTable(), failureId);
}

/**
 * The replay source the simulator serves when the caller names none.
 *
 * The figures are the whole MetroPT-3 recording as `data/metropt3-first-month-stats.json` reports
 * it; the simulator passes its own once it has opened the file.
 */
const DEFAULT_DATASET: GtCatalog["dataset"] = {
  first_ts: "2020-02-01T00:00:00.000Z",
  last_ts: "2020-09-01T03:59:50.000Z",
  rows: 1516948,
  gaps: 331,
};

/** Digest over the data files that exist, concatenated in name order. */
function sourceSha256(): string {
  const hash = createHash("sha256");
  for (const file of readdirSync(DATA_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    hash.update(readFileSync(join(DATA_DIR, file)));
  }
  return hash.digest("hex");
}

/**
 * The catalog message the simulator retains on `gt/{unit_id}/catalog`.
 *
 * The presets and the failure table are forwarded verbatim; the injections are cut down to what
 * the menu of the user interface needs, so the transforms never leave the simulator.
 */
export function buildGtCatalog(unitId?: string, dataset?: GtCatalog["dataset"]): GtCatalog {
  const catalog: GtCatalog = {
    schema: "urn:fdp:schema:gt-catalog:v1",
    unit_id: unitId ?? DEFAULT_UNIT_ID,
    wall_ts: toIsoMs(new Date()),
    dataset: dataset ?? DEFAULT_DATASET,
    presets: loadPresets(),
    injections: (loadInjections()?.injections ?? []).map((injection) => ({
      injection_id: injection.injection_id,
      fault_id: injection.fault_id,
      label: injection.label,
      benign: injection.benign,
      description: injection.description,
      default_duration_sim_min: injection.default_duration_sim_min,
      params: injection.params,
    })),
    failures: loadFailureTable(),
    source_sha256: sourceSha256(),
  };
  return assertValid("gt-catalog", catalog);
}
