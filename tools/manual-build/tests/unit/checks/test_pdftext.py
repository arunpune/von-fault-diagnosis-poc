# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``PdfText``: the one extraction the PDF-level checks share.

Every assertion here is made against ``tests/fixtures/pdf/two-page.pdf``, the
committed two-page document, so the checks that read a PDF can be tested on a
host without WeasyPrint. Its single ruled table spans the page break in the
two-row shape chapter 8 prints, which is what makes the table and column
assertions worth making at all.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from fdp_manual_build.checks.pdftext import PdfText, normalize
from fdp_manual_build.errors import BuildError
from fdp_manual_build.units import EN_DASH

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "pdf" / "two-page.pdf"
#: The committed fixture is capped at 60 KB.
SIZE_CAP = 60 * 1024


@pytest.fixture(scope="module")
def pdf() -> PdfText:
    """The committed fixture, extracted once for the module."""
    with PdfText.open(FIXTURE) as opened:
        yield opened


def test_the_committed_fixture_stays_small() -> None:
    assert FIXTURE.stat().st_size <= SIZE_CAP


def test_the_pages_are_extracted_in_order(pdf: PdfText) -> None:
    assert pdf.page_count == 2
    assert pdf.pages[0].splitlines()[0] == "8 Problem solving"
    assert "fixture_fault_01" in pdf.pages[0]
    assert "fixture_fault_60" in pdf.pages[1]
    assert pdf.blank_pages() == ()


def test_the_joined_text_hashes_the_way_the_manifest_does(pdf: PdfText) -> None:
    assert pdf.joined == "\f".join(pdf.pages)
    assert pdf.text_sha256 == hashlib.sha256(pdf.joined.encode("utf-8")).hexdigest()
    assert pdf.pdf_sha256 == hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
    assert pdf.size == FIXTURE.stat().st_size


def test_a_page_is_found_by_a_normalized_needle(pdf: PdfText) -> None:
    assert pdf.page_of("fixture_fault_01") == 1
    assert pdf.page_of("fixture_fault_60") == 2
    assert pdf.page_of("no_such_fault") is None


def test_a_chapter_opens_on_the_page_whose_own_line_is_its_title(pdf: PdfText) -> None:
    assert pdf.page_opening("8 Problem solving") == 1
    # The running text mentions the causes, but no line is that title.
    assert pdf.page_opening("9 Technical data") is None


def test_the_table_comes_back_as_rows_of_cells(pdf: PdfText) -> None:
    tables = pdf.tables_by_page[0]
    assert tables
    rows = [row for table in tables for row in table]
    band = next(row for row in rows if "fixture_fault_01" in row)
    assert band[0] == "fixture_condition_01"
    assert band[1] == "fixture_fault_01"
    assert band[-1] == "cooling"
    detail = rows[rows.index(band) + 1]
    assert detail[2] == "Fit a new element 1 and log the service."


def test_the_header_is_repeated_on_the_second_page(pdf: PdfText) -> None:
    for page in (0, 1):
        rows = [row for table in pdf.tables_by_page[page] for row in table]
        assert ("Condition", "Fault id", "", "Subsystem") in rows


def test_every_cell_of_a_page_is_searchable(pdf: PdfText) -> None:
    assert "fixture_condition_01" in pdf.cells_by_page[0]
    assert pdf.cell_page_of("Fit a new element 60 and log the service.") == 2
    assert pdf.cell_page_of("nothing prints this") is None


def test_rows_on_walks_only_the_pages_it_is_given(pdf: PdfText) -> None:
    first = [row for table in pdf.rows_on([1]) for row in table]
    both = [row for table in pdf.rows_on([1, 2]) for row in table]
    assert len(both) > len(first)
    assert not list(pdf.rows_on([99]))


def test_a_page_can_be_read_by_columns(pdf: PdfText) -> None:
    left, right = pdf.page_halves(0)
    assert "fixture_condition_01" in left
    assert "log the service." in right
    assert pdf.in_any_half("fixture_condition_01") == 1
    assert pdf.in_any_half("no_such_condition") is None


def test_the_hygiene_metadata_is_exposed(pdf: PdfText) -> None:
    assert pdf.metadata["Producer"] == "WeasyPrint 70.0"
    assert pdf.metadata["CreationDate"] == "D:20260115000000+00'00"
    assert "ModDate" not in pdf.metadata
    assert pdf.pdf_version == "1.7"
    assert all("IBMPlex" in name.replace("-", "") for name in pdf.fontnames), pdf.fontnames
    assert pdf.raw_contains(b"%PDF-1.7")
    for marker in (b"/JavaScript", b"/EmbeddedFiles", b"/AcroForm"):
        assert not pdf.raw_contains(marker)


def test_normalize_collapses_whitespace_and_folds_the_hard_hyphen() -> None:
    assert normalize("  8.0\n bar  ") == "8.0 bar"
    assert normalize(f"F{chr(0x2011)}012") == "F-012"
    # The en dash is kept: the checks search for both spellings themselves.
    span = f"-1.0{EN_DASH}16.0 bar"
    assert normalize(span) == span


def test_a_file_that_is_not_a_pdf_is_a_build_error(tmp_path: Path) -> None:
    broken = tmp_path / "broken.pdf"
    broken.write_text("not a pdf", encoding="utf-8")
    with pytest.raises(BuildError, match="cannot be read as a PDF"):
        PdfText.open(broken)


def test_a_missing_file_is_a_build_error(tmp_path: Path) -> None:
    with pytest.raises(BuildError, match="cannot be read"):
        PdfText.open(tmp_path / "absent.pdf")
