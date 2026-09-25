-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- 0007 · The cost ledger and the system alerts
-- (docs/plan/05-database.md §4.5, spec §7).
--
-- Cost per decision is tokens times a dated price. The arithmetic lives in the
-- generated column below and nowhere else, so the API, the UI and the
-- evaluation report cannot drift apart on what a run cost.
--
-- The runner wraps this file in a single transaction: no BEGIN/COMMIT here.

CREATE TABLE app.cost_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  decision_id uuid NOT NULL UNIQUE REFERENCES app.decisions(decision_id),
  backend text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  -- The price list is dated, so a re-priced model never rewrites history.
  price_input_per_mtok numeric(12,6) NOT NULL,
  price_output_per_mtok numeric(12,6) NOT NULL DEFAULT 0,
  prices_as_of date NOT NULL,
  cost_usd numeric(16,10) GENERATED ALWAYS AS ((input_tokens * price_input_per_mtok + output_tokens * price_output_per_mtok) / 1000000.0) STORED,
  wall_ts timestamptz NOT NULL DEFAULT now(),
  sim_ts timestamptz);
COMMENT ON TABLE app.cost_ledger IS 'One row per billed decision: tokens, the dated price they were charged at and the cost the generated column derives (05-database.md §4.5).';

CREATE VIEW app.v_cost_totals AS
  SELECT backend,
         model,
         count(*) AS calls,
         sum(input_tokens) AS input_tokens,
         sum(output_tokens) AS output_tokens,
         sum(cost_usd) AS cost_usd
    FROM app.cost_ledger
   GROUP BY backend, model;
COMMENT ON VIEW app.v_cost_totals IS 'Cost and token totals per backend and model, the shape the cost panel and the evaluation report read (05-database.md §4.5).';

CREATE TABLE app.system_alerts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id uuid NOT NULL UNIQUE,
  unit_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('telemetry_silent', 'decision_api_silent')),
  state text NOT NULL CHECK (state IN ('raised', 'cleared')),
  raised_wall_ts timestamptz NOT NULL,
  cleared_wall_ts timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb);
COMMENT ON TABLE app.system_alerts IS 'One row per alert-system message (03-contracts.md §3.2): a source of the pipeline went silent or came back.';

-- 0001 already set the default privileges these repeat; see 0003 for why they
-- are stated again.
REVOKE ALL ON app.cost_ledger, app.system_alerts, app.v_cost_totals FROM PUBLIC, gt_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.cost_ledger, app.system_alerts TO app_rw, eval;
GRANT SELECT ON app.v_cost_totals TO app_rw, eval;
