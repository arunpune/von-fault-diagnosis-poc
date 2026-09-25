# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The realistic variant, row by row of the knob table.

Every knob of ``build.yaml``'s ``realistic`` block leaves a trace either in the
assembled HTML or in ``manual/templates/css/realistic.css``, and this module
checks both ends without rendering a page: the HTML is parsed with
``tinyhtml5`` and the stylesheet with ``tinycss2``, both already WeasyPrint
dependencies, so nothing here needs Pango. That the rules then do what they
promise on paper is the job of ``tests/e2e/test_build_fixture.py``.

The last group of tests is the guard rail of the variants: the ``clean`` document
is the easy one, and none of the markup the realistic variant adds — the
running-string hook of the cover, the block a wide table is wrapped in, the
floating footnote spans, the imperial conversions, the one spanning
troubleshooting table — may reach it.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path
from xml.etree.ElementTree import Element

import pytest
import tinycss2
import tinyhtml5

from fdp_manual_build import numbering
from fdp_manual_build.build import build_variant, read_sources
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.model import Manual
from fdp_manual_build.templating import TEMPLATES_RELATIVE

XHTML = "{http://www.w3.org/1999/xhtml}"
VARIANTS = ("clean", "realistic")
#: ``build.yaml``'s ``two_column_chapters`` for the realistic variant.
TWO_COLUMN_CHAPTERS = (2, 6, 7)
#: The four strings ``realistic.css`` pulls off the cover for the furniture.
RUNNING_STRINGS = ("doc-title", "short-name", "rev-id", "rev-date")
#: The one Markdown footnote of the mini fixture (chapter 1).
FOOTNOTE_BODY = "The maintenance chapter repeats this sequence before each procedure."


# --- helpers ---------------------------------------------------------------


def parse(html: str) -> Element:
    """Parse a document the way WeasyPrint does."""
    root: Element = tinyhtml5.parse(html)
    return root


def find(root: Element, tag: str) -> Iterator[Element]:
    """Every element of one tag, in document order."""
    return root.iter(f"{XHTML}{tag}")


def classes(element: Element) -> set[str]:
    return set((element.get("class") or "").split())


def with_class(root: Element, tag: str, name: str) -> list[Element]:
    """Every ``tag`` element carrying the class ``name``."""
    return [element for element in find(root, tag) if name in classes(element)]


@pytest.fixture(scope="module")
def documents(request: pytest.FixtureRequest) -> dict[str, str]:
    """Both variants of the mini fixture, built once for the whole module."""
    repo_root: Path = request.getfixturevalue("repo_root")
    cfg: BuildConfig = request.getfixturevalue("mini_config")
    manual: Manual = request.getfixturevalue("mini_manual")
    sources = read_sources(cfg, repo_root)
    sections = numbering.scan(sources.chapters, numbering.generated_sections(manual))
    return {
        name: build_variant(cfg, cfg.variant(name), manual, sections, sources) for name in VARIANTS
    }


@pytest.fixture(scope="module")
def stylesheet(request: pytest.FixtureRequest) -> str:
    """``manual/templates/css/realistic.css`` as it is committed."""
    repo_root: Path = request.getfixturevalue("repo_root")
    path = repo_root / TEMPLATES_RELATIVE / "css" / "realistic.css"
    return path.read_text(encoding="utf-8")


# --- layout: two columns and the elements that span them --------------------


def test_only_chapters_2_6_and_7_are_set_in_two_columns(documents: dict[str, str]) -> None:
    root = parse(documents["realistic"])
    columns = {
        int(section.get("data-chapter") or 0): section.get("data-columns")
        for section in with_class(root, "section", "chapter")
    }
    assert columns == {
        number: ("2" if number in TWO_COLUMN_CHAPTERS else "1") for number in range(1, 11)
    }


def test_the_clean_variant_never_asks_for_a_second_column(documents: dict[str, str]) -> None:
    root = parse(documents["clean"])
    sections = with_class(root, "section", "chapter")
    assert sections
    assert {section.get("data-columns") for section in sections} == {"1"}


