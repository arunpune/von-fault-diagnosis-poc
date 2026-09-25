# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The build reads no clock and draws no random number.

Same inputs must give the same bytes, so nothing under ``src/`` or
``manual/templates/`` may reach for the wall clock, a random source or a UUID.
The two modules that legitimately record wall time are exempt: ``manifest.py``
writes it into a field excluded from the reproducibility comparison, and
``scanned.py`` seeds its own noise generator. So is the ``checks`` package: it
judges the build and writes ``reports/manual-check.*``, which carries the time
of the run and how long each check took and is never an input to a build.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[2] / "src" / "fdp_manual_build"
TEMPLATES = Path(__file__).resolve().parents[4] / "manual" / "templates"

#: Files allowed to use a clock or a random source.
EXEMPT = frozenset({"manifest.py", "scanned.py"})
#: Packages that report on a build instead of producing one.
EXEMPT_PACKAGES = frozenset({"checks"})

FORBIDDEN = {
    "wall clock": re.compile(r"\bdatetime\.now\b|\bdate\.today\b"),
    "monotonic or wall time": re.compile(r"\btime\.time\b|\btime\.monotonic\b"),
    "random source": re.compile(r"\brandom\b"),
    "uuid": re.compile(r"\buuid\b"),
}


def _is_exempt(path: Path) -> bool:
    relative = path.relative_to(SRC)
    return path.name in EXEMPT or bool(set(relative.parts[:-1]) & EXEMPT_PACKAGES)


def _sources() -> list[Path]:
    files = [path for path in SRC.rglob("*.py") if not _is_exempt(path)]
    if TEMPLATES.is_dir():
        files += sorted(TEMPLATES.rglob("*.j2"))
        files += sorted(TEMPLATES.rglob("*.css"))
    assert files, f"no sources found under {SRC}"
    return sorted(files)


@pytest.mark.parametrize("path", _sources(), ids=lambda path: path.name)
def test_no_clock_and_no_randomness(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    hits = [
        f"{label}: line {index}"
        for label, pattern in FORBIDDEN.items()
        for index, line in enumerate(text.splitlines(), start=1)
        if pattern.search(line)
    ]
    assert not hits, f"{path} is not deterministic: {'; '.join(hits)}"
