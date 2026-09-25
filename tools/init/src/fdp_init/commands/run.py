# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-init run``: the whole sequence, the container default.

Waits for Postgres and the broker, migrates, verifies the dataset, fills the
model cache and ingests the manual unless it is already stored, then writes the
report. Fail-fast: the exit code is the one of the step that failed.
"""

from __future__ import annotations

import argparse

from fdp_init import pipeline
from fdp_init.config import Settings


def run(args: argparse.Namespace, settings: Settings) -> int:
    """Run :func:`fdp_init.pipeline.run`.

    Args:
        args: Unused; the sub-command takes no options.
        settings: The environment contract.

    Returns:
        ``0``, including when the manual was already ingested.

    Raises:
        InitError: with the exit code of the failing step, turned into the
            process exit code by :func:`fdp_init.cli.main`.
    """
    del args
    return pipeline.run(settings)