def test_the_stylesheet_puts_two_columns_on_the_body_of_a_marked_chapter(stylesheet: str) -> None:
    rule = _rule(stylesheet, '.chapter[data-columns="2"] > .body')
    assert "columns: 2" in rule
    assert "column-gap: 7mm" in rule
    assert "column-fill: auto" in rule


def test_the_stylesheet_spans_figures_tables_and_wide_blocks(stylesheet: str) -> None:
    spanning = [
        selector
        for selector, body in _rules(stylesheet)
        if "column-span: all" in body
        for selector in selector.split(",")
    ]
    wanted = {"> figure", "> table", "> .wide"}
    for suffix in wanted:
        assert any(
            part.strip().startswith('.chapter[data-columns="2"] > .body ') and suffix in part
            for part in spanning
        ), suffix


def test_every_wide_element_of_a_two_column_chapter_is_a_direct_child(
    documents: dict[str, str],
) -> None:
    """WeasyPrint spans a direct child of the multi-column box only."""
    root = parse(documents["realistic"])
    checked = 0
    for section in with_class(root, "section", "chapter"):
        if section.get("data-columns") != "2":
            continue
        body = next(element for element in section if "body" in classes(element))
        children = set(body)
        for element in [*find(body, "figure"), *with_class(body, "div", "wide")]:
            assert element in children, element.get("id") or element.get("class")
            checked += 1
    assert checked == 2, "the fixture has one figure and one wrapped table in columns"


def test_the_maintenance_schedule_is_wrapped_so_it_can_span(documents: dict[str, str]) -> None:
    realistic = parse(documents["realistic"])
    wrappers = with_class(realistic, "div", "wide")
    assert len(wrappers) == 1
    assert [table.get("class") for table in find(wrappers[0], "table")] == ["maintenance-schedule"]
    assert not with_class(parse(documents["clean"]), "div", "wide")


# --- page furniture ---------------------------------------------------------


def test_the_cover_hands_the_four_document_strings_to_the_stylesheet(
    documents: dict[str, str],
) -> None:
    root = parse(documents["realistic"])
    hooks = with_class(root, "span", "running-strings")
    assert len(hooks) == 1
    hook = hooks[0]
    assert {name: hook.get(f"data-{name}") for name in RUNNING_STRINGS} == {
        "doc-title": "CAU-7 Compressed-Air Unit",
        "short-name": "CAU-7",
        "rev-id": "1.0",
        "rev-date": "2026-01-15",
    }
    # An empty element: the strings must not reach the extracted cover text.
    assert not (hook.text or "").strip()
    assert not list(hook)


def test_the_stylesheet_reads_those_strings_off_the_hook(stylesheet: str) -> None:
    rule = _rule(stylesheet, ".running-strings")
    for name in RUNNING_STRINGS:
        assert f"{name} attr(data-{name})" in rule


def test_the_running_header_is_set_from_the_chapter_heading(stylesheet: str) -> None:
    assert "string-set: chapter content()" in _rule(stylesheet, "h1.chapter-title")
    # base.css sets `chapter` on the <section>, whose content() is the whole
    # chapter; the heading is the one line a running header wants.
    assert "string-set: none" in _rule(stylesheet, ".chapter")


def test_the_page_margins_carry_every_piece_of_furniture(stylesheet: str) -> None:
    page = _rule(stylesheet, "@page")
    assert "content: string(doc-title)" in page
    assert "content: string(chapter)" in page
    assert 'content: "Rev. " string(rev-id) " · " string(rev-date)' in page
    assert "content: string(short-name)" in page
    assert 'content: "Page " counter(page) " of " counter(pages)' in page
    assert "@footnote" in page


def test_the_stylesheet_parses_without_a_single_error(stylesheet: str) -> None:
    rules = tinycss2.parse_stylesheet(stylesheet, skip_comments=True, skip_whitespace=True)
    assert not [rule for rule in rules if rule.type == "error"]
    assert rules


