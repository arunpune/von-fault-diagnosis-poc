# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The one database connection init opens.

``pg8000`` is the driver (BSD-3-Clause, pure Python, a permissive runtime
dependency) and the ``pgvector`` adapter is registered on every connection so
``app.chunks.embedding`` round-trips as a list of floats instead of a string
literal.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager, suppress

import pg8000.native
from pgvector.pg8000 import register_vector

from fdp_init.config import Settings
from fdp_init.errors import ExitCode, InitError

STEP = "db"

CONNECT_TIMEOUT_S = 10.0
"""The readiness wait already proved the server is up, so this is short."""

logger = logging.getLogger(__name__)


def connect(settings: Settings) -> pg8000.native.Connection:
    """Open an admin connection, with the vector type registered when it exists.

    A database init has never migrated has no ``vector`` type yet — ``0001``
    creates the extension — so the connection that is about to run the
    migrations cannot insist on it. :func:`register_vectors` is called again
    once they have run.

    Raises:
        InitError: exit code 8, when the server cannot be reached or refuses
            the credentials. The readiness wait runs first, so reaching
            this is a real failure, not a cold start.
    """
    try:
        connection = pg8000.native.Connection(
            settings.postgres_user,
            host=settings.postgres_host,
            port=settings.postgres_port,
            database=settings.postgres_db,
            password=settings.postgres_password,
            timeout=CONNECT_TIMEOUT_S,
        )
    except (pg8000.native.DatabaseError, pg8000.native.InterfaceError, OSError) as exc:
        raise InitError(
            ExitCode.DB_WRITE,
            f"cannot connect to postgres at {settings.postgres_host}:{settings.postgres_port} "
            f"as {settings.postgres_user!r}: {exc}",
            STEP,
        ) from exc
    register_vectors(connection)
    return connection


def register_vectors(connection: pg8000.native.Connection) -> bool:
    """Register the pgvector adapter on ``connection``, if the type exists.

    Returns:
        ``True`` when ``vector`` is installed in the database and the adapter
        is registered; ``False`` before the migrations created it.
    """
    try:
        register_vector(connection)
    except RuntimeError:  # pgvector's "vector type not found in the database"
        return False
    return True


@contextmanager
def transaction(connection: pg8000.native.Connection) -> Iterator[pg8000.native.Connection]:
    """Run a block inside ``BEGIN`` / ``COMMIT``, rolling back on any error.

    ``BaseException`` is caught on purpose: a ``KeyboardInterrupt`` in the
    middle of the ingest must not leave the session holding an open
    transaction.
    """
    connection.run("BEGIN")
    try:
        yield connection
    except BaseException:
        with suppress(Exception):
            connection.run("ROLLBACK")
        raise
    connection.run("COMMIT")
