# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-init ingest``: extract, embed and store the manual.

The ingestion half of ``fdp-init run`` without the waits, the migrations and
the dataset, for a developer who re-rendered the PDF against a stack that is
already up. The skip check still applies; ``INIT_FORCE_INGEST=1`` overrides it.
"""

from __future__ import annotations

import argparse

from fdp_init import pipeline
from fdp_init.config import Settings


def run(args: argparse.Namespace, settings: Settings) -> int:
    """Run :func:`fdp_init.pipeline.ingest`.

    Args:
        args: Unused; the sub-command takes no options.
        settings: The environment contract.

    Returns:
        ``0``, including when the manual was already ingested.

    Raises:
        InitError: exit code 2 when the schema is not migrated or the manual is
            unreadable, 6 for the manual or the catalog, 7 for the model, 8 for
            the database write; turned into the process exit code by
            :func:`fdp_init.cli.main`.
    """
    del args
    return pipeline.ingest(settings)
