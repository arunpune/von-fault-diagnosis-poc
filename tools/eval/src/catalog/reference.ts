// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Reading `fixtures/catalog.json` into `CatalogEntry[]`.
//
// Two shapes reach this file and both must come out the same way.
//
//   * The contracts `catalog` document `make manual` writes: an envelope with
//     `machine`, `signals`, `alarms`, `conditions`, `causes`, `maintenance`
//     and `parameters`, whose `causes[]` already *are* catalog entries, in the
//     manual's vocabulary. Nothing is translated; every entry is validated and
//     handed on.
//   * The legacy shape, an early sketch where `conditions[]` is a table of
//     symptoms and a cause points at it by id. There one entry is
//     emitted per (cause, condition) pair — the way `app.catalog_causes` stores
//     them — and the condition's title and alarm codes are looked up.
//
// A third shape, a bare `{ entries: [...] }` list, is what an exported view of
// `app.v_catalog_entries` looks like on disk; it is accepted too, so a reviewer
// can point the harness at one without a conversion step.
//
// Beside the entries comes the document's condition table with each
// condition's symptom sentences: an entry carries a condition's title but not
// its sentences, and the retrieval query needs them.
//
// The direction words are checked against `DIRECTION_MAP`, not trusted: E1 asks
// this loader to report "any direction words without a mapping", so every cause
// is walked before anything is thrown and the whole list travels on the error.

import { validate } from "@fdp/contracts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CatalogError, DIRECTION_MAP } from "./types.ts";
import type {
  CatalogEntry,
  CatalogShape,
  EvalCondition,
  ReferenceCatalog,
  UnmappedDirection,
} from "./types.ts";

/** The reference catalog `make manual` writes. */
export const REFERENCE_CATALOG_PATH: string = fileURLToPath(
  new URL("../../fixtures/catalog.json", import.meta.url),
);

/** The committed stand-in the tests use while the real document is not built. */
export const MINI_CATALOG_PATH: string = fileURLToPath(
  new URL("../../fixtures/catalog-mini.json", import.meta.url),
);

