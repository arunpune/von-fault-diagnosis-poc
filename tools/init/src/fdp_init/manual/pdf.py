# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Layout pass of manual extraction.

The pass turns a PDF page into :class:`~fdp_init.manual.model.Line` objects and
then into :class:`~fdp_init.manual.model.TextBlock` paragraphs, in the order a
reader would follow them:

1. :func:`page_lines` reads the lines of one page, drops the ones a table
   covers and splits a line the two-column layout glued together;
2. :func:`detect_furniture` and :func:`drop_furniture` remove the running
   header, the footer and the page number;
3. :func:`order_lines` reflows the columns and records the band in
   ``Line.column``;
4. :func:`extract_blocks` merges lines into paragraphs, lists and footnotes.

Beyond :func:`open_document`, only four pdfplumber calls are used —
``extract_text_lines``, ``chars``, ``find_tables`` (in
:mod:`fdp_init.manual.tables`, never here) and ``crop`` — so the layout stays
reproducible across pdfplumber patch releases. Nothing here keeps global
state: the same PDF bytes give the same lines and blocks.
"""

from __future__ import annotations

import itertools
import re
import statistics
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import pdfplumber

from fdp_init.manual.model import (
    COLUMN_FULL,
    COLUMN_LEFT,
    COLUMN_RIGHT,
    Heading,
    Line,
    TextBlock,
)
from fdp_init.util.textnorm import dehyphenate, norm_ws

__all__ = [
    "BBox",
    "BlockSpan",
    "body_font_size",
    "detect_furniture",
    "drop_furniture",
    "extract_blocks",
    "is_page_number",
    "normalise_furniture",
    "open_document",
    "order_lines",
    "page_lines",
]

BBox = tuple[float, float, float, float]
"""A pdfplumber bounding box, ``(x0, top, x1, bottom)``."""

PdfDocument = Any
"""pdfplumber's ``PDF``; the distribution ships no type information."""

PdfPage = Any
"""pdfplumber's ``Page``; the distribution ships no type information."""

_BOLD_TOKENS = ("Bold", "Black", "Semibold", "Medium")
_BOLD_SHARE = 0.6
"""A line is bold when this share of its chars carries a bold font name."""

MARGIN_BAND = 0.09
"""Page furniture lives in the top or bottom 9 % of the page."""

FURNITURE_PAGE_SHARE = 0.40
FURNITURE_MIN_PAGES = 3
"""A margin line repeats on ≥ 40 % of the pages and on ≥ 3 pages to be furniture."""

GUTTER_LO = 0.47
GUTTER_HI = 0.53
"""The two-column gutter, as a fraction of the page width."""

TWO_COLUMN_SHARE = 0.60
"""Share of body lines that must sit in a band for the page to be two-column."""

_MIN_GUTTER_GAP = 0.015
"""A char gap must be this wide (of the page width) to count as the gutter."""

PARAGRAPH_GAP_RATIO = 0.6
"""A vertical gap wider than this many line heights ends a paragraph."""

FOOTNOTE_SIZE_DROP = 1.5
"""A footnote line is at least this much smaller than the body size."""

_DIGIT_RE = re.compile(r"\d")
_PAGE_NUMBER_RE = re.compile(r"^(page\s+)?#+(\s*(/|of)\s*#+)?$", re.IGNORECASE)
# The bullet and footnote glyphs are the typographic ones a manual prints, so
# the look-alike characters ruff warns about are exactly what has to match.
_BULLET_RE = re.compile(r"^(?:[•·▪◦]|[-–—]|\(?\d{1,2}[.)])\s+")  # noqa: RUF001
_FOOTNOTE_MARKER_RE = re.compile(r"^(?:(\d{1,2})[.)]?|[*†‡])\s+")


@dataclass(frozen=True, slots=True)
class BlockSpan:
    """A :class:`TextBlock` with the geometry the section pass needs.

    ``TextBlock`` carries no coordinates, but
    :func:`fdp_init.manual.sections.assign_sections` has to interleave blocks
    with headings to find the innermost open one. The span keeps the page and
    the ``top`` of the block's first line beside the block and is dropped again
    as soon as ``section_ref`` is filled in.
    """

    block: TextBlock
    page: int
    top: float


