<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# The `postgres` service

The store behind the whole PoC: the manual catalog and its chunk embeddings, telemetry, events, decisions, tickets
and the cost ledger. It is a stock image with a mounted init script — nothing is built here.

The schema, the migrations and the role grants are in [`db/README.md`](../../db/README.md); how the service is wired
into the stack is in [`docs/architecture.md`](../../docs/architecture.md#persistence).

## Image

`pgvector/pgvector:0.8.6-pg18-trixie` — PostgreSQL 18.6 with pgvector 0.8.6 on Debian 13, amd64 and arm64, so the
extension needs no build of its own. Every testcontainers helper in the repository starts the same tag, so migrations
are tested against the major the stack runs.

## The volume path, and why it matters

PostgreSQL 18 moved the cluster to `/var/lib/postgresql/18/docker` and declares its volume one level up:

```yaml
volumes:
  - pgdata:/var/lib/postgresql # not /var/lib/postgresql/data
```

Mounting the pre-18 `/var/lib/postgresql/data` path would not fail. The server would initialise a cluster in the
declared, anonymous volume instead, the named `pgdata` volume would stay empty, and the database would be gone after
the next `docker compose down`. `make compose-check` asserts the target for exactly that reason.

## Roles

`initdb/00-roles.sh` creates the three login roles:

| Role | Password from | Used by |
| --- | --- | --- |
| `app_rw` | `PG_APP_PASSWORD` (`app_rw`) | the backend's diagnosis pool; reads and writes `app`, nothing on `gt` |
| `gt_rw` | `PG_GT_PASSWORD` (`gt_rw`) | the backend's overlay module, the only writer of the answer schema `gt`; nothing on `app` |
| `eval` | `PG_EVAL_PASSWORD` (`eval`) | the evaluation tool; reads and writes `app`, reads `gt` only |

The init container connects as `POSTGRES_USER`, not as one of these roles: it applies the migrations, which makes it the
owner of `app` and `gt`, and it writes the ingested manual and catalog as that owner.

Compose mounts the directory read-only at `/docker-entrypoint-initdb.d`. The official entrypoint runs it **once**, as
`POSTGRES_USER`, and only while the data directory is still empty. Migrations never create a role; they only grant and
revoke, and the first one refuses to run when a role is missing.

## Environment

| Variable | Default | What it does |
| --- | --- | --- |
| `POSTGRES_USER` | `fdp_admin` | superuser the init container runs migrations as |
| `POSTGRES_PASSWORD` | `fdp_admin` | its password |
| `POSTGRES_DB` | `fdp` | the database `00-roles.sh` and every service connect to |
| `PG_APP_PASSWORD`, `PG_GT_PASSWORD`, `PG_EVAL_PASSWORD` | `app_rw`, `gt_rw`, `eval` | read by `00-roles.sh` |

These are PoC defaults, not secrets: the base stack publishes no database port, so only the Compose network reaches
it unless `make up-dev` publishes 5432. The backend never receives a
connection URL: Compose passes it `PG_HOST`, `PG_PORT`, `POSTGRES_DB` and the two role passwords, and it composes the
URLs itself.

## After a password change

Changing `PG_APP_PASSWORD`, `PG_GT_PASSWORD` or `PG_EVAL_PASSWORD` in `.env` has no effect on an existing volume: the
roles already exist, so the init script does not run again. Re-create them with

```sh
make reset-db   # stop the stack and delete the pgdata volume only
make up
```

The next start re-creates the roles, re-applies the migrations and re-ingests the manual with the cached embedding
model. `make reset` does the same but runs `docker compose down -v`, so it also drops the `model-cache` volume and the
model is downloaded again (≈ 91 MB).

## Health

`pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"` every 5 s, 12 retries after a 10 s grace period. `init` and
`backend` wait for `service_healthy`, so a slow first start delays them instead of failing them.

## Reaching the database by hand

The base stack publishes no port. `make up-dev` adds the fixed mapping of `compose.dev.yaml`:

```sh
psql "postgres://eval:eval@localhost:5432/fdp"
```

In CI the same service is published on an ephemeral loopback port instead, so a stack the smoke test left running can
be scored without colliding with anything else on the machine:

```sh
docker compose -p "$PROJECT" port postgres 5432
```

There is no `postgresql.conf` tuning in this PoC; the image defaults carry the workload.
