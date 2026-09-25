# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-init migrate``: apply ``db/migrations``.

Exposed on its own so a developer can bring a database up to date without
running the ingest, and so ``scripts/smoke.sh`` can tell "the schema is
current" from "the manual is ingested". ``--status`` lists what the directory
holds against what the database has and changes nothing.

Any :class:`~fdp_init.migrate.MigrationError` exits 4 with its code and the
file that caused it; the same step inside ``fdp-init run`` fails the same way.
"""

from __future__ import annotations

import argparse
import logging
from contextlib import closing
from typing import Any

from fdp_init.config import Settings
from fdp_init.db import connect
from fdp_init.errors import ExitCode
from fdp_init.migrate import MigrationError, migrate, status

STEP = "migrate"

logger = logging.getLogger(__name__)


def run(args: argparse.Namespace, settings: Settings) -> int:
    """Apply the pending migrations, or list them with ``--status``.

    Returns:
        ``0`` when the database is up to date, ``4`` on any refusal of the
        runner contract.
    """
    directory = settings.migrations_dir
    logger.info(
        "migrations in %s",
        directory,
        extra={"step": STEP, "event": "start", "dir": str(directory)},
    )
    try:
        with closing(connect(settings)) as conn:
            if getattr(args, "status", False):
                return _report_status(conn, settings)
            result = migrate(conn, directory)
    except MigrationError as error:
        logger.error(
            "%s: %s",
            error.code,
            error.message,
            extra={
                "step": STEP,
                "event": "failed",
                "code": str(error.code),
                "file": error.file,
                "exit_code": int(ExitCode.MIGRATION),
            },
        )
        return int(ExitCode.MIGRATION)

    logger.info(
        "applied %d, skipped %d",
        len(result.applied),
        result.skipped,
        extra={
            "step": STEP,
            "event": "done",
            "applied": len(result.applied),
            "skipped": result.skipped,
        },
    )
    return int(ExitCode.OK)


def _report_status(conn: Any, settings: Settings) -> int:
    """Log one line per migration, applied first, and return ``0``."""
    result = status(conn, settings.migrations_dir)
    for state, files in (("applied", result.applied), ("pending", result.pending)):
        for migration in files:
            logger.info(
                "%s %s",
                state,
                migration.file,
                extra={
                    "step": STEP,
                    "event": "status",
                    "state": state,
                    "version": migration.version,
                    "file": migration.file,
                },
            )
    logger.info(
        "%d applied, %d pending",
        len(result.applied),
        len(result.pending),
        extra={
            "step": STEP,
            "event": "done",
            "applied": len(result.applied),
            "pending": len(result.pending),
        },
    )
    return int(ExitCode.OK)