def open_document(path: Path) -> PdfDocument:
    """Open ``path`` for extraction.

    A thin wrapper so every caller opens a PDF the same way and so the one
    import of :mod:`pdfplumber` in the manual package lives here. The result is
    a context manager; the caller closes it.
    """
    return pdfplumber.open(path)


def _is_bold(chars: Sequence[dict[str, Any]]) -> bool:
    """True when ≥ 60 % of ``chars`` carry a bold-ish font name."""
    if not chars:
        return False
    bold = sum(
        1 for char in chars if any(token in str(char.get("fontname", "")) for token in _BOLD_TOKENS)
    )
    return bold >= _BOLD_SHARE * len(chars)


def _char_size(chars: Sequence[dict[str, Any]]) -> float:
    """The median char size of a line, its size for every later rule."""
    return float(statistics.median(float(char["size"]) for char in chars))


def _inside(bbox: BBox, x: float, y: float) -> bool:
    return bbox[0] <= x <= bbox[2] and bbox[1] <= y <= bbox[3]


def _gutter_gap(chars: Sequence[dict[str, Any]], page_width: float) -> float | None:
    """The x of the gutter a line straddles, or ``None`` when it straddles none.

    A two-column line that pdfplumber returned as one line (both columns share
    a baseline) has one wide char gap whose middle falls inside the gutter
    band. Word gaps are an order of magnitude narrower, so the test is safe on
    a full-width line.
    """
    ordered = sorted(chars, key=lambda char: float(char["x0"]))
    widest = 0.0
    middle: float | None = None
    for left, right in itertools.pairwise(ordered):
        gap = float(right["x0"]) - float(left["x1"])
        if gap > widest:
            widest = gap
            middle = (float(left["x1"]) + float(right["x0"])) / 2
    if middle is None or widest < _MIN_GUTTER_GAP * page_width:
        return None
    if not GUTTER_LO * page_width <= middle <= GUTTER_HI * page_width:
        return None
    return middle


def _raw_line(raw: dict[str, Any], page_number: int) -> Line | None:
    """Build a :class:`Line` from one ``extract_text_lines`` record."""
    chars = list(raw.get("chars") or ())
    text = norm_ws(str(raw["text"]))
    if not text or not chars:
        return None
    return Line(
        page=page_number,
        top=float(raw["top"]),
        x0=float(raw["x0"]),
        x1=float(raw["x1"]),
        text=text,
        size=_char_size(chars),
        bold=_is_bold(chars),
    )


def _extract_raw_lines(page: PdfPage) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = page.extract_text_lines(
        layout=False, strip=True, return_chars=True
    )
    return lines


def _in_margin(raw: dict[str, Any], page_height: float) -> bool:
    centre = (float(raw["top"]) + float(raw["bottom"])) / 2
    return centre <= MARGIN_BAND * page_height or centre >= (1 - MARGIN_BAND) * page_height


def _column_of(x0: float, x1: float, page_width: float) -> int:
    """Classify one line by its bbox against the gutter band.

    A line may nose into the gutter — a hung bullet starts a hair left of
    ``0.53·W`` — so a band line has to *reach past* the middle of the page on
    its own side and stay on this side of the far gutter edge.
    """
    low = GUTTER_LO * page_width
    high = GUTTER_HI * page_width
    if x0 < low and x1 <= high:
        return COLUMN_LEFT
    if x0 >= low and x1 > high:
        return COLUMN_RIGHT
    return COLUMN_FULL


def _faces(span: tuple[float, float], others: Iterable[tuple[float, float]]) -> bool:
    """True when ``span`` vertically overlaps at least one of ``others``."""
    top, bottom = span
    return any(other_top < bottom and top < other_bottom for other_top, other_bottom in others)