# --- footnotes ---------------------------------------------------------------


def test_the_realistic_prose_carries_floating_footnote_spans(
    documents: dict[str, str],
) -> None:
    root = parse(documents["realistic"])
    bodies = ["".join(note.itertext()) for note in with_class(root, "span", "fn")]
    # One from the Markdown footnote of chapter 1, one from `ref()` in the
    # `short_with_footnotes` style of chapter 6 (manual/tools/context.py).
    assert FOOTNOTE_BODY in bodies
    assert "Section 4.1, Setting table" in bodies


def test_the_clean_variant_folds_the_same_note_into_the_sentence(
    documents: dict[str, str],
) -> None:
    clean = documents["clean"]
    assert 'class="fn"' not in clean
    assert f"({FOOTNOTE_BODY})" in clean


def test_the_stylesheet_floats_the_span_into_the_page_footnote_area(stylesheet: str) -> None:
    assert "float: footnote" in _rule(stylesheet, ".fn")
    assert "counter(footnote)" in _rule(stylesheet, "::footnote-call")
    assert "counter(footnote)" in _rule(stylesheet, "::footnote-marker")


# --- tables that span pages ---------------------------------------------------


def test_the_realistic_troubleshooting_is_one_table_with_a_group_row_per_condition(
    documents: dict[str, str], mini_manual: Manual
) -> None:
    root = parse(documents["realistic"])
    tables = with_class(root, "table", "troubleshooting")
    assert len(tables) == 1
    assert "spanning" in classes(tables[0])
    groups = with_class(tables[0], "tr", "group")
    # Each group row carries the id of the heading the clean variant prints,
    # so `ref('cond:<id>')` and the table of contents still land on it.
    assert [group.get("id") for group in groups] == [
        f"cond-{condition.id}" for condition in mini_manual.conditions
    ]
    assert len(list(find(tables[0], "thead"))) == 1


def test_the_clean_troubleshooting_gives_every_condition_its_own_table(
    documents: dict[str, str], mini_manual: Manual
) -> None:
    root = parse(documents["clean"])
    tables = with_class(root, "table", "troubleshooting")
    assert len(tables) == len(mini_manual.conditions)
    assert not with_class(root, "tr", "group")


def test_the_message_list_is_one_table_in_realistic_and_split_in_clean(
    documents: dict[str, str],
) -> None:
    assert len(with_class(parse(documents["realistic"]), "table", "alarms")) == 1
    assert len(with_class(parse(documents["clean"]), "table", "alarms")) > 1


def test_the_stylesheet_styles_the_group_row_and_keeps_it_with_its_rows(
    stylesheet: str,
) -> None:
    assert "break-after: avoid" in _rule(stylesheet, "tr.group")
    assert "font-weight: 700" in _rule(stylesheet, "tr.group td")


# --- units ---------------------------------------------------------------------


def test_realistic_quantities_carry_the_imperial_value_in_parentheses(
    documents: dict[str, str],
) -> None:
    realistic = documents["realistic"]
    assert "7.5 bar (109 psi)" in realistic
    assert "8 L (2.11 US gal)" in realistic


def test_clean_quantities_stay_in_si(documents: dict[str, str]) -> None:
    clean = documents["clean"]
    assert "7.5 bar" in clean
    assert "psi" not in clean
    assert "US gal" not in clean


# --- fact placement --------------------------------------------------------------


def test_a_prose_only_setting_leaves_the_table_and_is_stated_in_the_prose(
    documents: dict[str, str],
) -> None:
    root = parse(documents["realistic"])
    row = next(
        element for element in find(root, "tr") if element.get("id") == "setting-cut_in_pressure"
    )
    assert with_class(row, "td", "see-text")
    assert "8.0 bar" not in "".join(row.itertext())
    assert "the cut-in pressure at 8.0 bar (116 psi)" in documents["realistic"]


