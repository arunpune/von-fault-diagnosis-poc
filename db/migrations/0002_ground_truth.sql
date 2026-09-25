-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- 0002 · The ground-truth overlay schema (docs/plan/05-database.md §5, ADR 0032).
--
-- Written by the backend's overlay module as `gt_rw`, read by the evaluation
-- harness as `eval`. There are no foreign keys between `gt` and `app` in either
-- direction; the harness joins on `sim_ts` in code. `app_rw` has no USAGE on
-- this schema, so a diagnosis query naming a table below fails with 42501
-- (spec rule 3, asserted by the isolation test).
--
-- The runner wraps this file in a single transaction: no BEGIN/COMMIT here.

CREATE TABLE gt.injections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id text NOT NULL,
  instance_id text NOT NULL,
  injection_id text NOT NULL,
  fault_id text NOT NULL,
  event text NOT NULL CHECK (event IN ('start', 'stop')),
  sim_ts timestamptz NOT NULL,
  wall_ts timestamptz NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  ends_sim_ts timestamptz,
  reason text CHECK (reason IN ('expired', 'cleared', 'jump', 'reset')),
  -- SIM emits one start and at most one stop per instance_id
  -- (docs/plan/06-simulation.md §7.6, decision R-11).
  UNIQUE (unit_id, instance_id, event));
COMMENT ON TABLE gt.injections IS 'One row per gt-injection message (03-contracts.md §3.2): the start and optional stop of an injected fault instance.';

CREATE TABLE gt.markers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('jump', 'reset', 'loop')),
  preset_id text,
  sim_ts_from timestamptz NOT NULL,
  sim_ts_to timestamptz NOT NULL,
  wall_ts timestamptz NOT NULL);
COMMENT ON TABLE gt.markers IS 'One row per gt-marker message (03-contracts.md §3.2): a jump, reset or loop in simulated time.';

CREATE TABLE gt.catalog_snapshot (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id text NOT NULL,
  received_wall_ts timestamptz NOT NULL DEFAULT now(),
  payload_sha256 char(64) NOT NULL UNIQUE,
  payload jsonb NOT NULL);
COMMENT ON TABLE gt.catalog_snapshot IS 'One row per distinct gt-catalog message (03-contracts.md §3.2), deduplicated by the SHA-256 of its payload.';

-- One row per injected instance, with the end the stop reported or, while no
-- stop has arrived, the end the start announced.
CREATE VIEW gt.v_injection_windows AS
  SELECT s.unit_id,
         s.instance_id,
         s.injection_id,
         s.fault_id,
         s.sim_ts AS start_sim_ts,
         coalesce(e.sim_ts, s.ends_sim_ts) AS end_sim_ts,
         e.reason,
         s.params
    FROM gt.injections s
    LEFT JOIN gt.injections e
      ON e.unit_id = s.unit_id AND e.instance_id = s.instance_id AND e.event = 'stop'
   WHERE s.event = 'start';
COMMENT ON VIEW gt.v_injection_windows IS 'The injection windows the evaluation harness scores against, one row per gt-injection start.';

-- 0001 already set the default privileges these repeat. Stating them again
-- keeps the isolation test independent of the ALTER DEFAULT PRIVILEGES
-- mechanism, and keeps the grants of a table visible in the file that creates it.
REVOKE ALL ON SCHEMA gt FROM PUBLIC, app_rw;
REVOKE ALL ON ALL TABLES IN SCHEMA gt FROM app_rw;
GRANT USAGE ON SCHEMA gt TO gt_rw, eval;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gt TO gt_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA gt TO eval;
-- No sequence grants: the identity columns above are filled by a NextValueExpr,
-- which does not check the sequence ACL the way a `serial` default would.
