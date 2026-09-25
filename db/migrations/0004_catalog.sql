-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- 0004 · The fault catalog, normalised the way the manual states it
-- (docs/plan/05-database.md §4.2, ADR 0013, decision R-10).
--
-- A cause is stored once per document under its `fault_id`; conditions reach
-- it through the `catalog_condition_causes` link table, so the same cause can
-- appear under several conditions without being copied. `signal_moves` use the
-- manual's closed vocabulary (03-contracts.md §2 `signal_move`), not a second
-- direction enum invented here.
--
-- Written by init, read by the backend's retrieval and ticket rendering.
-- The runner wraps this file in a single transaction: no BEGIN/COMMIT here.

-- `array_to_string` is STABLE, not IMMUTABLE, because an array's element
-- output function may depend on a session setting (a timestamptz array reads
-- TimeZone). A stored generated column may only call immutable functions, so
-- the plan's `array_to_string(symptoms, ' ')` in the `catalog_conditions`
-- tsvector below cannot be written directly. For `text[]` the output function
-- is the identity, so the wrapper states the immutability the element type
-- actually has and nothing more (05-database.md §4.2, revision 3).
CREATE FUNCTION app.text_array_to_string(value text[], separator text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN array_to_string(value, separator);
COMMENT ON FUNCTION app.text_array_to_string(text[], text) IS 'array_to_string for text[], declared immutable so a generated tsvector column can call it (05-database.md §4.2).';

CREATE TABLE app.catalog_sections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES app.manual_documents(id) ON DELETE CASCADE,
  section_ref text NOT NULL,
  title text NOT NULL,
  level integer NOT NULL,
  parent_ref text,
  page_start integer,
  page_end integer,
  UNIQUE (document_id, section_ref));
COMMENT ON TABLE app.catalog_sections IS 'One row per manual section, the target of every manual_ref the catalog and the tickets carry (05-database.md §4.2).';

CREATE TABLE app.catalog_conditions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES app.manual_documents(id) ON DELETE CASCADE,
  condition_id text NOT NULL,
  title text NOT NULL,
  symptom text,
  symptoms text[] NOT NULL DEFAULT '{}',
  alarm_codes text[] NOT NULL DEFAULT '{}',
  signals text[] NOT NULL DEFAULT '{}',
  manual_section text,
  page_start integer,
  page_end integer,
  source text NOT NULL CHECK (source IN ('tables', 'llm', 'yaml')),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || coalesce(symptom, '') || ' ' || app.text_array_to_string(symptoms, ' '))) STORED,
  UNIQUE (document_id, condition_id));
COMMENT ON TABLE app.catalog_conditions IS 'One row per observable condition of the catalog contract (03-contracts.md §3.2), the entry point of the fault-finding tables (05-database.md §4.2).';

CREATE TABLE app.catalog_causes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES app.manual_documents(id) ON DELETE CASCADE,
  fault_id text NOT NULL,
  name text NOT NULL,
  summary text NOT NULL DEFAULT '',
  subsystem text NOT NULL CHECK (subsystem IN ('compressor', 'intake_unloading', 'oil', 'cooling', 'separator_drain', 'dryer', 'reservoirs', 'distribution', 'electrical', 'control')),
  benign boolean NOT NULL DEFAULT false,
  remedy text NOT NULL DEFAULT '',
  parts text[] NOT NULL DEFAULT '{}',
  maintenance text[] NOT NULL DEFAULT '{}',
  related_alarms text[] NOT NULL DEFAULT '{}',
  manual_section text,
  manual_anchor text,
  page integer,
  page_start integer,
  page_end integer,
  pages jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL CHECK (source IN ('tables', 'llm', 'yaml')),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', name || ' ' || summary || ' ' || remedy)) STORED,
  UNIQUE (document_id, fault_id));
COMMENT ON TABLE app.catalog_causes IS 'One row per cause, the stored form of the catalog-entry contract (03-contracts.md §3.2) that app.v_catalog_entries reassembles (05-database.md §4.2).';

