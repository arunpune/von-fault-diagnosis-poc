# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Heading detection and the section tree.

The heading tree of both committed fixtures is compared against
``expected.json``: the clean variant prints an ``8.2.k`` heading per condition,
the realistic one prints none — the same three conditions open a group row
*inside* the spanning troubleshooting table, which the table region excludes.
Getting both right from the same rules is what the section pass has to prove.

The synthetic cases beside them cover what the fixtures cannot show: a
cross-reference in prose, a number that does not continue the tree, and a
measurement that reads like a heading.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from fdp_init.manual.model import Heading, Line
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
from fdp_init.manual.sections import (
    assign_sections,
    chapter_tag,
    detect_headings,
    parent_ref,
    sections_table,
)

pytestmark = pytest.mark.unit

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "mini-manual"
VARIANTS = ("clean", "realistic")
BODY_SIZE = 10.0

TABLE_SETTINGS = {
    "vertical_strategy": "lines",
    "horizontal_strategy": "lines",
    "snap_tolerance": 3,
    "join_tolerance": 3,
    "intersection_tolerance": 5,
}


def table_bboxes(page: Any) -> list[BBox]:
    """The table regions of one page.

    The group rows the realistic variant prints inside its spanning table sit
    in one of these, which is why they never reach :func:`detect_headings`.
    """
    found = page.find_tables(TABLE_SETTINGS)
    return [
        (float(table.bbox[0]), float(table.bbox[1]), float(table.bbox[2]), float(table.bbox[3]))
        for table in found
    ]


@pytest.fixture(scope="module")
def expected() -> dict[str, Any]:
    return json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))


class Sectioned:
    """Headings and sectioned blocks for one fixture variant."""

    def __init__(self, variant: str) -> None:
        self.variant = variant
        with open_document(FIXTURES / f"mini-manual-{variant}.pdf") as pdf:
            self.page_count = len(pdf.pages)
            width = float(pdf.pages[0].width)
            height = float(pdf.pages[0].height)
            boxes: list[list[BBox]] = [table_bboxes(page) for page in pdf.pages]
            self.body_size = body_font_size(pdf, exclude_bboxes=boxes)
            raw = [
                page_lines(page, exclude_bboxes=page_boxes)
                for page, page_boxes in zip(pdf.pages, boxes, strict=True)
            ]
        kept = drop_furniture(raw, detect_furniture(raw, height), height).pages_lines
        self.pages_lines = [order_lines(lines, width) for lines in kept]
        self.headings = detect_headings(self.pages_lines, self.body_size)
        self.blocks = assign_sections(
            extract_blocks(
                [line for page in self.pages_lines for line in page],
                self.body_size,
                headings=self.headings,
            ),
            self.headings,
        )


@pytest.fixture(scope="module")
def both() -> dict[str, Sectioned]:
    return {variant: Sectioned(variant) for variant in VARIANTS}


def _line(text: str, *, top: float = 100.0, size: float = BODY_SIZE, bold: bool = True) -> Line:
    return Line(page=1, top=top, x0=40.0, x1=300.0, text=text, size=size, bold=bold)


# --------------------------------------------------------------------------
# The heading tree of the fixtures
# --------------------------------------------------------------------------


@pytest.mark.parametrize("variant", VARIANTS)
def test_heading_tree_matches_the_fixture(
    variant: str, both: dict[str, Sectioned], expected: dict[str, Any]
) -> None:
    """Refs, titles, levels and pages equal ``expected.json`` for both variants."""
    found = [
        {"ref": heading.ref, "title": heading.title, "level": heading.level, "page": heading.page}
        for heading in both[variant].headings
    ]
    assert found == expected["variants"][variant]["headings"]


def test_the_realistic_group_rows_are_not_headings(both: dict[str, Sectioned]) -> None:
    """``8.2.1`` is printed inside the spanning table, so it opens no section.

    The clean variant prints the same three refs as real headings above their
    own tables, which is why the two trees differ.
    """
    realistic = {heading.ref for heading in both["realistic"].headings}
    clean = {heading.ref for heading in both["clean"].headings}
    assert {"8.2.1", "8.2.2", "8.2.3"} <= clean
    assert not {"8.2.1", "8.2.2", "8.2.3"} & realistic


def test_a_cross_reference_in_prose_is_not_a_heading(both: dict[str, Sectioned]) -> None:
    """Both variants print "causes listed in 8.2." — and no heading comes of it."""
    for sectioned in both.values():
        assert any("causes listed in 8.2." in block.text for block in sectioned.blocks), (
            sectioned.variant
        )


