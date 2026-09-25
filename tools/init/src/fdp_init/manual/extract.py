# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The one caller that composes every extraction pass.

:func:`extract_manual` runs the passes in a fixed order — read every page,
detect the furniture, drop it, order the lines, detect the headings, then the
tables and the blocks — and returns the frozen
:class:`~fdp_init.manual.model.ManualDoc` the catalog builder, the chunker and
the ingest report all read.

Two passes over the pages, not one, because they answer different questions.
The *prose* pass excludes the table regions, so a paragraph never swallows a
table cell and a group row printed inside a table never becomes a section. The
*whole-page* pass excludes nothing and produces ``full_text``: the self-check
compares the fault ids the table parser recovered against the ids the page
*prints*, and a denominator built from the parsed tables would be the numerator
again.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from fdp_init.errors import ExitCode, InitError
from fdp_init.manual.model import (
    ExtractStats,
    Heading,
    Line,
    ManualDoc,
    Table,
    TableKind,
    TextBlock,
)
from fdp_init.manual.pdf import (
    BBox,
    body_font_size,
    detect_furniture,
    drop_furniture,
    extract_blocks,
    open_document,
    order_lines,
    page_lines,
)
from fdp_init.manual.profiles import (
    BEHAVIOURS,
    classify_header,
    condition_id_re,
    fault_id_re,
    normalize_id,
    signal_tag,
)
from fdp_init.manual.sections import assign_sections, detect_headings
from fdp_init.manual.tables import TableStats, extract_tables, find_page_tables
from fdp_init.util.hashing import sha256_file

__all__ = [
    "MIN_CHARACTERS",
    "STEP",
    "TABLE_RECALL_FLOOR",
    "column_map",
    "extract_manual",
    "row_fault_id",
    "variant_of",
]

log = logging.getLogger(__name__)

STEP = "ingest"
"""The pipeline step that owns extraction failures."""

MIN_CHARACTERS = 200
"""Below this many characters the document has no extractable text."""

TABLE_RECALL_FLOOR = 0.9
"""``table_recall_estimate`` below this logs a warning; it never fails."""

VARIANT_SUFFIXES: tuple[tuple[str, str], ...] = (
    ("-clean.pdf", "clean"),
    ("-realistic.pdf", "realistic"),
)
"""File-name suffix to ``app.manual_documents.variant``."""

DEFAULT_VARIANT = "byo"
"""Any other name is a manual the operator brought along."""

_TITLE_KEYS = ("Title", "dc:title")
"""Where a PDF writer puts the document title, most common first."""


def variant_of(path: Path) -> str:
    """Classify a manual by its file name.

    ``cau-7-clean.pdf`` is ``clean``, ``cau-7-realistic.pdf`` is ``realistic``
    and everything else is ``byo``, which is what ``app.manual_documents``
    stores.
    """
    name = path.name.lower()
    for suffix, variant in VARIANT_SUFFIXES:
        if name.endswith(suffix):
            return variant
    return DEFAULT_VARIANT


def column_map(table: Table) -> dict[str, int]:
    """The canonical column positions of ``table``'s header."""
    return classify_header(table.header)[1]


def row_fault_id(cells: Sequence[str], columns: Mapping[str, int]) -> str | None:
    """The fault id of one troubleshooting row, ``None`` when it prints none.

    The id column wins when the table has one — the manual of this repository
    prints it — and otherwise the first match of
    :func:`~fdp_init.manual.profiles.fault_id_re` in the cause cell is taken,
    which is the fallback for a manual that runs the id into the prose.
    """
    pattern = fault_id_re()
    index = columns.get("id")
    if index is not None and index < len(cells):
        match = pattern.search(cells[index])
        if match is not None:
            return normalize_id("fault", match.group(0))
    cause = columns.get("cause")
    if cause is not None and cause < len(cells):
        match = pattern.search(cells[cause])
        if match is not None:
            return normalize_id("fault", match.group(0))
    return None


