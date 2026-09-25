# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The composed extraction against both mini-manual PDFs.

The individual passes have their own tests (``test_pdf_layout``,
``test_sections``, ``test_tables``); what is proved here is that composing them
reproduces ``expected.json`` — and that the two layouts, which print the same
manual in two shapes, come back as the same troubleshooting rows. A change that
makes one variant pass and the other fail is the failure this file is for.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from fdp_init.errors import ExitCode, InitError
from fdp_init.manual.extract import (
    MIN_CHARACTERS,
    column_map,
    extract_manual,
    row_fault_id,
    variant_of,
)
from fdp_init.manual.model import ManualDoc, TableKind

pytestmark = pytest.mark.unit

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "mini-manual"
VARIANTS = ("clean", "realistic")
EXPECTED: dict[str, Any] = json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def documents() -> dict[str, ManualDoc]:
    """Both fixtures, extracted once for the whole module."""
    return {
        variant: extract_manual(FIXTURES / f"mini-manual-{variant}.pdf") for variant in VARIANTS
    }


def _expected(variant: str) -> dict[str, Any]:
    return EXPECTED["variants"][variant]


def _troubleshooting_rows(doc: ManualDoc) -> list[tuple[str, str, str]]:
    """``(condition_id-ish group ref, fault id, cause cell)`` for every row."""
    rows: list[tuple[str, str, str]] = []
    for table in doc.tables:
        if table.kind is not TableKind.TROUBLESHOOTING:
            continue
        columns = column_map(table)
        cause = columns["cause"]
        for row in table.rows:
            fault_id = row_fault_id(row.cells, columns)
            assert fault_id is not None
            rows.append((row.group_ref or "", fault_id, row.cells[cause]))
    return rows


