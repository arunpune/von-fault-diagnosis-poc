// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Exports the manual's catalog as the backend's calibration fixture.
//
//   node --conditions=@fdp/source tools/eval/scripts/export-man-fixture.ts
//
// The manual build writes the manual's reference catalog to
// `fixtures/catalog.json` (`manual/build.yaml` pdf.outputs.catalog): 39 causes
// in the manual's own registry ids. This script maps that document to
// `catalog-entry[]` through the harness's own reference mapping —
// `loadReferenceCatalog`, the loader every eval run reads the reference catalog
// with — and writes the entries to
// `apps/backend/test/fixtures/catalog/man/catalog.json` with every object's
// keys sorted, so the file is a pure function of the reference catalog and
// nothing about it is decided by hand.
//
// The file is generated and never edited. The backend never imports tools/eval,
// so the committed JSON is the whole hand-over, and
// `test/man-fixture-drift.test.ts` regenerates it in memory and fails the
// moment a manual change reaches the reference catalog without being exported
// again. Prettier leaves the file alone (`.prettierignore`), because it would
// collapse the short arrays and the bytes would stop being this script's.
//
// It exits 0 when the fixture was written and 1 when the reference catalog
// cannot be read or mapped.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadReferenceCatalog, REFERENCE_CATALOG_PATH } from "../src/catalog/reference.ts";
import type { CatalogEntry } from "../src/catalog/types.ts";

/** Where the backend's calibration fixture lives. */
export const MAN_FIXTURE_PATH: string = fileURLToPath(
  new URL("../../../apps/backend/test/fixtures/catalog/man/catalog.json", import.meta.url),
);

const REPO_ROOT: string = fileURLToPath(new URL("../../..", import.meta.url));

const EXIT_FAILURE = 1;

/**
 * A copy of a parsed JSON value whose objects list their keys in code-unit order, at every
 * depth; arrays keep their order.
 */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    sorted[key] = sortKeys(inner);
  }
  return sorted;
}

/**
 * The fixture text for these entries: the manual's order of causes, sorted keys, two-space
 * indentation and a final newline.
 */
export function renderManFixture(entries: readonly CatalogEntry[]): string {
  return `${JSON.stringify(entries.map(sortKeys), null, 2)}\n`;
}

/** The fixture as the reference catalog at `referencePath` produces it. */
export function manFixtureText(referencePath: string = REFERENCE_CATALOG_PATH): string {
  return renderManFixture(loadReferenceCatalog(referencePath).entries);
}

function say(message: string): void {
  process.stdout.write(`export-man-fixture: ${message}\n`);
}

function main(): void {
  const catalog = loadReferenceCatalog();
  mkdirSync(dirname(MAN_FIXTURE_PATH), { recursive: true });
  writeFileSync(MAN_FIXTURE_PATH, renderManFixture(catalog.entries), "utf8");
  say(
    `wrote ${relative(REPO_ROOT, MAN_FIXTURE_PATH)}: ${catalog.entries.length} causes from ` +
      `${relative(REPO_ROOT, catalog.path)} (sha256 ${catalog.sha256})`,
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `export-man-fixture: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = EXIT_FAILURE;
  }
}