def test_headings_carry_the_printed_condition_id(both: dict[str, Sectioned]) -> None:
    """The clean ``8.2.k`` heading keeps the id it prints.

    ``Heading.title`` is the line as printed; removing the id token is the
    catalog builder's job, because slugging the title would not reproduce it.
    """
    titles = {heading.ref: heading.title for heading in both["clean"].headings}
    assert titles["8.2.1"] == "Line pressure below setpoint low_line_pressure"
    assert titles["8.2.2"] == "Compressor starts and loads too often frequent_cycling"
    assert titles["8.2.3"] == "Oil temperature high oil_temperature_high"


# --------------------------------------------------------------------------
# Section assignment
# --------------------------------------------------------------------------


def test_every_block_below_a_heading_carries_its_ref(both: dict[str, Sectioned]) -> None:
    """The innermost open heading wins, and 8.1's prose stays out of 8.2."""
    for sectioned in both.values():
        refs = {block.section_ref for block in sectioned.blocks}
        assert {"1", "3", "4", "8.1", "8.2", "9"} <= refs, sectioned.variant
        opening = next(
            block for block in sectioned.blocks if block.text.startswith("Work from what")
        )
        assert opening.section_ref == "8.1"
        following = next(
            block for block in sectioned.blocks if block.text.startswith("Each table below")
        )
        assert following.section_ref == "8.2"


def test_clean_symptom_paragraphs_land_under_their_condition(
    both: dict[str, Sectioned],
) -> None:
    """The prose between an ``8.2.k`` heading and its table belongs to ``8.2.k``."""
    by_ref = {
        block.section_ref: block.text
        for block in both["clean"].blocks
        if block.section_ref.startswith("8.2.")
    }
    assert by_ref["8.2.1"].startswith("The unit runs but the line pressure")
    assert by_ref["8.2.2"].startswith("The unit loads and unloads more often")
    assert by_ref["8.2.3"].startswith("The oil temperature reading stays above")


def test_a_block_above_the_first_heading_has_no_section(both: dict[str, Sectioned]) -> None:
    """The running header of page 1 is printed above ``1 Safety``."""
    first = both["realistic"].blocks[0]
    assert first.text.startswith("CAU-7 compressed-air unit")
    assert first.section_ref == ""


def test_assign_sections_renumbers_the_ordinals(both: dict[str, Sectioned]) -> None:
    for sectioned in both.values():
        ordinals = [block.ordinal for block in sectioned.blocks]
        assert ordinals == list(range(len(ordinals))), sectioned.variant


# --------------------------------------------------------------------------
# catalog_sections rows
# --------------------------------------------------------------------------


def test_sections_table_for_the_clean_fixture(both: dict[str, Sectioned]) -> None:
    """One row per heading, with the parent and the page range."""
    rows = sections_table(both["clean"].headings, both["clean"].page_count)
    assert [row["section_ref"] for row in rows] == [
        "1",
        "3",
        "4",
        "8",
        "8.1",
        "8.2",
        "8.2.1",
        "8.2.2",
        "8.2.3",
        "9",
    ]
    by_ref = {row["section_ref"]: row for row in rows}
    assert by_ref["8"] == {
        "section_ref": "8",
        "title": "Problem solving",
        "level": 1,
        "parent_ref": None,
        "page_start": 3,
        "page_end": 5,
    }
    assert by_ref["8.1"]["parent_ref"] == "8"
    assert by_ref["8.2.3"]["parent_ref"] == "8.2"
    assert by_ref["8.2.3"]["page_start"] == 5
    assert by_ref["8.2.3"]["page_end"] == 5
    assert by_ref["9"]["page_end"] == 6


def test_sections_table_page_ranges_never_invert(both: dict[str, Sectioned]) -> None:
    for sectioned in both.values():
        for row in sections_table(sectioned.headings, sectioned.page_count):
            assert row["page_start"] <= row["page_end"] <= sectioned.page_count


def test_parent_ref() -> None:
    assert parent_ref("8") is None
    assert parent_ref("8.2") == "8"
    assert parent_ref("8.2.3") == "8.2"


# --------------------------------------------------------------------------
# The heading rules, on synthetic lines
# --------------------------------------------------------------------------


