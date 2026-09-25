# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""PDF page text: extraction, page numbers and the hyphenation join."""

from collections.abc import Callable, Sequence
from pathlib import Path

import pytest

from fdp_blocklist.pdf import extract_pages, scan_pdf
from fdp_blocklist.scan import ScanError, Scanner

MakeScanner = Callable[..., Scanner]
WritePdf = Callable[[Path, Sequence[Sequence[str]]], Path]


def test_a_generated_pdf_round_trips_through_pdfplumber(
    tmp_path: Path, pdf_writer: WritePdf
) -> None:
    path = pdf_writer(tmp_path / "one.pdf", [["first line", "second line"]])
    assert extract_pages(path) == ["first line\nsecond line"]


def test_a_hit_carries_its_page_number(
    tmp_path: Path, pdf_writer: WritePdf, make_scanner: MakeScanner
) -> None:
    path = pdf_writer(
        tmp_path / "manual.pdf",
        [["clean page"], ["the Zorbal drum sits here"], ["also clean"]],
    )
    hits = scan_pdf(make_scanner(tmp_path), path, "manual.pdf")
    assert [(hit.page, hit.line, hit.section) for hit in hits] == [(2, 1, "lubricants")]
    assert hits[0].location == "manual.pdf:p2:1:5"


def test_a_phrase_broken_by_the_column_break_matches(
    tmp_path: Path, pdf_writer: WritePdf, make_scanner: MakeScanner
) -> None:
    path = pdf_writer(tmp_path / "two.pdf", [["the plate reads Zorblax", "Kompressoren 2026"]])
    hits = scan_pdf(make_scanner(tmp_path), path, "two.pdf")
    assert [hit.term for hit in hits] == ["zorblax kompressoren"]
    assert hits[0].page == 1


def test_a_hyphenated_word_across_pdf_lines_matches(
    tmp_path: Path, pdf_writer: WritePdf, make_scanner: MakeScanner
) -> None:
    path = pdf_writer(tmp_path / "hyphen.pdf", [["the zor-", "bal drum"]])
    hits = scan_pdf(make_scanner(tmp_path), path, "hyphen.pdf")
    assert [(hit.term, hit.page, hit.line) for hit in hits] == [("zorbal", 1, 1)]


def test_a_clean_pdf_produces_nothing(
    tmp_path: Path, pdf_writer: WritePdf, make_scanner: MakeScanner
) -> None:
    path = pdf_writer(tmp_path / "clean.pdf", [["a twin tower dryer and a screw element"]])
    assert scan_pdf(make_scanner(tmp_path), path, "clean.pdf") == []


def test_an_unreadable_pdf_is_an_error(tmp_path: Path) -> None:
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"not a pdf at all")
    with pytest.raises(ScanError, match="cannot read the PDF"):
        extract_pages(broken)