def _refine_columns(
    boxes: Sequence[tuple[float, float, float, float]], page_width: float
) -> list[int]:
    """Classify lines, then demote the ones no opposite band line faces.

    A short line on the left margin — ``8.2 Fault tables``, or any heading the
    stylesheet lets span both columns — has the bbox of a left-band line. The
    two bands only exist side by side, so a candidate that no line of the
    opposite band sits beside is a full-width line, whether it stands above the
    bands, below them or between two of them. ``boxes`` are
    ``(x0, top, x1, bottom)``.
    """
    raw = [_column_of(x0, x1, page_width) for x0, _, x1, _ in boxes]
    spans = {
        band: [
            (top, bottom)
            for (_, top, _, bottom), col in zip(boxes, raw, strict=True)
            if col == band
        ]
        for band in (COLUMN_LEFT, COLUMN_RIGHT)
    }
    opposite = {COLUMN_LEFT: spans[COLUMN_RIGHT], COLUMN_RIGHT: spans[COLUMN_LEFT]}
    refined: list[int] = []
    for (_, top, _, bottom), col in zip(boxes, raw, strict=True):
        keep = col != COLUMN_FULL and _faces((top, bottom), opposite[col])
        refined.append(col if keep else COLUMN_FULL)
    return refined


def _is_two_column(columns: Sequence[int], straddling: int) -> bool:
    """Apply the 60 % rule, counting a straddling line as both bands."""
    total = len(columns) + straddling
    if total == 0:
        return False
    banded = sum(1 for col in columns if col != COLUMN_FULL) + 2 * straddling
    return banded >= TWO_COLUMN_SHARE * total


def _split_at_gutter(page: PdfPage, raw: dict[str, Any], split_x: float) -> list[Line]:
    """Re-read one glued two-column line as its left and its right half.

    ``crop`` is used rather than re-joining the chars by hand so both halves
    keep pdfplumber's own word spacing; the band is the line's own height, and
    a line the crop pulls in from a neighbouring baseline is filtered out.
    """
    top = float(raw["top"])
    bottom = float(raw["bottom"])
    band_top = max(0.0, top - 0.5)
    band_bottom = min(float(page.height), bottom + 0.5)
    halves: list[Line] = []
    for x0, x1 in ((0.0, split_x), (split_x, float(page.width))):
        cropped = page.crop((x0, band_top, x1, band_bottom))
        for part in _extract_raw_lines(cropped):
            centre = (float(part["top"]) + float(part["bottom"])) / 2
            if not top <= centre <= bottom:
                continue
            line = _raw_line(part, int(page.page_number))
            if line is not None:
                halves.append(line)
    if len(halves) < 2:
        fallback = _raw_line(raw, int(page.page_number))
        return [fallback] if fallback is not None else []
    return halves


def page_lines(page: PdfPage, *, exclude_bboxes: Sequence[BBox] = ()) -> list[Line]:
    """Read the text lines of one page.

    Lines whose middle falls inside one of ``exclude_bboxes`` — the table
    regions :mod:`fdp_init.manual.tables` found — are dropped, so table text
    never reaches a paragraph. On a two-column page, a line pdfplumber returned
    with both columns on one baseline is split at the gutter. Page furniture is
    left in place: :func:`detect_furniture` needs to see it on every page
    first, and the margin bands are exempt from the split so a footer stays one
    string.

    The result is in pdfplumber's own order; :func:`order_lines` reflows it.
    """
    page_number = int(page.page_number)
    page_width = float(page.width)
    page_height = float(page.height)
    kept: list[dict[str, Any]] = []
    for raw in _extract_raw_lines(page):
        centre_x = (float(raw["x0"]) + float(raw["x1"])) / 2
        centre_y = (float(raw["top"]) + float(raw["bottom"])) / 2
        if any(_inside(bbox, centre_x, centre_y) for bbox in exclude_bboxes):
            continue
        kept.append(raw)

    splits: dict[int, float] = {}
    for index, raw in enumerate(kept):
        if _in_margin(raw, page_height):
            continue
        split_x = _gutter_gap(list(raw.get("chars") or ()), page_width)
        if split_x is not None:
            splits[index] = split_x

    boxes = [
        (float(raw["x0"]), float(raw["top"]), float(raw["x1"]), float(raw["bottom"]))
        for index, raw in enumerate(kept)
        if index not in splits
    ]
    two_column = _is_two_column(_refine_columns(boxes, page_width), len(splits))

    lines: list[Line] = []
    for index, raw in enumerate(kept):
        if two_column and index in splits:
            lines.extend(_split_at_gutter(page, raw, splits[index]))
            continue
        line = _raw_line(raw, page_number)
        if line is not None:
            lines.append(line)
    return lines


