# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The layout pass on the committed mini-manual PDFs.

Real pdfplumber on the two fixtures, no mocks: the whole point of the
pass is what a PDF actually returns, so a stubbed page would test nothing. The
clean variant is single column with a page number, the realistic one has a
running header, a footer, two-column prose in 8.1 and a footnote, and both
print the same words — which is the property the reflow has to preserve.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from fdp_init.manual.model import (
    COLUMN_FULL,
    COLUMN_LEFT,
    COLUMN_RIGHT,
    Heading,
    Line,
    TextBlock,
)
from fdp_init.manual.pdf import (
    BBox,
    BlockSpan,
    body_font_size,
    detect_furniture,
    drop_furniture,
    extract_blocks,
    is_page_number,
    normalise_furniture,
    open_document,
    order_lines,
    page_lines,
)
from fdp_init.manual.sections import assign_sections, detect_headings

pytestmark = pytest.mark.unit

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "mini-manual"
VARIANTS = ("clean", "realistic")

TABLE_SETTINGS = {
    "vertical_strategy": "lines",
    "horizontal_strategy": "lines",
    "snap_tolerance": 3,
    "join_tolerance": 3,
    "intersection_tolerance": 5,
}
"""The ruled-table settings. The test finds the table regions itself so the
layout pass is exercised apart from ``manual/tables.py``."""


def table_bboxes(page: Any) -> list[BBox]:
    """The table regions of one page, as ``manual/tables.py`` will pass them."""
    found = page.find_tables(TABLE_SETTINGS)
    return [
        (float(table.bbox[0]), float(table.bbox[1]), float(table.bbox[2]), float(table.bbox[3]))
        for table in found
    ]


@pytest.fixture(scope="module")
def expected() -> dict[str, Any]:
    """``expected.json`` of the mini-manual fixture."""
    return json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))


class Extracted:
    """Everything the layout pass produces for one fixture variant."""

    def __init__(self, variant: str) -> None:
        self.variant = variant
        with open_document(FIXTURES / f"mini-manual-{variant}.pdf") as pdf:
            self.page_count = len(pdf.pages)
            self.width = float(pdf.pages[0].width)
            self.height = float(pdf.pages[0].height)
            self.table_bboxes: list[list[BBox]] = [table_bboxes(page) for page in pdf.pages]
            self.body_size = body_font_size(pdf, exclude_bboxes=self.table_bboxes)
            raw = [
                page_lines(page, exclude_bboxes=boxes)
                for page, boxes in zip(pdf.pages, self.table_bboxes, strict=True)
            ]
        self.furniture = detect_furniture(raw, self.height)
        result = drop_furniture(raw, self.furniture, self.height)
        self.dropped = result.dropped
        self.pages_lines = [order_lines(lines, self.width) for lines in result.pages_lines]
        self.headings = detect_headings(self.pages_lines, self.body_size)
        self.spans: list[BlockSpan] = extract_blocks(
            [line for page in self.pages_lines for line in page],
            self.body_size,
            headings=self.headings,
        )
        self.blocks: list[TextBlock] = assign_sections(self.spans, self.headings)

    def section(self, ref: str, *kinds: str) -> list[TextBlock]:
        wanted = set(kinds) if kinds else None
        return [
            block
            for block in self.blocks
            if block.section_ref == ref and (wanted is None or block.kind in wanted)
        ]

    def text(self) -> str:
        return " ".join(block.text for block in self.blocks)


@pytest.fixture(scope="module", params=VARIANTS)
def extracted(request: pytest.FixtureRequest) -> Extracted:
    return Extracted(str(request.param))


@pytest.fixture(scope="module")
def both() -> dict[str, Extracted]:
    return {variant: Extracted(variant) for variant in VARIANTS}


# --------------------------------------------------------------------------
# Page furniture
# --------------------------------------------------------------------------


def test_dropped_furniture_matches_the_fixture(
    extracted: Extracted, expected: dict[str, Any]
) -> None:
    """The dropped strings equal ``expected.json``, in page order."""
    assert extracted.dropped == expected["variants"][extracted.variant]["furniture"]


def test_every_realistic_page_loses_its_furniture() -> None:
    """Each of the six realistic pages has at least one margin line removed."""
    realistic = Extracted("realistic")
    with open_document(FIXTURES / "mini-manual-realistic.pdf") as pdf:
        before = [
            page_lines(page, exclude_bboxes=boxes)
            for page, boxes in zip(pdf.pages, realistic.table_bboxes, strict=True)
        ]
    after = drop_furniture(before, realistic.furniture, realistic.height).pages_lines
    for index, (raw, kept) in enumerate(zip(before, after, strict=True), start=1):
        assert len(kept) < len(raw), f"page {index} kept every line"


