# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Table extraction against the two mini-manual PDFs.

The fixtures print the same catalog in two layouts, so the interesting
assertions are the ones that compare them: a table the realistic variant runs
across a page break, with its header repeated and one cause row cut in half,
must come out as the rows the clean variant prints on one page.

``expected.json`` is the contract for what the PDFs contain; these tests read it
rather than repeating its numbers.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

import pdfplumber
import pytest

from fdp_init.manual.model import Heading, Table, TableKind, TableRow
from fdp_init.manual.profiles import alarm_code_re, classify_header
from fdp_init.manual.tables import (
    LINES_SETTINGS,
    RawTable,
    TableStats,
    assign_groups,
    continue_split_rows,
    detect_header,
    extract_tables,
    find_page_tables,
    fold_banded_rows,
    fold_labelled_rows,
    is_group_row,
    merge_spanning,
    norm_cell,
    parse_group_row,
    section_ref_for,
    stacked_header,
    without_page_background,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "mini-manual"
MANUALS = Path(__file__).resolve().parents[4] / "data" / "manual"
EXPECTED: dict[str, Any] = json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))
VARIANTS = ("clean", "realistic")

# The stand-in for manual/sections.py: the heading rule, cut down to what these
# tests need. It keeps this file independent of the section pass while still
# feeding extract_tables the headings the real pipeline feeds it.
HEADING_RE = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,2})\s+([A-Z][^\n]{2,80})$")
BOLD_MARKERS = ("Bold", "Black", "Semibold", "Medium")
BOLD_RATIO = 0.6


def _body_size(pdf: Any) -> float:
    """The mode of the document's character sizes."""
    sizes = Counter(round(float(char["size"]), 1) for page in pdf.pages for char in page.chars)
    return float(sizes.most_common(1)[0][0]) if sizes else 0.0


def _headings(pdf: Any) -> list[Heading]:
    """Numbered, bold headings outside every table region, in reading order."""
    found: list[Heading] = []
    for page in pdf.pages:
        boxes = [raw.bbox for raw in find_page_tables(page)]
        for line in page.extract_text_lines(layout=False, strip=True, return_chars=True):
            match = HEADING_RE.match(line["text"])
            if match is None:
                continue
            centre_x = (line["x0"] + line["x1"]) / 2
            centre_y = (line["top"] + line["bottom"]) / 2
            if any(box[0] <= centre_x <= box[2] and box[1] <= centre_y <= box[3] for box in boxes):
                continue
            chars = line["chars"]
            bold = sum(
                1 for char in chars if any(m in char["fontname"] for m in BOLD_MARKERS)
            ) / len(chars)
            if bold < BOLD_RATIO:
                continue
            ref = match.group(1)
            found.append(
                Heading(
                    ref=ref,
                    title=match.group(2).strip(),
                    level=ref.count(".") + 1,
                    page=int(page.page_number),
                    top=float(line["top"]),
                )
            )
    return found


@pytest.fixture(scope="module")
def extracted() -> dict[str, tuple[list[Table], TableStats]]:
    """Both fixture PDFs, extracted once."""
    out: dict[str, tuple[list[Table], TableStats]] = {}
    for variant in VARIANTS:
        with pdfplumber.open(FIXTURES / f"mini-manual-{variant}.pdf") as pdf:
            out[variant] = extract_tables(pdf, _headings(pdf), _body_size(pdf))
    return out


def _troubleshooting(tables: list[Table]) -> list[Table]:
    return [table for table in tables if table.kind is TableKind.TROUBLESHOOTING]


def _rows(tables: list[Table]) -> list[tuple[str | None, str | None, tuple[str, ...]]]:
    return [
        (row.group_ref, row.group_title, tuple(row.cells))
        for table in _troubleshooting(tables)
        for row in table.rows
    ]


# ---------------------------------------------------------------------------
# The fixture PDFs
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("variant", VARIANTS)
def test_tables_match_expected_json(
    extracted: dict[str, tuple[list[Table], TableStats]], variant: str
) -> None:
    """Kind, header, section, pages and row count of every table."""
    tables, _ = extracted[variant]
    expected = EXPECTED["variants"][variant]["tables"]
    assert [table.kind.value for table in tables] == [item["kind"] for item in expected]
    for table, item in zip(tables, expected, strict=True):
        assert table.header == item["header"]
        assert table.section_ref == item["section_ref"]
        assert len(table.rows) == item["rows"]
        assert (table.page_from, table.page_to) == (item["page_from"], item["page_to"])
        assert table.merged_from == item["merged_from"]
        assert table.strategy == "lines"


