# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Shared pytest fixtures for the manual tooling tests."""

from __future__ import annotations

import json
import shutil
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import yaml

TOOLS_DIR = Path(__file__).resolve().parent.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from load import SPEC_FILES, SpecLoader  # noqa: E402  (path shim above must run first)

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

#: pass as ``value`` to remove the key or list item the pointer addresses; test
#: modules receive it through the ``delete`` fixture rather than by import, so
#: that pytest's import mode cannot hand them a second, unequal sentinel.
DELETE = object()

MutateFn = Callable[[Path, Path, str, str, Any], Path]


def _split_pointer(pointer: str) -> list[str]:
    if not pointer.startswith("/"):
        raise ValueError(f"pointer must start with '/': {pointer!r}")
    return [part.replace("~1", "/").replace("~0", "~") for part in pointer[1:].split("/")]


def _descend(document: Any, tokens: list[str]) -> Any:
    node = document
    for token in tokens:
        node = node[int(token)] if isinstance(node, list) else node[token]
    return node


def _apply(document: Any, pointer: str, value: Any) -> None:
    tokens = _split_pointer(pointer)
    parent = _descend(document, tokens[:-1])
    last = tokens[-1]
    key: Any = int(last) if isinstance(parent, list) else last
    if value is DELETE:
        del parent[key]
    else:
        parent[key] = value


def _leading_comment(text: str) -> str:
    lines = text.splitlines(keepends=True)
    kept: list[str] = []
    for line in lines:
        if line.startswith("#") or not line.strip():
            kept.append(line)
        else:
            break
    return "".join(kept)


@pytest.fixture(scope="session")
def delete() -> object:
    """The sentinel that makes ``mutate`` remove a key or list item."""
    return DELETE


@pytest.fixture(scope="session")
def minimal_spec_dir() -> Path:
    """The committed, complete and valid tiny spec every rule test starts from."""
    return FIXTURES_DIR / "spec-minimal"


@pytest.fixture
def mutate() -> MutateFn:
    """Return ``mutate(spec_dir, tmp_path, file, pointer, value)``.

    Copies ``spec_dir`` into ``tmp_path``, edits the single value that ``pointer``
    (an RFC 6901 JSON pointer) addresses inside ``file`` (a key of
    :data:`load.SPEC_FILES`) and returns the copy's path. Pass :data:`DELETE` as
    ``value`` to remove the key or list item instead. The SPDX header comment of
    a rewritten YAML file is preserved so that rule L1 keeps passing.
    """

    def _mutate(spec_dir: Path, tmp_path: Path, file: str, pointer: str, value: Any) -> Path:
        target = tmp_path / "spec-mutated"
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(spec_dir, target)
        path = target / SPEC_FILES[file][0]
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".json":
            document = json.loads(text)
            _apply(document, pointer, value)
            path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        else:
            document = yaml.load(text, Loader=SpecLoader)
            _apply(document, pointer, value)
            body = yaml.safe_dump(document, sort_keys=False, allow_unicode=True)
            path.write_text(_leading_comment(text) + body, encoding="utf-8")
        return target

    return _mutate
