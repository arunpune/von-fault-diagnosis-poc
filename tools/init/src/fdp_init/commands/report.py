# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-init report``: print the latest ingest run from the database.

The document goes to stdout as indented JSON — the run's id, status, times and
error, and its stored report — so it can be piped into ``jq`` or pasted into an
issue. The log lines of the command itself stay below ``info``, which keeps
stdout to the document alone at the default level.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from contextlib import closing

import pg8000.native

from fdp_init.config import Settings
from fdp_init.db import connect
from fdp_init.errors import ExitCode, InitError
from fdp_init.report import latest_report

STEP = "report"

logger = logging.getLogger(__name__)


def run(args: argparse.Namespace, settings: Settings) -> int:
    """Print the newest ``app.ingest_runs`` row and its report.

    Args:
        args: Unused; the sub-command takes no options.
        settings: The environment contract; only the Postgres settings matter.

    Returns:
        ``0``, also when no ingest has run yet — which is logged, and stdout
        stays empty.

    Raises:
        InitError: exit code 8, when the runs cannot be read (no connection, or
            a database that was never migrated).
    """
    del args
    with closing(connect(settings)) as conn:
        try:
            stored = latest_report(conn)
        except pg8000.native.DatabaseError as error:
            raise InitError(
                ExitCode.DB_WRITE, f"cannot read app.ingest_runs: {error}", STEP
            ) from error
    if stored is None:
        logger.warning("no ingest run is recorded yet", extra={"step": STEP, "event": "skipped"})
        return int(ExitCode.OK)
    sys.stdout.write(json.dumps(stored.to_dict(), indent=2, sort_keys=True) + "\n")
    return int(ExitCode.OK)
