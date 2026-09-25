# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The plain-SQL forward-only migration runner, in Python.

This is the production runner: ``fdp-init migrate`` and ``fdp-init run`` apply
``db/migrations`` through it. ``packages/db-migrate`` is the TypeScript twin
that the backend and eval test suites use, and the two are held together by
``db/conformance/expected.json`` — both suites iterate the same file, so a
change to one implementation that the other does not follow turns the other
red.

The rules, all observable through that fixture:

- files are ``NNNN_<slug>.sql`` and apply in ascending version order; a
  sub-directory and ``README.md`` are skipped and every other entry is a
  refusal, as is a version claimed twice;
- one transaction per file, with the bookkeeping row written inside it, so a
  failing file leaves neither its objects nor a record of itself;
- the SHA-256 of an applied file's bytes is stored and re-checked, so editing
  an applied migration is refused rather than silently ignored;
- nothing is applied below the highest applied version, and no applied version
  may lose its file.

The file's SQL runs as one batch through ``pg8000``'s parameterless
:meth:`~pg8000.native.Connection.run`, which uses the simple-query protocol and
therefore accepts several statements, dollar-quoted bodies and ``DO`` blocks
without this module ever parsing SQL. ``tests/integration/test_migrations.py``
pins that behaviour against a real server.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from enum import StrEnum
from itertools import pairwise
from pathlib import Path
from typing import Any

from fdp_init.errors import ExitCode, InitError
from fdp_init.util.hashing import sha256_file

STEP = "migrate"

FILE_PATTERN = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")
"""The only file name a migrations directory may hold."""

ALLOWED_OTHER_FILE = "README.md"
"""The one non-migration file the directory may hold; sub-directories are
skipped too, because the conformance cases keep their variants in one.
"""

CREATE_BOOKKEEPING = (
    "CREATE TABLE IF NOT EXISTS public.schema_migrations ("
    "version integer PRIMARY KEY, name text NOT NULL, sha256 char(64) NOT NULL, "
    "applied_at timestamptz NOT NULL DEFAULT now())"
)

LOCK_BOOKKEEPING = "LOCK TABLE public.schema_migrations IN EXCLUSIVE MODE"

SELECT_APPLIED = "SELECT version, sha256 FROM public.schema_migrations"

INSERT_APPLIED = (
    "INSERT INTO public.schema_migrations (version, name, sha256) VALUES (:version, :name, :sha256)"
)

LOGGED_HASH_CHARS = 12
"""Enough of the digest to tell two files apart in a log line."""

logger = logging.getLogger(__name__)


class MigrationErrorCode(StrEnum):
    """The refusals both runners share."""

    INVALID_FILENAME = "invalid_filename"
    """An entry that is not ``NNNN_<slug>.sql``, or a version claimed twice."""

    HASH_MISMATCH = "hash_mismatch"
    """An applied file whose bytes on disk are no longer the applied ones."""

    OUT_OF_ORDER = "out_of_order"
    """A pending file numbered below the highest applied version."""

    MISSING_FILE = "missing_file"
    """An applied version with no file in the directory."""

    APPLY_FAILED = "apply_failed"
    """The server refused the file; the transaction was rolled back."""


class MigrationError(InitError):
    """A refusal, with the code and the file that caused it.

    It is an :class:`~fdp_init.errors.InitError` with
    :attr:`~fdp_init.errors.ExitCode.MIGRATION`, so ``fdp-init migrate`` and
    ``fdp-init run`` both exit 4 on it without the caller mapping anything.

    Attributes:
        code: The shared enum value, printed by the sub-command.
        file: The base name that caused the refusal, where there is one.
    """

    def __init__(self, code: MigrationErrorCode, message: str, file: str | None = None) -> None:
        super().__init__(ExitCode.MIGRATION, message, STEP)
        self.code = code
        self.file = file