@pytest.mark.parametrize("variant", VARIANTS)
def test_every_troubleshooting_row_is_recovered(
    extracted: dict[str, tuple[list[Table], TableStats]], variant: str
) -> None:
    """Both layouts yield the eight (condition, cause) rows of expected.json."""
    tables, _ = extracted[variant]
    rows = [row for table in _troubleshooting(tables) for row in table.rows]
    assert len(rows) == EXPECTED["counts"]["cause_rows"]
    assert all(row.cells[0] for row in rows), "every row keeps its printed fault id"
    assert all(row.group_ref and row.group_title for row in rows)


def test_realistic_table_spans_the_page_break(
    extracted: dict[str, tuple[list[Table], TableStats]],
) -> None:
    """The spanning table is one table, its repeated header dropped."""
    (table,) = _troubleshooting(extracted["realistic"][0])
    assert table.merged_from == 2
    assert table.continued_without_header is False
    assert (table.page_from, table.page_to) == (4, 5)
    assert not any(cell == "Fault id" for row in table.rows for cell in row.cells)


def test_split_row_is_rejoined_across_the_break(
    extracted: dict[str, tuple[list[Table], TableStats]],
) -> None:
    """The cause the page break cut in two comes back whole and identical."""
    continuation = EXPECTED["variants"]["realistic"]["row_continuations"][0]
    fault_id = continuation["fault_id"]
    (realistic,) = [
        row
        for row in _troubleshooting(extracted["realistic"][0])[0].rows
        if row.cells[0] == fault_id
    ]
    (clean,) = [
        row
        for table in _troubleshooting(extracted["clean"][0])
        for row in table.rows
        if row.cells[0] == fault_id
    ]
    assert realistic.page == continuation["head_page"], "the head's page wins"
    assert realistic.cells == clean.cells


def test_rows_are_identical_across_the_two_layouts(
    extracted: dict[str, tuple[list[Table], TableStats]],
) -> None:
    """Group rows and 8.2.k headings label the rows the same way."""
    assert _rows(extracted["clean"][0]) == _rows(extracted["realistic"][0])


def test_clean_layout_takes_group_refs_from_its_headings(
    extracted: dict[str, tuple[list[Table], TableStats]],
) -> None:
    """Three per-condition tables, each row labelled by the heading above it."""
    tables = _troubleshooting(extracted["clean"][0])
    assert [table.section_ref for table in tables] == ["8.2.1", "8.2.2", "8.2.3"]
    for table in tables:
        assert {row.group_ref for row in table.rows} == {table.section_ref}


def test_realistic_layout_takes_group_refs_from_its_group_rows(
    extracted: dict[str, tuple[list[Table], TableStats]],
) -> None:
    """The group rows open the conditions and are not data rows themselves."""
    tables, stats = extracted["realistic"]
    expected = EXPECTED["variants"]["realistic"]["tables"][2]["group_rows"]
    (table,) = _troubleshooting(tables)
    assert stats.group_rows == len(expected)
    seen = [row.group_ref for row in table.rows]
    assert sorted(set(seen)) == [item["ref"] for item in expected]
    for item in expected:
        title = next(row.group_title for row in table.rows if row.group_ref == item["ref"])
        assert title is not None
        assert title.startswith(item["title"])
        assert item["condition_id"] in title


@pytest.mark.parametrize("variant", VARIANTS)
def test_alarm_rows_carry_parsable_codes(
    extracted: dict[str, tuple[list[Table], TableStats]], variant: str
) -> None:
    """Six alarm rows, every code matching the default grammar."""
    tables, _ = extracted[variant]
    (alarms,) = [table for table in tables if table.kind is TableKind.ALARMS]
    assert len(alarms.rows) == EXPECTED["counts"]["alarms"]
    codes = [alarm_code_re().search(row.cells[0]) for row in alarms.rows]
    assert all(code is not None for code in codes)
    assert [item["code"] for item in EXPECTED["catalog"]["alarms"]] == [
        code.group(0) for code in codes if code is not None
    ]


