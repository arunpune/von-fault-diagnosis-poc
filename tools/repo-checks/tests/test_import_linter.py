# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The Python half of the import boundaries actually fires.

The root ``pyproject.toml`` declares an ``independence`` contract over the
workspace's packages, which is worth exactly as much as the proof that it
reports a violation. This drives the real ``lint-imports`` binary over a
throw-away workspace: two packages that do not know each other, then the same
pair with one import added.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]

CONFIG = """[tool.importlinter]
root_packages = ["pkg_a", "pkg_b"]

[[tool.importlinter.contracts]]
name = "the fixture packages are independent"
type = "independence"
modules = ["pkg_a", "pkg_b"]
"""

CLEAN_A = "value = 1\n"
CLEAN_B = "value = 2\n"
VIOLATING_A = "import pkg_b\n\nvalue = pkg_b.value\n"


def lint_imports() -> str:
    """Absolute path of the ``lint-imports`` binary of the active environment."""
    found = shutil.which("lint-imports")
    if found:
        return found
    fallback = Path(sys.executable).parent / "lint-imports"
    assert fallback.is_file(), "install the dev group: `uv sync --all-packages`"
    return str(fallback)


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    """A two-package workspace with a config declaring them independent."""
    (tmp_path / "pkg_a").mkdir()
    (tmp_path / "pkg_b").mkdir()
    (tmp_path / "pkg_a" / "__init__.py").write_text(CLEAN_A, encoding="utf-8")
    (tmp_path / "pkg_b" / "__init__.py").write_text(CLEAN_B, encoding="utf-8")
    (tmp_path / "pyproject.toml").write_text(CONFIG, encoding="utf-8")
    return tmp_path


def run_lint_imports(workspace: Path) -> subprocess.CompletedProcess[str]:
    """Run the real binary against ``workspace`` with only that on the path."""
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(workspace)
    return subprocess.run(
        [lint_imports(), "--config", str(workspace / "pyproject.toml"), "--no-cache", "--no-logo"],
        capture_output=True,
        check=False,
        text=True,
        cwd=workspace,
        env=environment,
    )


def test_a_clean_workspace_reports_the_contract_kept(workspace: Path) -> None:
    completed = run_lint_imports(workspace)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "KEPT" in completed.stdout
    assert "BROKEN" not in completed.stdout


def test_a_cross_import_reports_the_contract_broken(workspace: Path) -> None:
    (workspace / "pkg_a" / "__init__.py").write_text(VIOLATING_A, encoding="utf-8")
    completed = run_lint_imports(workspace)
    assert completed.returncode == 1, completed.stdout + completed.stderr
    assert "BROKEN" in completed.stdout
    assert "pkg_a -> pkg_b" in completed.stdout


def existing_member_packages() -> set[str]:
    """Import names of the uv workspace members that exist in this worktree."""
    config = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    names: set[str] = set()
    for member in config["tool"]["uv"]["workspace"]["members"]:
        manifest = REPO_ROOT / member / "pyproject.toml"
        if not manifest.is_file():
            continue  # a member a later task still has to write
        distribution = tomllib.loads(manifest.read_text(encoding="utf-8"))["project"]["name"]
        names.add(distribution.replace("-", "_"))
    return names


def test_the_repository_contracts_cover_every_python_member() -> None:
    """A member that exists must be named in both contracts, or it is unguarded."""
    expected = existing_member_packages()
    assert "fdp_repo_checks" in expected

    linter = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))["tool"][
        "importlinter"
    ]
    assert set(linter["root_packages"]) == expected
    independence, forbidden = linter["contracts"]
    assert independence["type"] == "independence"
    assert set(independence["modules"]) == expected
    assert forbidden["type"] == "forbidden"
    assert forbidden["source_modules"] == ["fdp_init"]
    assert set(forbidden["forbidden_modules"]) == expected - {"fdp_init"}
