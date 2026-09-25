-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- 0003 · The manual, its ingest runs and the retrieval chunks
-- (docs/plan/05-database.md §4.1, ADR 0031, baseline §9).
--
-- Written by init while it ingests a PDF, read by the backend's retrieval.
-- The runner wraps this file in a single transaction, so it contains no
-- BEGIN/COMMIT and no CREATE INDEX CONCURRENTLY.

CREATE TABLE app.manual_documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  path text NOT NULL,
  -- 'realistic' | 'clean' | 'byo'; free text because the bring-your-own path
  -- may name a variant this repository never renders.
  variant text,
  sha256 char(64) NOT NULL UNIQUE,
  bytes bigint NOT NULL,
  pages integer,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb);
COMMENT ON TABLE app.manual_documents IS 'One row per ingested manual PDF, keyed by the SHA-256 init checks for idempotency (05-database.md §4.1).';

CREATE TABLE app.ingest_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES app.manual_documents(id) ON DELETE CASCADE,
  started_wall_ts timestamptz NOT NULL DEFAULT now(),
  finished_wall_ts timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  -- The embedding identity init compares against packages/contracts/embedding.json:
  -- a succeeded run with the same three values is what lets it skip re-ingestion.
  embedding_model_id text NOT NULL,
  embedding_revision text NOT NULL,
  embedding_dimension integer NOT NULL,
  catalog_source text CHECK (catalog_source IN ('tables', 'llm', 'yaml')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text);
COMMENT ON TABLE app.ingest_runs IS 'One row per ingestion attempt of a manual document, carrying the embedding identity that decides idempotency (05-database.md §4.1).';

CREATE TABLE app.chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES app.manual_documents(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  section_ref text,
  section_title text,
  page_start integer,
  page_end integer,
  kind text NOT NULL CHECK (kind IN ('text', 'table', 'list', 'figure')),
  content text NOT NULL,
  tokens integer,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(section_title, '') || ' ' || content)) STORED,
  -- The one place the embedding width is written down. The contracts suite
  -- asserts this literal equals `dimension` in packages/contracts/embedding.json
  -- (03-contracts.md §7), so it appears exactly once in this file.
  embedding vector(384),
  UNIQUE (document_id, ordinal));
COMMENT ON TABLE app.chunks IS 'One row per retrieval chunk of a manual document: full-text vector, embedding and the section it came from (05-database.md §4.1).';

CREATE INDEX chunks_tsv_gin ON app.chunks USING gin (tsv);
CREATE INDEX chunks_embedding_hnsw ON app.chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX chunks_section_trgm ON app.chunks USING gin (section_ref gin_trgm_ops);

-- 0001 already set the default privileges these repeat. Stating them again
-- keeps the grants of a table visible in the file that creates it, and keeps
-- the app-schema test independent of the ALTER DEFAULT PRIVILEGES mechanism.
REVOKE ALL ON app.manual_documents, app.ingest_runs, app.chunks FROM PUBLIC, gt_rw;
GRANT SELECT, INSERT, UPDATE, DELETE
   ON app.manual_documents, app.ingest_runs, app.chunks
   TO app_rw, eval;
