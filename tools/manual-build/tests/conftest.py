# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Shared pytest fixtures for the manual build tests."""

from __future__ import annotations

import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import yaml

from fdp_manual_build.config import BuildConfig, load_build_config
from fdp_manual_build.load import load_manual
from fdp_manual_build.manual_tools import find_repo_root
from fdp_manual_build.model import Manual

TESTS_DIR = Path(__file__).resolve().parent
FIXTURES_DIR = TESTS_DIR / "fixtures"
MINI_SPEC_DIR = FIXTURES_DIR / "mini-spec"

#: Pass as ``value`` to :data:`MutateFn` to delete the addressed key or item.
DELETE = object()

MutateFn = Callable[[Path, str, str, Any], Path]


def _repo_root() -> Path:
    root = find_repo_root(TESTS_DIR)
    if root is None:  # pragma: no cover - the tests live inside the checkout
        raise RuntimeError(f"no manual/tools/load.py above {TESTS_DIR}")
    return root


@pytest.fixture(scope="session")
def repo_root() -> Path:
    """The checkout that provides the manual's loader and the real schemas."""
    return _repo_root()


@pytest.fixture(scope="session")
def mini_spec_dir() -> Path:
    """The committed mini manual tree."""
    return MINI_SPEC_DIR


@pytest.fixture(scope="session")
def mini_config(repo_root: Path, mini_spec_dir: Path) -> BuildConfig:
    """``build.yaml`` of the mini fixture, parsed and validated."""
    return load_build_config(repo_root, mini_spec_dir)


@pytest.fixture(scope="session")
def mini_manual(repo_root: Path, mini_config: BuildConfig) -> Manual:
    """The mini fixture loaded into the data model."""
    return load_manual(repo_root, mini_config)


@pytest.fixture
def delete() -> object:
    """The sentinel that makes :data:`MutateFn` remove a key or list item."""
    return DELETE


@pytest.fixture
def mutate(tmp_path: Path) -> MutateFn:
    """Return ``mutate(tmp_path, relative, pointer, value) -> Path``.

    Copies the mini fixture into ``tmp_path``, edits the single value that
    ``pointer`` (an RFC 6901 JSON pointer) addresses inside the YAML file
    ``relative`` and returns the copy's root. Pass :data:`DELETE` as ``value``
    to remove the key or list item instead. The SPDX header comment is kept.
    """

    def _mutate(target_root: Path, relative: str, pointer: str, value: Any) -> Path:
        target = target_root / "mini-spec"
        if not target.exists():
            shutil.copytree(MINI_SPEC_DIR, target)
        path = target / relative
        text = path.read_text(encoding="utf-8")
        document = yaml.safe_load(text)
        _apply(document, pointer, value)
        body = yaml.safe_dump(document, sort_keys=False, allow_unicode=True)
        path.write_text(_leading_comment(text) + body, encoding="utf-8")
        return target

    return _mutate


def _leading_comment(text: str) -> str:
    kept: list[str] = []
    for line in text.splitlines(keepends=True):
        if line.startswith("#") or not line.strip():
            kept.append(line)
        else:
            break
    return "".join(kept)


def _apply(document: Any, pointer: str, value: Any) -> None:
    if not pointer.startswith("/"):
        raise ValueError(f"pointer must start with '/': {pointer!r}")
    tokens = [part.replace("~1", "/").replace("~0", "~") for part in pointer[1:].split("/")]
    node = document
    for token in tokens[:-1]:
        node = node[int(token)] if isinstance(node, list) else node[token]
    last = tokens[-1]
    key: Any = int(last) if isinstance(node, list) else last
    if value is DELETE:
        del node[key]
    else:
        node[key] = value
