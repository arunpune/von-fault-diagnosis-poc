# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-checks gt-paths``: no diagnosis path reaches ground truth.

The cross-language half of the ground-truth isolation
(docs/architecture.md#ground-truth-isolation). The package graphs of the three
languages catch an import; this catches the paths they cannot see — a topic
literal in a string, a ``gt.*`` table name in SQL, a dependency added to a
manifest, a bind mount in a Dockerfile.

Scope: the backend source outside ``overlay/`` (the read-only overlay endpoint
and the recorder are the permitted readers), the frontend source, and the
Dockerfiles and package manifests of every app. Tests under
``apps/*/test/`` are deliberately out of scope; they may exercise the overlay.
A directory that does not exist is not a finding, so the check also runs on a
partial tree.
"""

from __future__ import annotations

import argparse
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from fdp_repo_checks.findings import Finding, report

NAME = "gt-paths"
HELP = "check that no diagnosis path names ground truth"

SCAN_DIRS = ("apps/backend/src", "apps/frontend/src")
"""Source trees diagnosis code lives in."""

EXCLUDED_DIRS = ("apps/backend/src/overlay",)
"""Inside the scanned trees, the modules permitted to read ground truth."""

SCAN_GLOBS = ("apps/*/Dockerfile*", "apps/*/package.json")
"""Manifests and images: a dependency or a bind mount is a path too."""

SKIP_DIR_NAMES = frozenset({"node_modules", "dist", "coverage", "__pycache__", ".turbo"})

MAX_SCAN_BYTES = 2 * 1024 * 1024
"""Anything larger than this in a source tree is generated, not hand-written."""

PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("package", re.compile(r"@fdp/ground-truth", re.IGNORECASE)),
    ("name", re.compile(r"ground[-_]truth", re.IGNORECASE)),
    ("topic", re.compile(r"[\"'`]gt/", re.IGNORECASE)),
    ("table", re.compile(r"\bgt\.(injections|markers|catalog_snapshot)\b", re.IGNORECASE)),
)
"""Ordered so the most specific pattern claims an overlapping span first."""


@dataclass(frozen=True)
class Hit:
    """One match, with enough position to suppress an overlapping duplicate."""

    kind: str
    start: int
    end: int
    text: str


def register(parser: argparse.ArgumentParser) -> None:
    """The check takes no options of its own beyond the global ``--root``."""


def scan_line(line: str) -> list[Hit]:
    """Return the distinct matches in one line, longest span first."""
    candidates: list[Hit] = []
    for kind, pattern in PATTERNS:
        candidates.extend(
            Hit(kind, match.start(), match.end(), match.group(0))
            for match in pattern.finditer(line)
        )
    candidates.sort(key=lambda hit: (hit.start, -(hit.end - hit.start)))
    kept: list[Hit] = []
    for hit in candidates:
        if any(hit.start < other.end and other.start < hit.end for other in kept):
            continue
        kept.append(hit)
    return kept


def _is_excluded(relative: str) -> bool:
    return any(
        relative == excluded or relative.startswith(f"{excluded}/") for excluded in EXCLUDED_DIRS
    )


def iter_scan_paths(root: Path) -> Iterator[str]:
    """Yield the repository-relative paths in scope, sorted and unique."""
    seen: set[str] = set()
    for directory in SCAN_DIRS:
        base = root / directory
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file() or path.is_symlink():
                continue
            relative = path.relative_to(root).as_posix()
            if _is_excluded(relative) or SKIP_DIR_NAMES.intersection(path.parts):
                continue
            seen.add(relative)
    for pattern in SCAN_GLOBS:
        for path in sorted(root.glob(pattern)):
            if path.is_file() and not path.is_symlink():
                seen.add(path.relative_to(root).as_posix())
    yield from sorted(seen)


def scan_file(root: Path, relative: str) -> list[Finding]:
    """Report every ground-truth reference in one file."""
    path = root / relative
    try:
        if path.stat().st_size > MAX_SCAN_BYTES:
            return []
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    findings: list[Finding] = []
    for number, line in enumerate(text.splitlines(), start=1):
        findings.extend(
            Finding(relative, f"ground-truth {hit.kind} reference {hit.text!r}", line=number)
            for hit in scan_line(line)
        )
    return findings


def run(args: argparse.Namespace) -> int:
    """Scan every in-scope file and report."""
    root: Path = args.root
    paths = list(iter_scan_paths(root))
    findings = [finding for path in paths for finding in scan_file(root, path)]
    return report(NAME, findings, output_format=args.output_format, checked=len(paths))
