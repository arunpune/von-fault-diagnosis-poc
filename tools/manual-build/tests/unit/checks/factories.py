# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Builders the check tests share.

The adapters of ``fdp_manual_build.checks`` read two things: the model the
loader produced and the output of the manual's validators. :func:`context` builds a
:class:`~fdp_manual_build.checks.base.CheckContext` around the mini fixture and
lets a test seed the validator output with :func:`tool_run`, so every finding
code can be provoked without a subprocess and without a broken fixture tree.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

from fdp_manual_build.checks.base import CheckContext, Finding, Profile
from fdp_manual_build.checks.mantools import ToolRun
from fdp_manual_build.checks.pdftext import normalize

__all__ = ["STATS", "FakePdf", "blocklist_stub", "context", "tool_run"]

_TESTS_DIR = Path(__file__).resolve().parents[2]
_STATS_RELATIVE = Path("data") / "metropt3-first-month-stats.json"

#: The one statistics field check #11 asserts on, with the verified sha256.
STATS: Mapping[str, Any] = {
    "source": {
        "file": "MetroPT3(AirCompressor).csv",
        "sha256": "db30ccb4ea402e3c8bf2c99db06e288d4f2a772f6928f9dbe26a920d69793e24",
    }
}


def tool_run(
    tool: str,
    *lines: str,
    error: str | None = None,
    skipped: str | None = None,
) -> ToolRun:
    """A validator run whose standard output is ``lines``."""
    if error is not None or skipped is not None:
        return ToolRun(tool=tool, command=(tool,), returncode=2, error=error, skipped=skipped)
    return ToolRun.from_stdout(tool, "".join(f"{line}\n" for line in lines), command=(tool,))


def context(
    *,
    repo_root: Path,
    manual_root: Path,
    cfg: Any = None,
    manual: Any = None,
    sections: Any = None,
    profile: Profile = Profile.FIXTURE,
    load_errors: Sequence[Finding] = (),
    validate: ToolRun | None = None,
    content_checks: ToolRun | None = None,
    stats: Mapping[str, Any] | None = None,
    reports_dir: Path | None = None,
    variant_dir: Path | None = None,
    blocklist_cmd: Path | None = None,
    pdfs: Mapping[str, Any] | None = None,
    rebuilt: Mapping[str, Any] | None = None,
    rebuilt_dir: Path | None = None,
    require_pdf: bool = True,
) -> CheckContext:
    """A context with the validator runs already seeded, so nothing forks.

    ``pdfs`` and ``rebuilt`` take :class:`FakePdf` instances as readily as the
    real extraction, because the checks only ever call the reading surface.
    """
    ctx = CheckContext(
        repo_root=repo_root,
        manual_root=manual_root,
        profile=profile,
        cfg=cfg,
        manual=manual,
        sections=sections,
        load_errors=tuple(load_errors),
        stats=STATS if stats is None else stats,
        stats_path=repo_root / _STATS_RELATIVE,
        stats_sha256="0" * 64,
        reports_dir=reports_dir or (_TESTS_DIR / ".reports"),
        variant_dir=variant_dir or (repo_root / "data" / "manual"),
        blocklist_cmd=blocklist_cmd or (repo_root / "scripts" / "blocklist.sh"),
        require_pdf=require_pdf,
        rebuilt_dir=rebuilt_dir,
        pdfs=dict(pdfs or {}),
        rebuilt=None if rebuilt is None else dict(rebuilt),
    )
    ctx.tool_runs["validate"] = validate if validate is not None else tool_run("validate.py")
    ctx.tool_runs["content_checks"] = (
        content_checks
        if content_checks is not None
        else tool_run("content_checks.py", skipped="not part of this test")
    )
    return ctx


class FakePdf:
    """A stand-in for :class:`~fdp_manual_build.checks.pdftext.PdfText`.

    The PDF-level checks only ever read: page text, table cells, column halves,
    the hashes and the hygiene metadata. Building those from plain strings lets
    a unit test provoke every finding code — a missing fault id, an interleaved
    column, a fallback font — without rendering anything.
    """

    def __init__(
        self,
        pages: Sequence[str] = (),
        *,
        tables: Mapping[int, Sequence[Sequence[Sequence[str]]]] | None = None,
        halves: Mapping[int, tuple[str, str]] | None = None,
        name: str = "fixture.pdf",
        metadata: Mapping[str, Any] | None = None,
        pdf_version: str = "1.7",
        fontnames: Sequence[str] = ("ABCDEF+IBM-Plex-Sans",),
        markers: Sequence[bytes] = (),
        text_sha256: str = "t" * 64,
        pdf_sha256: str = "p" * 64,
    ) -> None:
        self.path = Path(name)
        self.pages = tuple(pages)
        self._tables = {
            number: tuple(tuple(tuple(row) for row in table) for table in value)
            for number, value in (tables or {}).items()
        }
        self._halves = dict(halves or {})
        self.metadata = dict(metadata or {"Producer": "WeasyPrint 70.0"})
        self.pdf_version = pdf_version
        self.fontnames = frozenset(fontnames)
        self.text_sha256 = text_sha256
        self.pdf_sha256 = pdf_sha256
        self._markers = tuple(markers)

    @property
    def page_count(self) -> int:
        return len(self.pages)

    @property
    def joined(self) -> str:
        return "\f".join(self.pages)

    @property
    def size(self) -> int:
        return len(self.joined)

    @property
    def normalized_pages(self) -> tuple[str, ...]:
        return tuple(normalize(text) for text in self.pages)

    def blank_pages(self) -> tuple[int, ...]:
        return tuple(number for number, text in enumerate(self.pages, start=1) if not text.strip())

    def page_of(self, needle: str) -> int | None:
        for number, text in enumerate(self.normalized_pages, start=1):
            if needle in text:
                return number
        return None

    def page_opening(self, title: str) -> int | None:
        for number, text in enumerate(self.pages, start=1):
            if any(line.strip() == title for line in text.splitlines()):
                return number
        return None

    def cell_page_of(self, needle: str) -> int | None:
        for number in sorted(self._tables):
            cells = [
                normalize(cell) for table in self._tables[number] for row in table for cell in row
            ]
            if any(needle in cell for cell in cells):
                return number
        return None

    def rows_on(self, pages: Sequence[int]) -> Iterator[tuple[tuple[str, ...], ...]]:
        for number in pages:
            for table in self._tables.get(number, ()):
                yield tuple(tuple(normalize(cell) for cell in row) for row in table)

    def page_halves(self, page_index: int) -> tuple[str, str]:
        return self._halves.get(page_index + 1, ("", ""))

    def in_any_half(self, needle: str) -> int | None:
        for number, (left, right) in sorted(self._halves.items()):
            if needle in normalize(left) or needle in normalize(right):
                return number
        return None

    def raw_contains(self, marker: bytes) -> bool:
        return marker in self._markers


def blocklist_stub(tmp_path: Path, payload: Mapping[str, Any], *, exit_code: int = 0) -> Path:
    """An executable stand-in for ``scripts/blocklist.sh`` printing ``payload``."""
    script = tmp_path / "blocklist-stub.py"
    script.write_text(
        f"#!{sys.executable}\n"
        "import sys\n"
        f"sys.stdout.write({json.dumps(json.dumps(payload))})\n"
        f"raise SystemExit({exit_code})\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    return script
