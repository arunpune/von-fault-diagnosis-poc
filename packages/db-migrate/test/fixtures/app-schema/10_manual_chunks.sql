-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- One manual document, one succeeded ingest run and two chunks, written as
-- `app_rw` by test/integration/app-schema.test.ts.
--
-- Every row is reached by its natural key rather than by a generated id, so
-- the fixtures do not depend on where an identity sequence happens to stand.
-- The two embeddings are built from `generate_series` instead of a pasted
-- literal: 384 components each, deterministic, and not parallel to each other
-- so a cosine ordering between them is meaningful.

INSERT INTO app.manual_documents (name, path, variant, sha256, bytes, pages, meta)
VALUES ('operator-manual', 'data/manual/operator-manual.pdf', 'realistic',
        repeat('a', 64), 1048576, 120, '{"revision": "r1"}'::jsonb);

INSERT INTO app.ingest_runs (document_id, finished_wall_ts, status,
                             embedding_model_id, embedding_revision, embedding_dimension,
                             catalog_source, stats)
SELECT d.id, now(), 'succeeded', 'sentence-embedder-small', 'r1', 384, 'tables', '{"chunks": 2}'::jsonb
  FROM app.manual_documents d
 WHERE d.sha256 = repeat('a', 64);

INSERT INTO app.chunks (document_id, ordinal, section_ref, section_title,
                        page_start, page_end, kind, content, tokens, embedding)
SELECT d.id, 0, '8.2.3', 'Separator drain valve', 12, 13, 'text',
       'The separator drain valve vents condensate once per unloaded cycle.', 14,
       (SELECT ('[' || string_agg(((i % 10) + 1)::text, ',' ORDER BY i) || ']')::vector
          FROM generate_series(0, 383) AS g(i))
  FROM app.manual_documents d
 WHERE d.sha256 = repeat('a', 64);

INSERT INTO app.chunks (document_id, ordinal, section_ref, section_title,
                        page_start, page_end, kind, content, tokens, embedding)
SELECT d.id, 1, '9.1.0', 'Dryer tower switching', 20, 21, 'text',
       'The dryer towers alternate every two minutes while the unit is loaded.', 16,
       (SELECT ('[' || string_agg((10 - (i % 10))::text, ',' ORDER BY i) || ']')::vector
          FROM generate_series(0, 383) AS g(i))
  FROM app.manual_documents d
 WHERE d.sha256 = repeat('a', 64);
