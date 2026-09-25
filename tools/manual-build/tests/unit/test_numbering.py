# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Heading scan and section numbering."""

from __future__ import annotations

import dataclasses
import hashlib
from pathlib import Path

import pytest

from fdp_manual_build.config import BuildConfig
from fdp_manual_build.errors import BuildError
from fdp_manual_build.model import Manual
from fdp_manual_build.numbering import (
    ChapterSource,
    SectionMap,
    generated_sections,
    read_chapters,
    scan,
)

#: The whole outline of the mini fixture, in document order.
EXPECTED_OUTLINE = [
    ("sec:safety-general", "1.1"),
    ("sec:overview", "2.1"),
    ("sec:schematic", "2.2"),
    ("sec:message-list", "3.1"),
    ("sec:settings-table", "4.1"),
    ("sec:reference-conditions", "5.1"),
    ("sec:normal-cycle", "6.1"),
    ("sec:maintenance-schedule", "7.1"),
    ("sec:maintenance-procedures", "7.2"),
    ("task:oil_change", "7.2.1"),
    ("task:daily_checks", "7.2.2"),
    ("sec:troubleshooting-how-to", "8.1"),
    ("cond:oil_temperature_high", "8.2"),
    ("cond:low_line_pressure", "8.3"),
    ("cond:frequent_cycling", "8.4"),
    ("sec:signal-list", "9.1"),
    ("sec:revision-history", "10.1"),
]


def _chapter(text: str, number: int = 1) -> ChapterSource:
    data = text.encode("utf-8")
    return ChapterSource(
        number=number,
        slug="safety",
        title="Safety precautions",
        path=Path("content/01-safety.md"),
        relative="content/01-safety.md",
        text=text,
        sha256=hashlib.sha256(data).hexdigest(),
    )


@pytest.fixture
def mini_sections(mini_config: BuildConfig, mini_manual: Manual) -> SectionMap:
    return scan(read_chapters(mini_config), generated_sections(mini_manual))


def test_read_chapters_covers_every_chapter(mini_config: BuildConfig) -> None:
    chapters = read_chapters(mini_config)
    assert [chapter.number for chapter in chapters] == list(range(1, 11))
    assert chapters[0].relative == "content/01-safety.md"
    assert all(len(chapter.sha256) == 64 for chapter in chapters)


def test_a_missing_partial_is_an_error(mini_config: BuildConfig, tmp_path: Path) -> None:
    empty = dataclasses.replace(mini_config, manual_root=tmp_path)
    with pytest.raises(BuildError) as raised:
        read_chapters(empty)
    assert len(raised.value.errors) == 10
    assert raised.value.errors[0].file == "content/01-safety.md"


def test_the_outline_is_deterministic(mini_sections: SectionMap) -> None:
    assert [(anchor, ref.number) for anchor, ref in mini_sections.items()] == EXPECTED_OUTLINE


def test_html_ids_replace_the_colon(mini_sections: SectionMap) -> None:
    assert mini_sections["cond:low_line_pressure"].html_id == "cond-low_line_pressure"
    assert mini_sections["cond:low_line_pressure"].slug == "low_line_pressure"
    assert mini_sections["sec:overview"].html_id == "sec-overview"
    assert mini_sections["sec:overview"].chapter == 2


def test_generated_headings_need_the_spec(mini_config: BuildConfig) -> None:
    without = scan(read_chapters(mini_config))
    assert "cond:low_line_pressure" not in without
    assert without["sec:signal-list"].number == "9.1"


def test_generated_sections_follow_the_spec_order(mini_manual: Manual) -> None:
    generated = generated_sections(mini_manual)
    assert [item.anchor for item in generated["troubleshooting"]] == [
        "cond:oil_temperature_high",
        "cond:low_line_pressure",
        "cond:frequent_cycling",
    ]
    assert [item.level for item in generated["maintenance_procedures"]] == [3, 3]


def test_a_heading_without_an_anchor_names_file_and_line() -> None:
    chapter = _chapter("Intro paragraph.\n\n## General safety\n\nBody.\n")
    with pytest.raises(BuildError) as raised:
        scan([chapter])
    error = raised.value.errors[0]
    assert error.file == "content/01-safety.md"
    assert error.message.startswith("line 3: heading 'General safety' has no explicit {#anchor}")


def test_a_duplicate_anchor_is_an_error() -> None:
    text = "## One {#sec:one-a}\n\n## Two {#sec:one-a}\n"
    with pytest.raises(BuildError) as raised:
        scan([_chapter(text)])
    assert "line 3: duplicate anchor 'sec:one-a'" in raised.value.errors[0].message


def test_a_malformed_anchor_is_an_error() -> None:
    with pytest.raises(BuildError) as raised:
        scan([_chapter("## One {#Sec One}\n")])
    assert "malformed anchor 'Sec One'" in raised.value.errors[0].message


@pytest.mark.parametrize("hashes", ["#", "####"])
def test_only_levels_two_and_three_are_allowed(hashes: str) -> None:
    with pytest.raises(BuildError) as raised:
        scan([_chapter(f"{hashes} One {{#sec:one-a}}\n")])
    assert "is not allowed" in raised.value.errors[0].message


def test_a_subsection_before_the_first_section_is_an_error() -> None:
    with pytest.raises(BuildError) as raised:
        scan([_chapter("### Early {#sec:early-bird}\n")])
    assert "has no ## section above it" in raised.value.errors[0].message


def test_an_unknown_table_macro_is_an_error() -> None:
    text = "## One {#sec:one-a}\n\n{{ tables.invoices() }}\n"
    with pytest.raises(BuildError) as raised:
        scan([_chapter(text)])
    assert "unknown table macro 'invoices'" in raised.value.errors[0].message


def test_every_problem_is_reported_at_once() -> None:
    text = "## One\n\n### Two\n"
    with pytest.raises(BuildError) as raised:
        scan([_chapter(text)])
    assert len(raised.value.errors) == 2


def test_numbering_restarts_per_chapter() -> None:
    first = _chapter("## A {#sec:alpha}\n\n### A1 {#sec:alpha-one}\n", number=1)
    second = _chapter("## B {#sec:beta}\n", number=2)
    sections = scan([first, second])
    assert sections["sec:alpha"].number == "1.1"
    assert sections["sec:alpha-one"].number == "1.1.1"
    assert sections["sec:beta"].number == "2.1"
