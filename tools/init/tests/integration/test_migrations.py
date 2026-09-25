# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``db/migrations`` applied for real, on a fresh pgvector database.

The conformance suite pins the runner's behaviour; this one pins that the
schema the repository actually ships goes in through it: ``0001`` to ``0007``
and init's ``0008_chunk_links.sql``, with the ground truth still out of
``app_rw``'s reach afterwards (ground-truth isolation).

It also pins the one driver assumption the runner rests on: pg8000 sends a
parameterless ``run`` over the simple-query protocol, so a file goes in as one
multi-statement batch — dollar-quoted ``DO`` blocks included — and the server
aborts it as a whole.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from fdp_init.migrate import MigrationError, list_migrations, migrate, status

from .conftest import ROOT, FreshDatabase

pytestmark = pytest.mark.integration

MIGRATIONS = ROOT / "db" / "migrations"

CON_03_FILE = MIGRATIONS / "0003_manual_chunks.sql"

EMBEDDING_TYPE = "vector(384)"
"""The one place the width is written down is ``0003``; the contracts suite
pins it against ``packages/contracts/embedding.json``."""

TABLE_KINDS = (
    "troubleshooting",
    "alarms",
    "parameters",
    "signals",
    "maintenance",
    "other",
)

needs_con_03 = pytest.mark.skipif(
    not CON_03_FILE.is_file(), reason="db/migrations/0003_manual_chunks.sql is absent"
)


def quiet(_line: str) -> None:
    """Swallow the runner's log lines; the conformance suite checks them."""


@pytest.fixture
def migrated(fresh_db: FreshDatabase) -> FreshDatabase:
    """A database with the whole of ``db/migrations`` applied."""
    migrate(fresh_db.admin, MIGRATIONS, log=quiet)
    return fresh_db


def scalar(conn: Any, sql: str, **params: object) -> Any:
    """The first column of the first row."""
    return conn.run(sql, **params)[0][0]


@needs_con_03
def test_every_migration_applies_in_order(fresh_db: FreshDatabase) -> None:
    files = list_migrations(MIGRATIONS)
    assert [migration.version for migration in files] == list(range(1, len(files) + 1)), (
        "db/migrations is numbered 0001..N without a gap"
    )

    result = migrate(fresh_db.admin, MIGRATIONS, log=quiet)

    assert [migration.file for migration in result.applied] == [
        migration.file for migration in files
    ]
    assert result.skipped == 0
    rows = fresh_db.admin.run(
        "SELECT version, name, sha256 FROM public.schema_migrations ORDER BY version"
    )
    assert [(int(v), n, s) for v, n, s in rows] == [
        (migration.version, migration.name, migration.sha256) for migration in files
    ]


@needs_con_03
def test_a_second_run_applies_nothing(migrated: FreshDatabase) -> None:
    result = migrate(migrated.admin, MIGRATIONS, log=quiet)

    assert result.applied == []
    assert result.skipped == len(list_migrations(MIGRATIONS))


@needs_con_03
def test_status_reports_everything_applied(migrated: FreshDatabase) -> None:
    result = status(migrated.admin, MIGRATIONS)

    assert [migration.file for migration in result.applied] == [
        migration.file for migration in list_migrations(MIGRATIONS)
    ]
    assert result.pending == []


@needs_con_03
def test_0008_adds_the_three_chunk_link_columns(migrated: FreshDatabase) -> None:
    rows = migrated.admin.run(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
        "WHERE table_schema = 'app' AND table_name = 'chunks' "
        "AND column_name IN ('fault_id', 'alarm_code', 'table_kind') "
        "ORDER BY column_name"
    )

    assert [(name, kind, nullable) for name, kind, nullable in rows] == [
        ("alarm_code", "text", "YES"),
        ("fault_id", "text", "YES"),
        ("table_kind", "text", "YES"),
    ]


@needs_con_03
@pytest.mark.parametrize(
    ("index", "column"),
    [("chunks_fault_id_idx", "fault_id"), ("chunks_alarm_code_idx", "alarm_code")],
)
def test_0008_adds_a_partial_index_per_link_column(
    migrated: FreshDatabase, index: str, column: str
) -> None:
    definition = scalar(
        migrated.admin,
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'app' AND indexname = :name",
        name=index,
    )

    assert definition is not None, f"{index} is missing"
    assert f"({column})" in definition
    assert f"WHERE ({column} IS NOT NULL)" in definition


@needs_con_03
@pytest.mark.parametrize("kind", TABLE_KINDS)
def test_table_kind_accepts_the_listed_vocabulary(migrated: FreshDatabase, kind: str) -> None:
    conn = migrated.admin
    document = scalar(
        conn,
        "INSERT INTO app.manual_documents (name, path, sha256, bytes) "
        "VALUES ('m', 'm.pdf', :sha, 1) RETURNING id",
        sha="0" * 64,
    )
    conn.run(
        "INSERT INTO app.chunks (document_id, ordinal, kind, content, table_kind) "
        "VALUES (:doc, 1, 'table', 'body', :kind)",
        doc=document,
        kind=kind,
    )

    assert scalar(conn, "SELECT count(*) FROM app.chunks WHERE table_kind = :k", k=kind) == 1