@pytest.mark.parametrize("variant", VARIANTS)
def test_signal_rows_carry_their_source_column(
    extracted: dict[str, tuple[list[Table], TableStats]], variant: str
) -> None:
    """Five signal rows with the MetroPT-3 column the replay reads."""
    tables, _ = extracted[variant]
    (signals,) = [table for table in tables if table.kind is TableKind.SIGNALS]
    assert len(signals.rows) == EXPECTED["counts"]["signals"]
    source = signals.header.index("Source column")
    assert [row.cells[source] for row in signals.rows] == [
        item["metropt_column"] for item in EXPECTED["catalog"]["signals"]
    ]


@pytest.mark.parametrize("variant", VARIANTS)
def test_stats_count_what_the_layout_did(
    extracted: dict[str, tuple[list[Table], TableStats]], variant: str
) -> None:
    """The self-check counters follow the layout, not the variant name."""
    tables, stats = extracted[variant]
    spanning = variant == "realistic"
    assert stats.tables_by_strategy == {"lines": len(tables)}
    assert stats.rows_recovered == sum(len(table.rows) for table in tables)
    assert stats.rows_dropped == 0
    assert stats.merged_fragments == (1 if spanning else 0)
    assert stats.rows_continued == (1 if spanning else 0)
    assert stats.group_rows == (3 if spanning else 0)
    assert stats.tables_by_kind["troubleshooting"] == (1 if spanning else 3)


def test_page_background_rectangle_is_not_a_table() -> None:
    """A CSS page background paints four edges that are not a table.

    The committed CAU-7 manual sets ``body { background }``, so every prose page
    yields one page-sized single-column candidate; the table pass drops it. The mini
    manual does not set it, which is why this check needs the real document.
    """
    path = MANUALS / "cau-7-realistic.pdf"
    if not path.exists():  # pragma: no cover - the PDF is committed
        pytest.skip("the built manual is not present")
    with pdfplumber.open(path) as pdf:
        page = pdf.pages[3]
        candidates = page.find_tables(dict(LINES_SETTINGS))
        assert len(candidates) == 1, "pdfplumber sees the background as a table"
        assert max(len(row) for row in candidates[0].extract()) == 1
        assert find_page_tables(page) == []


# ---------------------------------------------------------------------------
# The text-strategy fallback, on a stand-in page
# ---------------------------------------------------------------------------

# Both fixture PDFs draw every cell border, so the fallback never fires
# on them. These stand-ins are the only place it can be exercised: they
# implement the handful of members find_page_tables touches on a pdfplumber
# page, and nothing else.

UNRULED_HEADER = "Fault id Possible cause Subsystem Signals Checks Remedy"
UNRULED_ROWS = [
    ["Fault id", "Possible cause", "Remedy"],
    ["dryer_purge_leak", "Dryer purge leak.", "Replace it."],
]


class _FakeFound:
    """What ``page.find_tables`` returns: a bbox and the cells under it."""

    def __init__(self, bbox: tuple[float, float, float, float], cells: list[list[str]]) -> None:
        self.bbox = bbox
        self.rows: tuple[Any, ...] = ()
        self._cells = cells

    def extract(self) -> list[list[str]]:
        return self._cells


class _FakePage:
    """The slice of a pdfplumber page ``find_page_tables`` reads."""

    def __init__(self, text: str, ruled: list[_FakeFound], unruled: list[_FakeFound]) -> None:
        self.page_number = 1
        self.width = 600.0
        self.height = 800.0
        self.rects: list[dict[str, Any]] = []
        self.tried: list[str] = []
        self._text = text
        self._by_strategy = {"lines": ruled, "text": unruled}

    def extract_text(self) -> str:
        return self._text

    def find_tables(self, settings: dict[str, Any]) -> list[_FakeFound]:
        strategy = str(settings["vertical_strategy"])
        self.tried.append(strategy)
        return self._by_strategy[strategy]


def _unruled_candidate() -> _FakeFound:
    return _FakeFound((40.0, 100.0, 550.0, 300.0), UNRULED_ROWS)


def test_text_strategy_rescues_a_page_that_draws_no_borders() -> None:
    """A printed header on a page with no ruled table is worth a second pass."""
    page = _FakePage(
        f"{UNRULED_HEADER}\ndryer_purge_leak Dryer purge leak.", [], [_unruled_candidate()]
    )
    (raw,) = find_page_tables(page)
    assert page.tried == ["lines", "text"]
    assert raw.strategy == "text"
    assert detect_header(raw)[1] is TableKind.TROUBLESHOOTING


