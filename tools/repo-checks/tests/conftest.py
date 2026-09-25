# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Shared fixtures.

``pytest`` imports the workspace with ``--import-mode=importlib``, which gives
every test module a path-derived name and so no package to import a sibling
from. Putting this directory on ``sys.path`` here — before any test module is
imported — lets them say ``from helpers import ...`` and keeps one instance of
that module.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import pytest

from helpers import FixtureRepo, make_repo


@pytest.fixture
def repo(tmp_path: Path) -> FixtureRepo:
    """An initialised repository with the licence texts the checks expect."""
    return make_repo(tmp_path / "repo")