def test_a_line_that_only_mentions_a_number_is_not_a_heading() -> None:
    """ "See 8.2.3" does not start with its number, so the anchor never matches."""
    lines = [
        _line("8 Problem solving", top=10.0),
        _line("8.2 Fault tables", top=30.0),
        _line("See 8.2.3 for the list of causes.", top=50.0, bold=False),
        _line("Read 8.2.3 and 8.2.1 before opening a component.", top=70.0),
    ]
    assert [heading.ref for heading in detect_headings([lines], BODY_SIZE)] == ["8", "8.2"]


def test_a_number_that_does_not_continue_the_tree_is_rejected() -> None:
    """``8.2.3`` needs ``8.2`` open; a stray depth is a numbered list item."""
    lines = [
        _line("8 Problem solving", top=10.0),
        _line("8.2.3 Oil temperature high", top=30.0),
        _line("8.2 Fault tables", top=50.0),
        _line("8.2.3 Oil temperature high", top=70.0),
    ]
    found = [(heading.ref, heading.level) for heading in detect_headings([lines], BODY_SIZE)]
    assert found == [("8", 1), ("8.2", 2), ("8.2.3", 3)]


def test_a_chapter_number_only_has_to_grow() -> None:
    """An excerpt prints 1, 3, 4, 8, 9 — every one a chapter."""
    lines = [
        _line(f"{number} Chapter", top=10.0 * index) for index, number in enumerate((1, 3, 4, 8, 9))
    ]
    assert [heading.ref for heading in detect_headings([lines], BODY_SIZE)] == [
        "1",
        "3",
        "4",
        "8",
        "9",
    ]


def test_a_chapter_number_may_not_go_backwards() -> None:
    lines = [_line("8 Problem solving", top=10.0), _line("4 Programmable settings", top=30.0)]
    assert [heading.ref for heading in detect_headings([lines], BODY_SIZE)] == ["8"]


def test_body_text_that_matches_the_shape_is_rejected() -> None:
    """Neither bold nor larger than the body: an ordinary numbered paragraph."""
    lines = [_line("8 Problem solving", top=10.0, bold=False, size=BODY_SIZE)]
    assert detect_headings([lines], BODY_SIZE) == []


def test_a_larger_line_needs_no_bold() -> None:
    lines = [_line("8 Problem solving", top=10.0, bold=False, size=BODY_SIZE + 1)]
    assert [heading.ref for heading in detect_headings([lines], BODY_SIZE)] == ["8"]


def test_a_measurement_is_not_a_heading() -> None:
    """``7 A per phase`` matches the shape; ``A`` is a unit, so it is a reading."""
    lines = [
        _line("7 A per phase", top=10.0),
        _line("9 Technical data", top=30.0),
    ]
    assert [heading.ref for heading in detect_headings([lines], BODY_SIZE)] == ["9"]


def test_a_deeper_number_than_the_grammar_allows_is_rejected() -> None:
    """The heading grammar stops at three levels; ``8.2.3.1`` is a step, not a section."""
    lines = [
        _line("8 Problem solving", top=10.0),
        _line("8.2 Fault tables", top=30.0),
        _line("8.2.3 Oil temperature high", top=50.0),
        _line("8.2.3.1 Check the cooler", top=70.0),
    ]
    refs = [heading.ref for heading in detect_headings([lines], BODY_SIZE)]
    assert refs == ["8", "8.2", "8.2.3"]


def test_detect_headings_walks_pages_in_order() -> None:
    pages = [
        [_line("1 Safety", top=10.0)],
        [_line("8 Problem solving", top=10.0), _line("8.1 Before you start", top=30.0)],
    ]
    found = [(heading.ref, heading.page) for heading in detect_headings(pages, BODY_SIZE)]
    assert found == [("1", 1), ("8", 1), ("8.1", 1)]


# --------------------------------------------------------------------------
# Chapter tags
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("title", "tag"),
    [
        ("Problem solving", "troubleshooting"),
        ("Troubleshooting the dryer", "troubleshooting"),
        ("Controller messages", "alarms"),
        ("Programmable settings", "settings"),
        ("Maintenance schedule", "maintenance"),
        ("Technical data", "technical"),
        ("Signal list", "technical"),
        ("Transport and storage", "other"),
    ],
)
def test_chapter_tag(title: str, tag: str) -> None:
    heading = Heading(ref="1", title=title, level=1, page=1, top=10.0)
    assert chapter_tag(heading) == tag
