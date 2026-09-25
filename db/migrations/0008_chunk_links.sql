-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- 0008 · The identifiers a table chunk carries over from the manual
-- (docs/plan/init.md §6.2, docs/plan/05-database.md §1, ADR 0031).
--
-- Additive, and the only migration INI owns. Init sets these three columns
-- while it stores the chunks of a troubleshooting or alarm table, so retrieval
-- can map a chunk to app.catalog_causes or to an alarm code directly instead
-- of matching a section prefix. A text chunk leaves all three NULL, which is
-- why both indexes are partial.
--
-- Column privileges follow the table's, and 0003 already granted app_rw and
-- eval their DML on app.chunks, so there is no GRANT here.
--
-- The runner wraps this file in a single transaction: no BEGIN/COMMIT here,
-- and no CREATE INDEX CONCURRENTLY.

ALTER TABLE app.chunks
  ADD COLUMN fault_id text,        -- set on troubleshooting row chunks (verbatim manual id, init.md §8.5)
  ADD COLUMN alarm_code text,      -- set on alarm row chunks
  ADD COLUMN table_kind text CHECK (table_kind IN ('troubleshooting','alarms','parameters','signals','maintenance','other'));

CREATE INDEX chunks_fault_id_idx ON app.chunks (fault_id) WHERE fault_id IS NOT NULL;
CREATE INDEX chunks_alarm_code_idx ON app.chunks (alarm_code) WHERE alarm_code IS NOT NULL;

COMMENT ON COLUMN app.chunks.fault_id IS 'Cause id printed in the troubleshooting row this chunk was built from; lets retrieval map a table chunk to app.catalog_causes without a section prefix match';
