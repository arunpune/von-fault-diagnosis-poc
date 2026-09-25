# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""What the migration runner decides before it touches a database.

Listing a directory, naming the refusals and hashing the files needs no
server, so it is tested here; the behaviour that needs one — per-file
transactions, the bookkeeping table, the seven conformance cases — is in
``tests/integration``.

The hashes are checked against the conformance fixture both runners share, so
this file also pins that ``sha256`` means "SHA-256 of the file's bytes as
committed, lower-case hex".
"""

from __future__ import annotations

import argparse
import hashlib
from collections.abc import Callable
from pathlib import Path

import pytest

from fdp_init.commands import migrate as migrate_command
from fdp_init.errors import ExitCode, InitError
from fdp_init.migrate import (
    FILE_PATTERN,
    MigrationError,
    MigrationErrorCode,
    MigrationFile,
    StatusResult,
    list_migrations,
)

ROOT = Path(__file__).resolve().parents[4]

CONFORMANCE_DIRS = (
    ROOT / "db" / "conformance",
    ROOT / "tools" / "init" / "tests" / "fixtures" / "conformance",
)
"""The contract fixture, preferring the shared copy over the vendored one."""

SQL = "CREATE TABLE public.t (id integer PRIMARY KEY);\n"


def conformance_root() -> Path:
    """Whichever copy of the shared fixture is in this worktree."""
    for candidate in CONFORMANCE_DIRS:
        if (candidate / "expected.json").is_file():
            return candidate
    pytest.skip("no conformance fixture: neither db/conformance nor the vendored copy")


def write(directory: Path, name: str, body: str = SQL) -> Path:
    """Create ``name`` in ``directory``, making the directory if needed."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text(body, encoding="utf-8")
    return path


def test_error_codes_are_the_shared_five() -> None:
    assert [code.value for code in MigrationErrorCode] == [
        "invalid_filename",
        "hash_mismatch",
        "out_of_order",
        "missing_file",
        "apply_failed",
    ]


def test_migration_error_carries_code_file_and_exit_code() -> None:
    error = MigrationError(MigrationErrorCode.HASH_MISMATCH, "0001_a.sql changed", "0001_a.sql")
    assert error.code is MigrationErrorCode.HASH_MISMATCH
    assert error.file == "0001_a.sql"
    assert error.exit_code is ExitCode.MIGRATION
    assert error.step == "migrate"
    assert str(error) == "0001_a.sql changed"


def test_migration_error_file_is_optional() -> None:
    assert MigrationError(MigrationErrorCode.MISSING_FILE, "version 2 has no file").file is None


@pytest.mark.parametrize(
    "name",
    ["0001_first.sql", "0042_manual_chunks.sql", "9999_a0_b1.sql"],
)
def test_pattern_accepts_a_well_formed_name(name: str) -> None:
    assert FILE_PATTERN.match(name) is not None


@pytest.mark.parametrize(
    "name",
    [
        "0004-bad.sql",  # hyphen where the contract asks for an underscore
        "001_short.sql",  # three digits
        "00010_long.sql",  # five digits
        "0001_Upper.sql",  # upper case in the slug
        "0001_first.SQL",  # upper-case extension
        "0001_first.sql.bak",
        "0001.sql",  # no slug
        ".gitkeep",  # a dot file is a refusal too
    ],
)
def test_pattern_refuses_everything_else(name: str) -> None:
    assert FILE_PATTERN.match(name) is None


def test_list_migrations_sorts_by_version_not_by_name(tmp_path: Path) -> None:
    write(tmp_path, "0010_tenth.sql")
    write(tmp_path, "0002_second.sql")
    write(tmp_path, "0001_first.sql")

    found = list_migrations(tmp_path)

    assert [migration.version for migration in found] == [1, 2, 10]
    assert [migration.name for migration in found] == ["first", "second", "tenth"]
    assert [migration.file for migration in found] == [
        "0001_first.sql",
        "0002_second.sql",
        "0010_tenth.sql",
    ]
    assert [migration.path for migration in found] == [
        tmp_path / "0001_first.sql",
        tmp_path / "0002_second.sql",
        tmp_path / "0010_tenth.sql",
    ]


def test_list_migrations_of_an_empty_directory_is_empty(tmp_path: Path) -> None:
    assert list_migrations(tmp_path) == []


def test_list_migrations_skips_readme_and_sub_directories(tmp_path: Path) -> None:
    write(tmp_path, "0001_first.sql")
    write(tmp_path, "README.md", "# migrations\n")
    write(tmp_path / "variant-modified", "0001_first.sql")

    assert [migration.file for migration in list_migrations(tmp_path)] == ["0001_first.sql"]