/** True when `make manual` has written the reference catalog on this machine. */
export function referenceCatalogExists(path: string = REFERENCE_CATALOG_PATH): boolean {
  return existsSync(path);
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

/**
 * Rewrites the directions of one cause and records the words that have no mapping.
 *
 * The cause is returned with its `signal_moves` in the contracts vocabulary; an unmapped word
 * is pushed onto `unmapped` and the move is dropped, so the walk continues and the caller sees
 * every offending word at once rather than the first.
 */
function mapDirections(cause: Json, faultId: string, unmapped: UnmappedDirection[]): unknown[] {
  const moves: unknown[] = [];
  for (const move of asArray(cause["signal_moves"])) {
    if (!isRecord(move)) continue;
    const direction = asString(move["direction"]);
    if (direction === undefined) continue;
    const mapped = DIRECTION_MAP[direction];
    if (mapped === undefined) {
      unmapped.push({ fault_id: faultId, direction });
      continue;
    }
    moves.push({ ...move, direction: mapped });
  }
  return moves;
}

/** How a legacy cause names the conditions it explains: a list of condition ids. */
function legacyConditionIds(cause: Json): string[] | undefined {
  const value = cause["conditions"];
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

/** The document's condition table, in either shape that has one, by condition id. */
function conditionIndex(document: Json): Map<string, Json> {
  const index = new Map<string, Json>();
  for (const condition of asArray(document["conditions"])) {
    if (!isRecord(condition)) continue;
    const id = asString(condition["id"]);
    if (id !== undefined) index.set(id, condition);
  }
  return index;
}

/**
 * Every condition of the document with its symptom sentences.
 *
 * Both shapes that have a condition table carry the sentences on it: the contracts `catalog`
 * document as `symptom`, one sentence, and optionally `symptoms[]`, further wordings; the
 * legacy sketch as `symptoms[]`. They come out as `symptom` first and then `symptoms[]`, blanks and
 * repeats dropped, which is how the backend's `loadCatalog` reads `app.catalog_conditions`, so
 * the query the database-free retriever builds is the one production builds. A bare
 * `entries[]` list has no table and gives none.
 */
function conditionTable(index: ReadonlyMap<string, Json>): EvalCondition[] {
  return [...index].map(([conditionId, condition]) => {
    const sentences = [
      asString(condition["symptom"]) ?? "",
      ...asStringArray(condition["symptoms"]),
    ]
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence !== "");
    return {
      condition_id: conditionId,
      title: asString(condition["title"]) ?? "",
      symptoms: [...new Set(sentences)],
    };
  });
}

/**
 * One `CatalogEntry` per (cause, condition) pair of the legacy shape.
 *
 * The legacy cause carries `title` where a catalog entry carries `name`, `summary` is its
 * description, `maintenance_refs` its maintenance ids and `section`/`pages.realistic[0]` its
 * manual reference. Everything the entry schema requires and the legacy shape does not state is
 * filled with the empty value of its type, never invented.
 */
function fromLegacyPair(
  cause: Json,
  faultId: string,
  condition: Json,
  moves: unknown[],
): Record<string, unknown> {
  const pages = isRecord(cause["pages"]) ? cause["pages"] : undefined;
  const realistic = pages === undefined ? [] : asArray(pages["realistic"]);
  const pageStart = typeof realistic[0] === "number" ? realistic[0] : undefined;
  const alarms = asStringArray(condition["alarms"]);
  const section = asString(cause["section"]) ?? asString(condition["section"]) ?? "8";

  return {
    fault_id: faultId,
    name: asString(cause["title"]) ?? asString(cause["name"]) ?? faultId,
    subsystem: cause["subsystem"],
    benign: cause["benign"] === true,
    summary: asString(cause["summary"]) ?? asString(cause["description"]) ?? "",
    signal_moves: moves,
    signal_moves_text: asStringArray(cause["signal_moves_text"]),
    checks: asStringArray(cause["checks"]),
    remedy: asString(cause["remedy"]) ?? "",
    conditions: [
      {
        condition_id: asString(condition["id"]) ?? "",
        title: asString(condition["title"]) ?? "",
        likelihood: "unknown",
        alarms,
      },
    ],
    parts: asStringArray(cause["parts"]),
    maintenance: asStringArray(cause["maintenance_refs"] ?? cause["maintenance"]),
    related_alarms: [...new Set([...asStringArray(cause["related_alarms"]), ...alarms])],
    manual_ref: pageStart === undefined ? { section } : { section, page_start: pageStart },
    source: "yaml",
  };
}

function validateEntry(candidate: unknown, path: string, index: number): CatalogEntry {
  const result = validate("catalog-entry", candidate);
  if (!result.ok) {
    const issues = result.errors.map((issue) => issue.text).join("; ");
    const faultId = isRecord(candidate)
      ? (asString(candidate["fault_id"]) ?? `#${index}`)
      : `#${index}`;
    throw new CatalogError(path, `cause '${faultId}' is not a valid catalog entry: ${issues}`);
  }
  return result.value;
}

/** Maps one document, whatever its shape, into validated catalog entries and its conditions. */
function mapDocument(
  document: Json,
  path: string,
): { entries: CatalogEntry[]; shape: CatalogShape; conditions: EvalCondition[] } {
  const unmapped: UnmappedDirection[] = [];
  const entries: CatalogEntry[] = [];

  const listed = document["entries"];
  const causes = document["causes"];
  const shape: CatalogShape = Array.isArray(listed) ? "contracts" : "pdf";

  if (shape === "pdf" && !Array.isArray(causes)) {
    throw new CatalogError(path, "has neither an entries[] list nor a causes[] list");
  }

  const index = conditionIndex(document);
  const source = shape === "contracts" ? asArray(listed) : asArray(causes);

  source.forEach((raw, position) => {
    if (!isRecord(raw)) {
      throw new CatalogError(path, `cause #${position} is not an object`);
    }
    const faultId = asString(raw["fault_id"]) ?? `#${position}`;
    const moves = mapDirections(raw, faultId, unmapped);

    const legacy = shape === "pdf" ? legacyConditionIds(raw) : undefined;
    if (legacy === undefined) {
      entries.push(validateEntry({ ...raw, signal_moves: moves }, path, position));
      return;
    }
    for (const conditionId of legacy) {
      const condition = index.get(conditionId);
      if (condition === undefined) {
        throw new CatalogError(
          path,
          `cause '${faultId}' names condition '${conditionId}', which the document does not declare`,
        );
      }
      entries.push(validateEntry(fromLegacyPair(raw, faultId, condition, moves), path, position));
    }
  });

  if (unmapped.length > 0) {
    const listedWords = unmapped
      .map((entry) => `${entry.fault_id}: '${entry.direction}'`)
      .join(", ");
    throw new CatalogError(
      path,
      `uses ${unmapped.length} direction word(s) outside the signal-move vocabulary (${listedWords})`,
      unmapped,
    );
  }

  return { entries, shape, conditions: conditionTable(index) };
}

/**
 * Reads the reference fault catalog and maps it to `CatalogEntry[]`.
 *
 * @param path the document to read; the reference catalog by default.
 * @throws CatalogError when the file is missing or malformed, when a cause does not validate
 * against `catalog-entry`, or when a direction word has no mapping — in which case every such
 * word is on `error.unmapped`, because E1 asks the report to list them all.
 */
export function loadReferenceCatalog(path: string = REFERENCE_CATALOG_PATH): ReferenceCatalog {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new CatalogError(path, `cannot be read (${String(error)})`);
  }

  let document: unknown;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new CatalogError(path, `is not JSON (${String(error)})`);
  }
  if (!isRecord(document)) throw new CatalogError(path, "is not an object");

  const { entries, shape, conditions } = mapDocument(document, path);
  if (entries.length === 0) throw new CatalogError(path, "declares no cause");

  return {
    entries,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source: "reference",
    shape,
    path,
    conditions: conditions.length,
    conditionTable: conditions,
  };
}

/** The causes of `entries`, by fault id, keeping the first row of a fault that has several. */
export function byFaultId(entries: readonly CatalogEntry[]): Map<string, CatalogEntry> {
  const index = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    if (!index.has(entry.fault_id)) index.set(entry.fault_id, entry);
  }
  return index;
}
