# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Section pass of manual extraction.

A manual numbers its headings, and every fact the catalog stores has to name
the section it came from: ``manual_section`` is what a technician follows back
to the paper. This module finds those headings among the lines the layout pass
returned, attaches every text block to the innermost one and turns the tree
into the ``app.catalog_sections`` rows.

Only the numbering is trusted, never the font alone: a line is a heading when
it *starts* with its number, continues the tree the document has built so far
and is set apart from the body. A cross-reference such as "See 8.2.3" is
therefore never mistaken for the section it names.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import replace
from typing import TypedDict

from fdp_init.manual.model import Heading, Line, TextBlock
from fdp_init.manual.pdf import BlockSpan

__all__ = [
    "CHAPTER_TAGS",
    "SectionRow",
    "assign_sections",
    "chapter_tag",
    "detect_headings",
    "parent_ref",
    "sections_table",
]

HEADING_RE = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,2})\s+([A-Z][^\n]{2,80})$")
"""A heading: the number first, then a title that starts with a capital."""

HEADING_SIZE_LIFT = 1.0
"""A heading is bold or at least this much larger than the body size."""

UNIT_TOKENS = frozenset({"bar", "°c", "a", "s", "min", "h", "%", "psi"})
"""A title starting with a unit is a measurement, not a heading."""

CHAPTER_TAGS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("troubleshooting", ("problem", "troubleshoot")),
    ("alarms", ("controller", "message")),
    ("settings", ("setting", "parameter")),
    ("maintenance", ("maintenance",)),
    ("technical", ("technical data", "signal")),
)
"""Keyword map, in order; the first hit wins, ``other`` is the default."""


class SectionRow(TypedDict):
    """One ``app.catalog_sections`` row."""

    section_ref: str
    title: str
    level: int
    parent_ref: str | None
    page_start: int
    page_end: int


def parent_ref(ref: str) -> str | None:
    """``"8.2.3"`` → ``"8.2"``; a top-level ref has no parent."""
    head, _, tail = ref.rpartition(".")
    return head if tail and head else None


def _level(ref: str) -> int:
    return ref.count(".") + 1


def _continues_tree(ref: str, open_refs: dict[int, str], last_top: int | None) -> bool:
    """Whether ``ref`` continues the open heading tree.

    ``8.2`` needs ``8`` open and ``8.2.3`` needs ``8.2`` open. A top-level
    number only has to be *greater* than the previous one, not its successor:
    the mini-manual — like any excerpt of a real manual — prints chapters 1, 3,
    4, 8, 9.
    """
    level = _level(ref)
    if level == 1:
        return last_top is None or int(ref) > last_top
    parent = parent_ref(ref)
    return parent is not None and open_refs.get(level - 1) == parent


def _is_set_apart(line: Line, body_size: float) -> bool:
    return line.bold or line.size >= body_size + HEADING_SIZE_LIFT


def _title_is_measurement(title: str) -> bool:
    first = title.split(maxsplit=1)[0] if title.split() else ""
    return first.casefold() in UNIT_TOKENS


def detect_headings(lines_by_page: Sequence[Sequence[Line]], body_size: float) -> list[Heading]:
    """Find the numbered headings of the document.

    ``lines_by_page`` holds the ordered lines of each page with the table
    regions already excluded, so a group row printed inside a troubleshooting
    table — ``8.2.1 Line pressure below setpoint`` — is not offered here and
    never becomes a section of its own.
    """
    headings: list[Heading] = []
    open_refs: dict[int, str] = {}
    last_top: int | None = None
    for lines in lines_by_page:
        for line in lines:
            match = HEADING_RE.match(line.text)
            if match is None:
                continue
            ref, title = match.group(1), match.group(2).strip()
            if not _is_set_apart(line, body_size) or _title_is_measurement(title):
                continue
            if not _continues_tree(ref, open_refs, last_top):
                continue
            level = _level(ref)
            open_refs = {depth: value for depth, value in open_refs.items() if depth < level}
            open_refs[level] = ref
            if level == 1:
                last_top = int(ref)
            headings.append(
                Heading(ref=ref, title=title, level=level, page=line.page, top=line.top)
            )
    return headings


def assign_sections(blocks: Sequence[BlockSpan], headings: Sequence[Heading]) -> list[TextBlock]:
    """Attach every block to the innermost heading that is open above it.

    Blocks arrive in reading order, so the innermost open heading is simply the
    last one the walk passed. A block printed before the first heading — a
    cover line, or a running header the repetition rule did not class as
    furniture — keeps an empty ``section_ref``. The returned blocks are
    renumbered from zero so ``ordinal`` is dense over the document.
    """
    ordered = sorted(headings, key=lambda heading: (heading.page, heading.top))
    out: list[TextBlock] = []
    index = 0
    current = ""
    for span in blocks:
        while index < len(ordered) and (ordered[index].page, ordered[index].top) <= (
            span.page,
            span.top,
        ):
            current = ordered[index].ref
            index += 1
        out.append(replace(span.block, section_ref=current, ordinal=len(out)))
    return out


def chapter_tag(heading: Heading) -> str:
    """Tag a chapter by the keywords, ``other`` when none matches."""
    title = heading.title.casefold()
    for tag, keywords in CHAPTER_TAGS:
        if any(keyword in title for keyword in keywords):
            return tag
    return "other"


def sections_table(headings: Sequence[Heading], page_count: int) -> list[SectionRow]:
    """Build the ``app.catalog_sections`` rows.

    A section runs until the next heading at its own level or above. When that
    heading opens on a later page the section ends on the page before it;
    when it opens on the same page the two share that page, so the section ends
    there. The last section of the document runs to the last page.
    """
    rows: list[SectionRow] = []
    for position, heading in enumerate(headings):
        page_end = page_count
        for later in headings[position + 1 :]:
            if later.level <= heading.level:
                page_end = later.page if later.page == heading.page else later.page - 1
                break
        rows.append(
            SectionRow(
                section_ref=heading.ref,
                title=heading.title,
                level=heading.level,
                parent_ref=parent_ref(heading.ref),
                page_start=heading.page,
                page_end=max(heading.page, page_end),
            )
        )
    return rows
