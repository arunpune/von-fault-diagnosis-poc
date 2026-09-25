# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Ruled-table extraction.

The manual prints its fault catalog as tables, and a page break cuts them: the
realistic layout runs one troubleshooting table across two pages, repeats the
header on the second, and lets a single cause row straddle the break. This
module puts those fragments back together and hands ``Table``/``TableRow`` of
``model.py`` to the catalog builder.

Nothing here branches on the manual variant. The clean layout gives every
condition its own table under an ``8.2.k`` heading, the realistic one opens the
same condition with a group row inside one spanning table, and both paths end in
the same ``TableRow.group_ref``/``group_title`` — which is what makes the
catalog identical from either PDF. A table whose header is printed over two
rows prints every record over two rows as well (the identification band of the
committed CAU-7 manuals); :func:`fold_banded_rows` makes each record one row
again before anything else reads it, and :func:`fold_labelled_rows` gives it
back a field printed across the table underneath it (``Signals: …``).

Every threshold is a module constant with the reason for its value beside it.
"""

from __future__ import annotations

import re
import statistics
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, NamedTuple

from ..util.textnorm import dehyphenate, norm_header_cell, norm_ws
from .model import Heading, Table, TableKind, TableRow
from .profiles import (
    MIN_HEADER_HITS,
    classify_header,
    fault_id_re,
    label_column,
    looks_like_header_line,
)

__all__ = [
    "FULL_PAGE_HEIGHT_FRACTION",
    "FULL_PAGE_WIDTH_FRACTION",
    "HEADER_BOLD_RATIO",
    "HEADER_SEARCH_ROWS",
    "LABELLED_CELL_RE",
    "LINES_SETTINGS",
    "SPAN_BOTTOM_FRACTION",
    "SPAN_TOP_FRACTION",
    "TEXT_SETTINGS",
    "RawTable",
    "TableStats",
    "assign_groups",
    "continue_split_rows",
    "detect_header",
    "extract_tables",
    "find_page_tables",
    "fold_banded_rows",
    "fold_labelled_rows",
    "is_group_row",
    "merge_spanning",
    "norm_cell",
    "parse_group_row",
    "section_ref_for",
    "stacked_header",
    "without_page_background",
]

LINES_SETTINGS: Mapping[str, Any] = {
    "vertical_strategy": "lines",
    "horizontal_strategy": "lines",
    "snap_tolerance": 3,
    "join_tolerance": 3,
    "intersection_tolerance": 5,
}
"""The ruled-border settings; the manual draws every cell border."""

TEXT_SETTINGS: Mapping[str, Any] = {
    "vertical_strategy": "text",
    "horizontal_strategy": "text",
}
"""Fallback for a manual that aligns its columns without drawing them."""

FULL_PAGE_WIDTH_FRACTION = 0.80
FULL_PAGE_HEIGHT_FRACTION = 0.80
"""How much of the page a CSS page background covers, in both directions.

A CSS ``background`` on ``body`` is painted as a filled rectangle covering the
content box, and its four edges look like ruled borders to pdfplumber. On a
page of prose that returns one page-sized "table" holding the text; on a page
with a full-width table it is worse, because the table's own rules touch the
rectangle's sides and pdfplumber joins the two into one page-sized grid that
swallows every heading and paragraph printed around the table (verified on both
committed CAU-7 manuals). So the rectangle is removed before the search
(:func:`without_page_background`), and a page-sized candidate with single-cell
rows that still turns up is dropped: a real table of that size has more than one
column.
"""

SPAN_BOTTOM_FRACTION = 0.80
SPAN_TOP_FRACTION = 0.25
"""How close to the page edges two fragments must sit to be one table."""

HEADER_SEARCH_ROWS = 2
"""How many leading rows may be the header row.

One is the normal case; two lets a table that prints a caption row above its
header still be recognised. Rows before the header are dropped.
"""

HEADER_BOLD_RATIO = 0.60
"""Share of bold characters that makes an unrecognised first row a header."""

HEADER_SIZE_MARGIN = 0.5
"""Points above the body size that also make an unrecognised first row a header."""

MIN_HEADERLESS_ROWS = 2
"""A table needs this many rows before its first row may be read as a header."""

BOLD_FONT_MARKERS = ("Bold", "Black", "Semibold", "Medium")
"""Substrings of ``fontname`` that mark a bold face."""

GROUP_ROW_RE = re.compile(r"^(\d+(?:\.\d+)+)\s+(.+)$")
"""A group row opens a condition: ``8.2.3`` followed by its title."""

LABELLED_CELL_RE = re.compile(r"^([^:\d]{1,40}):\s+(\S.*)$", re.DOTALL)
"""A cell that opens with a column's name and a colon: ``Signals: Oil temperature …``.