def test_text_strategy_is_not_tried_on_a_page_of_prose() -> None:
    """Without a header-looking line the fallback would only invent tables."""
    page = _FakePage(
        "Read this manual before the unit is started for the first time.",
        [],
        [_unruled_candidate()],
    )
    assert find_page_tables(page) == []
    assert page.tried == ["lines"]


def test_a_ruled_page_never_reaches_the_fallback() -> None:
    """The ruled strategy is the trusted one; it is asked first and alone."""
    page = _FakePage(UNRULED_HEADER, [_unruled_candidate()], [])
    (raw,) = find_page_tables(page)
    assert page.tried == ["lines"]
    assert raw.strategy == "lines"


# ---------------------------------------------------------------------------
# The rules, on hand-built fragments
# ---------------------------------------------------------------------------

TROUBLESHOOTING_HEADER = ["Fault id", "Possible cause", "Remedy"]


def _raw(
    page: int,
    bbox: tuple[float, float, float, float],
    rows: list[list[str]],
    **kwargs: Any,
) -> RawTable:
    return RawTable(page=page, bbox=bbox, cells=rows, **kwargs)


def test_norm_cell_joins_a_hyphenated_line_break() -> None:
    assert norm_cell("tempera-\nture  high") == "temperature high"
    assert norm_cell(None) == ""
    assert norm_cell("cut-out\npressure") == "cut-out pressure"


def test_detect_header_recognises_a_profile() -> None:
    raw = _raw(1, (0.0, 0.0, 10.0, 10.0), [TROUBLESHOOTING_HEADER, ["a", "b", "c"]])
    header, kind, column_map = detect_header(raw, body_size=10.0)
    assert header == TROUBLESHOOTING_HEADER
    assert kind is TableKind.TROUBLESHOOTING
    assert column_map == {"id": 0, "cause": 1, "remedy": 2}


def test_detect_header_falls_back_to_a_bold_first_row() -> None:
    """A bold first row is a header, but nothing says what its columns mean."""
    raw = _raw(
        1,
        (0.0, 0.0, 10.0, 10.0),
        [["Left", "Right"], ["1", "2"]],
        header_bold=True,
    )
    header, kind, column_map = detect_header(raw, body_size=10.0)
    assert header == ["Left", "Right"]
    assert kind is TableKind.OTHER
    assert column_map == {}


def test_detect_header_leaves_a_header_less_table_alone() -> None:
    raw = _raw(1, (0.0, 0.0, 10.0, 10.0), [["1", "2"], ["3", "4"]])
    assert detect_header(raw, body_size=10.0) == (None, TableKind.OTHER, {})


def test_group_rows_are_recognised_by_shape() -> None:
    assert is_group_row(["8.2.3 Oil temperature high oil_temperature_high", "", "", ""])
    assert parse_group_row(["8.2.1 Line pressure below setpoint", "", ""]) == (
        "8.2.1",
        "Line pressure below setpoint",
    )
    assert not is_group_row(["8.2.3 Oil temperature high", "cause", ""])
    assert not is_group_row(["8 Problem solving", "", ""]), "a chapter number is not a group"
    assert parse_group_row(["", "", ""]) is None


def test_continue_split_rows_appends_a_tail_to_its_head() -> None:
    """A row with no key cell and no fault id anywhere belongs to the row above."""
    rows = [
        TableRow(cells=["oil_cooler_fouled", "Oil cooler fouled. It rejects", "Clean it."], page=4),
        TableRow(cells=["", "less heat than it should.", ""], page=5),
    ]
    joined, continued = continue_split_rows(rows, {"id": 0, "cause": 1, "remedy": 2})
    assert continued == 1
    assert len(joined) == 1
    assert joined[0].page == 4
    assert joined[0].cells == [
        "oil_cooler_fouled",
        "Oil cooler fouled. It rejects less heat than it should.",
        "Clean it.",
    ]


def test_continue_split_rows_keeps_a_row_that_names_a_fault() -> None:
    rows = [
        TableRow(cells=["oil_cooler_fouled", "Oil cooler fouled.", "Clean it."], page=4),
        TableRow(cells=["", "See oil_filter_clogged.", ""], page=5),
    ]
    joined, continued = continue_split_rows(rows, {"id": 0, "cause": 1})
    assert continued == 0
    assert len(joined) == 2