def test_no_furniture_string_survives_in_the_text(extracted: Extracted) -> None:
    """A dropped string is gone from the blocks, not merely from one page.

    Only the distinctive strings are checked: the clean variant's furniture is
    a bare page number, and a digit is bound to appear inside a section
    reference somewhere in the prose.
    """
    body = extracted.text()
    for dropped in {text for text in extracted.dropped if len(text) > 3}:
        assert dropped not in body


def test_clean_furniture_is_only_page_numbers(both: dict[str, Extracted]) -> None:
    """The clean variant prints nothing in the margins but the page number."""
    assert both["clean"].dropped == [str(number) for number in range(1, 7)]
    assert all(is_page_number(normalise_furniture(text)) for text in both["clean"].dropped)


def test_a_chapter_header_on_two_pages_is_not_furniture(both: dict[str, Extracted]) -> None:
    """Furniture needs ≥ 3 pages: the header of chapters 1, 4 and 9 stays.

    Only ``8 Problem solving`` runs over three pages of the excerpt, which is
    why ``expected.json`` lists it three times and lists no other header.
    """
    headers = [text for text in both["realistic"].dropped if text.startswith("CAU-7")]
    assert headers == ["CAU-7 compressed-air unit — Instruction manual 8 Problem solving"] * 3


def test_is_page_number_accepts_the_usual_shapes() -> None:
    assert is_page_number(normalise_furniture("3"))
    assert is_page_number(normalise_furniture("page 3"))
    assert is_page_number(normalise_furniture("3 / 12"))
    assert is_page_number(normalise_furniture("page 3 of 12"))
    assert not is_page_number(normalise_furniture("Rev. A · 2026-09-19 page 3 of 6"))
    assert not is_page_number(normalise_furniture("8.2 Fault tables"))


# --------------------------------------------------------------------------
# Body font size
# --------------------------------------------------------------------------


def test_body_size_is_the_prose_size_not_the_table_size(both: dict[str, Extracted]) -> None:
    """Table cells outnumber prose in this manual, so they must be excluded.

    Counting them would report 9.2 pt (clean) or 8.8 pt (realistic) — the
    table size — and every rule hanging off the body size would move with it.
    """
    assert both["clean"].body_size == pytest.approx(11.5)
    assert both["realistic"].body_size == pytest.approx(11.0)


def test_body_size_without_exclusions_falls_back_to_the_whole_document() -> None:
    """The plain ``mode of char sizes`` is still what is computed."""
    with open_document(FIXTURES / "mini-manual-realistic.pdf") as pdf:
        assert body_font_size(pdf) == pytest.approx(8.8)


# --------------------------------------------------------------------------
# Table regions
# --------------------------------------------------------------------------


def test_alarm_table_region_removes_its_lines(both: dict[str, Extracted]) -> None:
    """The alarm rows of chapter 3 reach no text block once excluded.

    The bboxes come straight from ``page.find_tables()``, the way
    ``manual/tables.py`` will hand them over.
    """
    for extracted in both.values():
        body = extracted.text()
        for code in ("W101", "W102", "W104", "W108", "X201", "S301"):
            assert code not in body, f"{extracted.variant}: {code} leaked out of the table"
        assert "Low-pressure switch closed" not in body


def test_without_the_bboxes_the_alarm_rows_are_lines_again() -> None:
    """The exclusion is what removes them, not the paragraph rules."""
    with open_document(FIXTURES / "mini-manual-realistic.pdf") as pdf:
        page = pdf.pages[0]
        with_tables = page_lines(page)
        without = page_lines(page, exclude_bboxes=table_bboxes(page))
    assert any("W101" in line.text for line in with_tables)
    assert not any("W101" in line.text for line in without)
    assert len(without) < len(with_tables)


# --------------------------------------------------------------------------
# Column reflow
# --------------------------------------------------------------------------


def _normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


FOOTNOTE_BODY = (
    "Do not exceed 95 °C (203 °F): above that limit the controller stops the unit "
    "and inhibits the restart."
)


