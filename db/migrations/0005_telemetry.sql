-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- 0005 · Telemetry aggregates, native alarms, heartbeats and retention
-- (docs/plan/05-database.md §4.3, spec §8.5, baseline §9).
--
-- Raw samples are never stored: the backend's ingest folds them into one row
-- per unit, minute and signal, and prunes by simulated time.
--
-- The runner wraps this file in a single transaction: no BEGIN/COMMIT here.

CREATE TABLE app.telemetry_agg_1m (
  unit_id text NOT NULL,
  minute_sim_ts timestamptz NOT NULL,
  signal_id text NOT NULL,
  n integer NOT NULL CHECK (n > 0),
  min double precision,
  max double precision,
  avg double precision,
  last double precision,
  -- Fraction of true samples; NULL for analog signals.
  duty double precision CHECK (duty BETWEEN 0 AND 1),
  -- A discontinuity flag fell inside this minute, so the minute may not be
  -- compared with its neighbours.
  discontinuity boolean NOT NULL DEFAULT false,
  PRIMARY KEY (unit_id, minute_sim_ts, signal_id));
COMMENT ON TABLE app.telemetry_agg_1m IS 'One row per unit, minute of simulated time and signal: the folded telemetry contract the rules and the UI charts read (05-database.md §4.3).';

CREATE INDEX telemetry_agg_1m_lookup ON app.telemetry_agg_1m (unit_id, signal_id, minute_sim_ts DESC);

CREATE TABLE app.native_alarms (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id text NOT NULL,
  code text NOT NULL,
  state text NOT NULL CHECK (state IN ('raised', 'cleared')),
  sim_ts timestamptz NOT NULL,
  wall_ts timestamptz NOT NULL DEFAULT now(),
  seq bigint);
COMMENT ON TABLE app.native_alarms IS 'One row per alarm-native message (03-contracts.md §3.2): a controller alarm the simulated unit raised or cleared.';

CREATE INDEX native_alarms_lookup ON app.native_alarms (unit_id, sim_ts DESC);

CREATE TABLE app.heartbeats (
  source text PRIMARY KEY CHECK (source IN ('telemetry', 'decision_api')),
  status text NOT NULL CHECK (status IN ('ok', 'silent', 'unknown')),
  last_ok_wall_ts timestamptz,
  last_seen_wall_ts timestamptz,
  consecutive_errors integer NOT NULL DEFAULT 0,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb);
COMMENT ON TABLE app.heartbeats IS 'One row per watched source, the liveness the system alerts of 0007 are raised from (05-database.md §4.3).';

-- Both sources exist from the first migration on, so the backend updates a row
-- it never has to create and the UI can render `unknown` before anything runs.
INSERT INTO app.heartbeats (source, status) VALUES ('telemetry', 'unknown'), ('decision_api', 'unknown');

-- Retention by simulated time (spec §8.5): the backend calls this every ten
-- wall minutes with TELEMETRY_RETENTION_SIM_DAYS and the current sim_ts. It
-- returns how many minutes it removed, so the caller can log one number.
CREATE FUNCTION app.prune_telemetry_agg(retention_days integer, now_sim_ts timestamptz) RETURNS bigint LANGUAGE sql AS $$
  WITH d AS (
    DELETE FROM app.telemetry_agg_1m
     WHERE minute_sim_ts < now_sim_ts - make_interval(days => retention_days)
    RETURNING 1)
  SELECT count(*) FROM d
$$;
COMMENT ON FUNCTION app.prune_telemetry_agg(integer, timestamptz) IS 'Delete telemetry minutes older than retention_days before now_sim_ts and return how many were removed (05-database.md §4.3).';

-- 0001 already set the default privileges these repeat; see 0003 for why they
-- are stated again.
REVOKE ALL ON app.telemetry_agg_1m, app.native_alarms, app.heartbeats FROM PUBLIC, gt_rw;
REVOKE ALL ON FUNCTION app.prune_telemetry_agg(integer, timestamptz) FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
   ON app.telemetry_agg_1m, app.native_alarms, app.heartbeats
   TO app_rw, eval;
GRANT EXECUTE ON FUNCTION app.prune_telemetry_agg(integer, timestamptz) TO app_rw, eval;
