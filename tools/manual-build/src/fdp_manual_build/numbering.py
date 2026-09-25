# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Chapter partials to a :data:`SectionMap`.

The outline is computed by scanning the *raw* Markdown with two regexes - the
heading lines that carry an explicit ``{#anchor}`` and the ``{{ tables.x() }}``
macro lines - before any Jinja pass, so the HTML preview and the PDF build
number the manual identically.

``manual/tools/context.py::build_outline`` is the reference implementation;
this module implements the same two regexes and the same labels.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import TYPE_CHECKING, Final

from fdp_manual_build.errors import BuildError, LoadError

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.config import BuildConfig
    from fdp_manual_build.model import Manual

__all__ = [
    "TABLE_MACROS",
    "ChapterSource",
    "GeneratedHeading",
    "SectionMap",
    "SectionRef",
    "generated_sections",
    "read_chapters",
    "scan",
]

#: The ten table macros of the manual's namespace.
TABLE_MACROS: Final = frozenset(
    {
        "alarms",
        "settings",
        "maintenance_schedule",
        "maintenance_procedures",
        "troubleshooting",
        "technical_data",
        "signals",
        "normal_bands",
        "parts",
        "revision_history",
    }
)
#: The two macros that emit headings of their own.
_GENERATING_MACROS: Final = frozenset({"troubleshooting", "maintenance_procedures"})

_HEADING = re.compile(r"^(?P<hashes>#+)[ \t]+(?P<rest>.*?)[ \t]*$")
_ANCHORED = re.compile(r"^(?P<title>.+?)[ \t]*\{#(?P<anchor>[^}]*)\}$")
_MACRO = re.compile(r"^[ \t]*\{\{[ \t]*tables\.(?P<name>[A-Za-z_][A-Za-z0-9_]*)\(\)[ \t]*\}\}")
_ANCHOR = re.compile(r"^[a-z]+:[a-z][a-z0-9_-]{1,60}$")

_SECTION_LEVEL: Final = 2
_SUBSECTION_LEVEL: Final = 3


@dataclass(frozen=True)
class ChapterSource:
    """One chapter partial as read from disk."""

    number: int
    slug: str
    title: str
    path: Path
    relative: str
    text: str
    sha256: str


@dataclass(frozen=True)
class SectionRef:
    """One numbered section of the outline."""

    number: str
    title: str
    chapter: int
    anchor: str
    slug: str

    @property
    def html_id(self) -> str:
        """The HTML id: the anchor with ``:`` replaced by ``-``."""
        return self.anchor.replace(":", "-")


SectionMap = Mapping[str, SectionRef]


@dataclass(frozen=True)
class GeneratedHeading:
    """A heading a table macro emits at its own position in the partial."""

    level: int
    anchor: str
    title: str


def read_chapters(cfg: BuildConfig) -> tuple[ChapterSource, ...]:
    """Read ``content/NN-<slug>.md`` for every chapter of ``cfg``.

    Raises:
        BuildError: when a partial is missing; every missing file is listed.
    """
    sources: list[ChapterSource] = []
    errors: list[LoadError] = []
    for chapter in cfg.chapters:
        path = cfg.chapter_path(chapter)
        relative = f"content/{chapter.filename}"
        if not path.is_file():
            errors.append(LoadError(relative, "", "missing chapter partial"))
            continue
        data = path.read_bytes()
        sources.append(
            ChapterSource(
                number=chapter.number,
                slug=chapter.slug,
                title=chapter.title,
                path=path,
                relative=relative,
                text=data.decode("utf-8"),
                sha256=hashlib.sha256(data).hexdigest(),
            )
        )
    if errors:
        raise BuildError(f"{cfg.manual_root}: chapter partials are missing", errors)
    return tuple(sources)


def generated_sections(manual: Manual) -> Mapping[str, tuple[GeneratedHeading, ...]]:
    """The headings each table macro contributes, keyed by macro name."""
    generated: dict[str, tuple[GeneratedHeading, ...]] = {
        "troubleshooting": tuple(
            GeneratedHeading(level=_SECTION_LEVEL, anchor=f"cond:{item.id}", title=item.title)
            for item in manual.conditions
        ),
        "maintenance_procedures": tuple(
            GeneratedHeading(level=_SUBSECTION_LEVEL, anchor=f"task:{item.id}", title=item.name)
            for item in manual.maintenance
        ),
    }
    return MappingProxyType(generated)


def scan(
    chapters: Sequence[ChapterSource],
    generated: Mapping[str, Sequence[GeneratedHeading]] | None = None,
) -> SectionMap:
    """Number every section of ``chapters`` in document order.

    ``##`` becomes ``N.k`` and ``###`` ``N.k.m``; the headings a table macro
    emits are inserted at the macro's position. Anchors are unique across the
    whole manual and become HTML ids with ``:`` replaced by ``-``.

    Raises:
        BuildError: on a heading without an anchor, a heading outside levels
            2 and 3, a malformed or duplicate anchor, a ``###`` before the
            first ``##`` of its chapter or an unknown table macro. Every
            problem is reported with its file and line.
    """
    errors: list[LoadError] = []
    sections: dict[str, SectionRef] = {}
    for chapter in chapters:
        _ChapterScan(chapter, generated or {}, sections, errors).run()
    if errors:
        raise BuildError("the chapter partials break the outline rules", errors)
    return MappingProxyType(sections)


class _ChapterScan:
    """Numbers one chapter, appending to the manual-wide map and error list."""

    def __init__(
        self,
        chapter: ChapterSource,
        generated: Mapping[str, Sequence[GeneratedHeading]],
        sections: dict[str, SectionRef],
        errors: list[LoadError],
    ) -> None:
        self._chapter = chapter
        self._generated = generated
        self._sections = sections
        self._errors = errors
        self._section = 0
        self._subsection = 0
        self._line = 0

    def run(self) -> None:
        """Walk the partial line by line."""
        for line_number, line in enumerate(self._chapter.text.splitlines(), start=1):
            self._line = line_number
            macro = _MACRO.match(line)
            if macro is not None:
                self._expand(macro["name"])
                continue
            heading = _HEADING.match(line)
            if heading is not None:
                self._heading(heading)

    def _heading(self, heading: re.Match[str]) -> None:
        level = len(heading["hashes"])
        if not _SECTION_LEVEL <= level <= _SUBSECTION_LEVEL:
            self._fail(f"heading level {level} is not allowed; partials use ## and ### only")
            return
        anchored = _ANCHORED.match(heading["rest"])
        if anchored is None:
            self._fail(f"heading {heading['rest']!r} has no explicit {{#anchor}}")
            return
        anchor = anchored["anchor"]
        if _ANCHOR.match(anchor) is None:
            self._fail(f"malformed anchor {anchor!r}")
            return
        self._add(level, anchor, anchored["title"])

    def _expand(self, name: str) -> None:
        if name not in TABLE_MACROS:
            self._fail(f"unknown table macro {name!r}")
            return
        if name not in _GENERATING_MACROS:
            return
        for heading in self._generated.get(name, ()):
            self._add(heading.level, heading.anchor, heading.title)

    def _add(self, level: int, anchor: str, title: str) -> None:
        number = self._number(level)
        if number is None:
            self._fail(f"{'#' * level} {title!r} has no ## section above it")
            return
        if anchor in self._sections:
            self._fail(f"duplicate anchor {anchor!r}")
            return
        self._sections[anchor] = SectionRef(
            number=number,
            title=title,
            chapter=self._chapter.number,
            anchor=anchor,
            slug=anchor.split(":", 1)[1],
        )

    def _number(self, level: int) -> str | None:
        """The next ``N.k[.m]``, or ``None`` for a ``###`` with no ``##`` above."""
        if level == _SECTION_LEVEL:
            self._section += 1
            self._subsection = 0
            return f"{self._chapter.number}.{self._section}"
        if self._section == 0:
            return None
        self._subsection += 1
        return f"{self._chapter.number}.{self._section}.{self._subsection}"

    def _fail(self, message: str) -> None:
        self._errors.append(LoadError(self._chapter.relative, "", f"line {self._line}: {message}"))
