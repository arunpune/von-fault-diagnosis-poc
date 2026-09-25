<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# `db/` — the schema and the migration runner contract

The schema of this PoC is plain SQL and nothing else: numbered files in
[`migrations/`](migrations), applied forward-only, each in its own transaction,
recorded in `public.schema_migrations`. There is no ORM and no migration
framework, because the `GRANT`/`REVOKE` statements that keep ground truth away
from diagnosis code ([ground rule 3](../CONTRIBUTING.md#ground-rules),
[ground-truth isolation](../docs/architecture.md#ground-truth-isolation)) must be
visible in the same file as the tables they protect.

| Path | What it is |
| --- | --- |
| `migrations/NNNN_<slug>.sql` | the schema, one file per change, never edited after it has been applied |
| `conformance/` | the fixture both runners are tested against |
| `../infra/postgres/initdb/00-roles.sh` | the three login roles, created once by the PostgreSQL entrypoint |
| `../packages/db-migrate` | `@fdp/db-migrate`: the TypeScript runner, its CLI and a testcontainers helper |
| `../tools/init/src/fdp_init/migrate.py` | the Python runner init uses in production |

## 1. Numbering

File names match `^(\d{4})_([a-z0-9_]+)\.sql$` and apply in ascending order of
the four-digit version. Two files may not share a version, and nothing else may
sit in a migrations directory but `README.md` and sub-directories.

| Range | Content |
| --- | --- |
| `0001`–`0007` | the base schema: extensions and schemas, `gt`, manual chunks, catalog, telemetry, diagnosis, cost and system |
| `0008` | `0008_chunk_links.sql`, additive: `fault_id`, `alarm_code` and `table_kind` on `app.chunks`, with a partial index on each of the first two |
| `0009`+ | additive only: new columns or indexes, never a second definition of a base-schema table |

**Never edit a file that has been applied.** The runner stores the SHA-256 of
each applied file and refuses to run when the bytes on disk no longer match
(`hash_mismatch`); it also refuses a file numbered below the highest applied
version (`out_of_order`) and an applied version whose file has disappeared
(`missing_file`). A correction is a new numbered file. To start over in
development, `make reset-db` drops the database volume (`make reset` drops every
volume of the stack, the model cache included) and the next `make up` re-applies
everything.

Migrations contain no `BEGIN`/`COMMIT` — the runner opens the transaction — and
nothing that refuses to run inside one, so no `CREATE INDEX CONCURRENTLY`. They
only `GRANT` and `REVOKE`; they never create a role.

## 2. Roles

`infra/postgres/initdb/00-roles.sh` runs once, as `POSTGRES_USER`, while the
data directory is still empty. Compose mounts the directory it sits in; the
testcontainers helper copies the one file into the container. Passwords come
from `PG_APP_PASSWORD`, `PG_GT_PASSWORD` and `PG_EVAL_PASSWORD` and default to
the role name — PoC defaults, not secrets. `0001` refuses to run when one of
the three roles is missing, naming the script.

| Role | Used by | After the migrations |
| --- | --- | --- |
| `fdp_admin` (`POSTGRES_USER`) | init, migrations, tests as admin | owns `app`, `gt` and every object in them |
| `app_rw` | the backend's diagnosis pool | `USAGE` and DML on `app`; **nothing** on `gt`, not even `USAGE` |
| `gt_rw` | the backend's overlay pool | `USAGE` and DML on `gt`; **nothing** on `app` |
| `eval` | `tools/eval` | `USAGE` and DML on `app`; `USAGE` and `SELECT` only on `gt` |

`packages/db-migrate/test/integration/isolation.test.ts` asserts each line of
that table against a real server, including that `app_rw` cannot `SET ROLE
gt_rw` and that `information_schema` records no grant of any `gt` relation to
`app_rw`.

## 3. Running the migrations

As a library, from TypeScript:

```ts
import { migrate, status } from "@fdp/db-migrate";

const result = await migrate(pool, "db/migrations", { log: console.log });
//   { applied: MigrationFile[], skipped: number }
const pending = (await status(pool, "db/migrations")).pending;
```

`migrate` takes a `pg.Client` or a `pg.Pool`; from a pool it checks one client
out for the whole run. It throws a `MigrationError` with a `code` of
`invalid_filename | hash_mismatch | out_of_order | missing_file | apply_failed`
and, where there is one, the `file` that caused it.

From the command line (exit code 2 on a `MigrationError`, which prints the code
and the file):

```bash
pnpm --filter @fdp/db-migrate migrate --dir db/migrations --url postgres://fdp_admin:fdp_admin@localhost:5432/fdp
pnpm --filter @fdp/db-migrate status  --dir db/migrations --url "$DATABASE_URL"
```

`--dir` falls back to `MIGRATIONS_DIR` and then to `db/migrations`; `--url`
falls back to `DATABASE_URL`. A relative `--dir` is resolved against the
directory the command was typed in (`INIT_CWD`), not against the package
directory a `pnpm --filter` script runs in, so the paths above mean what they
look like from the repository root. Connect as the migrating role: the schemas
and every object in them are owned by whoever runs this.

In production the Python twin does the same work, as part of `init` or on its
own. It reads `MIGRATIONS_DIR` and the `POSTGRES_*` variables of
[`tools/init`](../tools/init/README.md) rather than a URL, and exits `4`
on a `MigrationError`, printing the code and the file (`init`'s exit codes
differ from the package CLI's, which uses `2`):

```bash
uv run --package fdp-init fdp-init migrate            # apply
uv run --package fdp-init fdp-init migrate --status   # list applied and pending
```

```python
from pathlib import Path

from fdp_init.migrate import MigrationError, migrate, status

try:
    result = migrate(conn, Path("db/migrations"))  # MigrateResult(applied, skipped)
except MigrationError as error:
    print(error.code, error.file)  # e.g. hash_mismatch 0008_chunk_links.sql

pending = status(conn, Path("db/migrations")).pending
```

In a test, with a throw-away server that already has the roles and the
migrations:

```ts
import { startPostgres } from "@fdp/db-migrate/testing";

const pg = await startPostgres();            // or { migrate: false }
const backend = new Pool({ connectionString: pg.urlFor("app_rw") });
// … pg.adminUrl, pg.urlFor("gt_rw" | "eval"), pg.host, pg.port, pg.container
await pg.stop();
```

It starts `pgvector/pgvector:0.8.6-pg18-trixie` on a host port Docker chooses,
copies `00-roles.sh` into `/docker-entrypoint-initdb.d/` (no bind mount), waits
until the server answers `pg_isready` over TCP and applies `db/migrations`.
Several checkouts may run their suites at the same time; the container carries
an `fdp.worktree` label naming the working copy that started it. Docker is
required, so these suites run under `test:integration`, never under `test`.

## 4. The conformance fixture

`conformance/expected.json` is the contract between the two runners: both test
suites iterate the same file, so a change to one implementation that the other
does not follow turns the other's suite red. It holds seven cases — `basic`,
`rerun`, `hash_change`, `failing`, `out_of_order`, `missing_file`,
`bad_filename` — each a list of steps naming a directory under
`conformance/cases/`, the outcome the runner must produce, and the state the
database must be left in. The file carries nothing language-specific; the
format is documented in its own `about` block.

Adding a case means adding a directory under `conformance/cases/` and an entry
to `expected.json`, and making both suites green.
