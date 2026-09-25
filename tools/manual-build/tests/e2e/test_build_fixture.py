# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The mini fixture, from YAML to PDF and back out with pdfplumber.

This is the end of the build pipeline exercised for real:
the six YAML files and the ten Markdown partials under
``tests/fixtures/mini-spec`` are loaded, assembled into both variants and
rendered with the pinned WeasyPrint options, and then every promise
the two variants make is read back out of the PDF bytes:

* the fixture is small on purpose, so the pages are checked against the
  fixture's own budget rather than the manual's 28-56 (``--no-strict-pages``);
* the ``clean`` document is the easy one — every fault id and every message
  code of the fixture must be in its text, and the troubleshooting rows must
  come back as table rows (acceptance check #4 asks for 90 %);
* the ``realistic`` document is the hard one — its footnote bodies are at the
  foot of the page that references them, and every page but the cover carries
  the running header, the revision stamp and "Page N of M";
* both embed IBM Plex subsets and nothing else, and rendering the
  same document twice gives the same bytes.

Everything here needs a working Pango and Cairo, so the module carries the
``weasyprint`` marker and skips when the import fails. On macOS::

    DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib uv run --package fdp-manual-build \\
        pytest tools/manual-build/tests/e2e/test_build_fixture.py -m weasyprint

The render call is made directly rather than through ``fdp-manual-build
build``: the fixture is a bare manual tree with no ``templates/`` of its own,
so its stylesheets, fonts and figures come from the checkout's ``manual/``.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from pathlib import Path

import pdfplumber
import pytest

from fdp_manual_build import numbering
from fdp_manual_build.build import build_variant, read_sources
from fdp_manual_build.config import BuildConfig, VariantConfig
from fdp_manual_build.model import Manual
from fdp_manual_build.render import extract_pages, to_pdf

pytestmark = pytest.mark.weasyprint

VARIANTS = ("clean", "realistic")
#: The mini fixture builds to a dozen-odd pages, 10 to 14 by design, and the
#: budget here is a wider band, so a layout change is visible without being
#: brittle.
PAGE_BUDGET = (8, 20)
#: Acceptance check #4: the clean troubleshooting rows must be recoverable.
MINIMUM_ROW_RECOVERY = 0.90
#: pdfplumber's ruled-table strategy, the one check #4 is defined with.
LINES_STRATEGY = {"vertical_strategy": "lines", "horizontal_strategy": "lines"}
#: Every embedded face is a subset of one of the two IBM Plex families.
SUBSET_FONTNAME = re.compile(r"^[A-Z]{6}\+")
#: The one Markdown footnote of the fixture (chapter 1) and the cross-reference
#: note the manual's ``short_with_footnotes`` style adds in chapter 6.
FOOTNOTE_BODY = "The maintenance chapter repeats this sequence before each procedure."
XREF_FOOTNOTE = "Section 4.1, Setting table"
#: The `prose_only` setting of the fixture, as the prose of chapter 4 states it.
CUT_IN_PRESSURE = "the cut-in pressure at 8.0 bar"
CHAPTER_8_TITLE = "8 Problem solving"
CHAPTER_9_TITLE = "9 Technical data and signal list"


@dataclass(frozen=True)
class Rendered:
    """One rendered variant, with its bytes and its extracted text."""

    variant: VariantConfig
    pdf: bytes
    pages: tuple[str, ...]

    @property
    def text(self) -> str:
        return "\n".join(self.pages)

    @property
    def flat(self) -> str:
        """The whole text on one line, so a search survives a line break."""
        return flatten(self.text)

    def first_page_titled(self, title: str) -> int:
        """Index of the page whose own text opens a chapter (not the TOC)."""
        for index, text in enumerate(self.pages):
            if any(line.strip() == title for line in text.splitlines()):
                return index
        raise AssertionError(f"no page of {self.variant.name} starts chapter {title!r}")


@pytest.fixture(scope="module")
def weasyprint_ready() -> None:
    """Skip the module when WeasyPrint cannot load Pango on this host."""
    try:
        import weasyprint  # noqa: F401, PLC0415
    except Exception as error:  # pragma: no cover - environment dependent
        pytest.skip(f"WeasyPrint is not usable here: {error}")


@pytest.fixture(scope="module")
def html(request: pytest.FixtureRequest) -> dict[str, str]:
    """Both variants of the mini fixture assembled once for the module."""
    repo_root: Path = request.getfixturevalue("repo_root")
    cfg: BuildConfig = request.getfixturevalue("mini_config")
    manual: Manual = request.getfixturevalue("mini_manual")
    sources = read_sources(cfg, repo_root)
    sections = numbering.scan(sources.chapters, numbering.generated_sections(manual))
    return {
        name: build_variant(cfg, cfg.variant(name), manual, sections, sources) for name in VARIANTS
    }


@pytest.fixture(scope="module")
def rendered(
    request: pytest.FixtureRequest,
    weasyprint_ready: None,
    html: dict[str, str],
) -> dict[str, Rendered]:
    """Both variants rendered once, with their pages already extracted."""
    repo_root: Path = request.getfixturevalue("repo_root")
    cfg: BuildConfig = request.getfixturevalue("mini_config")
    results: dict[str, Rendered] = {}
    for name in VARIANTS:
        variant = cfg.variant(name)
        pdf = _render(repo_root, cfg, variant, html[name])
        results[name] = Rendered(variant=variant, pdf=pdf, pages=tuple(extract_pages(pdf)))
    return results


def _render(repo_root: Path, cfg: BuildConfig, variant: VariantConfig, document: str) -> bytes:
    """Render one variant with the stylesheets and fonts of the checkout."""
    manual_root = repo_root / "manual"
    return to_pdf(
        document,
        base_url=manual_root,
        cfg=cfg,
        variant=variant,
        font_dir=manual_root / "fonts",
    )


# --- both variants ----------------------------------------------------------


@pytest.mark.parametrize("name", VARIANTS)
def test_the_fixture_renders_inside_its_own_page_budget(
    rendered: dict[str, Rendered], name: str
) -> None:
    low, high = PAGE_BUDGET
    assert low <= len(rendered[name].pages) <= high


def test_the_two_variants_do_not_paginate_alike(rendered: dict[str, Rendered]) -> None:
    """The smaller realistic body is what makes a page number variant-specific."""
    assert len(rendered["clean"].pages) != len(rendered["realistic"].pages)


@pytest.mark.parametrize("name", VARIANTS)
def test_every_embedded_face_is_an_ibm_plex_subset(
    rendered: dict[str, Rendered], name: str
) -> None:
    with pdfplumber.open(io.BytesIO(rendered[name].pdf)) as document:
        fontnames = {char["fontname"] for page in document.pages for char in page.chars}
    assert fontnames
    for fontname in fontnames:
        assert SUBSET_FONTNAME.match(fontname), fontname
        assert "IBMPlex" in fontname.replace("-", ""), fontname


@pytest.mark.parametrize("name", VARIANTS)
def test_rendering_the_same_document_twice_gives_the_same_bytes(
    request: pytest.FixtureRequest,
    weasyprint_ready: None,
    html: dict[str, str],
    rendered: dict[str, Rendered],
    name: str,
) -> None:
    repo_root: Path = request.getfixturevalue("repo_root")
    cfg: BuildConfig = request.getfixturevalue("mini_config")
    again = _render(repo_root, cfg, cfg.variant(name), html[name])
    assert again == rendered[name].pdf


@pytest.mark.parametrize("name", VARIANTS)
def test_a_footnote_body_reaches_the_page_it_is_referenced_from(
    rendered: dict[str, Rendered], name: str
) -> None:
    result = rendered[name]
    reference = "venting the pressure"
    pages = [index for index, text in enumerate(result.pages) if reference in flatten(text)]
    assert pages, "the sentence the fixture footnotes was not extracted"
    assert FOOTNOTE_BODY in flatten(result.pages[pages[0]])


# --- the clean variant is the easy document ---------------------------------


def test_every_fault_id_and_message_code_is_in_the_clean_text(
    rendered: dict[str, Rendered], mini_manual: Manual
) -> None:
    text = rendered["clean"].flat
    missing = [fault_id for fault_id in mini_manual.causes if fault_id not in text]
    missing += [alarm.code for alarm in mini_manual.alarms if alarm.code not in text]
    assert not missing


def test_the_clean_troubleshooting_rows_come_back_as_table_rows(
    rendered: dict[str, Rendered], mini_manual: Manual
) -> None:
    expected = {
        (condition.id, entry.fault_id)
        for condition in mini_manual.conditions
        for entry in condition.causes
    }
    found = _recovered_rows(rendered["clean"], expected)
    assert len(found) >= MINIMUM_ROW_RECOVERY * len(expected), sorted(expected - found)


def test_the_clean_pages_carry_a_page_number_and_nothing_else(
    rendered: dict[str, Rendered],
) -> None:
    pages = rendered["clean"].pages
    assert pages[1].rstrip().endswith("2")
    for text in pages:
        assert "Rev." not in text
        assert "Page " not in text


def test_the_clean_variant_prints_no_imperial_conversion(
    rendered: dict[str, Rendered],
) -> None:
    text = rendered["clean"].flat
    assert CUT_IN_PRESSURE in text
    assert "psi" not in text
    assert "US gal" not in text


# --- the realistic variant is the hard document -----------------------------


def test_the_cover_of_the_realistic_variant_carries_no_furniture(
    rendered: dict[str, Rendered],
) -> None:
    cover = rendered["realistic"].pages[0]
    assert "Rev." not in cover
    assert "Page 1 of" not in cover


def test_every_realistic_page_after_the_cover_is_stamped(
    rendered: dict[str, Rendered],
) -> None:
    result = rendered["realistic"]
    total = len(result.pages)
    for number, text in enumerate(result.pages[1:], start=2):
        assert "Rev. 1.0 · 2026-01-15" in text, number
        assert f"Page {number} of {total}" in text
        assert "CAU-7 Compressed-Air Unit" in text


def test_the_running_header_names_the_chapter_of_the_page(
    rendered: dict[str, Rendered], mini_config: BuildConfig
) -> None:
    """`string(chapter)` comes off the chapter heading, so the header of a page
    names the chapter that page belongs to and never the one before it.

    The fixture is small enough that each of its chapters fits a page, so the
    continuation case is covered by
    :func:`test_the_repeated_header_is_on_every_page_of_the_spanning_table`,
    which walks the pages of the one table that does run on.
    """
    result = rendered["realistic"]
    titles = [f"{chapter.number} {chapter.title}" for chapter in mini_config.chapters]
    openers = {result.first_page_titled(title): title for title in titles}
    assert len(openers) == len(titles), "two chapters opened on the same page"
    running = ""
    for index, text in enumerate(result.pages):
        running = openers.get(index, running)
        if not running:
            continue
        assert text.splitlines()[0].endswith(running), index


def test_the_realistic_quantities_carry_their_imperial_value(
    rendered: dict[str, Rendered],
) -> None:
    # The prose of chapter 4 states the `prose_only` setting, so this one is
    # running text rather than a table cell, which pdfplumber interleaves.
    text = rendered["realistic"].flat
    assert f"{CUT_IN_PRESSURE} (116 psi)" in text
    assert "US gal" in text


def test_a_cross_reference_note_lands_at_the_foot_of_its_own_page(
    rendered: dict[str, Rendered],
) -> None:
    result = rendered["realistic"]
    pages = [index for index, text in enumerate(result.pages) if XREF_FOOTNOTE in flatten(text)]
    assert len(pages) == 1
    lines = [line.strip() for line in result.pages[pages[0]].splitlines() if line.strip()]
    note = next(line for line in lines if XREF_FOOTNOTE in line)
    # `::footnote-marker` numbers the body, and the page furniture is the only
    # thing below it.
    assert re.match(r"^\d+\.\s", note), note
    assert lines.index(note) >= len(lines) - 2


def test_the_realistic_troubleshooting_rows_survive_the_page_breaks(
    rendered: dict[str, Rendered], mini_manual: Manual
) -> None:
    """The one spanning table repeats its header, so its rows stay rows."""
    expected = {
        (condition.id, entry.fault_id)
        for condition in mini_manual.conditions
        for entry in condition.causes
    }
    assert _recovered_rows(rendered["realistic"], expected) == expected


def test_the_repeated_header_is_on_every_page_of_the_spanning_table(
    rendered: dict[str, Rendered],
) -> None:
    result = rendered["realistic"]
    first = result.first_page_titled(CHAPTER_8_TITLE)
    last = result.first_page_titled(CHAPTER_9_TITLE) - 1
    header = "Condition Fault id Subsystem"
    assert all(header in text for text in result.pages[first : last + 1])


# --- helpers ----------------------------------------------------------------


def flatten(text: str) -> str:
    """Collapse every run of whitespace, so a search survives a line break."""
    return re.sub(r"\s+", " ", text).strip()


def _recovered_rows(result: Rendered, expected: set[tuple[str, str]]) -> set[tuple[str, str]]:
    """The ``(condition, fault)`` pairs pdfplumber gets back out of chapter 8."""
    first = result.first_page_titled(CHAPTER_8_TITLE)
    last = result.first_page_titled(CHAPTER_9_TITLE)
    found: set[tuple[str, str]] = set()
    with pdfplumber.open(io.BytesIO(result.pdf)) as document:
        for page in document.pages[first:last]:
            for table in page.extract_tables(LINES_STRATEGY):
                for row in table:
                    cells = {(cell or "").replace("\n", " ").strip() for cell in row}
                    found |= {pair for pair in expected if cells.issuperset(pair)}
    return found
