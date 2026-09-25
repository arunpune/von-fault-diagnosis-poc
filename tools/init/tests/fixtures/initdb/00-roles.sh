#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# The three login roles the stack uses (db/README.md, "Roles").
#
# The PostgreSQL entrypoint runs everything in /docker-entrypoint-initdb.d once,
# as POSTGRES_USER, and only while the data directory is still empty. Compose
# mounts this directory read-only; the testcontainers helper of
# @fdp/db-migrate copies this one file in. Re-create the roles after a password
# change with `make reset`, which drops the volume.
#
# The passwords are PoC defaults, not secrets (docs/security.md, "The PoC defaults").
# Migrations never create roles: they only GRANT and REVOKE, and 0001 refuses to
# run when one of the three is missing.

set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE ROLE app_rw LOGIN PASSWORD '${PG_APP_PASSWORD:-app_rw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  CREATE ROLE gt_rw  LOGIN PASSWORD '${PG_GT_PASSWORD:-gt_rw}'  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  CREATE ROLE eval   LOGIN PASSWORD '${PG_EVAL_PASSWORD:-eval}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  -- The migration runner creates public.schema_migrations as this same role,
  -- after this script has run, so a default privilege is the only way to make
  -- the bookkeeping table readable by the three login roles without editing an
  -- applied migration (db/README.md: append-only, never edit an applied file).
  -- The backend reads it at start-up to refuse to run against a database that
  -- init has not migrated yet. Nothing else of this stack puts
  -- a table in schema public, so this grants exactly that one table.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO app_rw, gt_rw, eval;
  ALTER ROLE app_rw SET search_path = app, public;
  ALTER ROLE gt_rw  SET search_path = gt, public;
  ALTER ROLE eval   SET search_path = app, gt, public;
SQL
