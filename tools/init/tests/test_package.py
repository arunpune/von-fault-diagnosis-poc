# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Smoke test: the workspace member is importable and carries a version."""

import fdp_init


def test_package_exposes_a_version() -> None:
    assert fdp_init.__version__ == "0.1.0"


def test_package_exposes_the_ingest_version() -> None:
    """Part of the idempotency key."""
    assert isinstance(fdp_init.INGEST_VERSION, int)
    assert fdp_init.INGEST_VERSION >= 1