def test_continue_split_rows_needs_a_key_column() -> None:
    rows = [TableRow(cells=["", "x"], page=1)]
    assert continue_split_rows(rows, {"tag": 0, "unit": 1}) == (rows, 0)


def test_assign_groups_falls_back_to_the_enclosing_heading() -> None:
    headings = [
        Heading(ref="8.2.1", title="Line pressure below setpoint", level=3, page=4, top=50.0)
    ]
    rows = [TableRow(cells=["downstream_air_leak", "x"], page=4)]
    data, groups = assign_groups(rows, headings, "8.2.1")
    assert groups == 0
    assert (data[0].group_ref, data[0].group_title) == ("8.2.1", "Line pressure below setpoint")


def test_assign_groups_prefers_the_group_rows_it_finds() -> None:
    rows = [
        TableRow(cells=["8.2.2 Compressor starts too often", "", ""], page=4),
        TableRow(cells=["downstream_air_leak", "x", "y"], page=4),
    ]
    data, groups = assign_groups(rows, [], "8.2")
    assert groups == 1
    assert len(data) == 1
    assert (data[0].group_ref, data[0].group_title) == ("8.2.2", "Compressor starts too often")


def test_section_ref_takes_the_innermost_heading_above_the_table() -> None:
    headings = [
        Heading(ref="8.2.2", title="b", level=3, page=4, top=520.0),
        Heading(ref="8.2.3", title="c", level=3, page=5, top=330.0),
    ]
    assert section_ref_for(5, 46.0, headings) == "8.2.2", "the last heading of the page before"
    assert section_ref_for(5, 380.0, headings) == "8.2.3"
    assert section_ref_for(1, 10.0, headings) == ""


def test_merge_spanning_continues_a_fragment_without_a_header() -> None:
    """A fragment that reprints no header still merges when nothing else claims it."""
    head = _raw(
        1,
        (40.0, 300.0, 550.0, 700.0),
        [TROUBLESHOOTING_HEADER, ["dryer_purge_leak", "Dryer purge leak.", "Replace it."]],
    )
    tail = _raw(
        2,
        (40.0, 100.0, 550.0, 300.0),
        [["oil_filter_clogged", "Oil filter clogged.", "Fit a new one."]],
    )
    (table,) = merge_spanning({1: [head], 2: [tail]}, 800.0, [], body_size=10.0)
    assert table.merged_from == 2
    assert table.continued_without_header is True
    assert table.kind is TableKind.TROUBLESHOOTING
    assert [row.cells[0] for row in table.rows] == ["dryer_purge_leak", "oil_filter_clogged"]
    assert [row.page for row in table.rows] == [1, 2]


def test_merge_spanning_refuses_a_fragment_under_its_own_heading() -> None:
    """A heading above the candidate means a new table started."""
    head = _raw(
        1,
        (40.0, 300.0, 550.0, 700.0),
        [TROUBLESHOOTING_HEADER, ["dryer_purge_leak", "Dryer purge leak.", "Replace it."]],
    )
    tail = _raw(
        2,
        (40.0, 100.0, 550.0, 300.0),
        [["oil_filter_clogged", "Oil filter clogged.", "Fit a new one."]],
    )
    headings = [Heading(ref="9", title="Technical data", level=1, page=2, top=44.0)]
    tables = merge_spanning({1: [head], 2: [tail]}, 800.0, headings, body_size=10.0)
    assert len(tables) == 2
    assert all(table.merged_from == 1 for table in tables)


def test_merge_spanning_refuses_a_fragment_far_from_the_page_edge() -> None:
    head = _raw(
        1,
        (40.0, 300.0, 550.0, 400.0),
        [TROUBLESHOOTING_HEADER, ["dryer_purge_leak", "Dryer purge leak.", "Replace it."]],
    )
    tail = _raw(2, (40.0, 100.0, 550.0, 300.0), [TROUBLESHOOTING_HEADER, ["a", "b", "c"]])
    tables = merge_spanning({1: [head], 2: [tail]}, 800.0, [], body_size=10.0)
    assert [table.merged_from for table in tables] == [1, 1]


