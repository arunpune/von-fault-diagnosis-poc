// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The half of the runner contract that needs no database
// (db/README.md#3-running-the-migrations):
// which files a directory offers, in which order, and how they are hashed.
// The conformance fixture in db/conformance is the input here too, so the
// cases the Docker suite replays against a real server start from the same
// files.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { parseArgs } from "../src/cli.ts";
import { MigrationError, listMigrations, sha256File } from "../src/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CASES = join(REPO_ROOT, "db", "conformance", "cases");
const MIGRATIONS = join(REPO_ROOT, "db", "migrations");

const scratch = mkdtempSync(join(tmpdir(), "fdp-db-migrate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A fresh directory holding exactly `names`, each with one harmless statement. */
function directoryWith(label: string, names: readonly string[]): string {
  const dir = join(scratch, label);
  mkdirSync(dir);
  for (const name of names) writeFileSync(join(dir, name), "SELECT 1;\n");
  return dir;
}

/** Run `act` and return the MigrationError it is expected to throw. */
function refusal(act: () => unknown): MigrationError {
  try {
    act();
  } catch (error) {
    if (error instanceof MigrationError) return error;
    throw error;
  }
  throw new Error("expected a MigrationError, nothing was thrown");
}

describe("listMigrations", () => {
  it("returns every file of a directory in ascending version order", () => {
    const files = listMigrations(join(CASES, "out_of_order", "variant-inserted"));
    expect(files.map((file) => file.version)).toEqual([1, 2, 3]);
    expect(files.map((file) => file.file)).toEqual([
      "0001_first.sql",
      "0002_second.sql",
      "0003_third.sql",
    ]);
    expect(files.map((file) => file.name)).toEqual(["first", "second", "third"]);
  });

  it("ignores sub-directories, so a case may keep its variants inside it", () => {
    expect(listMigrations(join(CASES, "hash_change")).map((file) => file.version)).toEqual([1, 2]);
  });

  it("refuses a file that is not NNNN_<slug>.sql", () => {
    const error = refusal(() => listMigrations(join(CASES, "bad_filename")));
    expect(error.code).toBe("invalid_filename");
    expect(error.file).toBe("0004-bad.sql");
  });

  it("refuses an upper-case slug and a three-digit prefix", () => {
    expect(refusal(() => listMigrations(directoryWith("upper", ["0001_Bad.sql"]))).code).toBe(
      "invalid_filename",
    );
    expect(refusal(() => listMigrations(directoryWith("short", ["001_bad.sql"]))).code).toBe(
      "invalid_filename",
    );
  });

  it("refuses two files claiming the same version", () => {
    const dir = directoryWith("duplicate", ["0007_alpha.sql", "0007_beta.sql"]);
    const error = refusal(() => listMigrations(dir));
    expect(error.code).toBe("invalid_filename");
    expect(error.message).toContain("share version 7");
  });

  it("allows a README beside the migrations", () => {
    const dir = directoryWith("readme", ["0001_only.sql", "README.md"]);
    expect(listMigrations(dir).map((file) => file.file)).toEqual(["0001_only.sql"]);
  });

  it("lists this repository's own migrations", () => {
    expect(listMigrations(MIGRATIONS).map((file) => file.file)).toEqual([
      "0001_extensions_schemas.sql",
      "0002_ground_truth.sql",
      "0003_manual_chunks.sql",
      "0004_catalog.sql",
      "0005_telemetry.sql",
      "0006_diagnosis.sql",
      "0007_cost_system.sql",
      "0008_chunk_links.sql",
      "0009_backend_episode_links.sql",
    ]);
  });
});

describe("sha256File", () => {
  it("is the lower-case hex SHA-256 of the file's bytes", () => {
    const path = join(scratch, "abc.txt");
    writeFileSync(path, "abc\n");
    expect(sha256File(path)).toBe(
      "edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb",
    );
  });

  it("gives every migration of this repository a 64-character hash", () => {
    for (const file of listMigrations(MIGRATIONS)) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("separates the two copies of 0001 that the hash_change case uses", () => {
    const appliedPath = join(CASES, "hash_change", "0001_first.sql");
    const editedPath = join(CASES, "hash_change", "variant-modified", "0001_first.sql");
    const applied = readFileSync(appliedPath, "utf8");
    const edited = readFileSync(editedPath, "utf8");
    // The fixture is only convincing while the two differ by one character.
    expect(edited).toHaveLength(applied.length);
    expect([...applied].filter((character, at) => character !== edited[at])).toHaveLength(1);
    expect(sha256File(appliedPath)).not.toBe(sha256File(editedPath));
  });
});

describe("parseArgs", () => {
  it("reads the command and both options", () => {
    const parsed = parseArgs(["migrate", "--dir", "db/migrations", "--url", "postgres://x/y"], {
      INIT_CWD: REPO_ROOT,
    });
    expect(parsed).toEqual({ command: "migrate", dir: MIGRATIONS, url: "postgres://x/y" });
  });

  it("resolves a relative --dir against the directory the command was typed in", () => {
    // `pnpm --filter @fdp/db-migrate migrate --dir db/migrations` runs with the
    // package as its working directory, so only INIT_CWD makes that path mean
    // what db/README.md documents.
    const parsed = parseArgs(["migrate", "--dir", "db/migrations", "--url", "u"], {
      INIT_CWD: "/somewhere",
    });
    expect(parsed).toEqual({ command: "migrate", dir: "/somewhere/db/migrations", url: "u" });
  });

  it("falls back to the environment and leaves an absolute path alone", () => {
    expect(
      parseArgs(["status"], {
        MIGRATIONS_DIR: "/db/migrations",
        DATABASE_URL: "u",
        INIT_CWD: "/somewhere",
      }),
    ).toEqual({ command: "status", dir: "/db/migrations", url: "u" });
  });

  it("explains an unknown command, an unknown option and a missing url", () => {
    expect(parseArgs(["apply"], {})).toContain("unknown command");
    expect(parseArgs(["status", "--all", "1"], { DATABASE_URL: "u" })).toContain("unknown option");
    expect(parseArgs(["status", "--dir"], { DATABASE_URL: "u" })).toContain("needs a value");
    expect(parseArgs(["status"], {})).toContain("no database url");
  });
});