The label holds no digit and no colon and stays short, so a sentence that
merely contains a colon, or a numbered group row, never reads as one.
"""


class _HeaderInfo(NamedTuple):
    """Where a candidate's header row sits and what it says.

    ``band_width`` is the cell count of the upper header row when the header is
    printed over two rows (:func:`stacked_header`), and ``0`` otherwise; ``row``
    is always the lower one, the last row before the data.
    """

    row: int
    header: list[str]
    kind: TableKind
    column_map: dict[str, int]
    band_width: int = 0


class _Finished(NamedTuple):
    """One built table together with the counters its construction produced."""

    table: Table
    group_rows: int
    rows_dropped: int
    rows_continued: int


@dataclass(frozen=True, slots=True)
class RawTable:
    """One table as a page yielded it, before headers, merging or grouping.

    Deliberately free of any pdfplumber handle: the geometry and the boldness of
    the first row are read once in :func:`find_page_tables`, so every later step
    is a pure function of plain data and can be tested on hand-built fragments.
    """

    page: int
    bbox: tuple[float, float, float, float]
    cells: list[list[str]]
    strategy: str = "lines"
    header_bold: bool = False
    header_size: float = 0.0

    @property
    def top(self) -> float:
        """Distance from the top of the page to the first ruled border."""
        return self.bbox[1]

    @property
    def bottom(self) -> float:
        """Distance from the top of the page to the last ruled border."""
        return self.bbox[3]

    @property
    def columns(self) -> int:
        """The widest row's cell count."""
        return max((len(row) for row in self.cells), default=0)


@dataclass(frozen=True, slots=True)
class TableStats:
    """The table half of ``ExtractStats``.

    Every field but ``rows_continued`` carries the name it has in
    ``ExtractStats``, so the pipeline copies them across without a mapping.
    ``rows_continued`` is extra: the self-check does not count the rows a page
    break cut, and the number is worth having in the report because a layout
    change shows up in it first.
    """

    tables_by_kind: dict[str, int] = field(default_factory=dict)
    tables_by_strategy: dict[str, int] = field(default_factory=dict)
    merged_fragments: int = 0
    group_rows: int = 0
    rows_recovered: int = 0
    rows_dropped: int = 0
    rows_continued: int = 0


def norm_cell(value: str | None) -> str:
    """Normalise one extracted cell; ``None`` becomes the empty string.

    ``dehyphenate`` runs first because it needs the line breaks that ``norm_ws``
    then collapses, so ``"tempera-\\nture"`` survives as one word.
    """
    return norm_ws(dehyphenate(value or ""))


def _covers_page(width: float, height: float, page: Any) -> bool:
    """True when a box this size covers the content box (see the constants)."""
    wide = width >= FULL_PAGE_WIDTH_FRACTION * float(page.width)
    tall = height >= FULL_PAGE_HEIGHT_FRACTION * float(page.height)
    return wide and tall


def _is_page_background(bbox: tuple[float, float, float, float], page: Any, columns: int) -> bool:
    """True for a page-sized candidate whose rows are single cells (see the constants)."""
    return _covers_page(bbox[2] - bbox[0], bbox[3] - bbox[1], page) and columns <= 1


def _is_background_fill(obj: Mapping[str, Any], page: Any) -> bool:
    """True for a filled, unstroked rectangle the size of the content box."""
    return (
        obj.get("object_type") == "rect"
        and bool(obj.get("fill"))
        and not obj.get("stroke")
        and _covers_page(float(obj.get("width", 0.0)), float(obj.get("height", 0.0)), page)
    )


def without_page_background(page: Any) -> Any:
    """The page without the rectangle a CSS page background paints.

    Only that rectangle goes: cell backgrounds are a row high, and a stroked
    rectangle is a border the reader can see. A page without one is returned
    unchanged, so the common case costs a scan of ``page.rects`` and nothing more.
    """
    if not any(_is_background_fill(rect, page) for rect in page.rects):
        return page
    return page.filter(lambda obj: not _is_background_fill(obj, page))