def test_merge_spanning_refuses_a_repeated_header_under_a_new_heading() -> None:
    """The clean layout repeats one header over one table per condition.

    Two such tables meeting at a page break are still two conditions, whether
    the heading of the second one closes page ``p`` or opens page ``p + 1``.
    """
    head = _raw(
        1,
        (40.0, 300.0, 550.0, 700.0),
        [TROUBLESHOOTING_HEADER, ["dryer_purge_leak", "Dryer purge leak.", "Replace it."]],
    )
    tail = _raw(
        2,
        (40.0, 100.0, 550.0, 300.0),
        [TROUBLESHOOTING_HEADER, ["oil_filter_clogged", "Oil filter clogged.", "Fit it."]],
    )
    assert len(merge_spanning({1: [head], 2: [tail]}, 800.0, [], body_size=10.0)) == 1
    for heading in (
        Heading(ref="8.4", title="Compressor starts too often", level=2, page=2, top=60.0),
        Heading(ref="8.4", title="Compressor starts too often", level=2, page=1, top=720.0),
    ):
        tables = merge_spanning({1: [head], 2: [tail]}, 800.0, [heading], body_size=10.0)
        assert [table.merged_from for table in tables] == [1, 1]


# ---------------------------------------------------------------------------
# The page background of the committed manuals
# ---------------------------------------------------------------------------


class _FilterablePage:
    """The two members :func:`without_page_background` reads, and ``filter``."""

    width = 600.0
    height = 800.0

    def __init__(self, rects: list[dict[str, Any]]) -> None:
        self.rects = rects
        self.kept: list[dict[str, Any]] | None = None

    def filter(self, test: Any) -> _FilterablePage:
        self.kept = [rect for rect in self.rects if test(rect)]
        return self


def _rect(width: float, height: float, *, fill: bool, stroke: bool) -> dict[str, Any]:
    return {"object_type": "rect", "width": width, "height": height, "fill": fill, "stroke": stroke}


def test_without_page_background_removes_only_the_background_fill() -> None:
    background = _rect(516.0, 760.0, fill=True, stroke=False)
    cell = _rect(300.0, 14.0, fill=True, stroke=False)
    frame = _rect(516.0, 760.0, fill=False, stroke=True)
    page = _FilterablePage([background, cell, frame])
    assert without_page_background(page) is page
    assert page.kept == [cell, frame]


def test_without_page_background_leaves_a_plain_page_alone() -> None:
    page = _FilterablePage([_rect(300.0, 14.0, fill=True, stroke=False)])
    assert without_page_background(page) is page
    assert page.kept is None, "a page without a background is not filtered at all"


@pytest.mark.parametrize("variant", VARIANTS)
def test_a_full_width_table_is_not_joined_to_the_page_background(variant: str) -> None:
    """The committed manuals' background rectangle touches a full-width table.

    pdfplumber then returns one page-sized grid holding the table, the headings
    and the prose around it; with the rectangle gone the page yields the table
    alone, starting at its own two-row header.
    """
    path = MANUALS / f"cau-7-{variant}.pdf"
    if not path.exists():  # pragma: no cover - the PDFs are committed
        pytest.skip("the built manual is not present")
    with pdfplumber.open(path) as pdf:
        page = next(page for page in pdf.pages if "Possible cause" in (page.extract_text() or ""))
        (grid,) = page.find_tables(dict(LINES_SETTINGS))
        assert grid.bbox[1] < 0.06 * float(page.height), "the raw grid starts at the margin"
        raws = find_page_tables(page)
        assert raws, "the troubleshooting table must still be found"
        assert all(raw.bbox[3] - raw.bbox[1] < grid.bbox[3] - grid.bbox[1] for raw in raws)
        assert raws[0].cells[0][:2] == ["Condition", "Fault id"]


def test_rows_without_a_cause_are_dropped() -> None:
    raw = _raw(
        1,
        (40.0, 40.0, 550.0, 200.0),
        [TROUBLESHOOTING_HEADER, ["dryer_purge_leak", "", "Replace it."], ["a_b", "Cause.", "Do."]],
    )
    (table,) = merge_spanning({1: [raw]}, 800.0, [], body_size=10.0)
    assert [row.cells[0] for row in table.rows] == ["a_b"]


# ---------------------------------------------------------------------------
# A cause printed as two rows (the committed CAU-7 layout)
# ---------------------------------------------------------------------------

