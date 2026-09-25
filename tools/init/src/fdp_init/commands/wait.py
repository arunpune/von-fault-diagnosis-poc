# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-init wait``: block until the dependencies answer.

Exposed on its own so ``scripts/smoke.sh`` can check the stack without running
the whole pipeline. Exits 0 when everything selected is ready and 3 when the
budget runs out or a dependency refuses for good.
"""

from __future__ import annotations

import argparse

from fdp_init.config import Settings
from fdp_init.errors import ExitCode
from fdp_init.wait import wait_for_mqtt, wait_for_postgres

POSTGRES = "postgres"
MQTT = "mqtt"
ALL = "all"

CHOICES = (ALL, POSTGRES, MQTT)


def run(args: argparse.Namespace, settings: Settings) -> int:
    """Wait for the selected dependencies.

    Raises:
        InitError: exit code 3, propagated to :func:`fdp_init.cli.main`.
    """
    only = getattr(args, "only", ALL)
    if only in (ALL, POSTGRES):
        wait_for_postgres(settings)
    if only in (ALL, MQTT):
        wait_for_mqtt(settings)
    return int(ExitCode.OK)