def _first_row_font(page: Any, found: Any) -> tuple[bool, float]:
    """Measure the boldness and median size of a candidate's first row."""
    rows = getattr(found, "rows", ())
    if not rows or rows[0].bbox is None:
        return False, 0.0
    chars = page.crop(rows[0].bbox, strict=False).chars
    if not chars:
        return False, 0.0
    bold = sum(
        1
        for char in chars
        if any(marker in str(char.get("fontname", "")) for marker in BOLD_FONT_MARKERS)
    )
    sizes = [float(char.get("size", 0.0)) for char in chars]
    return bold / len(chars) >= HEADER_BOLD_RATIO, float(statistics.median(sizes))


def _found_tables(page: Any, settings: Mapping[str, Any], strategy: str) -> list[RawTable]:
    """Run one pdfplumber strategy over a page and normalise what it returns."""
    raws: list[RawTable] = []
    for found in page.find_tables(dict(settings)):
        cells = [[norm_cell(cell) for cell in row] for row in found.extract()]
        columns = max((len(row) for row in cells), default=0)
        bbox = tuple(float(value) for value in found.bbox)
        if len(bbox) != 4:  # pragma: no cover - pdfplumber always gives four
            continue
        box = (bbox[0], bbox[1], bbox[2], bbox[3])
        if _is_page_background(box, page, columns):
            continue
        bold, size = _first_row_font(page, found)
        raws.append(
            RawTable(
                page=int(page.page_number),
                bbox=box,
                cells=cells,
                strategy=strategy,
                header_bold=bold,
                header_size=size,
            )
        )
    return raws


def _looks_like_a_header_page(page: Any) -> bool:
    """True when a text line on the page reads like a profile header."""
    text = page.extract_text() or ""
    return any(looks_like_header_line(line) for line in text.splitlines())


def find_page_tables(page: Any) -> list[RawTable]:
    """Find the tables of one pdfplumber page, in reading order.

    The page background is removed first (:func:`without_page_background`). The
    ruled strategy runs next because the manual draws its borders. Only
    when a page yields no ruled table *and* prints a line that reads like a
    profile header is the text strategy tried; the result is flagged
    ``strategy="text"`` so the report can show how much of the document needed
    it.
    """
    page = without_page_background(page)
    raws = _found_tables(page, LINES_SETTINGS, "lines")
    if not raws and _looks_like_a_header_page(page):
        raws = _found_tables(page, TEXT_SETTINGS, "text")
    return sorted(raws, key=lambda raw: (raw.top, raw.bbox[0]))


def _header_at(raw: RawTable) -> _HeaderInfo | None:
    """Find the first row that a profile recognises, within the search window.

    When the row above it names more columns of the same profile, the header is
    printed over two rows and so is every record (:func:`stacked_header`).
    """
    for index, row in enumerate(raw.cells[:HEADER_SEARCH_ROWS]):
        kind, column_map = classify_header(row)
        if kind is TableKind.OTHER:
            continue
        stacked = stacked_header(raw.cells[index - 1], row) if index else None
        if stacked is not None:
            header, stacked_map = stacked
            band_width = len(header) - len(row)
            return _HeaderInfo(index, header, kind, stacked_map, band_width)
        return _HeaderInfo(index, list(row), kind, column_map)
    return None


def stacked_header(
    band: Sequence[str], detail: Sequence[str]
) -> tuple[list[str], dict[str, int]] | None:
    """Read a header printed over two rows, ``None`` when ``band`` is not its first half.

    The committed CAU-7 manuals print a cause as two rows: an identification
    band ``Condition | Fault id | Subsystem`` above the prose row ``Possible
    cause | What to check | Remedy | See also``, and the ``<thead>`` names both.
    The band is the upper half of the header when, read together with the lower
    half, it adds the ``id`` column and at least
    :data:`~fdp_init.manual.profiles.MIN_HEADER_HITS` columns in all to the
    profile the lower half matched, and takes none of its columns away. The
    header is then the two rows side by side, which is the shape
    :func:`fold_banded_rows` gives every record.
    """
    detail_kind, detail_map = classify_header(detail)
    combined = [*band, *detail]
    kind, column_map = classify_header(combined)
    width = len(band)
    added = {name for name, position in column_map.items() if position < width}
    kept = all(column_map.get(name) == width + position for name, position in detail_map.items())
    if kind is not detail_kind or "id" not in added or len(added) < MIN_HEADER_HITS or not kept:
        return None
    return combined, column_map