@dataclass(frozen=True, slots=True)
class MigrationFile:
    """One ``NNNN_<slug>.sql`` on disk, with the hash that identifies it."""

    version: int
    """The four-digit prefix as an integer: the bookkeeping primary key."""

    name: str
    """The slug after the prefix, without the extension."""

    path: Path
    """Where the bytes were read from."""

    sha256: str
    """SHA-256 of those bytes, lower-case hex."""

    @property
    def file(self) -> str:
        """The base name, for messages and log lines."""
        return self.path.name


@dataclass(frozen=True, slots=True)
class MigrateResult:
    """What one :func:`migrate` run did."""

    applied: list[MigrationFile]
    """The files applied by this run, in the order they were applied."""

    skipped: int
    """How many files were already applied and therefore left alone."""


@dataclass(frozen=True, slots=True)
class StatusResult:
    """What the directory holds, split by what the database already has."""

    applied: list[MigrationFile]
    pending: list[MigrationFile]


Log = Callable[[str], None]
"""One line per applied file; never SQL."""


def list_migrations(directory: Path) -> list[MigrationFile]:
    """Every migration in ``directory``, ascending by version.

    Raises:
        MigrationError: ``invalid_filename`` for an entry that is neither a
            sub-directory, ``README.md`` nor ``NNNN_<slug>.sql``, and for two
            files claiming the same version.
        InitError: exit code 4, when ``directory`` cannot be listed — a
            mis-set ``MIGRATIONS_DIR`` is worth naming rather than a traceback.
    """
    try:
        entries = sorted(directory.iterdir())
    except OSError as exc:
        raise InitError(
            ExitCode.MIGRATION, f"cannot read the migrations directory {directory}: {exc}", STEP
        ) from exc

    files: list[MigrationFile] = []
    for entry in entries:
        if entry.is_dir() or entry.name == ALLOWED_OTHER_FILE:
            continue
        match = FILE_PATTERN.match(entry.name)
        if match is None:
            raise MigrationError(
                MigrationErrorCode.INVALID_FILENAME,
                f"{entry.name} in {directory} is not NNNN_<slug>.sql",
                entry.name,
            )
        files.append(
            MigrationFile(
                version=int(match.group(1)),
                name=match.group(2),
                path=entry,
                sha256=sha256_file(entry),
            )
        )

    files.sort(key=lambda migration: migration.version)
    for previous, current in pairwise(files):
        if previous.version == current.version:
            raise MigrationError(
                MigrationErrorCode.INVALID_FILENAME,
                f"{previous.file} and {current.file} share version {current.version}",
                current.file,
            )
    return files


def migrate(conn: Any, directory: Path, *, log: Log | None = None) -> MigrateResult:
    """Apply every pending migration in ``directory``, ascending.

    Args:
        conn: An open ``pg8000.native.Connection`` as the migrating role; the
            schemas and every object in them end up owned by it.
        directory: Where the ``NNNN_<slug>.sql`` files live.
        log: Called once per applied file. Defaults to an ``info`` record on
            this module's logger.

    Raises:
        MigrationError: any code of :class:`MigrationErrorCode`. The run stops
            at the first refusal; files applied before it stay applied,
            because each one committed on its own.
    """
    emit = log if log is not None else _log_applied
    files = list_migrations(directory)
    recorded = _read_applied(conn)

    versions = {migration.version for migration in files}
    for version in sorted(recorded):
        if version not in versions:
            raise MigrationError(
                MigrationErrorCode.MISSING_FILE,
                f"applied migration {version} has no file in {directory}",
            )

    highest_applied = max(recorded, default=0)
    fresh: list[MigrationFile] = []
    for migration in files:
        applied_hash = recorded.get(migration.version)
        if applied_hash is not None:
            if applied_hash != migration.sha256:
                raise MigrationError(
                    MigrationErrorCode.HASH_MISMATCH,
                    f"{migration.file} changed after it was applied "
                    f"(recorded {applied_hash}, on disk {migration.sha256})",
                    migration.file,
                )
            continue
        if migration.version < highest_applied:
            raise MigrationError(
                MigrationErrorCode.OUT_OF_ORDER,
                f"{migration.file} is below the applied version {highest_applied}",
                migration.file,
            )
        _apply_one(conn, migration)
        emit(f"applied {migration.file} {migration.sha256[:LOGGED_HASH_CHARS]}")
        fresh.append(migration)

    return MigrateResult(applied=fresh, skipped=len(files) - len(fresh))