def _title_of(metadata: Mapping[str, object]) -> str | None:
    """The document title from the PDF metadata, ``None`` when it has none."""
    for key in _TITLE_KEYS:
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _page_text(pages_lines: Iterable[Sequence[Line]]) -> str:
    """Join ordered lines into the page-ordered text of ``full_text``."""
    return "\n".join("\n".join(line.text for line in lines) for lines in pages_lines)


def _headings_by_level(headings: Sequence[Heading]) -> dict[int, int]:
    """How many headings the document prints at each level."""
    counts: dict[int, int] = {}
    for heading in headings:
        counts[heading.level] = counts.get(heading.level, 0) + 1
    return counts


def _declared_non_fault_ids(tables: Sequence[Table]) -> set[str]:
    """Identifiers the document declares as something other than a cause.

    Signal tags, derived behaviours and condition ids all match the snake_case
    grammar, so a raw scan of ``full_text`` counts them as fault ids and
    the self-check reads as a 50 % loss on a document that lost nothing.
    The document says what they are — the ``SIGNALS`` table names its tags, the
    group rows name their conditions — so they are subtracted before the ratio
    is taken.
    """
    declared = set(BEHAVIOURS)
    condition_pattern = condition_id_re()
    for table in tables:
        columns = classify_header(table.header)[1]
        if table.kind is TableKind.SIGNALS:
            for row in table.rows:
                tag = signal_tag(row.cells, columns["tag"], columns.get("label"))[0]
                if tag:
                    declared.add(tag)
        elif table.kind is TableKind.TROUBLESHOOTING:
            condition = columns.get("condition")
            for row in table.rows:
                in_row = condition is not None and condition < len(row.cells)
                printed = row.cells[condition] if in_row and condition is not None else ""
                for text in (row.group_title or "", printed):
                    match = condition_pattern.search(text)
                    if match is not None:
                        declared.add(normalize_id("condition", match.group(0)))
    return declared


def _table_fault_ids(tables: Sequence[Table]) -> tuple[set[str], int]:
    """Distinct fault ids of the troubleshooting rows, and the rows without one."""
    found: set[str] = set()
    missing = 0
    for table in tables:
        if table.kind is not TableKind.TROUBLESHOOTING:
            continue
        columns = classify_header(table.header)[1]
        for row in table.rows:
            fault_id = row_fault_id(row.cells, columns)
            if fault_id is None:
                missing += 1
            else:
                found.add(fault_id)
    return found, missing


@dataclass(frozen=True, slots=True)
class _Passes:
    """What one walk over the pages produced, before the document is frozen."""

    page_count: int
    title: str | None
    body_size: float
    headings: list[Heading]
    tables: list[Table]
    table_stats: TableStats
    furniture: list[str]
    prose_pages: list[list[Line]]
    full_text: str


def _build_stats(passes: _Passes) -> ExtractStats:
    """Fill the self-check counters from the finished passes.

    The denominator is the union of the ids the page prints with the ids the
    tables recovered, so a row whose id a line break hyphenated out of
    ``full_text`` cannot push the ratio above 1.
    """
    in_tables, missing = _table_fault_ids(passes.tables)
    in_text = set(fault_id_re().findall(passes.full_text)) - _declared_non_fault_ids(passes.tables)
    stats = passes.table_stats
    return ExtractStats(
        pages=passes.page_count,
        characters=len(passes.full_text),
        headings_by_level=_headings_by_level(passes.headings),
        furniture_lines=len(passes.furniture),
        tables_by_kind=dict(stats.tables_by_kind),
        tables_by_strategy=dict(stats.tables_by_strategy),
        merged_fragments=stats.merged_fragments,
        group_rows=stats.group_rows,
        rows_recovered=stats.rows_recovered,
        rows_dropped=stats.rows_dropped,
        rows_without_fault_id=missing,
        fault_ids_in_text=len(in_text | in_tables),
        fault_ids_in_tables=len(in_tables),
    )


