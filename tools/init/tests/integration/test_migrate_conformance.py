# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The shared migration-runner conformance fixture, against a real server.

``db/conformance/expected.json`` is the contract between the two runners:
``packages/db-migrate`` iterates it
from TypeScript and this module iterates it from Python, so a change to one
implementation that the other does not follow turns the other's suite red.

Each case runs its steps in order against one fresh, empty database. A step
names a directory under the fixture, the outcome the runner must produce, how
many rows it added to ``public.schema_migrations``, and the state the database
must be left in.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from fdp_init.migrate import MigrationError, migrate

from .conftest import ROOT, FreshDatabase

pytestmark = pytest.mark.integration

CONFORMANCE_DIRS = (
    ROOT / "db" / "conformance",
    ROOT / "tools" / "init" / "tests" / "fixtures" / "conformance",
)
"""The shared copy first, then the vendored one init keeps as a fallback;
``test_contracts_drift.py`` keeps them identical."""


def conformance_root() -> Path | None:
    """Whichever copy of the shared fixture is in this worktree."""
    for candidate in CONFORMANCE_DIRS:
        if (candidate / "expected.json").is_file():
            return candidate
    return None


def load_cases() -> list[dict[str, Any]]:
    """The cases of ``expected.json``, or an empty list when there is none."""
    root = conformance_root()
    if root is None:
        return []
    expected = json.loads((root / "expected.json").read_text(encoding="utf-8"))
    assert expected["schema"] == "fdp-migration-conformance-v1"
    cases: list[dict[str, Any]] = expected["cases"]
    return cases


CASES = load_cases()


def applied_versions(conn: Any) -> list[int]:
    """The bookkeeping table, ascending; an absent table counts as ``[]``."""
    if conn.run("SELECT to_regclass('public.schema_migrations')")[0][0] is None:
        return []
    rows = conn.run("SELECT version FROM public.schema_migrations ORDER BY version")
    return [int(row[0]) for row in rows]


def relation_exists(conn: Any, relation: str) -> bool:
    """True when ``schema.table`` is a relation this database has."""
    return conn.run("SELECT to_regclass(:name)", name=relation)[0][0] is not None


def run_step(conn: Any, directory: Path) -> tuple[str, int]:
    """Run the runner over ``directory``; return the outcome and rows added."""
    before = len(applied_versions(conn))
    outcome = "ok"
    try:
        migrate(conn, directory, log=lambda _line: None)
    except MigrationError as error:
        outcome = str(error.code)
    return outcome, len(applied_versions(conn)) - before


@pytest.mark.skipif(not CASES, reason="no conformance fixture in this worktree")
def test_every_case_of_the_fixture_is_covered() -> None:
    """The fixture still holds the seven cases the contract names."""
    assert [case["name"] for case in CASES] == [
        "basic",
        "rerun",
        "hash_change",
        "failing",
        "out_of_order",
        "missing_file",
        "bad_filename",
    ]


@pytest.mark.skipif(not CASES, reason="no conformance fixture in this worktree")
@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_conformance_case(case: dict[str, Any], fresh_db: FreshDatabase) -> None:
    root = conformance_root()
    assert root is not None
    conn = fresh_db.admin

    for index, step in enumerate(case["steps"]):
        where = f"{case['name']} step {index} ({step['dir']})"
        outcome, added = run_step(conn, root / step["dir"])

        assert outcome == step["expect"], where
        if "applied" in step:
            assert added == step["applied"], f"{where}: rows added to schema_migrations"
        assert applied_versions(conn) == step["applied_versions"], where
        for relation in step["tables_exist"]:
            assert relation_exists(conn, relation), f"{where}: {relation} is missing"
        for relation in step["tables_absent"]:
            assert not relation_exists(conn, relation), f"{where}: {relation} should be gone"


@pytest.mark.skipif(not CASES, reason="no conformance fixture in this worktree")
def test_a_failing_file_leaves_no_bookkeeping_row(fresh_db: FreshDatabase) -> None:
    """The ``failing`` case, stated as the per-file transaction it proves."""
    root = conformance_root()
    assert root is not None
    conn = fresh_db.admin

    with pytest.raises(MigrationError) as raised:
        migrate(conn, root / "cases" / "failing", log=lambda _line: None)

    assert str(raised.value.code) == "apply_failed"
    assert raised.value.file == "0002_broken.sql"
    assert "division by zero" in raised.value.message
    assert applied_versions(conn) == [1]
    assert not relation_exists(conn, "public.t_partial")
    names = conn.run("SELECT name FROM public.schema_migrations ORDER BY version")
    assert [row[0] for row in names] == ["first"]


@pytest.mark.skipif(not CASES, reason="no conformance fixture in this worktree")
def test_the_bookkeeping_table_records_name_and_hash(fresh_db: FreshDatabase) -> None:
    """What ``migrate`` stores is what ``list_migrations`` read from disk."""
    root = conformance_root()
    assert root is not None
    conn = fresh_db.admin

    result = migrate(conn, root / "cases" / "basic", log=lambda _line: None)

    rows = conn.run("SELECT version, name, sha256 FROM public.schema_migrations ORDER BY version")
    assert [(int(v), n, s) for v, n, s in rows] == [
        (migration.version, migration.name, migration.sha256) for migration in result.applied
    ]
    assert result.skipped == 0


@pytest.mark.skipif(not CASES, reason="no conformance fixture in this worktree")
def test_the_runner_logs_one_line_per_applied_file_and_no_sql(
    fresh_db: FreshDatabase,
) -> None:
    root = conformance_root()
    assert root is not None
    lines: list[str] = []

    migrate(fresh_db.admin, root / "cases" / "basic", log=lines.append)

    assert len(lines) == 2
    assert lines[0].startswith("applied 0001_first.sql ")
    assert lines[1].startswith("applied 0002_second.sql ")
    assert not any("CREATE TABLE" in line for line in lines)