def fold_banded_rows(rows: Sequence[TableRow], band_width: int, id_column: int) -> list[TableRow]:
    """Join every band row to the detail row printed under it.

    A band row is the one whose id cell holds a fault id and nothing else; its
    first ``band_width`` cells are followed by the next row's cells, so the
    record reads like the two header rows side by side. A group row passes
    through untouched. A detail row with no band above it — the tail of a row a
    page break cut — keeps empty band cells, which is what makes
    :func:`continue_split_rows` attach it to the record it belongs to.
    """
    pattern = fault_id_re()
    folded: list[TableRow] = []
    awaiting_detail = False
    for row in rows:
        if is_group_row(row.cells):
            folded.append(row)
            awaiting_detail = False
        elif pattern.fullmatch(_cell(row.cells, id_column)):
            band = (list(row.cells) + [""] * band_width)[:band_width]
            folded.append(_with_cells(row, band))
            awaiting_detail = True
        elif awaiting_detail:
            folded[-1] = _with_cells(folded[-1], [*folded[-1].cells, *row.cells])
            awaiting_detail = False
        else:
            folded.append(_with_cells(row, [""] * band_width + list(row.cells)))
    return folded


def fold_labelled_rows(
    rows: Sequence[TableRow], header: Sequence[str], kind: TableKind
) -> tuple[list[TableRow], list[str]]:
    """Give a row that names its own column to the record above it.

    A table may print one field of a record underneath it, in a single cell
    across the table that opens with the field's name: the committed CAU-7
    manuals print ``Signals: …`` under every full entry of chapter 8. When that
    name is a column the table's profile knows and its header does not print,
    the column is added at the end of the header and the text after the label
    becomes that cell of the record above. Every other row — a group row, the
    tail of a row a page break cut — passes through untouched for
    :func:`continue_split_rows`.

    Returns the rows and the header with the added columns, if any, at its end.
    """
    printed = classify_header(header)[1]
    added: dict[str, int] = {}
    names = list(header)
    folded: list[TableRow] = []
    for row in rows:
        labelled = _labelled_cell(row.cells, kind)
        if (
            labelled is None
            or labelled[1] in printed
            or not folded
            or is_group_row(folded[-1].cells)
        ):
            folded.append(row)
            continue
        label, column, text = labelled
        position = added.setdefault(column, len(names))
        if position == len(names):
            names.append(label)
        folded[-1] = _with_cell(folded[-1], position, text)
    return folded, names


def _labelled_cell(cells: Sequence[str], kind: TableKind) -> tuple[str, str, str] | None:
    """``(label, column, text)`` of a row whose one cell reads ``Label: text``."""
    filled = [cell for cell in cells if cell]
    if len(filled) != 1:
        return None
    match = LABELLED_CELL_RE.match(filled[0])
    if match is None:
        return None
    label, text = norm_ws(match.group(1)), norm_ws(match.group(2))
    column = label_column(kind, label)
    return None if column is None else (label, column, text)


def _with_cells(row: TableRow, cells: list[str]) -> TableRow:
    """``row`` with its cells replaced; the page and the group labels stay."""
    return TableRow(
        cells=cells, page=row.page, group_ref=row.group_ref, group_title=row.group_title
    )


def _with_cell(row: TableRow, position: int, text: str) -> TableRow:
    """``row`` with the cell at ``position`` set to ``text``, padded to reach it."""
    cells = list(row.cells) + [""] * max(0, position + 1 - len(row.cells))
    cells[position] = text
    return _with_cells(row, cells)


def _bold_header(raw: RawTable, body_size: float) -> _HeaderInfo | None:
    """Read the first row as a header when it is set apart but unrecognised."""
    if len(raw.cells) < MIN_HEADERLESS_ROWS:
        return None
    if raw.header_bold or raw.header_size >= body_size + HEADER_SIZE_MARGIN:
        return _HeaderInfo(0, list(raw.cells[0]), TableKind.OTHER, {})
    return None