def test_section_8_1_has_the_same_block_shape_in_both_variants(
    both: dict[str, Extracted],
) -> None:
    """Two paragraphs then one list, whether the prose ran in one or two columns."""
    for extracted in both.values():
        kinds = [block.kind for block in extracted.section("8.1")]
        assert kinds == ["paragraph", "paragraph", "list"], extracted.variant


def test_section_8_1_prose_order_survives_the_reflow(both: dict[str, Extracted]) -> None:
    """The two-column 8.1 reflows to the clean variant's reading order.

    The only difference the layout may introduce is the footnote: the clean
    variant prints it inline in parentheses at the end of the second
    paragraph, the realistic one moves it to the page foot and leaves a call
    number behind. Everything else — including the bullet list assembled from
    the right-hand column — has to come out word for word the same.
    """
    clean = [_normalise(block.text) for block in both["clean"].section("8.1")]
    realistic = [_normalise(block.text) for block in both["realistic"].section("8.1")]

    assert realistic[0] == clean[0]
    assert realistic[2] == clean[2]

    tail = realistic[1].removesuffix("1")
    assert realistic[1].endswith("1"), "the footnote call should stay on the paragraph"
    assert clean[1] == f"{tail} ({FOOTNOTE_BODY})"


def test_the_right_column_bullets_are_one_list_block(both: dict[str, Extracted]) -> None:
    """All three bullets of 8.1 land in one list block, in printed order."""
    for extracted in both.values():
        lists = extracted.section("8.1", "list")
        assert len(lists) == 1, extracted.variant
        text = lists[0].text
        assert text.index("• Note") < text.index("• Take every") < text.index("• Change one")


def test_only_the_realistic_8_1_page_is_two_column(both: dict[str, Extracted]) -> None:
    """Page 3 of the realistic variant is the one page with two bands."""
    banded = {
        variant: [
            index + 1
            for index, lines in enumerate(extracted.pages_lines)
            if any(line.column != COLUMN_FULL for line in lines)
        ]
        for variant, extracted in both.items()
    }
    assert banded["clean"] == []
    assert banded["realistic"] == [3]


# --------------------------------------------------------------------------
# Footnotes
# --------------------------------------------------------------------------


def test_the_realistic_footnote_is_kept_and_tagged(both: dict[str, Extracted]) -> None:
    """The limit that lives only in the footnote survives, tagged ``[note 1]``."""
    footnotes = [block for block in both["realistic"].blocks if block.kind == "footnote"]
    assert len(footnotes) == 1
    assert footnotes[0].text == f"[note 1] {FOOTNOTE_BODY}"
    assert footnotes[0].page == 3


def test_the_clean_variant_prints_the_footnote_inline(both: dict[str, Extracted]) -> None:
    """Nothing is tagged in the clean variant — the limit is part of the prose."""
    assert [block for block in both["clean"].blocks if block.kind == "footnote"] == []
    assert FOOTNOTE_BODY in both["clean"].text()


def test_a_small_line_above_the_body_is_not_a_footnote(both: dict[str, Extracted]) -> None:
    """The running header of pages 1, 2 and 6 is small print at the top.

    The layout pass only reads small print *below* the body as a footnote, so the header
    the repetition rule leaves behind stays an ordinary paragraph.
    """
    headers = [
        block
        for block in both["realistic"].blocks
        if block.text.startswith("CAU-7 compressed-air unit")
    ]
    assert [block.page for block in headers] == [1, 2, 6]
    assert all(block.kind == "paragraph" for block in headers)


# --------------------------------------------------------------------------
# Paragraphs
# --------------------------------------------------------------------------


def test_paragraphs_break_on_the_printed_gap(both: dict[str, Extracted]) -> None:
    """Chapter 1 prints two paragraphs; the pass returns two, not one."""
    for extracted in both.values():
        blocks = extracted.section("1")
        assert len(blocks) == 2, extracted.variant
        assert blocks[0].text.startswith("Read this manual")
        assert blocks[1].text.startswith("Only a trained technician")


def test_a_heading_line_becomes_no_block() -> None:
    """A heading reaches the document as a ``Heading``, never as a paragraph."""
    heading = Heading(ref="8", title="Problem solving", level=1, page=1, top=100.0)
    lines = [
        Line(
            page=1,
            top=100.0,
            x0=40.0,
            x1=200.0,
            text="8 Problem solving",
            size=13.0,
            bold=True,
        ),
        Line(
            page=1,
            top=120.0,
            x0=40.0,
            x1=560.0,
            text="Work from what the unit shows.",
            size=10.0,
            bold=False,
        ),
    ]
    spans = extract_blocks(lines, 10.0, headings=[heading])
    assert [span.block.text for span in spans] == ["Work from what the unit shows."]


