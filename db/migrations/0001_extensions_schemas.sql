-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- 0001 · Extensions, the two schemas and the privileges that separate them
-- (docs/plan/05-database.md §2, ADR 0031, ADR 0032, spec rule 3).
--
-- The runner wraps this file in a single transaction, so it contains no
-- BEGIN/COMMIT and nothing that refuses to run inside one.

-- The roles come from infra/postgres/initdb/00-roles.sh, which the PostgreSQL
-- entrypoint runs once on an empty data directory. Without them every GRANT
-- below would fail one at a time; fail loudly and name the fix instead.
DO $guard$
DECLARE
  missing text;
BEGIN
  SELECT expected.rolname
    INTO missing
    FROM (VALUES ('app_rw'), ('gt_rw'), ('eval')) AS expected(rolname)
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE pg_roles.rolname = expected.rolname)
   ORDER BY expected.rolname
   LIMIT 1;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'role % missing: run infra/postgres/initdb/00-roles.sh', missing;
  END IF;
END
$guard$;

-- pgvector for the chunk embeddings (0003), pg_trgm for fuzzy section lookup.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- `app` is the diagnosis side, `gt` the ground-truth overlay. Nothing joins
-- them in the database: the two are only ever read together by the evaluation
-- harness, which connects as `eval`.
CREATE SCHEMA app;
CREATE SCHEMA gt;
COMMENT ON SCHEMA app IS 'Diagnosis side: manual chunks, catalog, telemetry aggregates, events, decisions, tickets, cost.';
COMMENT ON SCHEMA gt IS 'Ground truth: injection windows, sim markers and catalog snapshots. Never readable by app_rw (spec rule 3).';

REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON SCHEMA gt FROM PUBLIC;

GRANT USAGE ON SCHEMA app TO app_rw, eval;
GRANT USAGE ON SCHEMA gt TO gt_rw, eval;

-- Default privileges for the role that runs the migrations, so every table a
-- later migration creates in these schemas is reachable without repeating the
-- grants. 0002 and the CON-03 files still state their grants explicitly, and
-- the isolation test asserts the outcome rather than the mechanism.
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw, eval;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw, eval;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO app_rw, eval;

ALTER DEFAULT PRIVILEGES IN SCHEMA gt
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gt_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA gt
  GRANT SELECT ON TABLES TO eval;
