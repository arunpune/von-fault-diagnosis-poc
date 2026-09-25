# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Markers and shared fixtures for the init test suite.

The root ``pyproject.toml`` declares ``integration`` and ``network``; the four
markers that only init uses are registered here so
``--strict-markers`` stays usable and ``pytest -m unit`` means something.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

MARKERS = (
    "unit: no Docker, no network; the default layer",
    "e2e: builds the init image and runs it (needs Docker)",
    "quality: needs the committed manual PDFs and the reference catalog",
    "live: needs LLM_API_KEY; skipped otherwise and never prints it",
)


def pytest_configure(config: pytest.Config) -> None:
    """Register the init-only markers."""
    for marker in MARKERS:
        config.addinivalue_line("markers", marker)


@pytest.fixture
def env(tmp_path: Path) -> Callable[..., dict[str, str]]:
    """Build an environment mapping for :meth:`Settings.from_env`.

    The base pins ``INIT_ROOT_DIR`` to the test's own directory, so relative
    defaults resolve inside ``tmp_path`` and no test depends on where the
    repository happens to be checked out.
    """

    def build(**overrides: str) -> dict[str, str]:
        base = {"INIT_ROOT_DIR": str(tmp_path)}
        base.update(overrides)
        return base

    return build