def body_font_size(pdf: PdfDocument, *, exclude_bboxes: Sequence[Sequence[BBox]] = ()) -> float:
    """The body font size of the document: the mode of its char sizes.

    ``exclude_bboxes`` holds one bbox sequence per page — the table regions.
    Table cells are set smaller than prose and outnumber it in a manual that is
    mostly tables, so counting them would report a table size as the body size
    and break the heading and footnote rules that hang off it. The "mode of
    char sizes" is therefore taken over the chars outside the tables. Sizes are
    binned to two decimals and a tie goes to the larger size, so the result is
    deterministic.
    """
    sizes: Counter[float] = Counter()
    for index, page in enumerate(pdf.pages):
        boxes = exclude_bboxes[index] if index < len(exclude_bboxes) else ()
        for char in page.chars:
            centre_x = (float(char["x0"]) + float(char["x1"])) / 2
            centre_y = (float(char["top"]) + float(char["bottom"])) / 2
            if any(_inside(bbox, centre_x, centre_y) for bbox in boxes):
                continue
            sizes[round(float(char["size"]), 2)] += 1
    if not sizes:
        return 0.0
    return max(sizes.items(), key=lambda item: (item[1], item[0]))[0]


def normalise_furniture(text: str) -> str:
    """Normalise a margin line for the repetition test: digits become ``#``."""
    return _DIGIT_RE.sub("#", norm_ws(text))


def is_page_number(normalised: str) -> bool:
    """True for ``3``, ``page 3``, ``3 / 12``, ``page 3 of 12``."""
    return _PAGE_NUMBER_RE.match(normalised) is not None


def _line_height(line: Line) -> float:
    """``Line`` keeps no bottom, so its font size stands in for its height."""
    return line.size


def _is_margin_line(line: Line, page_height: float) -> bool:
    """True when the line's middle lies in the top or bottom 9 % of the page."""
    band = MARGIN_BAND * page_height
    middle = line.top + _line_height(line) / 2
    return middle <= band or middle >= page_height - band


def detect_furniture(pages_lines: Sequence[Sequence[Line]], page_height: float) -> set[str]:
    """The normalised margin lines that repeat often enough to be furniture.

    A candidate sits in the top or bottom 9 % of its page. Once its digits are
    normalised to ``#``, it is furniture when it appears on ≥ 40 % of the pages
    and on at least three of them — so a running header that only covers one
    chapter of an excerpt stays in the text, while the revision stamp and the
    page footer are dropped everywhere.
    """
    page_count = len(pages_lines)
    if page_count == 0:
        return set()
    seen: dict[str, set[int]] = {}
    for index, lines in enumerate(pages_lines):
        for line in lines:
            if _is_margin_line(line, page_height):
                seen.setdefault(normalise_furniture(line.text), set()).add(index)
    threshold = max(FURNITURE_MIN_PAGES, FURNITURE_PAGE_SHARE * page_count)
    return {text for text, pages in seen.items() if len(pages) >= threshold}


@dataclass(frozen=True, slots=True)
class FurnitureResult:
    """What :func:`drop_furniture` removed and what it kept."""

    pages_lines: list[list[Line]]
    dropped: list[str]
    """The raw strings that were dropped, in page order — ``ManualDoc.furniture``."""