def test_a_line_sharing_a_headings_baseline_survives() -> None:
    """The match is on the text as well as the position.

    On a two-column page the line beside a spanning heading shares its
    baseline; matching the heading by ``(page, top)`` alone would silently
    swallow the neighbour's first line.
    """
    heading = Heading(ref="8", title="Problem solving", level=1, page=1, top=100.0)
    lines = [
        Line(
            page=1,
            top=100.0,
            x0=40.0,
            x1=270.0,
            text="8 Problem solving",
            size=13.0,
            bold=True,
            column=COLUMN_LEFT,
        ),
        Line(
            page=1,
            top=100.0,
            x0=330.0,
            x1=560.0,
            text="The right column keeps running.",
            size=10.0,
            bold=False,
            column=COLUMN_RIGHT,
        ),
    ]
    spans = extract_blocks(lines, 10.0, headings=[heading])
    assert [span.block.text for span in spans] == ["The right column keeps running."]


def test_ordinals_are_dense_and_in_reading_order(extracted: Extracted) -> None:
    assert [block.ordinal for block in extracted.blocks] == list(range(len(extracted.blocks)))
    pages = [block.page for block in extracted.blocks]
    assert pages == sorted(pages)


def test_extraction_is_deterministic() -> None:
    """Same bytes, same blocks — the deterministic catalog starts here."""
    first = Extracted("realistic")
    second = Extracted("realistic")
    assert first.blocks == second.blocks
    assert first.dropped == second.dropped


# --------------------------------------------------------------------------
# order_lines on synthetic lines
# --------------------------------------------------------------------------

PAGE_WIDTH = 600.0


def _line(top: float, x0: float, x1: float, text: str) -> Line:
    return Line(page=1, top=top, x0=x0, x1=x1, text=text, size=10.0, bold=False)


def test_order_lines_leaves_a_single_column_alone() -> None:
    """A single-column page comes back sorted by ``top``, all lines full width."""
    lines = [
        _line(100.0, 40.0, 560.0, "first"),
        _line(120.0, 40.0, 540.0, "second"),
        _line(140.0, 40.0, 200.0, "third"),
    ]
    ordered = order_lines(list(reversed(lines)), PAGE_WIDTH)
    assert [line.text for line in ordered] == ["first", "second", "third"]
    assert {line.column for line in ordered} == {COLUMN_FULL}


def test_order_lines_reflows_two_columns_around_a_spanning_heading() -> None:
    """Left band, right band, then the spanning heading that closes it.

    The heading is short and starts at the left margin, so its bbox looks like
    a left-column line; only the fact that no right-column line faces it tells
    the two apart.
    """
    lines = [
        _line(100.0, 40.0, 270.0, "left one"),
        _line(100.0, 330.0, 560.0, "right one"),
        _line(115.0, 40.0, 260.0, "left two"),
        _line(115.0, 330.0, 550.0, "right two"),
        _line(140.0, 40.0, 150.0, "2 Spanning heading"),
        _line(160.0, 40.0, 270.0, "left three"),
        _line(160.0, 330.0, 560.0, "right three"),
    ]
    ordered = order_lines(lines, PAGE_WIDTH)
    assert [line.text for line in ordered] == [
        "left one",
        "left two",
        "right one",
        "right two",
        "2 Spanning heading",
        "left three",
        "right three",
    ]
    columns = {line.text: line.column for line in ordered}
    assert columns["left one"] == COLUMN_LEFT
    assert columns["right one"] == COLUMN_RIGHT
    assert columns["2 Spanning heading"] == COLUMN_FULL


def test_order_lines_keeps_a_short_trailing_line_full_width() -> None:
    """A left-margin line below the bands is full width, not a left column."""
    lines = [
        _line(100.0, 40.0, 270.0, "left one"),
        _line(100.0, 330.0, 560.0, "right one"),
        _line(115.0, 40.0, 260.0, "left two"),
        _line(115.0, 330.0, 550.0, "right two"),
        _line(200.0, 40.0, 120.0, "after the bands"),
    ]
    ordered = order_lines(lines, PAGE_WIDTH)
    assert ordered[-1].text == "after the bands"
    assert ordered[-1].column == COLUMN_FULL


def test_order_lines_on_nothing() -> None:
    assert order_lines([], PAGE_WIDTH) == []