@needs_con_03
def test_table_kind_refuses_a_word_outside_the_vocabulary(migrated: FreshDatabase) -> None:
    conn = migrated.admin
    document = scalar(
        conn,
        "INSERT INTO app.manual_documents (name, path, sha256, bytes) "
        "VALUES ('m', 'm.pdf', :sha, 1) RETURNING id",
        sha="1" * 64,
    )

    with pytest.raises(Exception, match="chunks_table_kind_check"):
        conn.run(
            "INSERT INTO app.chunks (document_id, ordinal, kind, content, table_kind) "
            "VALUES (:doc, 1, 'table', 'body', 'schematics')",
            doc=document,
        )


@needs_con_03
def test_the_embedding_column_is_the_contract_width(migrated: FreshDatabase) -> None:
    kind = scalar(
        migrated.admin,
        "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
        "WHERE attrelid = 'app.chunks'::regclass AND attname = 'embedding'",
    )

    assert kind == EMBEDDING_TYPE


@needs_con_03
def test_gt_stays_out_of_reach_of_the_diagnosis_role(migrated: FreshDatabase) -> None:
    """Ground-truth isolation, re-asserted after migrate; the full suite is the database's own."""
    conn = migrated.admin

    assert scalar(conn, "SELECT has_schema_privilege('app_rw', 'gt', 'USAGE')") is False
    assert scalar(conn, "SELECT has_schema_privilege('app_rw', 'app', 'USAGE')") is True

    app_rw = migrated.connect_as("app_rw")
    assert app_rw.run("SELECT count(*) FROM app.chunks")[0][0] == 0
    with pytest.raises(Exception, match="permission denied"):
        app_rw.run("SELECT count(*) FROM gt.injections")


@needs_con_03
def test_editing_an_applied_file_is_refused(migrated: FreshDatabase, tmp_path: Path) -> None:
    """The hash check, against the real set rather than a fixture."""
    copy = tmp_path / "migrations"
    copy.mkdir()
    for migration in list_migrations(MIGRATIONS):
        (copy / migration.file).write_bytes(migration.path.read_bytes())
    edited = copy / "0008_chunk_links.sql"
    edited.write_text(edited.read_text(encoding="utf-8") + "-- edited\n", encoding="utf-8")

    with pytest.raises(MigrationError) as raised:
        migrate(migrated.admin, copy, log=quiet)

    assert str(raised.value.code) == "hash_mismatch"
    assert raised.value.file == "0008_chunk_links.sql"


def test_pg8000_runs_a_file_as_one_multi_statement_batch(
    fresh_db: FreshDatabase, tmp_path: Path
) -> None:
    """The runner's driver assumption, stated as a test.

    A parameterless ``run`` goes over the simple-query protocol, so several
    statements and a dollar-quoted ``DO`` body survive without the runner
    splitting anything. If this ever failed, the runner would need the
    statement splitter it does without today.
    """
    (tmp_path / "0001_batch.sql").write_text(
        "CREATE TABLE public.one (id integer PRIMARY KEY);\n"
        "INSERT INTO public.one (id) VALUES (1);\n"
        "DO $body$ BEGIN\n"
        "  CREATE TABLE public.two (note text NOT NULL DEFAULT 'semicolon; inside');\n"
        "  INSERT INTO public.two DEFAULT VALUES;\n"
        "END $body$;\n",
        encoding="utf-8",
    )

    result = migrate(fresh_db.admin, tmp_path, log=quiet)

    assert [migration.file for migration in result.applied] == ["0001_batch.sql"]
    assert scalar(fresh_db.admin, "SELECT count(*) FROM public.one") == 1
    assert scalar(fresh_db.admin, "SELECT note FROM public.two") == "semicolon; inside"


def test_a_batch_that_fails_halfway_leaves_nothing_behind(
    fresh_db: FreshDatabase, tmp_path: Path
) -> None:
    """The per-file transaction, on a file whose first statements succeed."""
    (tmp_path / "0001_half.sql").write_text(
        "CREATE TABLE public.kept (id integer PRIMARY KEY);\n"
        "INSERT INTO public.kept (id) VALUES (1);\n"
        "SELECT 1 / 0;\n",
        encoding="utf-8",
    )

    with pytest.raises(MigrationError) as raised:
        migrate(fresh_db.admin, tmp_path, log=quiet)

    assert str(raised.value.code) == "apply_failed"
    assert "0001_half.sql failed" in raised.value.message
    assert scalar(fresh_db.admin, "SELECT to_regclass('public.kept')") is None
    assert scalar(fresh_db.admin, "SELECT count(*) FROM public.schema_migrations") == 0
    # The session is usable again: the runner rolled the transaction back.
    assert scalar(fresh_db.admin, "SELECT 1") == 1
