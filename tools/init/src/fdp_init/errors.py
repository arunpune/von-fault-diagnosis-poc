# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Exit codes and the one error type the CLI maps to them.

The codes are the service contract (tools/init/README.md): ``fdp-init run`` is
fail-fast in pipeline order and the code of the failing step is the process
exit code, so Compose and ``scripts/smoke.sh`` can tell a
configuration mistake from a dependency that never came up.
"""

from __future__ import annotations

from enum import IntEnum


class ExitCode(IntEnum):
    """Process exit codes."""

    OK = 0
    """Success, including "nothing to do"."""

    UNEXPECTED = 1
    """Unexpected exception; the stack trace is logged."""

    CONFIG = 2
    """Configuration error, raised before any network or database access."""

    WAIT_TIMEOUT = 3
    """Postgres or the broker did not become ready within the budget."""

    MIGRATION = 4
    """A migration failed, or a role the schema needs is missing."""

    DATASET = 5
    """The MetroPT-3 download or its SHA-256 verification failed."""

    MANUAL = 6
    """Manual extraction or catalog building failed."""

    MODEL = 7
    """The embedding model could not be downloaded or loaded."""

    DB_WRITE = 8
    """Writing the ingest result to the database failed."""


class InitError(Exception):
    """A failure with a known exit code and the step that produced it.

    Attributes:
        exit_code: The code ``fdp-init`` exits with.
        message: One line, safe to log (no secrets, no SQL).
        step: The pipeline step (``config``, ``wait``,
            ``migrate``, ``dataset``, ``model``, ``ingest``, ``report``).
    """

    def __init__(self, exit_code: ExitCode, message: str, step: str) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.message = message
        self.step = step

    def __str__(self) -> str:
        return self.message
