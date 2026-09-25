-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- 0006 · Suspect events, episodes, decisions, tickets and their closures
-- (docs/plan/05-database.md §4.4, backend.md §10, baseline §11, decision R-53).
--
-- Written by the backend pipeline and by the evaluation harness during replays.
-- Column names follow the contracts of 03-contracts.md §3.2 verbatim, so a row
-- here and the message that produced it use the same words.
--
-- R-53 (revision 1): there is no `app.review_queue`. A `review` gate outcome
-- is a ticket with status `review`, promoted to `open` by a later decision at
-- or above the ticket threshold, so review work is one query over app.tickets.
--
-- The runner wraps this file in a single transaction: no BEGIN/COMMIT here.

CREATE TABLE app.suspect_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  unit_id text NOT NULL,
  sim_ts timestamptz NOT NULL,
  wall_ts timestamptz NOT NULL,
  -- No foreign key: the event is written before the episode it will belong to
  -- exists, and app.episodes points back at its first event instead.
  episode_id uuid,
  symptom_key text NOT NULL,
  rule_ids text[] NOT NULL,
  machine_mode text NOT NULL,
  evidence jsonb NOT NULL,
  observations jsonb NOT NULL,
  active_alarms text[] NOT NULL DEFAULT '{}',
  co_symptoms text[] NOT NULL DEFAULT '{}',
  ambient text NOT NULL DEFAULT 'unknown',
  window_from_sim_ts timestamptz NOT NULL,
  window_to_sim_ts timestamptz NOT NULL,
  -- The full suspect-event message as published.
  payload jsonb NOT NULL);
COMMENT ON TABLE app.suspect_events IS 'One row per suspect-event message (03-contracts.md §3.2): the rules fired, what they saw and the window they saw it in.';

CREATE INDEX suspect_events_lookup ON app.suspect_events (unit_id, sim_ts DESC);

CREATE TABLE app.episodes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  episode_id uuid NOT NULL UNIQUE,
  unit_id text NOT NULL,
  symptom_key text NOT NULL,
  symptom_keys text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('open', 'closed', 'aborted')),
  merged_into uuid REFERENCES app.episodes(episode_id),
  opened_sim_ts timestamptz NOT NULL,
  last_event_sim_ts timestamptz NOT NULL,
  last_decision_sim_ts timestamptz,
  closed_sim_ts timestamptz,
  close_reason text CHECK (close_reason IN ('silence', 'discontinuity', 'manual')),
  first_event_id uuid NOT NULL REFERENCES app.suspect_events(event_id),
  -- No foreign key: a ticket is created from an episode, so the episode row
  -- exists first and app.tickets carries the constrained side of the link.
  ticket_id uuid,
  closed_by_technician boolean NOT NULL DEFAULT false,
  event_count integer NOT NULL DEFAULT 0,
  decision_count integer NOT NULL DEFAULT 0);
COMMENT ON TABLE app.episodes IS 'One row per episode (backend.md §10): the run of suspect events and decisions about one symptom on one unit.';

-- Baseline §11: one open episode per (unit_id, symptom_key). A closed or
-- aborted episode leaves the pair free again.
CREATE UNIQUE INDEX episodes_one_open ON app.episodes (unit_id, symptom_key) WHERE status = 'open';

CREATE TABLE app.decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  decision_id uuid NOT NULL UNIQUE,
  episode_id uuid NOT NULL REFERENCES app.episodes(episode_id),
  event_id uuid NOT NULL REFERENCES app.suspect_events(event_id),
  unit_id text NOT NULL,
  sim_ts timestamptz NOT NULL,
  wall_ts timestamptz NOT NULL,
  backend text NOT NULL CHECK (backend IN ('jev', 'llm', 'rules')),
  model text NOT NULL,
  status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed')),
  choice text NOT NULL,
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  probabilities jsonb NOT NULL,
  support jsonb NOT NULL DEFAULT '{}'::jsonb,
  severity_level text NOT NULL CHECK (severity_level IN ('low', 'medium', 'high', 'critical')),
  severity_score real NOT NULL,
  severity_probabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  severity_confidence real NOT NULL,
  gate_outcome text NOT NULL CHECK (gate_outcome IN ('ticket', 'review', 'log')),
  abstained boolean NOT NULL DEFAULT false,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  state jsonb NOT NULL,
  state_digest char(64) NOT NULL,
  -- Raw provider bodies; the backend strips credentials before they get here,
  -- so no key value is ever stored (spec rule 7).
  request jsonb,
  response jsonb,
  request_id text,
  rationale text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  latency_ms integer,
  error jsonb,
  -- The decision contract as published.
  message jsonb NOT NULL);
