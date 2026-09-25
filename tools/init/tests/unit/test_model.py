# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The manual data model.

The layout and section passes and the table and profile passes both build
these dataclasses, so these tests fix their shape and instantiate every one of
them.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest

from fdp_init.manual.model import (
    COLUMN_FULL,
    COLUMN_LEFT,
    COLUMN_RIGHT,
    ExtractStats,
    Heading,
    Line,
    ManualDoc,
    Table,
    TableKind,
    TableRow,
    TextBlock,
)

ALL_MODELS = (Line, Heading, TextBlock, TableRow, Table, ExtractStats, ManualDoc)


def a_line() -> Line:
    return Line(
        page=3,
        top=120.5,
        x0=56.0,
        x1=290.0,
        text="Oil temperature high",
        size=9.5,
        bold=False,
        column=COLUMN_LEFT,
    )


def a_heading() -> Heading:
    return Heading(ref="8.2.3", title="Oil temperature high", level=3, page=21, top=96.0)


def a_block() -> TextBlock:
    return TextBlock(
        section_ref="8.2.3",
        page=21,
        ordinal=4,
        text="The display shows a high oil temperature.",
        kind="paragraph",
    )


def a_row() -> TableRow:
    return TableRow(
        cells=["oil_cooler_fouled", "Oil cooler fouled", "Oil temperature rises."],
        page=21,
        group_ref="8.2.3",
        group_title="Oil temperature high",
    )


def a_table() -> Table:
    return Table(
        section_ref="8.2",
        page_from=20,
        page_to=21,
        kind=TableKind.TROUBLESHOOTING,
        header=["Fault id", "Possible cause", "Signals"],
        rows=[a_row()],
        bbox=(56.0, 90.0, 539.0, 700.0),
        strategy="lines",
        merged_from=2,
        continued_without_header=True,
    )


def a_stats() -> ExtractStats:
    return ExtractStats(
        pages=45,
        characters=98_000,
        headings_by_level={1: 10, 2: 32, 3: 17},
        furniture_lines=5,
        tables_by_kind={"troubleshooting": 1, "alarms": 1},
        tables_by_strategy={"lines": 2},
        merged_fragments=2,
        group_rows=17,
        rows_recovered=39,
        rows_dropped=1,
        rows_without_fault_id=0,
        fault_ids_in_text=39,
        fault_ids_in_tables=38,
    )


def a_doc() -> ManualDoc:
    return ManualDoc(
        path=Path("data/manual/cau-7-realistic.pdf"),
        sha256="0" * 64,
        bytes=402_000,
        page_count=45,
        title="CAU-7 instruction book",
        variant="realistic",
        headings=[a_heading()],
        blocks=[a_block()],
        tables=[a_table()],
        furniture=["page # of #"],
        full_text="8.2.3 Oil temperature high",
        stats=a_stats(),
    )


def test_every_dataclass_is_frozen() -> None:
    for model in ALL_MODELS:
        assert dataclasses.is_dataclass(model)
        assert model.__dataclass_params__.frozen  # type: ignore[attr-defined]


def test_each_model_instantiates() -> None:
    doc = a_doc()

    assert doc.tables[0].rows[0].group_ref == "8.2.3"
    assert doc.headings[0].ref == "8.2.3"
    assert doc.blocks[0].kind == "paragraph"
    assert doc.variant == "realistic"
    assert a_line().column == COLUMN_LEFT


def test_frozen_fields_cannot_be_rebound() -> None:
    heading = a_heading()

    with pytest.raises(dataclasses.FrozenInstanceError):
        heading.title = "something else"  # type: ignore[misc]


def test_table_kind_values_match_the_migration() -> None:
    """``0008_chunk_links.sql`` checks exactly these six strings."""
    assert {kind.value for kind in TableKind} == {
        "troubleshooting",
        "alarms",
        "parameters",
        "signals",
        "maintenance",
        "other",
    }
    assert TableKind.ALARMS == "alarms"


def test_column_constants_are_distinct() -> None:
    assert {COLUMN_FULL, COLUMN_LEFT, COLUMN_RIGHT} == {0, 1, 2}


def test_table_recall_estimate() -> None:
    assert a_stats().table_recall_estimate == pytest.approx(38 / 39)
    assert ExtractStats().table_recall_estimate == 1.0
