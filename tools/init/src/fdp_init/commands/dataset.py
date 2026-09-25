# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-init dataset``: make ``METROPT_CSV`` exist and verify it.

Exposed on its own so a developer can fill ``data/metropt3/`` — or re-check a
hand-placed copy with ``--rehash`` — without running migrations, the manual
and the embeddings first. Exits 0 with the status in the log, or 5 when the
dataset cannot be trusted.
"""

from __future__ import annotations

import argparse

from fdp_init.config import Settings
from fdp_init.dataset.metropt import ensure_dataset
from fdp_init.errors import ExitCode


def run(args: argparse.Namespace, settings: Settings) -> int:
    """Run the dataset step alone.

    Raises:
        InitError: exit code 5 (or 2 for a configuration mistake), propagated
            to :func:`fdp_init.cli.main`, which logs and maps it.
    """
    ensure_dataset(settings, rehash=bool(getattr(args, "rehash", False)))
    return int(ExitCode.OK)