def drop_furniture(
    pages_lines: Sequence[Sequence[Line]], furniture: set[str], page_height: float
) -> FurnitureResult:
    """Remove the furniture of :func:`detect_furniture` plus any page number.

    Only margin lines are candidates, so a body line that happens to read like
    a page number survives. The dropped strings are collected as printed, page
    by page and top to bottom, which is the order ``ManualDoc.furniture`` and
    the ingest report use.
    """
    kept_pages: list[list[Line]] = []
    dropped: list[str] = []
    for lines in pages_lines:
        kept: list[Line] = []
        for line in sorted(lines, key=lambda item: item.top):
            normalised = normalise_furniture(line.text)
            if _is_margin_line(line, page_height) and (
                normalised in furniture or is_page_number(normalised)
            ):
                dropped.append(line.text)
                continue
            kept.append(line)
        kept_pages.append(kept)
    return FurnitureResult(pages_lines=kept_pages, dropped=dropped)


def order_lines(lines: Sequence[Line], page_width: float) -> list[Line]:
    """Reflow one page into reading order and record the band in ``column``.

    A single-column page comes back sorted by ``top``. A two-column page is
    walked top to bottom: a full-width line closes the open band, and a band is
    emitted as its left lines (by ``top``) followed by its right lines, which
    is how a reader follows a column. Spanning headings therefore keep their
    place between the bands instead of being pulled into one.
    """
    if not lines:
        return []
    boxes = [(line.x0, line.top, line.x1, line.top + line.size) for line in lines]
    columns = _refine_columns(boxes, page_width)
    ordered_input = sorted(
        zip(lines, columns, strict=True), key=lambda item: (item[0].top, item[0].x0)
    )
    if not _is_two_column(columns, 0):
        return [replace(line, column=COLUMN_FULL) for line, _ in ordered_input]

    out: list[Line] = []
    band: list[tuple[Line, int]] = []

    def flush() -> None:
        for wanted in (COLUMN_LEFT, COLUMN_RIGHT):
            out.extend(replace(line, column=column) for line, column in band if column == wanted)
        band.clear()

    for line, column in ordered_input:
        if column == COLUMN_FULL:
            flush()
            out.append(replace(line, column=COLUMN_FULL))
            continue
        band.append((line, column))
    flush()
    return out


def _breaks_band(previous: Line, current: Line) -> bool:
    """True when the two lines belong to different bands of the reflow.

    Left to right inside one band is where a paragraph continues, so it is not
    a break; everything else that changes the column is.
    """
    if previous.column == current.column:
        return False
    return not (previous.column == COLUMN_LEFT and current.column == COLUMN_RIGHT)


def _is_footnote_line(line: Line, body_size: float) -> bool:
    return line.size <= body_size - FOOTNOTE_SIZE_DROP


def _footnote_number(text: str, fallback: int) -> int:
    match = _FOOTNOTE_MARKER_RE.match(text)
    if match is not None and match.group(1):
        return int(match.group(1))
    return fallback


def _classify_page(lines: Sequence[Line], body_size: float) -> list[bool]:
    """Mark the trailing small-print lines of one page as footnote lines.

    A footnote sits below the body text, is set smaller than the body and opens
    with a marker (``1.``, ``*``, ``†``); its continuation lines carry no
    marker. A small line that precedes every body line — a running header on a
    page whose header is not furniture — is not a footnote.
    """
    flags = [False] * len(lines)
    seen_body = False
    in_footnote = False
    for index, line in enumerate(lines):
        small = _is_footnote_line(line, body_size)
        if small and seen_body and _FOOTNOTE_MARKER_RE.match(line.text) is not None:
            flags[index] = True
            in_footnote = True
            continue
        if small and in_footnote:
            flags[index] = True
            continue
        in_footnote = False
        seen_body = True
    return flags


def _join(lines: Sequence[Line]) -> str:
    return norm_ws(dehyphenate("\n".join(line.text for line in lines)))


@dataclass(slots=True)
class _Draft:
    lines: list[Line]
    kind: str
    note: int | None = None


