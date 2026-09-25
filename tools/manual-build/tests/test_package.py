# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Smoke test: the workspace member is importable and carries a version."""

import fdp_manual_build


def test_package_exposes_a_version() -> None:
    assert fdp_manual_build.__version__ == "0.1.0"