def _header_info(raw: RawTable, body_size: float) -> _HeaderInfo | None:
    """The header row of a candidate, looked up once per fragment."""
    return _header_at(raw) or _bold_header(raw, body_size)


def detect_header(
    raw: RawTable, body_size: float = 0.0
) -> tuple[list[str] | None, TableKind, dict[str, int]]:
    """Classify a candidate's header row.

    The first row a profile recognises wins and gives the table its kind and its
    column map. Failing that, a first row set apart by a bold or larger face is
    still the header, but the table is ``OTHER`` because nothing says what its
    columns mean. A table with neither is header-less.
    """
    found = _header_info(raw, body_size)
    if found is None:
        return None, TableKind.OTHER, {}
    return found.header, found.kind, found.column_map


def parse_group_row(cells: Sequence[str]) -> tuple[str, str] | None:
    """Read ``("8.2.3", "Oil temperature high oil_temperature_high")`` off a group row.

    A group row carries the whole condition line in its first non-empty cell and
    nothing anywhere else; the printed condition id stays in the title, exactly
    as the ``8.2.k`` heading of the clean layout keeps it, so both layouts give
    the same ``group_title``.
    """
    first = next((index for index, cell in enumerate(cells) if cell), None)
    if first is None:
        return None
    if any(cell for cell in cells[first + 1 :]):
        return None
    match = GROUP_ROW_RE.match(cells[first])
    if match is None:
        return None
    return match.group(1), norm_ws(match.group(2))


def is_group_row(cells: Sequence[str]) -> bool:
    """True when the row opens a condition instead of naming a cause."""
    return parse_group_row(cells) is not None


def continue_split_rows(
    rows: Sequence[TableRow], column_map: Mapping[str, int]
) -> tuple[list[TableRow], int]:
    """Rejoin a row a page break cut in two.

    The tail fragment has no id of its own — its key cell (the id column, else
    the cause column) is empty and no fault id appears anywhere in it — so its
    non-empty cells are appended to the row above, which keeps the head's page.
    A tail that follows a group row is dropped instead of corrupting it.

    Returns the rows and how many fragments were rejoined.
    """
    key = column_map.get("id", column_map.get("cause"))
    if key is None:
        return list(rows), 0
    pattern = fault_id_re()
    joined: list[TableRow] = []
    continued = 0
    for row in rows:
        if not _is_tail(row, key, pattern):
            joined.append(row)
        elif joined and not is_group_row(joined[-1].cells):
            joined[-1] = _append_cells(joined[-1], row.cells)
            continued += 1
        # A tail with no head to attach to is dropped: the row it belonged to
        # is not in this table, and guessing another one would invent an entry.
    return joined, continued


def _is_tail(row: TableRow, key: int, pattern: re.Pattern[str]) -> bool:
    """True when the row can only be the second half of the row above it."""
    if _cell(row.cells, key) != "":
        return False
    return not any(pattern.search(cell) for cell in row.cells if cell)


def _append_cells(head: TableRow, tail: Sequence[str]) -> TableRow:
    """Space-join every non-empty tail cell onto the head row's own."""
    cells = list(head.cells)
    for index, cell in enumerate(tail):
        if not cell:
            continue
        while len(cells) <= index:
            cells.append("")
        cells[index] = f"{cells[index]} {cell}".strip()
    return TableRow(
        cells=cells,
        page=head.page,
        group_ref=head.group_ref,
        group_title=head.group_title,
    )


def assign_groups(
    rows: Sequence[TableRow], headings: Sequence[Heading], table_section: str
) -> tuple[list[TableRow], int]:
    """Set ``group_ref``/``group_title`` on the data rows and drop the group rows.

    A table that prints group rows takes them; a table that prints none belongs
    to one condition already, so it takes the innermost heading above it — the
    section the table sits in. Both layouts therefore label the rows the same
    way, which is why the catalog builder never asks which variant it is reading.

    Returns the data rows and how many group rows were consumed.
    """
    titles = {heading.ref: heading.title for heading in headings}
    fallback_ref = table_section or None
    fallback_title = titles.get(table_section) if table_section else None
    group_ref, group_title = fallback_ref, fallback_title
    data: list[TableRow] = []
    group_rows = 0
    for row in rows:
        group = parse_group_row(row.cells)
        if group is not None:
            group_ref, group_title = group
            group_rows += 1
            continue
        data.append(
            TableRow(
                cells=row.cells,
                page=row.page,
                group_ref=group_ref,
                group_title=group_title,
            )
        )
    return data, group_rows