BAND_HEADER = ["Condition", "Fault id", "", "Subsystem"]
DETAIL_HEADER = ["Possible cause", "What to check", "Remedy", "See also"]
LEAK_BAND = ["low_line_pressure", "downstream_air_leak", "", "distribution"]
LEAK_DETAIL = ["Leak in the network (common) Air escapes.", "• Listen.", "Seal it.", "W101"]
PURGE_BAND = ["low_line_pressure", "dryer_purge_leak", "", "dryer"]
PURGE_DETAIL = ["Purge valve not seating (common)", "• Listen.", "Fit a kit.", "W102"]


def test_stacked_header_reads_the_two_header_rows_side_by_side() -> None:
    header, column_map = stacked_header(BAND_HEADER, DETAIL_HEADER) or ([], {})
    assert header == [*BAND_HEADER, *DETAIL_HEADER]
    assert column_map == {
        "condition": 0,
        "id": 1,
        "subsystem": 3,
        "cause": 4,
        "checks": 5,
        "remedy": 6,
    }


def test_stacked_header_needs_a_band_that_names_the_id_column() -> None:
    assert stacked_header(["Condition", "Subsystem", "", ""], DETAIL_HEADER) is None
    assert stacked_header(["Symptoms, causes and remedies", "", "", ""], DETAIL_HEADER) is None
    assert stacked_header(["Fault id", "", "", ""], DETAIL_HEADER) is None, "one column is a label"


def test_stacked_header_never_takes_a_column_from_the_lower_row() -> None:
    """A band that repeats a lower column would shadow it in the combined map."""
    assert stacked_header(["Fault id", "Possible cause", "", ""], DETAIL_HEADER) is None


def test_detect_header_recognises_a_header_printed_over_two_rows() -> None:
    raw = _raw(1, (40.0, 40.0, 550.0, 400.0), [BAND_HEADER, DETAIL_HEADER, LEAK_BAND, LEAK_DETAIL])
    header, kind, column_map = detect_header(raw, body_size=10.0)
    assert header == [*BAND_HEADER, *DETAIL_HEADER]
    assert kind is TableKind.TROUBLESHOOTING
    assert column_map["id"] == 1
    assert column_map["cause"] == 4


def test_fold_banded_rows_joins_each_band_to_its_detail() -> None:
    rows = [
        TableRow(cells=["8.3 Line pressure below setpoint low_line_pressure", "", "", ""], page=3),
        TableRow(cells=LEAK_BAND, page=3),
        TableRow(cells=LEAK_DETAIL, page=3),
        TableRow(cells=PURGE_BAND, page=4),
        TableRow(cells=PURGE_DETAIL, page=4),
    ]
    folded = fold_banded_rows(rows, band_width=4, id_column=1)
    assert [row.cells for row in folded] == [
        rows[0].cells,
        [*LEAK_BAND, *LEAK_DETAIL],
        [*PURGE_BAND, *PURGE_DETAIL],
    ]
    assert [row.page for row in folded] == [3, 3, 4]


def test_fold_banded_rows_leaves_a_detail_tail_for_the_continuation_rule() -> None:
    """The tail of a detail row cut by a page break keeps empty band cells."""
    tail = ["runs on after a stop.", "", "", ""]
    rows = [
        TableRow(cells=LEAK_BAND, page=3),
        TableRow(cells=LEAK_DETAIL, page=3),
        TableRow(cells=tail, page=4),
    ]
    folded = fold_banded_rows(rows, band_width=4, id_column=1)
    assert folded[1].cells == ["", "", "", "", *tail]
    joined, continued = continue_split_rows(folded, {"id": 1, "cause": 4})
    assert continued == 1
    assert joined[0].cells[4] == f"{LEAK_DETAIL[0]} {tail[0]}"


def test_merge_spanning_folds_a_banded_table_across_a_page_break() -> None:
    """Both header rows repeat on the next page and are dropped; records are whole."""
    group = ["8.3 Line pressure below setpoint low_line_pressure — Pressure is low.", "", "", ""]
    head = _raw(
        1,
        (40.0, 300.0, 550.0, 700.0),
        [BAND_HEADER, DETAIL_HEADER, group, LEAK_BAND, LEAK_DETAIL],
    )
    tail = _raw(
        2, (40.0, 60.0, 550.0, 300.0), [BAND_HEADER, DETAIL_HEADER, PURGE_BAND, PURGE_DETAIL]
    )
    (table,) = merge_spanning({1: [head], 2: [tail]}, 800.0, [], body_size=10.0)
    assert table.merged_from == 2
    assert table.header == [*BAND_HEADER, *DETAIL_HEADER]
    assert [row.cells for row in table.rows] == [
        [*LEAK_BAND, *LEAK_DETAIL],
        [*PURGE_BAND, *PURGE_DETAIL],
    ]
    assert {row.group_ref for row in table.rows} == {"8.3"}