CREATE TABLE app.catalog_condition_causes (
  condition_pk bigint NOT NULL REFERENCES app.catalog_conditions(id) ON DELETE CASCADE,
  cause_pk bigint NOT NULL REFERENCES app.catalog_causes(id) ON DELETE CASCADE,
  ordinal integer NOT NULL DEFAULT 0,
  likelihood text NOT NULL DEFAULT 'unknown' CHECK (likelihood IN ('common', 'occasional', 'rare', 'unknown')),
  note text,
  PRIMARY KEY (condition_pk, cause_pk));
COMMENT ON TABLE app.catalog_condition_causes IS 'The many-to-many link of the fault-finding tables: which causes a condition lists, in which order and with which likelihood (05-database.md §4.2).';

CREATE INDEX catalog_condition_causes_cause ON app.catalog_condition_causes (cause_pk);

CREATE TABLE app.catalog_checks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cause_pk bigint NOT NULL REFERENCES app.catalog_causes(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  instruction text NOT NULL,
  expected text);
COMMENT ON TABLE app.catalog_checks IS 'The ordered checks of a catalog entry (03-contracts.md §3.2 `checks`), one row per instruction (05-database.md §4.2).';

CREATE TABLE app.catalog_remedies (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cause_pk bigint NOT NULL REFERENCES app.catalog_causes(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  action text NOT NULL,
  post_check text);
COMMENT ON TABLE app.catalog_remedies IS 'The ordered remedy steps of a cause, rendered into a ticket''s remedy text (05-database.md §4.2).';

CREATE TABLE app.catalog_signal_moves (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cause_pk bigint NOT NULL REFERENCES app.catalog_causes(id) ON DELETE CASCADE,
  ordinal integer NOT NULL DEFAULT 0,
  signal_id text,
  behaviour text,
  -- The manual's vocabulary verbatim (R-10): analog, digital and behaviour
  -- directions in one enum. Which direction suits which target kind is a
  -- referential check in the contracts suite, not a constraint here.
  direction text NOT NULL CHECK (direction IN ('rises', 'falls', 'high', 'low', 'unchanged', 'fluctuates', 'near_zero', 'not_venting',
    'on', 'off', 'stays_on', 'stays_off', 'toggles', 'no_pulse', 'higher', 'lower', 'longer', 'shorter', 'faster', 'slower', 'not_reached')),
  phase text NOT NULL DEFAULT 'any' CHECK (phase IN ('loaded', 'unloaded', 'off', 'any', 'start')),
  onset text NOT NULL DEFAULT 'sustained' CHECK (onset IN ('sudden', 'gradual', 'intermittent', 'sustained')),
  note text,
  text text,
  -- Exactly one target, as `signal_move` states it.
  CHECK ((signal_id IS NULL) <> (behaviour IS NULL)));
COMMENT ON TABLE app.catalog_signal_moves IS 'One row per signal_move of a catalog entry (03-contracts.md §2): the movement of one signal or derived behaviour a cause is expected to produce.';

CREATE TABLE app.catalog_alarms (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES app.manual_documents(id) ON DELETE CASCADE,
  code text NOT NULL,
  type text NOT NULL CHECK (type IN ('warning', 'shutdown_warning', 'shutdown', 'service')),
  title text NOT NULL,
  display text,
  trigger_text text,
  signal_id text,
  direction text,
  threshold numeric,
  threshold_unit text,
  delay_s integer,
  reset_rule text,
  bit integer CHECK (bit BETWEEN 0 AND 31),
  manual_section text,
  UNIQUE (document_id, code));
COMMENT ON TABLE app.catalog_alarms IS 'One row per controller alarm the manual documents, keyed by its alarm_code (03-contracts.md §2, 05-database.md §4.2).';

CREATE TABLE app.catalog_signals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES app.manual_documents(id) ON DELETE CASCADE,
  signal_id text NOT NULL,
  panel_label text,
  name text,
  description text,
  unit text,
  "group" text CHECK ("group" IN ('analog', 'digital', 'extra')),
  kind text,
  subsystem text,
  metropt_column text,
  range_min numeric,
  range_max numeric,
  normal_bands jsonb NOT NULL DEFAULT '{}'::jsonb,
  manual_section text,
  UNIQUE (document_id, signal_id));
