# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #4: chapter 8 read back out of a real spanning table.

``tests/fixtures/pdf/two-page.pdf`` holds sixty ``(condition, fault)`` entries
in the two-row shape the manual prints, spread over a page break with the
header repeated. Reading it back is the measurement check #4 asks for, and it
needs no WeasyPrint on the host.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from fdp_manual_build.checks.base import Status
from fdp_manual_build.checks.c04_tables import (
    MINIMUM_RECOVERY,
    TableRecoveryCheck,
    expected_pairs,
    recover,
)
from fdp_manual_build.checks.pdftext import PdfText
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.model import Condition, ConditionCause, Manual

from .factories import FakePdf, context

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "pdf" / "two-page.pdf"
#: What ``two-page.pdf`` prints, as its generator laid it out.
ENTRIES = 60
CONDITIONS = 6


def fixture_manual(manual: Manual) -> Manual:
    """The mini model with the sixty entries ``two-page.pdf`` prints."""
    by_condition: dict[str, list[ConditionCause]] = {}
    for index in range(1, ENTRIES + 1):
        condition = f"fixture_condition_{(index - 1) % CONDITIONS + 1:02d}"
        by_condition.setdefault(condition, []).append(
            ConditionCause(
                fault_id=f"fixture_fault_{index:02d}",
                likelihood="common",
                note_md=None,
                note_html=None,
            )
        )
    conditions = tuple(
        Condition(
            id=condition,
            title=condition.replace("_", " "),
            symptom_md="A symptom.",
            symptom_html=None,
            alarms=(),
            signals=(),
            causes=tuple(causes),
        )
        for condition, causes in sorted(by_condition.items())
    )
    return replace(manual, conditions=conditions)


@pytest.fixture(scope="module")
def pdf() -> PdfText:
    """The committed two-page fixture."""
    with PdfText.open(FIXTURE) as opened:
        yield opened


@pytest.fixture
def manual(mini_manual: Manual) -> Manual:
    """The model whose rows the fixture prints."""
    return fixture_manual(mini_manual)


def test_every_printed_pair_is_expected(manual: Manual) -> None:
    pairs = expected_pairs(manual)
    assert len(pairs) == ENTRIES
    assert ("fixture_condition_01", "fixture_fault_01") in pairs


def test_a_spanning_table_gives_every_row_back(
    pdf: PdfText, mini_config: BuildConfig, manual: Manual
) -> None:
    result = recover(pdf, mini_config, manual)
    assert result is not None
    assert result.pages == (1, 2), "chapter 8 runs to the end of the document"
    assert result.percent == 100.0
    assert result.percent >= MINIMUM_RECOVERY * 100
    assert result.missing == ()
    assert result.empty_remedies == ()


def test_the_check_passes_on_the_fixture(
    repo_root: Path,
    mini_spec_dir: Path,
    mini_config: BuildConfig,
    manual: Manual,
    pdf: PdfText,
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=manual,
        pdfs={"clean": pdf},
    )
    result = TableRecoveryCheck().run(ctx)
    assert result.status is Status.PASS
    assert result.metrics["recovered_rows"] == ENTRIES
    assert result.metrics["recovery_pct"] == 100.0
    assert result.metrics["pages_scanned"] == 2


def test_a_row_that_never_printed_drops_the_rate_below_the_floor(
    repo_root: Path,
    mini_spec_dir: Path,
    mini_config: BuildConfig,
    manual: Manual,
    pdf: PdfText,
) -> None:
    """Seven unprinted entries out of sixty-seven is under the 90 % floor."""
    extra = tuple(
        ConditionCause(
            fault_id=f"never_printed_{index:02d}",
            likelihood="rare",
            note_md=None,
            note_html=None,
        )
        for index in range(7)
    )
    first = manual.conditions[0]
    widened = replace(
        manual,
        conditions=(replace(first, causes=(*first.causes, *extra)), *manual.conditions[1:]),
    )
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=widened,
        pdfs={"clean": pdf},
    )
    result = TableRecoveryCheck().run(ctx)
    assert result.status is Status.FAIL
    codes = [item.code for item in result.findings]
    assert codes.count("tables.recovery_below_floor") == 1
    assert codes.count("tables.row_not_recovered") == len(extra)
    assert result.metrics["recovery_pct"] < MINIMUM_RECOVERY * 100


def test_an_empty_remedy_cell_is_informative(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, manual: Manual
) -> None:
    band = ["fixture_condition_01", "fixture_fault_01", "", "cooling"]
    detail = ["Wear on the cooling side", "Read the hours.", "", "Task 1"]
    stub = FakePdf(
        ["8 Problem solving", "9 Technical data and signal list"],
        tables={1: [[band, detail]]},
        name="stub-clean.pdf",
    )
    one = replace(manual, conditions=manual.conditions[:1])
    one = replace(
        one, conditions=(replace(one.conditions[0], causes=one.conditions[0].causes[:1]),)
    )
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=one,
        pdfs={"clean": stub},
    )
    result = TableRecoveryCheck().run(ctx)
    assert result.status is Status.PASS
    empty = [item for item in result.findings if item.code == "tables.empty_cell"]
    assert [item.data["fault"] for item in empty] == ["fixture_fault_01"]
    assert result.metrics["pages_scanned"] == 1


def test_a_document_without_chapter_eight_is_a_finding(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, manual: Manual
) -> None:
    stub = FakePdf(["Some other document"], name="stub-clean.pdf")
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=manual,
        pdfs={"clean": stub},
    )
    result = TableRecoveryCheck().run(ctx)
    assert result.status is Status.FAIL
    assert [item.code for item in result.findings] == ["tables.chapter_not_found"]


def test_a_missing_pdf_fails_by_default_and_skips_when_allowed(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, manual: Manual
) -> None:
    ctx = context(repo_root=repo_root, manual_root=mini_spec_dir, cfg=mini_config, manual=manual)
    failed = TableRecoveryCheck().run(ctx)
    assert failed.status is Status.FAIL
    assert [item.code for item in failed.findings] == ["tables.pdf_missing"]

    allowed = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=manual,
        require_pdf=False,
    )
    skipped = TableRecoveryCheck().run(allowed)
    assert skipped.status is Status.SKIPPED
    assert [item.code for item in skipped.findings] == ["check.pdf_absent"]