COMMENT ON TABLE app.decisions IS 'One row per decision message (03-contracts.md §3.2): what the backend asked, what came back and what the confidence gate did with it.';

CREATE INDEX decisions_lookup ON app.decisions (unit_id, sim_ts DESC);
CREATE INDEX decisions_episode ON app.decisions (episode_id, sim_ts DESC);

CREATE TABLE app.decision_candidates (
  decision_id uuid NOT NULL REFERENCES app.decisions(decision_id) ON DELETE CASCADE,
  rank integer NOT NULL,
  fault_id text NOT NULL,
  condition_id text NOT NULL,
  name text NOT NULL,
  probability real NOT NULL,
  support real,
  benign boolean NOT NULL DEFAULT false,
  manual_ref jsonb NOT NULL,
  retrieval jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (decision_id, fault_id));
COMMENT ON TABLE app.decision_candidates IS 'The ranked candidates of a decision, one row each, so the UI and the harness can join on fault_id (05-database.md §4.4).';

CREATE TABLE app.tickets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id uuid NOT NULL UNIQUE,
  episode_id uuid NOT NULL UNIQUE REFERENCES app.episodes(episode_id),
  unit_id text NOT NULL,
  -- R-53: `review` is a ticket status, not a separate queue.
  status text NOT NULL CHECK (status IN ('review', 'open', 'resolved', 'closed')),
  fault_id text NOT NULL,
  condition_id text NOT NULL,
  title text NOT NULL,
  cause text NOT NULL,
  remedy text NOT NULL,
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  manual_ref jsonb NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence real NOT NULL,
  probabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  severity_level text NOT NULL,
  backend text NOT NULL,
  model text NOT NULL,
  rationale text,
  latest_decision_id uuid NOT NULL REFERENCES app.decisions(decision_id),
  opened_sim_ts timestamptz NOT NULL,
  updated_sim_ts timestamptz NOT NULL,
  resolved_sim_ts timestamptz,
  close_reason text CHECK (close_reason IN ('silence', 'discontinuity', 'technician')),
  opened_wall_ts timestamptz NOT NULL DEFAULT now(),
  updated_wall_ts timestamptz NOT NULL DEFAULT now(),
  resolved_wall_ts timestamptz,
  update_count integer NOT NULL DEFAULT 0);
COMMENT ON TABLE app.tickets IS 'One row per ticket (03-contracts.md §3.2), at most one per episode; status review is the confidence gate''s review outcome (R-53).';

CREATE TABLE app.ticket_closures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES app.tickets(ticket_id),
  verdict text NOT NULL CHECK (verdict IN ('correct', 'wrong')),
  note text,
  closed_by text,
  sim_ts timestamptz NOT NULL,
  wall_ts timestamptz NOT NULL DEFAULT now());
COMMENT ON TABLE app.ticket_closures IS 'One row per ticket-closure message (03-contracts.md §3.2): the technician''s verdict on a ticket (R-28).';

-- 0001 already set the default privileges these repeat; see 0003 for why they
-- are stated again. `eval` writes these tables during scenario replays.
REVOKE ALL ON app.suspect_events, app.episodes, app.decisions, app.decision_candidates,
              app.tickets, app.ticket_closures
         FROM PUBLIC, gt_rw;
GRANT SELECT, INSERT, UPDATE, DELETE
   ON app.suspect_events, app.episodes, app.decisions, app.decision_candidates,
      app.tickets, app.ticket_closures
   TO app_rw, eval;
