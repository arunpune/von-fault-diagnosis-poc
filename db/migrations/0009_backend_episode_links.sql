-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- 0009 · The link a merged episode carries to the episode that owns its ticket
-- (docs/plan/backend.md §10 and §16, ADR 0061, decisions R-29 and R-53).
--
-- The only migration the backend owns, and additive as db/README.md §1 asks:
-- `app.episodes.merged_into` is already declared by CON's 0006 (05-database.md
-- §4.4 carries BE's columns), so this file adds what 0006 left out rather than
-- a second definition of the column — the sentence that says what the column
-- means, and the index the lookup behind it needs.
--
-- Merge, in one line: when the first answered decision of a new episode names
-- the same `fault_id` as another open episode that still owns an active
-- ticket, the new episode stays open — so its key does not re-open on every
-- event — but points at that episode, and its later decisions update that
-- episode's ticket instead of opening a second one for the same fault.
--
-- The index is partial because `merged_into` is NULL on every episode that was
-- not merged, which is nearly all of them; the lookup only ever asks for the
-- rows that point somewhere.
--
-- Applies after INI's 0008 (R-29); the runner refuses an out-of-order file.
-- It wraps this file in a single transaction: no BEGIN/COMMIT here, and no
-- CREATE INDEX CONCURRENTLY.

COMMENT ON COLUMN app.episodes.merged_into IS 'Open episode whose ticket this episode''s decisions update, because its first answered decision named the same fault_id (backend.md §10)';

CREATE INDEX episodes_merged_into_idx ON app.episodes (merged_into) WHERE merged_into IS NOT NULL;
