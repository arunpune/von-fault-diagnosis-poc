# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Ground-truth isolation: no diagnosis path names ground truth.

``lint-imports`` catches an import and ``fdp-checks gt-paths`` covers the
apps; this catches the paths neither sees inside ``src/fdp_init`` — a topic
literal, a ``gt.`` table name, a fixture path in a docstring. Init reads the
manual and the dataset and nothing else.
"""

from __future__ import annotations

import re
from pathlib import Path

import fdp_init

FORBIDDEN = (
    re.compile(r"ground-truth"),
    re.compile(r"ground_truth"),
    re.compile(r"tools/eval"),
    re.compile(r"gt/"),
    re.compile(r"\bgt\."),
    re.compile(r"metropt3-failures"),
)


def source_root() -> Path:
    """``src/fdp_init``, found from the installed package itself."""
    root = Path(fdp_init.__file__).parent
    assert root.name == "fdp_init"
    return root


def test_source_never_names_ground_truth() -> None:
    hits: list[str] = []
    for path in sorted(source_root().rglob("*.py")):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            hits.extend(
                f"{path.name}:{number}: {pattern.pattern} in {line.strip()!r}"
                for pattern in FORBIDDEN
                if pattern.search(line)
            )

    assert hits == []


def test_the_guard_would_catch_a_hit(tmp_path: Path) -> None:
    """The patterns are not all dead letters."""
    sample = "from packages.ground_truth import injections  # gt/#"

    assert [pattern.pattern for pattern in FORBIDDEN if pattern.search(sample)] == [
        "ground_truth",
        "gt/",
    ]