def test_the_clean_variant_prints_the_same_setting_in_its_table(
    documents: dict[str, str],
) -> None:
    root = parse(documents["clean"])
    row = next(
        element for element in find(root, "tr") if element.get("id") == "setting-cut_in_pressure"
    )
    cells = ["".join(cell.itertext()).strip() for cell in find(row, "td")]
    assert "8 bar" in cells
    assert not with_class(row, "td", "see-text")


def test_the_two_anchor_lists_decide_where_a_fact_may_be_printed(
    mini_config: BuildConfig,
) -> None:
    realistic = mini_config.variant("realistic")
    clean = mini_config.variant("clean")
    assert realistic.fact_placement == "mixed"
    # `prose_only`: the setting keeps its row as a cross-reference target, but
    # the number itself is only in the prose.
    assert realistic.fact_in_prose("setting:cut_in_pressure") is True
    assert realistic.fact_in_table("setting:cut_in_pressure") is False
    # `table_only`: the rating is a table cell and the prose points at it.
    assert realistic.fact_in_prose("machine.ratings.oil_fill_volume") is False
    assert realistic.fact_in_table("machine.ratings.oil_fill_volume") is True
    # The clean variant prints every fact in its table, wherever else it is.
    assert clean.fact_placement == "tables_only"
    for anchor in ("setting:cut_in_pressure", "machine.ratings.oil_fill_volume"):
        assert clean.fact_in_prose(anchor) is True
        assert clean.fact_in_table(anchor) is True


# --- cross references --------------------------------------------------------------


def test_realistic_cross_references_print_the_bare_number(documents: dict[str, str]) -> None:
    assert _xrefs(documents["realistic"], "#sec-settings-table") == ["4.1"]


def test_clean_cross_references_print_the_number_and_the_section_word(
    documents: dict[str, str],
) -> None:
    assert _xrefs(documents["clean"], "#sec-settings-table") == ["section 4.1"]


def _xrefs(html: str, href: str) -> list[str]:
    """The text of every ``a.xref`` pointing at ``href`` (never the contents)."""
    return [
        "".join(link.itertext())
        for link in with_class(parse(html), "a", "xref")
        if link.get("href") == href
    ]


# --- the clean document is untouched by all of the above ---------------------------


@pytest.mark.parametrize(
    "marker",
    [
        "running-strings",
        'class="wide"',
        'class="fn"',
        "troubleshooting spanning",
        'class="group"',
        "psi",
    ],
)
def test_no_realistic_only_markup_reaches_the_clean_document(
    documents: dict[str, str], marker: str
) -> None:
    assert marker in documents["realistic"], f"{marker} is not a realistic marker any more"
    assert marker not in documents["clean"]


# --- stylesheet parsing helpers -----------------------------------------------------


def _rules(stylesheet: str) -> list[tuple[str, str]]:
    """``(selector, body)`` of every qualified and ``@page`` rule, as text."""
    parsed = tinycss2.parse_stylesheet(stylesheet, skip_comments=True, skip_whitespace=True)
    rules: list[tuple[str, str]] = []
    for rule in parsed:
        if rule.type == "qualified-rule":
            prelude = tinycss2.serialize(rule.prelude)
            rules.append((_squeeze(prelude), _squeeze(tinycss2.serialize(rule.content))))
        elif rule.type == "at-rule" and rule.content is not None:
            rules.append((f"@{rule.lower_at_keyword}", _squeeze(tinycss2.serialize(rule.content))))
    return rules


def _rule(stylesheet: str, selector: str) -> str:
    """The declarations of the one rule whose selector is ``selector``."""
    bodies = [body for found, body in _rules(stylesheet) if found == selector]
    assert bodies, f"{selector!r} is not a rule of realistic.css"
    return "\n".join(bodies)


def _squeeze(text: str) -> str:
    """Collapse the whitespace tinycss2 kept, so a match is layout-agnostic."""
    return re.sub(r"\s+", " ", text).strip()