def section_ref_for(page: int, top: float, headings: Sequence[Heading]) -> str:
    """The innermost heading open at ``(page, top)``; ``""`` when there is none.

    Headings arrive in reading order, so the last one that starts before the
    position is the innermost open one.
    """
    current = ""
    for heading in headings:
        if (heading.page, heading.top) < (page, top):
            current = heading.ref
        else:
            break
    return current


@dataclass(slots=True)
class _Accumulator:
    """One table under construction, possibly still collecting page fragments.

    ``columns`` is the ruled column count of the first fragment, which every
    later fragment must repeat; it is not the header's length, because a header
    printed over two rows is stored as the two rows side by side.
    """

    header: list[str] | None
    kind: TableKind
    column_map: dict[str, int]
    rows: list[TableRow]
    bbox: tuple[float, float, float, float]
    page_from: int
    page_to: int
    last_bottom: float
    strategy: str
    columns: int
    band_width: int = 0
    merged_from: int = 1
    continued_without_header: bool = False


def _cell(cells: Sequence[str], index: int | None) -> str:
    if index is None or index >= len(cells):
        return ""
    return cells[index]


def _normalised(header: Sequence[str] | None) -> tuple[str, ...]:
    return tuple(norm_header_cell(cell) for cell in header or ())


def _heading_between(accumulator: _Accumulator, raw: RawTable, headings: Sequence[Heading]) -> bool:
    """True when a heading sits below the accumulator's last fragment or above ``raw``.

    Either one opens a new section, so the two fragments are two tables even
    when they repeat one header: the clean layout prints one troubleshooting
    table per condition, every one of them under the same header, and lets a
    long one break over a page.
    """
    return any(
        (heading.page == accumulator.page_to and heading.top > accumulator.last_bottom)
        or (heading.page == raw.page and heading.top < raw.top)
        for heading in headings
    )


def _continues(
    accumulator: _Accumulator,
    raw: RawTable,
    page_height: float,
    headings: Sequence[Heading],
    header: Sequence[str] | None,
) -> bool | None:
    """Decide whether ``raw`` is the next fragment of ``accumulator``.

    Returns ``None`` when it is a new table, ``False`` when it continues one with
    its header repeated, and ``True`` when it continues one that reprinted no
    header at all. A heading between the two fragments always means a new table.
    """
    adjacent = (
        accumulator.page_to == raw.page - 1
        and accumulator.last_bottom >= SPAN_BOTTOM_FRACTION * page_height
        and raw.top <= SPAN_TOP_FRACTION * page_height
        and accumulator.columns == raw.columns
    )
    if not adjacent or _heading_between(accumulator, raw, headings):
        return None
    if header is not None:
        return False if _normalised(header) == _normalised(accumulator.header) else None
    return True


def _data_rows(raw: RawTable, found: _HeaderInfo | None) -> list[TableRow]:
    """The candidate's rows below its header, empty ones left out."""
    start = 0 if found is None else found.row + 1
    return [TableRow(cells=list(cells), page=raw.page) for cells in raw.cells[start:] if any(cells)]


def _open(raw: RawTable, found: _HeaderInfo | None) -> _Accumulator:
    return _Accumulator(
        header=None if found is None else found.header,
        kind=TableKind.OTHER if found is None else found.kind,
        column_map={} if found is None else dict(found.column_map),
        rows=_data_rows(raw, found),
        bbox=raw.bbox,
        page_from=raw.page,
        page_to=raw.page,
        last_bottom=raw.bottom,
        strategy=raw.strategy,
        columns=raw.columns,
        band_width=0 if found is None else found.band_width,
    )


def _extend(accumulator: _Accumulator, raw: RawTable, found: _HeaderInfo | None) -> None:
    accumulator.rows.extend(_data_rows(raw, found))
    accumulator.page_to = raw.page
    accumulator.last_bottom = raw.bottom
    accumulator.merged_from += 1