COMMENT ON TABLE app.catalog_signals IS 'One row per signal the manual documents, including the dataset column it is replayed from (05-database.md §4.2).';

-- One row per cause in the catalog-entry shape of 03-contracts.md §3.2, so
-- retrieval and ticket rendering read the contract instead of re-joining the
-- seven tables above. `jsonb_strip_nulls` inside the nested objects is what
-- keeps an absent `signal` or `note` absent rather than null; the top-level
-- object keeps every key the contract requires.
CREATE VIEW app.v_catalog_entries AS
  SELECT ca.document_id,
         ca.fault_id,
         ca.id AS cause_pk,
         jsonb_build_object(
           'fault_id', ca.fault_id,
           'name', ca.name,
           'subsystem', ca.subsystem,
           'benign', ca.benign,
           'summary', ca.summary,
           'remedy', ca.remedy,
           'parts', to_jsonb(ca.parts),
           'maintenance', to_jsonb(ca.maintenance),
           'related_alarms', to_jsonb(ca.related_alarms),
           'source', ca.source,
           'pages', ca.pages,
           'signal_moves', (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                                     'signal', m.signal_id, 'behaviour', m.behaviour, 'direction', m.direction,
                                     'phase', m.phase, 'onset', m.onset, 'note', m.note, 'text', m.text))
                                   ORDER BY m.ordinal, m.id), '[]'::jsonb)
                              FROM app.catalog_signal_moves m WHERE m.cause_pk = ca.id),
           'signal_moves_text', (SELECT coalesce(jsonb_agg(m.text ORDER BY m.ordinal, m.id) FILTER (WHERE m.text IS NOT NULL), '[]'::jsonb)
                                   FROM app.catalog_signal_moves m WHERE m.cause_pk = ca.id),
           'checks', (SELECT coalesce(jsonb_agg(k.instruction ORDER BY k.ordinal), '[]'::jsonb)
                        FROM app.catalog_checks k WHERE k.cause_pk = ca.id),
           'conditions', (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                                   'condition_id', c.condition_id, 'title', c.title, 'likelihood', cc.likelihood,
                                   'note', cc.note, 'alarms', to_jsonb(c.alarm_codes))) ORDER BY cc.ordinal), '[]'::jsonb)
                            FROM app.catalog_condition_causes cc
                            JOIN app.catalog_conditions c ON c.id = cc.condition_pk
                           WHERE cc.cause_pk = ca.id),
           'manual_ref', jsonb_strip_nulls(jsonb_build_object(
                           'section', ca.manual_section, 'anchor', ca.manual_anchor, 'page', ca.page,
                           'page_start', ca.page_start, 'page_end', ca.page_end))
         ) AS entry
    FROM app.catalog_causes ca;
COMMENT ON VIEW app.v_catalog_entries IS 'One row per cause carrying the catalog-entry contract (03-contracts.md §3.2) as jsonb, for retrieval and ticket rendering.';

-- 0001 already set the default privileges these repeat; see 0003 for why they
-- are stated again. A view is a relation, so the same grant covers it.
REVOKE ALL ON app.catalog_sections, app.catalog_conditions, app.catalog_causes, app.catalog_condition_causes,
              app.catalog_checks, app.catalog_remedies, app.catalog_signal_moves, app.catalog_alarms,
              app.catalog_signals, app.v_catalog_entries
         FROM PUBLIC, gt_rw;
GRANT SELECT, INSERT, UPDATE, DELETE
   ON app.catalog_sections, app.catalog_conditions, app.catalog_causes, app.catalog_condition_causes,
      app.catalog_checks, app.catalog_remedies, app.catalog_signal_moves, app.catalog_alarms, app.catalog_signals
   TO app_rw, eval;
GRANT SELECT ON app.v_catalog_entries TO app_rw, eval;
REVOKE ALL ON FUNCTION app.text_array_to_string(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.text_array_to_string(text[], text) TO app_rw, eval;
