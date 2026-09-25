# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Import ``manual/tools/load.py``, the manual's single spec loader.

``manual/tools`` deliberately sits outside the uv workspace,
so it cannot be imported by name. This
module loads the file by path into a private module object instead of vendoring
a copy, which keeps the manual's schemas and field names the single source of truth.

The loader always reads the schemas from the checkout it lives in
(``manual/spec/schemas``), so a fixture tree carries data only.
"""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Mapping
from functools import cache
from pathlib import Path
from typing import Any, Protocol, cast

from fdp_manual_build.errors import BuildError

__all__ = ["MANUAL_TOOLS_RELATIVE", "SpecLoaderModule", "find_repo_root", "spec_loader"]

#: Where the manual's loader lives, relative to the repository root.
MANUAL_TOOLS_RELATIVE = Path("manual") / "tools" / "load.py"

_MODULE_NAME = "fdp_manual_build._manual_tools_load"


class Spec(Protocol):
    """The subset of ``manual.tools.load.Spec`` the PDF build relies on."""

    root: Path
    files_present: frozenset[str]

    def document(self, key: str) -> dict[str, Any] | None: ...

    def path_of(self, key: str) -> str: ...


class _LoadSpec(Protocol):
    def __call__(self, root: Path, only: set[str] | None = ...) -> Spec: ...


class SpecLoaderModule(Protocol):
    """The public surface of ``manual/tools/load.py`` (its ``__all__``)."""

    SPEC_FILES: Mapping[str, tuple[str, str]]
    YAML_FILE_KEYS: tuple[str, ...]
    SpecError: type[Exception]
    load_spec: _LoadSpec


def find_repo_root(start: Path) -> Path | None:
    """Return the first ancestor of ``start`` that holds ``manual/tools/load.py``."""
    start = start.resolve()
    candidates = (start, *start.parents) if start.is_dir() else start.parents
    for candidate in candidates:
        if (candidate / MANUAL_TOOLS_RELATIVE).is_file():
            return candidate
    return None


def spec_loader(repo_root: Path) -> SpecLoaderModule:
    """Import the manual's spec loader out of ``repo_root``.

    Raises:
        BuildError: when ``repo_root`` does not hold ``manual/tools/load.py``.
    """
    path = (repo_root / MANUAL_TOOLS_RELATIVE).resolve()
    if not path.is_file():
        raise BuildError(f"{repo_root}: no {MANUAL_TOOLS_RELATIVE.as_posix()} in this checkout")
    return _import_module(path)


@cache
def _import_module(path: Path) -> SpecLoaderModule:
    spec = importlib.util.spec_from_file_location(_MODULE_NAME, path)
    if spec is None or spec.loader is None:
        raise BuildError(f"{path}: cannot be imported as a Python module")
    module = importlib.util.module_from_spec(spec)
    # Registered before execution so that dataclasses and pickling can find it.
    sys.modules[_MODULE_NAME] = module
    spec.loader.exec_module(module)
    return cast("SpecLoaderModule", module)