def _flush_draft(draft: _Draft) -> BlockSpan | None:
    if not draft.lines:
        return None
    text = _join(draft.lines)
    if draft.kind == "footnote" and draft.note is not None:
        # ``[note n]`` is the normalised marker, so the printed one — "1.", "*",
        # "†" — is dropped rather than repeated in front of the same number.
        text = f"[note {draft.note}] {_FOOTNOTE_MARKER_RE.sub('', text, count=1)}"
    first = draft.lines[0]
    return BlockSpan(
        block=TextBlock(section_ref="", page=first.page, ordinal=0, text=text, kind=draft.kind),
        page=first.page,
        top=first.top,
    )


def extract_blocks(
    lines: Sequence[Line], body_size: float, *, headings: Sequence[Heading] = ()
) -> list[BlockSpan]:
    """Merge ordered lines into paragraphs, lists and footnotes.

    ``lines`` is the output of :func:`order_lines` for every page, in page
    order. A block ends at a heading line, a page break, a band change, a
    vertical gap wider than 0.6 of the line height, or the start of a
    footnote; a line opening with a bullet or a number starts a ``list`` block
    and the following items join it. Hyphenated line ends are rejoined.

    ``headings`` comes from :func:`fdp_init.manual.sections.detect_headings`:
    a heading line is a block boundary and is not itself a block, since it
    reaches the document as a :class:`Heading` and an ``app.catalog_sections``
    row instead.
    """
    # The text is part of the key, not just the position: on a two-column page
    # the line beside a heading shares its baseline, and dropping that one
    # instead would lose a paragraph's first line without a trace.
    heading_at = {
        (heading.page, round(heading.top, 2), f"{heading.ref} {heading.title}")
        for heading in headings
    }
    spans: list[BlockSpan] = []
    draft = _Draft(lines=[], kind="paragraph")

    def flush() -> None:
        span = _flush_draft(draft)
        if span is not None:
            spans.append(span)
        draft.lines = []
        draft.kind = "paragraph"
        draft.note = None

    for page_lines_ in _by_page(lines):
        footnotes = _classify_page(page_lines_, body_size)
        notes_on_page = 0
        flush()
        for index, line in enumerate(page_lines_):
            if (line.page, round(line.top, 2), line.text) in heading_at:
                flush()
                continue
            is_footnote = footnotes[index]
            previous = draft.lines[-1] if draft.lines else None
            if previous is not None and _ends_block(
                previous, line, kind=draft.kind, is_footnote=is_footnote
            ):
                flush()
            if not draft.lines:
                draft.kind = _opening_kind(line, is_footnote)
                if is_footnote:
                    notes_on_page += 1
                    draft.note = _footnote_number(line.text, notes_on_page)
                else:
                    draft.note = None
            draft.lines.append(line)
    flush()
    return [
        replace(span, block=replace(span.block, ordinal=index)) for index, span in enumerate(spans)
    ]


def _ends_block(previous: Line, current: Line, *, kind: str, is_footnote: bool) -> bool:
    """True when ``current`` opens a new block instead of joining ``previous``.

    The order matters: what a line *is* — body text or small print at the page
    foot — outranks where it sits, and a band change outranks the vertical gap,
    which only compares within one column (the tops jump backwards when the
    text moves from the left band to the right one).
    """
    if is_footnote != (kind == "footnote"):
        return True
    if is_footnote:
        return _FOOTNOTE_MARKER_RE.match(current.text) is not None
    if _breaks_band(previous, current):
        return True
    if _starts_item(current) and kind != "list":
        return True
    return previous.column == current.column and _gap_breaks(previous, current)


def _by_page(lines: Sequence[Line]) -> list[list[Line]]:
    pages: list[list[Line]] = []
    for line in lines:
        if not pages or pages[-1][0].page != line.page:
            pages.append([])
        pages[-1].append(line)
    return pages


def _starts_item(line: Line) -> bool:
    return _BULLET_RE.match(line.text) is not None


def _opening_kind(line: Line, is_footnote: bool) -> str:
    if is_footnote:
        return "footnote"
    return "list" if _starts_item(line) else "paragraph"


def _gap_breaks(previous: Line, current: Line) -> bool:
    gap = current.top - (previous.top + _line_height(previous))
    return gap > PARAGRAPH_GAP_RATIO * _line_height(previous)
