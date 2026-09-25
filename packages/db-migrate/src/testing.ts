// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@fdp/db-migrate/testing`: a throw-away PostgreSQL with this repository's
 * roles and migrations already in it.
 *
 * The backend and the evaluation harness use it for their integration tests,
 * so they test against the same image, the same roles script and the same
 * migrations the Compose stack runs.
 *
 * Nothing is shared between two calls but the image: the host port is random,
 * `infra/postgres/initdb/00-roles.sh` is copied into the container instead of
 * bind-mounted, and the container carries an `fdp.worktree` label naming the
 * working copy it was started from. Several worktrees may therefore run their
 * suites at the same time.
 */

import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { Wait } from "testcontainers";

import { migrate } from "./index.ts";

/** The pinned database image: pgvector 0.8.6 on PostgreSQL 18, amd64 and arm64. */
export const DEFAULT_POSTGRES_IMAGE = "pgvector/pgvector:0.8.6-pg18-trixie";

/** The admin role the image creates and the migrations run as. */
const ADMIN_USER = "fdp_admin";
const ADMIN_PASSWORD = "fdp_admin";
const DATABASE = "fdp";

/** The PoC role passwords of db/README.md#2-roles; not secrets. */
const ROLE_PASSWORDS = {
  app_rw: "app_rw",
  gt_rw: "gt_rw",
  eval: "eval",
} as const;

/** The three login roles `00-roles.sh` creates. */
export type PgRole = keyof typeof ROLE_PASSWORDS;

export interface PgTestStack {
  /** A connection string for `fdp_admin`, the owner of everything. */
  adminUrl: string;
  /** A connection string for one of the three unprivileged roles. */
  urlFor(role: PgRole): string;
  host: string;
  port: number;
  /** The started container, for `exec`, logs or a second database. */
  container: StartedPostgreSqlContainer;
  stop(): Promise<void>;
}

export interface StartPostgresOptions {
  /** Apply `db/migrations` once the server is up. Default true. */
  migrate?: boolean;
  /** Override the image, for a deliberate version test. */
  image?: string;
}

/** The repository root, from `src/` in development and `dist/` in an image. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const ROLES_SCRIPT = join(REPO_ROOT, "infra", "postgres", "initdb", "00-roles.sh");
export const MIGRATIONS_DIR = join(REPO_ROOT, "db", "migrations");

/**
 * Start PostgreSQL with the three roles created and, unless told otherwise,
 * `db/migrations` applied.
 */
export async function startPostgres(opts: StartPostgresOptions = {}): Promise<PgTestStack> {
  const container = await new PostgreSqlContainer(opts.image ?? DEFAULT_POSTGRES_IMAGE)
    .withUsername(ADMIN_USER)
    .withPassword(ADMIN_PASSWORD)
    .withDatabase(DATABASE)
    .withEnvironment({
      PG_APP_PASSWORD: ROLE_PASSWORDS.app_rw,
      PG_GT_PASSWORD: ROLE_PASSWORDS.gt_rw,
      PG_EVAL_PASSWORD: ROLE_PASSWORDS.eval,
    })
    .withLabels({ "fdp.worktree": basename(process.cwd()) })
    .withCopyFilesToContainer([
      { source: ROLES_SCRIPT, target: "/docker-entrypoint-initdb.d/00-roles.sh", mode: 0o755 },
    ])
    // Over TCP on purpose: the temporary server the entrypoint runs the initdb
    // scripts against listens on the unix socket only, so this cannot pass
    // before `00-roles.sh` has finished.
    .withWaitStrategy(
      Wait.forSuccessfulCommand(`pg_isready -h 127.0.0.1 -U ${ADMIN_USER} -d ${DATABASE}`),
    )
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const stack: PgTestStack = {
    adminUrl: url(ADMIN_USER, ADMIN_PASSWORD, host, port),
    urlFor: (role) => url(role, ROLE_PASSWORDS[role], host, port),
    host,
    port,
    container,
    stop: async () => {
      await container.stop();
    },
  };

  if (opts.migrate !== false) {
    const client = new pg.Client({ connectionString: stack.adminUrl });
    await client.connect();
    try {
      await migrate(client, MIGRATIONS_DIR);
    } finally {
      await client.end();
    }
  }
  return stack;
}

function url(user: string, password: string, host: string, port: number): string {
  return `postgres://${user}:${password}@${host}:${port}/${DATABASE}`;
}