def test_list_migrations_refuses_a_bad_file_name(tmp_path: Path) -> None:
    write(tmp_path, "0001_first.sql")
    write(tmp_path, "0004-bad.sql")

    with pytest.raises(MigrationError) as raised:
        list_migrations(tmp_path)

    assert raised.value.code is MigrationErrorCode.INVALID_FILENAME
    assert raised.value.file == "0004-bad.sql"


def test_list_migrations_refuses_a_dot_file(tmp_path: Path) -> None:
    write(tmp_path, "0001_first.sql")
    write(tmp_path, ".gitkeep", "")

    with pytest.raises(MigrationError) as raised:
        list_migrations(tmp_path)

    assert raised.value.code is MigrationErrorCode.INVALID_FILENAME
    assert raised.value.file == ".gitkeep"


def test_list_migrations_refuses_two_files_with_one_version(tmp_path: Path) -> None:
    write(tmp_path, "0001_first.sql")
    write(tmp_path, "0001_other.sql")

    with pytest.raises(MigrationError) as raised:
        list_migrations(tmp_path)

    assert raised.value.code is MigrationErrorCode.INVALID_FILENAME
    assert raised.value.file == "0001_other.sql"
    assert "share version 1" in raised.value.message


def test_list_migrations_names_a_missing_directory(tmp_path: Path) -> None:
    with pytest.raises(InitError) as raised:
        list_migrations(tmp_path / "nowhere")

    assert raised.value.exit_code is ExitCode.MIGRATION
    assert "nowhere" in raised.value.message


def test_hash_is_the_lower_case_hex_sha256_of_the_bytes(tmp_path: Path) -> None:
    body = "-- a comment\nCREATE TABLE public.t (id integer);\n"
    path = write(tmp_path, "0001_first.sql", body)

    (migration,) = list_migrations(tmp_path)

    assert migration.sha256 == hashlib.sha256(path.read_bytes()).hexdigest()
    assert migration.sha256 == migration.sha256.lower()
    assert len(migration.sha256) == 64


def test_one_changed_character_changes_the_hash(tmp_path: Path) -> None:
    first = write(tmp_path / "before", "0001_first.sql", "-- one\n" + SQL)
    second = write(tmp_path / "after", "0001_first.sql", "-- two\n" + SQL)

    (before,) = list_migrations(first.parent)
    (after,) = list_migrations(second.parent)

    assert before.version == after.version
    assert before.sha256 != after.sha256


def test_conformance_case_files_hash_to_their_bytes() -> None:
    """Every case directory of the shared fixture lists and hashes as expected.

    ``bad_filename`` is the one that must refuse; the others are read in full,
    which is what makes the digests the integration suite records real.
    """
    cases = conformance_root() / "cases"
    refused: list[Path] = []
    hashed = 0
    for directory in sorted(path for path in cases.rglob("*") if path.is_dir()):
        try:
            migrations = list_migrations(directory)
        except MigrationError as error:
            assert error.code is MigrationErrorCode.INVALID_FILENAME
            refused.append(directory)
            continue
        for migration in migrations:
            expected = hashlib.sha256(migration.path.read_bytes()).hexdigest()
            assert migration.sha256 == expected, f"{migration.path} hashed wrong"
            hashed += 1

    assert hashed >= 2, "the conformance fixture holds no readable cases"
    assert [directory.name for directory in refused] == ["bad_filename"]


def test_the_hash_change_variant_differs_from_the_case_it_shadows() -> None:
    case = conformance_root() / "cases" / "hash_change"
    applied = {migration.version: migration.sha256 for migration in list_migrations(case)}
    variant = {
        migration.version: migration.sha256
        for migration in list_migrations(case / "variant-modified")
    }

    assert applied.keys() == variant.keys()
    assert applied[1] != variant[1], "the variant must differ, or hash_mismatch is untestable"
    assert applied[2] == variant[2]


def test_the_bad_filename_case_is_refused_without_a_database() -> None:
    with pytest.raises(MigrationError) as raised:
        list_migrations(conformance_root() / "cases" / "bad_filename")

    assert raised.value.code is MigrationErrorCode.INVALID_FILENAME