def _minimal_pdf() -> bytes:
    """A one-page PDF that draws nothing: the "no extractable text" case."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    start = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        start,
    )
    return bytes(out)


# --------------------------------------------------------------------------
# The document itself
# --------------------------------------------------------------------------


@pytest.mark.parametrize("variant", VARIANTS)
def test_document_identity_matches_the_file(variant: str, documents: dict[str, ManualDoc]) -> None:
    """Path, variant, size, page count and title come off the file itself."""
    doc = documents[variant]
    path = FIXTURES / f"mini-manual-{variant}.pdf"
    assert doc.path == path
    assert doc.variant == variant
    assert doc.bytes == path.stat().st_size
    assert len(doc.sha256) == 64
    assert doc.page_count == _expected(variant)["page_count"]
    assert doc.title == "CAU-7 compressed-air unit · Instruction manual · Rev. A"


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("cau-7-clean.pdf", "clean"),
        ("mini-manual-realistic.pdf", "realistic"),
        ("customer-manual.pdf", "byo"),
        ("CAU-7-CLEAN.PDF", "clean"),
    ],
)
def test_variant_is_read_off_the_file_name(name: str, expected: str) -> None:
    """``app.manual_documents.variant`` follows the name, case-insensitively."""
    assert variant_of(Path("/data/manual") / name) == expected


@pytest.mark.parametrize("variant", VARIANTS)
def test_furniture_and_headings_match_the_fixture(
    variant: str, documents: dict[str, ManualDoc]
) -> None:
    """The composed passes return the heading tree and furniture."""
    doc = documents[variant]
    expected = _expected(variant)
    assert doc.furniture == expected["furniture"]
    assert [
        {"ref": h.ref, "title": h.title, "level": h.level, "page": h.page} for h in doc.headings
    ] == expected["headings"]


@pytest.mark.parametrize("variant", VARIANTS)
def test_tables_match_the_fixture(variant: str, documents: dict[str, ManualDoc]) -> None:
    """Kind, section, header, row count and page span, per table."""
    doc = documents[variant]
    assert [
        {
            "kind": table.kind.value,
            "section_ref": table.section_ref,
            "header": table.header,
            "rows": len(table.rows),
            "page_from": table.page_from,
            "page_to": table.page_to,
            "merged_from": table.merged_from,
        }
        for table in doc.tables
    ] == [
        {
            key: value
            for key, value in table.items()
            if key not in ("group_rows", "continued_without_header")
        }
        for table in _expected(variant)["tables"]
    ]


@pytest.mark.parametrize("variant", VARIANTS)
def test_table_text_never_reaches_a_block(variant: str, documents: dict[str, ManualDoc]) -> None:
    """A cause cell is a table row, never a paragraph (``exclude_bboxes``)."""
    doc = documents[variant]
    prose = "\n".join(block.text for block in doc.blocks)
    for table in doc.tables:
        if table.kind is not TableKind.TROUBLESHOOTING:
            continue
        columns = column_map(table)
        for row in table.rows:
            fault_id = row_fault_id(row.cells, columns)
            assert fault_id is not None
            assert fault_id not in prose, f"{fault_id} leaked from a table into a paragraph"


# --------------------------------------------------------------------------
# The two layouts print the same manual
# --------------------------------------------------------------------------


def test_both_variants_yield_the_same_troubleshooting_rows(
    documents: dict[str, ManualDoc],
) -> None:
    """Same group, same fault id, same cause cell — in the same order."""
    assert _troubleshooting_rows(documents["clean"]) == _troubleshooting_rows(
        documents["realistic"]
    )


def test_the_row_count_is_the_one_the_fixture_declares(documents: dict[str, ManualDoc]) -> None:
    """Seven causes over eight (condition, cause) rows."""
    counts = EXPECTED["counts"]
    for doc in documents.values():
        rows = _troubleshooting_rows(doc)
        assert len(rows) == counts["cause_rows"]
        assert len({fault_id for _, fault_id, _ in rows}) == counts["causes"]


# --------------------------------------------------------------------------
# The self-check
# --------------------------------------------------------------------------


@pytest.mark.parametrize("variant", VARIANTS)
def test_the_tables_recovered_every_fault_id_the_text_prints(
    variant: str, documents: dict[str, ManualDoc]
) -> None:
    """``table_recall_estimate`` is 1.0 on both fixtures."""
    stats = documents[variant].stats
    assert stats.fault_ids_in_tables == EXPECTED["counts"]["causes"]
    assert stats.fault_ids_in_text == stats.fault_ids_in_tables
    assert stats.table_recall_estimate == 1.0
    assert stats.rows_without_fault_id == 0


@pytest.mark.parametrize("variant", VARIANTS)
def test_counters_agree_with_the_document(variant: str, documents: dict[str, ManualDoc]) -> None:
    """Every counter is the number the document actually carries."""
    doc = documents[variant]
    stats = doc.stats
    expected = _expected(variant)
    assert stats.pages == doc.page_count
    assert stats.characters == len(doc.full_text)
    assert stats.furniture_lines == len(doc.furniture)
    assert sum(stats.headings_by_level.values()) == len(doc.headings)
    assert sum(stats.tables_by_kind.values()) == len(doc.tables)
    assert stats.rows_recovered == sum(len(table.rows) for table in doc.tables)
    assert stats.rows_dropped == 0
    assert stats.merged_fragments == sum(table.merged_from - 1 for table in doc.tables)
    assert stats.group_rows == sum(len(table["group_rows"]) for table in expected["tables"])


@pytest.mark.parametrize("variant", VARIANTS)
def test_full_text_keeps_the_table_text_and_drops_the_furniture(
    variant: str, documents: dict[str, ManualDoc]
) -> None:
    """``full_text`` is what the page prints, which is why the self-check can use it.

    Cells wrap, so the text is compared token by token rather than by sentence:
    every fault id and every alarm code the manual prints has to be in it, or
    the self-check would be measuring the parser against itself.
    """
    doc = documents[variant]
    for _, fault_id, _ in _troubleshooting_rows(doc):
        assert fault_id in doc.full_text
    for alarm in EXPECTED["catalog"]["alarms"]:
        assert alarm["code"] in doc.full_text
    lines = doc.full_text.splitlines()
    for dropped in doc.furniture:
        assert dropped not in lines


# --------------------------------------------------------------------------
# Failures (exit 6)
# --------------------------------------------------------------------------


def test_a_page_without_text_is_exit_six(tmp_path: Path) -> None:
    """A PDF that draws nothing is the "no extractable text" case."""
    path = tmp_path / "scan-clean.pdf"
    path.write_bytes(_minimal_pdf())
    with pytest.raises(InitError) as raised:
        extract_manual(path)
    assert raised.value.exit_code == ExitCode.MANUAL
    assert str(MIN_CHARACTERS) in raised.value.message
    assert "no extractable text" in raised.value.message


def test_a_file_that_is_not_a_pdf_is_exit_six(tmp_path: Path) -> None:
    """A wrong MANUAL_PATH fails as a manual error, not as a stack trace."""
    path = tmp_path / "notes.pdf"
    path.write_text("this is not a PDF at all\n", encoding="utf-8")
    with pytest.raises(InitError) as raised:
        extract_manual(path)
    assert raised.value.exit_code == ExitCode.MANUAL
    assert raised.value.step == "ingest"
    assert "could not be read as a PDF" in raised.value.message