def _accumulate(
    tables_by_page: Mapping[int, Sequence[RawTable]],
    page_height: float,
    headings: Sequence[Heading],
    body_size: float,
) -> list[_Accumulator]:
    """Walk the pages in order and fold spanning fragments into one table each."""
    accumulators: list[_Accumulator] = []
    for page in sorted(tables_by_page):
        for position, raw in enumerate(tables_by_page[page]):
            found = _header_info(raw, body_size)
            header = None if found is None else found.header
            headless = (
                _continues(accumulators[-1], raw, page_height, headings, header)
                if position == 0 and accumulators
                else None
            )
            if headless is None:
                accumulators.append(_open(raw, found))
                continue
            _extend(accumulators[-1], raw, found)
            accumulators[-1].continued_without_header |= headless
    return accumulators


def _finish(accumulator: _Accumulator, headings: Sequence[Heading]) -> _Finished:
    """Turn one accumulator into a ``Table``; also returns its row counters."""
    section_ref = section_ref_for(accumulator.page_from, accumulator.bbox[1], headings)
    rows = accumulator.rows
    if accumulator.band_width:
        rows = fold_banded_rows(rows, accumulator.band_width, accumulator.column_map["id"])
    rows, header = fold_labelled_rows(rows, accumulator.header or (), accumulator.kind)
    rows, continued = continue_split_rows(rows, accumulator.column_map)
    rows, group_rows = assign_groups(rows, headings, section_ref)
    cause = accumulator.column_map.get("cause")
    kept = [row for row in rows if cause is None or _cell(row.cells, cause)]
    table = Table(
        section_ref=section_ref,
        page_from=accumulator.page_from,
        page_to=accumulator.page_to,
        kind=accumulator.kind,
        header=header,
        rows=kept,
        bbox=accumulator.bbox,
        strategy=accumulator.strategy,
        merged_from=accumulator.merged_from,
        continued_without_header=accumulator.continued_without_header,
    )
    return _Finished(table, group_rows, len(rows) - len(kept), continued)


def merge_spanning(
    tables_by_page: Mapping[int, Sequence[RawTable]],
    page_height: float,
    headings: Sequence[Heading],
    body_size: float = 0.0,
) -> list[Table]:
    """Build the document's tables, merging the fragments a page break made.

    ``T``, the last table on page ``p``, and ``U``, the first on page ``p + 1``,
    are one table when ``T`` runs into the bottom margin, ``U`` starts in the top
    margin, their column counts agree, no heading sits between them, and either
    ``U`` repeats ``T``'s header or ``U`` has no header at all — the second case
    sets ``continued_without_header``. Row continuation and group assignment then
    run over the merged rows, so a cause split by the break comes out whole.
    """
    accumulators = _accumulate(tables_by_page, page_height, headings, body_size)
    return [_finish(accumulator, headings).table for accumulator in accumulators]


def extract_tables(
    pdf: Any, headings: Sequence[Heading], body_size: float = 0.0
) -> tuple[list[Table], TableStats]:
    """Extract every table of a document, with the self-check counters.

    ``headings`` comes from ``sections.py`` and decides both ``section_ref`` and,
    for a table that prints no group rows, the condition its rows belong to.
    """
    tables_by_page = {page.page_number: find_page_tables(page) for page in pdf.pages}
    page_height = float(pdf.pages[0].height) if pdf.pages else 0.0
    accumulators = _accumulate(tables_by_page, page_height, headings, body_size)
    tables: list[Table] = []
    by_kind: dict[str, int] = {}
    by_strategy: dict[str, int] = {}
    merged = group_rows = dropped = continued = recovered = 0
    for accumulator in accumulators:
        finished = _finish(accumulator, headings)
        table = finished.table
        tables.append(table)
        by_kind[table.kind.value] = by_kind.get(table.kind.value, 0) + 1
        by_strategy[table.strategy] = by_strategy.get(table.strategy, 0) + 1
        merged += table.merged_from - 1
        group_rows += finished.group_rows
        dropped += finished.rows_dropped
        continued += finished.rows_continued
        recovered += len(table.rows)
    stats = TableStats(
        tables_by_kind=by_kind,
        tables_by_strategy=by_strategy,
        merged_fragments=merged,
        group_rows=group_rows,
        rows_recovered=recovered,
        rows_dropped=dropped,
        rows_continued=continued,
    )
    return tables, stats