def test_the_repository_migrations_are_a_valid_set() -> None:
    migrations = list_migrations(ROOT / "db" / "migrations")
    versions = [migration.version for migration in migrations]

    assert versions == sorted(versions)
    assert len(set(versions)) == len(versions)
    assert 8 in versions, "0008_chunk_links.sql is init's migration"
    assert next(m for m in migrations if m.version == 8).name == "chunk_links"


def test_the_command_exits_four_and_names_the_code(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, tmp_path: Path
) -> None:
    """Every ``MigrationError`` reaches the process as exit code 4.

    ``invalid_filename`` is the one refusal that needs no server, so it is the
    one this layer can prove; the other four are the same ``except`` branch and
    the integration suite runs them against a real database.
    """
    write(tmp_path, "0004-bad.sql")
    monkeypatch.setattr(migrate_command, "connect", lambda _settings: _NullConnection())

    class _Settings:
        migrations_dir = tmp_path

    with caplog.at_level("ERROR"):
        code = migrate_command.run(argparse.Namespace(status=False), _Settings())  # type: ignore[arg-type]

    assert code == int(ExitCode.MIGRATION) == 4
    record = caplog.records[-1]
    assert record.code == "invalid_filename"  # type: ignore[attr-defined]
    assert record.file == "0004-bad.sql"  # type: ignore[attr-defined]
    assert "invalid_filename" in record.getMessage()


@pytest.mark.parametrize(
    "code", list(MigrationErrorCode), ids=[c.value for c in MigrationErrorCode]
)
def test_the_command_exits_four_on_every_refusal_of_the_contract(
    code: MigrationErrorCode,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    tmp_path: Path,
) -> None:
    """All five codes leave the process as exit 4 with the code on the record.

    The runner decides *which* code; this pins that none of them escapes the
    sub-command as an exception or as a different exit code, which is what
    Compose and ``scripts/smoke.sh`` read.
    """
    connection = _NullConnection()
    monkeypatch.setattr(migrate_command, "connect", lambda _settings: connection)
    monkeypatch.setattr(
        migrate_command,
        "migrate",
        _raising(
            MigrationError(code, f"{code.value} on 0008_chunk_links.sql", "0008_chunk_links.sql")
        ),
    )

    class _Settings:
        migrations_dir = tmp_path

    with caplog.at_level("ERROR"):
        exit_code = migrate_command.run(argparse.Namespace(status=False), _Settings())  # type: ignore[arg-type]

    assert exit_code == int(ExitCode.MIGRATION) == 4
    record = caplog.records[-1]
    assert record.code == code.value  # type: ignore[attr-defined]
    assert record.file == "0008_chunk_links.sql"  # type: ignore[attr-defined]
    assert record.exit_code == 4  # type: ignore[attr-defined]
    assert code.value in record.getMessage()
    assert connection.closed, "the connection is closed even when the run is refused"


def test_the_command_lists_applied_and_pending_with_status(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, tmp_path: Path
) -> None:
    """``--status`` reports both halves and changes nothing."""
    applied = MigrationFile(1, "first", tmp_path / "0001_first.sql", "a" * 64)
    pending = MigrationFile(8, "chunk_links", tmp_path / "0008_chunk_links.sql", "b" * 64)
    monkeypatch.setattr(migrate_command, "connect", lambda _settings: _NullConnection())
    monkeypatch.setattr(
        migrate_command,
        "status",
        lambda _conn, _dir: StatusResult(applied=[applied], pending=[pending]),
    )
    monkeypatch.setattr(
        migrate_command, "migrate", _raising(AssertionError("--status must apply nothing"))
    )

    class _Settings:
        migrations_dir = tmp_path

    with caplog.at_level("INFO"):
        exit_code = migrate_command.run(argparse.Namespace(status=True), _Settings())  # type: ignore[arg-type]

    assert exit_code == int(ExitCode.OK) == 0
    states = [
        (record.state, record.file)  # type: ignore[attr-defined]
        for record in caplog.records
        if getattr(record, "event", None) == "status"
    ]
    assert states == [("applied", "0001_first.sql"), ("pending", "0008_chunk_links.sql")]


def _raising(error: BaseException) -> Callable[..., object]:
    """A stand-in that raises ``error`` whatever it is called with."""

    def call(*_args: object, **_kwargs: object) -> object:
        raise error

    return call


class _NullConnection:
    """A connection the failing path never reaches a statement through."""

    def __init__(self) -> None:
        self.closed = False

    def run(self, sql: str, **params: object) -> list[list[object]]:
        raise AssertionError(f"no statement should run: {sql!r} {params!r}")

    def close(self) -> None:
        self.closed = True