def _read(path: Path) -> _Passes:
    """Run every page-level pass over ``path``.

    The prose pass excludes the table regions; the whole-page pass excludes
    nothing and is what ``full_text`` is built from. Both drop the same
    furniture, detected once on the prose pass so a table cell can never repeat
    its way into the furniture set.
    """
    with open_document(path) as pdf:
        pages = pdf.pages
        if not pages:
            raise _no_text(path, 0)
        width = float(pages[0].width)
        height = float(pages[0].height)
        boxes: list[list[BBox]] = [[raw.bbox for raw in find_page_tables(page)] for page in pages]
        body_size = body_font_size(pdf, exclude_bboxes=boxes)
        prose_raw = [
            page_lines(page, exclude_bboxes=page_boxes)
            for page, page_boxes in zip(pages, boxes, strict=True)
        ]
        whole_raw = [page_lines(page) for page in pages]
        furniture = detect_furniture(prose_raw, height)
        prose = drop_furniture(prose_raw, furniture, height)
        whole = drop_furniture(whole_raw, furniture, height)
        prose_pages = [order_lines(lines, width) for lines in prose.pages_lines]
        headings = detect_headings(prose_pages, body_size)
        tables, table_stats = extract_tables(pdf, headings, body_size)
        return _Passes(
            page_count=len(pages),
            title=_title_of(pdf.metadata),
            body_size=body_size,
            headings=headings,
            tables=tables,
            table_stats=table_stats,
            furniture=prose.dropped,
            prose_pages=prose_pages,
            full_text=_page_text(order_lines(lines, width) for lines in whole.pages_lines),
        )


def extract_manual(path: Path) -> ManualDoc:
    """Read one PDF into a :class:`ManualDoc`.

    Args:
        path: The manual to read. Its name decides
            :attr:`~fdp_init.manual.model.ManualDoc.variant`.

    Returns:
        Everything extraction knows about the document: the heading tree, the
        sectioned blocks, the merged tables, the dropped furniture, the
        page-ordered ``full_text`` and the self-check counters.

    Raises:
        InitError: exit code 6, when the file cannot be opened or the whole
            document holds fewer than :data:`MIN_CHARACTERS` characters — the
            "no extractable text" case, which is what a scanned manual
            looks like from here.
    """
    digest = sha256_file(path)
    size = path.stat().st_size
    try:
        passes = _read(path)
    except InitError:
        raise
    except Exception as error:
        # pdfplumber and pdfminer raise their own exception types for a
        # truncated, encrypted or malformed file; every one of them is the
        # exit-6 "manual extraction failed" as far as init is concerned.
        raise InitError(
            ExitCode.MANUAL, f"{path.name} could not be read as a PDF: {error}", STEP
        ) from error

    if len(passes.full_text) < MIN_CHARACTERS:
        raise _no_text(path, len(passes.full_text))

    blocks: list[TextBlock] = assign_sections(
        extract_blocks(
            [line for page in passes.prose_pages for line in page],
            passes.body_size,
            headings=passes.headings,
        ),
        passes.headings,
    )
    stats = _build_stats(passes)
    if stats.table_recall_estimate < TABLE_RECALL_FLOOR:
        log.warning(
            "the troubleshooting tables recovered %.0f%% of the fault ids the text prints",
            100 * stats.table_recall_estimate,
            extra={
                "step": STEP,
                "fault_ids_in_text": stats.fault_ids_in_text,
                "fault_ids_in_tables": stats.fault_ids_in_tables,
            },
        )
    return ManualDoc(
        path=path,
        sha256=digest,
        bytes=size,
        page_count=passes.page_count,
        title=passes.title,
        variant=variant_of(path),
        headings=passes.headings,
        blocks=blocks,
        tables=passes.tables,
        furniture=passes.furniture,
        full_text=passes.full_text,
        stats=stats,
    )


def _no_text(path: Path, characters: int) -> InitError:
    """The exit-6 error for a document with no extractable text."""
    return InitError(
        ExitCode.MANUAL,
        f"{path.name} holds no extractable text: {characters} characters "
        f"over the whole document, fewer than the {MIN_CHARACTERS} a text PDF has",
        STEP,
    )
