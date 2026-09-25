// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Shared plumbing for the Docker-backed suites: where the repository is, how a
// connection is opened and closed, and what a failed statement's SQLSTATE was.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const MIGRATIONS_DIR = join(REPO_ROOT, "db", "migrations");
export const CONFORMANCE_DIR = join(REPO_ROOT, "db", "conformance");

/** Open a client on `url`, hand it to `use`, and always close it again. */
export async function withClient<T>(
  url: string,
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/**
 * The SQLSTATE of the error `act` must raise.
 *
 * @throws when `act` succeeds or fails without a SQLSTATE, so a test can never
 * pass by accident.
 */
export async function sqlstateOf(act: () => Promise<unknown>): Promise<string> {
  try {
    await act();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
    throw error;
  }
  throw new Error("expected the statement to be refused, it succeeded");
}
