// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The backend's manual-catalog fixture is still the manual's catalog.
//
// `apps/backend/test/fixtures/catalog/man/catalog.json` is what the rules
// twin's confidence calibration is proved on. It is written by
// `scripts/export-man-fixture.ts` from the manual build's reference catalog,
// and the backend cannot check it itself: it never imports tools/eval. So the
// check lives here. The fixture is regenerated in memory and compared with the
// committed file; a manual change that reaches the reference catalog without a
// new export, or a hand edit of the fixture, fails this file instead of leaving
// the calibration on a catalog that no longer exists.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadReferenceCatalog, REFERENCE_CATALOG_PATH } from "../src/catalog/reference.ts";
import {
  MAN_FIXTURE_PATH,
  manFixtureText,
  renderManFixture,
  sortKeys,
} from "../scripts/export-man-fixture.ts";

/** What to run when this file fails because the manual changed. */
const REEXPORT = "node --conditions=@fdp/source tools/eval/scripts/export-man-fixture.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function committedText(): string {
  return readFileSync(MAN_FIXTURE_PATH, "utf8");
}

function faultIds(document: unknown): string[] {
  if (!Array.isArray(document)) throw new Error("the manual-catalog fixture is not an array");
  return document.map((entry: { fault_id: string }) => entry.fault_id);
}

/** A copy of the reference catalog with one direction word of `faultId` swapped. */
function referenceWithOneMoveChanged(faultId: string): string {
  const document = JSON.parse(readFileSync(REFERENCE_CATALOG_PATH, "utf8")) as {
    causes: { fault_id: string; signal_moves: { direction: string }[] }[];
  };
  const cause = document.causes.find((candidate) => candidate.fault_id === faultId);
  const move = cause?.signal_moves[0];
  if (move === undefined) throw new Error(`the reference catalog has no move for ${faultId}`);
  move.direction = move.direction === "rises" ? "falls" : "rises";

  const directory = mkdtempSync(join(tmpdir(), "fdp-man-fixture-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "catalog.json");
  writeFileSync(path, JSON.stringify(document), "utf8");
  return path;
}

describe("the backend's manual-catalog fixture", () => {
  it("holds the manual's 39 causes, in the reference catalog's ids and order", () => {
    const reference = loadReferenceCatalog();
    const committed: unknown = JSON.parse(committedText());
    expect(faultIds(committed)).toHaveLength(39);
    expect(faultIds(committed)).toEqual(reference.entries.map((entry) => entry.fault_id));
  });

  it("deep-equals a fresh export of the reference catalog", () => {
    expect(JSON.parse(committedText()), `stale fixture; re-export with: ${REEXPORT}`).toEqual(
      JSON.parse(manFixtureText()),
    );
  });

  it("is byte for byte the export, so a hand edit cannot survive", () => {
    expect(committedText(), `edited fixture; re-export with: ${REEXPORT}`).toBe(manFixtureText());
  });

  it("stops matching as soon as one move of the reference catalog changes", () => {
    const changed = manFixtureText(referenceWithOneMoveChanged("oil_cooler_fouled"));
    expect(changed).not.toBe(committedText());
    expect(JSON.parse(changed)).not.toEqual(JSON.parse(committedText()));
  });
});

describe("renderManFixture", () => {
  it("sorts the keys of every object at every depth and keeps array order", () => {
    const sorted = sortKeys({ b: [{ z: 1, a: 2 }, 3], a: { d: null, c: "x" } });
    expect(JSON.stringify(sorted)).toBe('{"a":{"c":"x","d":null},"b":[{"a":2,"z":1},3]}');
  });

  it("writes two-space JSON with a final newline", () => {
    const text = renderManFixture(loadReferenceCatalog().entries.slice(0, 1));
    expect(text.startsWith('[\n  {\n    "benign": ')).toBe(true);
    expect(text.endsWith("]\n")).toBe(true);
  });
});