# ---------------------------------------------------------------------------
# A field printed across the table under its record (the signals row)
# ---------------------------------------------------------------------------

LEAK_MOVES = "Line pressure (P2) falls persistently while loaded."
LEAK_SIGNALS = [f"Signals: {LEAK_MOVES}", "", "", ""]
LEAK_GROUP = ["8.3 Line pressure below setpoint low_line_pressure", "", "", ""]


def test_fold_labelled_rows_gives_the_signals_row_to_the_record_above() -> None:
    """The committed CAU-7 manuals print ``Signals: …`` under every full entry."""
    rows = fold_banded_rows(
        [
            TableRow(cells=LEAK_GROUP, page=3),
            TableRow(cells=LEAK_BAND, page=3),
            TableRow(cells=LEAK_DETAIL, page=3),
            TableRow(cells=LEAK_SIGNALS, page=3),
            TableRow(cells=PURGE_BAND, page=3),
            TableRow(cells=PURGE_DETAIL, page=3),
        ],
        band_width=4,
        id_column=1,
    )
    folded, header = fold_labelled_rows(
        rows, [*BAND_HEADER, *DETAIL_HEADER], TableKind.TROUBLESHOOTING
    )
    assert header == [*BAND_HEADER, *DETAIL_HEADER, "Signals"]
    assert classify_header(header)[1]["signals"] == 8
    assert [row.cells for row in folded] == [
        LEAK_GROUP,
        [*LEAK_BAND, *LEAK_DETAIL, LEAK_MOVES],
        [*PURGE_BAND, *PURGE_DETAIL],
    ]


def test_fold_labelled_rows_leaves_every_other_row_alone() -> None:
    """A label no profile column has, a column the header prints and a row with
    no record above it are not fields; the continuation rule sees them as before."""
    blank = ["", "", "", ""]
    record = TableRow(cells=[*LEAK_BAND, *LEAK_DETAIL], page=3)
    rows = [
        TableRow(cells=[*blank, *LEAK_SIGNALS], page=3),
        TableRow(cells=LEAK_GROUP, page=3),
        TableRow(cells=[*blank, *LEAK_SIGNALS], page=3),
        record,
        TableRow(cells=[*blank, "Note: the valve runs on after a stop.", "", "", ""], page=3),
        TableRow(cells=[*blank, "Remedy: fit a new kit.", "", "", ""], page=3),
    ]
    header = [*BAND_HEADER, *DETAIL_HEADER]
    assert fold_labelled_rows(rows, header, TableKind.TROUBLESHOOTING) == (rows, header)
    assert fold_labelled_rows([record, rows[0]], header, TableKind.OTHER) == (
        [record, rows[0]],
        header,
    )


def test_merge_spanning_keeps_a_signals_row_the_page_break_pushed_over() -> None:
    """The row opens the next page under the repeated header and still belongs
    to the record that closed the page before."""
    head = _raw(
        1,
        (40.0, 300.0, 550.0, 700.0),
        [BAND_HEADER, DETAIL_HEADER, LEAK_GROUP, LEAK_BAND, LEAK_DETAIL],
    )
    tail = _raw(
        2,
        (40.0, 60.0, 550.0, 300.0),
        [BAND_HEADER, DETAIL_HEADER, LEAK_SIGNALS, PURGE_BAND, PURGE_DETAIL],
    )
    (table,) = merge_spanning({1: [head], 2: [tail]}, 800.0, [], body_size=10.0)
    assert table.header == [*BAND_HEADER, *DETAIL_HEADER, "Signals"]
    assert [row.cells for row in table.rows] == [
        [*LEAK_BAND, *LEAK_DETAIL, LEAK_MOVES],
        [*PURGE_BAND, *PURGE_DETAIL],
    ]
    assert [row.page for row in table.rows] == [1, 2]