def status(conn: Any, directory: Path) -> StatusResult:
    """What ``directory`` holds, split into applied and pending.

    Raises:
        MigrationError: ``invalid_filename``, from :func:`list_migrations`.
    """
    files = list_migrations(directory)
    recorded = _read_applied(conn)
    return StatusResult(
        applied=[migration for migration in files if migration.version in recorded],
        pending=[migration for migration in files if migration.version not in recorded],
    )


def _log_applied(line: str) -> None:
    """The default :data:`Log`: one structured record per applied file."""
    logger.info("%s", line, extra={"step": STEP, "event": "applied"})


def _read_applied(conn: Any) -> dict[int, str]:
    """The recorded ``version -> sha256`` map, creating the table if missing.

    The exclusive lock makes two runners racing on the same database serialise
    on the bookkeeping table instead of both deciding a file is pending; it is
    released by the ``COMMIT`` and re-taken per file in :func:`_apply_one`.
    """
    conn.run(CREATE_BOOKKEEPING)
    conn.run("BEGIN")
    try:
        conn.run(LOCK_BOOKKEEPING)
        rows = conn.run(SELECT_APPLIED)
        conn.run("COMMIT")
    except BaseException:
        _rollback_quietly(conn)
        raise
    return {int(version): str(sha256) for version, sha256 in rows}


def _apply_one(conn: Any, migration: MigrationFile) -> None:
    """Run one file and record it, in one transaction.

    The whole file goes in as a single parameterless statement, which pg8000
    sends over the simple-query protocol: several statements, dollar quoting
    and ``DO`` blocks all survive, and the server aborts the batch as a whole,
    so the ``ROLLBACK`` below undoes every object the file had created.

    Raises:
        MigrationError: ``apply_failed``, naming the file and the server's
            message.
    """
    sql = migration.path.read_text(encoding="utf-8")
    conn.run("BEGIN")
    try:
        conn.run(LOCK_BOOKKEEPING)
        conn.run(sql)
        conn.run(
            INSERT_APPLIED,
            version=migration.version,
            name=migration.name,
            sha256=migration.sha256,
        )
        conn.run("COMMIT")
    except Exception as exc:
        _rollback_quietly(conn)
        raise MigrationError(
            MigrationErrorCode.APPLY_FAILED, _describe(migration, exc), migration.file
        ) from exc
    except BaseException:
        # A KeyboardInterrupt is not a migration failure, but the session must
        # still not be left holding an open transaction (db.transaction does
        # the same).
        _rollback_quietly(conn)
        raise


def _rollback_quietly(conn: Any) -> None:
    """Undo the open transaction; a failing ``ROLLBACK`` must not hide why."""
    with suppress(Exception):
        conn.run("ROLLBACK")


def _describe(migration: MigrationFile, exc: Exception) -> str:
    """The file, the server's message and, when it gave one, the position.

    ``pg8000`` raises ``DatabaseError`` with the server's error fields as a
    mapping: ``M`` is the message, ``P`` the character offset into the batch.
    Anything else — a dropped socket, say — is reported by its own text.
    """
    detail = exc.args[0] if exc.args else None
    if isinstance(detail, dict):
        message = str(detail.get("M", detail))
        position = detail.get("P")
    else:
        message = str(exc)
        position = None
    at = "" if position is None else f" at position {position}"
    return f"{migration.file} failed{at}: {message}"
