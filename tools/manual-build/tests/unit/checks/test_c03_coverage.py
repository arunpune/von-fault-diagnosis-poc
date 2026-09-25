# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #3: the expected set, the two spellings, and every finding code.

The document under test is a :class:`FakePdf` built from the expected set of
the mini fixture, so a single value can be taken out of it — the "delete one
fault id row from a rendered copy" case — without rendering anything.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from pathlib import Path

import pytest

from fdp_manual_build.checks.base import Level, Profile, Status
from fdp_manual_build.checks.c03_coverage import (
    CATEGORIES,
    CoverageCleanCheck,
    Expectation,
    expected_set,
    measure,
)
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.model import Manual
from fdp_manual_build.units import EN_DASH

from .factories import FakePdf, context

PAGE_FILLER = "The chapter continues here."


def document(
    expectations: Iterable[Expectation],
    *,
    drop: Sequence[str] = (),
    pages: int = 6,
    spelling: int = 0,
) -> FakePdf:
    """A PDF whose first page prints every expectation but the dropped ones."""
    kept = [item for item in expectations if item.key not in drop]
    body = " ".join(item.spellings[min(spelling, len(item.spellings) - 1)] for item in kept)
    return FakePdf([body, *[PAGE_FILLER] * (pages - 1)], name="mini-clean.pdf")


def ctx_for(
    repo_root: Path,
    mini_spec_dir: Path,
    mini_config: BuildConfig,
    mini_manual: Manual,
    pdf: FakePdf | None,
    **extra: object,
) -> object:
    """A context whose ``clean`` variant is ``pdf``."""
    return context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        pdfs={} if pdf is None else {"clean": pdf},
        **extra,  # type: ignore[arg-type]
    )


@pytest.fixture
def expectations(mini_manual: Manual) -> tuple[Expectation, ...]:
    """The expected set of the mini fixture."""
    return expected_set(mini_manual)


# --- the expected set --------------------------------------------------------


def test_every_category_of_the_plan_is_built(expectations: tuple[Expectation, ...]) -> None:
    built = {item.category for item in expectations}
    assert built <= set(CATEGORIES)
    for category in ("fault_id", "condition_id", "tag_id", "alarm_code", "parameter_value"):
        assert category in built


def test_a_fault_id_is_expected_verbatim(
    expectations: tuple[Expectation, ...], mini_manual: Manual
) -> None:
    ids = {item.needle for item in expectations if item.category == "fault_id"}
    assert ids == set(mini_manual.causes)


def test_a_threshold_that_points_at_a_setting_is_resolved(
    expectations: tuple[Expectation, ...],
) -> None:
    """W120 fires half a bar below the cut-in default of 8 bar."""
    threshold = next(
        item for item in expectations if item.key == "W120" and item.category == "alarm_threshold"
    )
    assert threshold.needle == "7.5 bar"


def test_a_quantity_carries_both_accepted_spellings(
    expectations: tuple[Expectation, ...],
) -> None:
    default = next(item for item in expectations if item.key == "cut_in_pressure.default")
    assert default.spellings == ("8 bar", "8.0 bar")
    assert default.number == "8"
    assert default.symbol == "bar"
    assert default.anchor == "setting:cut_in_pressure"


def test_a_range_tolerates_the_dash_and_the_wrap(
    expectations: tuple[Expectation, ...],
) -> None:
    span = next(
        item
        for item in expectations
        if item.key == "line_pressure" and item.category == "signal_range"
    )
    assert span.needle == f"-1.0{EN_DASH}16.0 bar"
    assert "-1.0-16.0 bar" in span.spellings
    assert f"-1.0{EN_DASH} 16.0 bar" in span.spellings


# --- measuring ---------------------------------------------------------------


def test_a_value_only_in_a_table_cell_is_found(
    expectations: tuple[Expectation, ...],
) -> None:
    """A narrow cell wraps its value; the cell is still one row of one table."""
    span = next(
        item
        for item in expectations
        if item.key == "line_pressure" and item.category == "signal_range"
    )
    pdf = FakePdf(["nothing here"], tables={1: [[["Range"], [span.needle]]]})
    outcome = measure(pdf, [span])[0]
    assert outcome.found
    assert outcome.where == "cell"
    assert outcome.page == 1


def test_the_authored_spelling_counts_as_the_reference_one(
    expectations: tuple[Expectation, ...],
) -> None:
    pdf = document(expectations, spelling=1)
    assert all(outcome.found for outcome in measure(pdf, expectations))


# --- the check ---------------------------------------------------------------


def test_a_complete_document_passes(
    repo_root: Path,
    mini_spec_dir: Path,
    mini_config: BuildConfig,
    mini_manual: Manual,
    expectations: tuple[Expectation, ...],
) -> None:
    ctx = ctx_for(repo_root, mini_spec_dir, mini_config, mini_manual, document(expectations))
    result = CoverageCleanCheck().run(ctx)  # type: ignore[arg-type]
    assert result.status is Status.PASS
    assert result.metrics["coverage_pct"] == 100.0
    assert result.metrics["expected"] == len(expectations)
    assert result.findings == ()


def test_deleting_one_fault_id_fails_the_check_and_names_it(
    repo_root: Path,
    mini_spec_dir: Path,
    mini_config: BuildConfig,
    mini_manual: Manual,
    expectations: tuple[Expectation, ...],
) -> None:
    dropped = sorted(mini_manual.causes)[0]
    pdf = document(expectations, drop=[dropped])
    ctx = ctx_for(repo_root, mini_spec_dir, mini_config, mini_manual, pdf)
    result = CoverageCleanCheck().run(ctx)  # type: ignore[arg-type]
    assert result.status is Status.FAIL
    missing = [item for item in result.findings if item.code == "coverage.missing_fault_id"]
    assert [item.data["key"] for item in missing] == [dropped]
    assert dropped in missing[0].message
    assert missing[0].location == f"spec/faults.yaml#/causes/{dropped}"
    assert result.metrics["found"] == len(expectations) - 1


def test_a_blank_page_is_a_finding(
    repo_root: Path,
    mini_spec_dir: Path,
    mini_config: BuildConfig,
    mini_manual: Manual,
    expectations: tuple[Expectation, ...],
) -> None:
    pdf = document(expectations)
    pdf.pages = (*pdf.pages[:-1], "   ")
    ctx = ctx_for(repo_root, mini_spec_dir, mini_config, mini_manual, pdf)
    result = CoverageCleanCheck().run(ctx)  # type: ignore[arg-type]
    blank = [item for item in result.findings if item.code == "coverage.blank_page"]
    assert [item.data["page"] for item in blank] == [len(pdf.pages)]
    assert result.status is Status.FAIL


def test_a_document_outside_the_page_budget_is_a_finding(
    repo_root: Path,
    mini_spec_dir: Path,
    mini_config: BuildConfig,
    mini_manual: Manual,
    expectations: tuple[Expectation, ...],
) -> None:
    pdf = document(expectations, pages=mini_config.pdf.page_budget.max + 1)
    ctx = ctx_for(repo_root, mini_spec_dir, mini_config, mini_manual, pdf)
    result = CoverageCleanCheck().run(ctx)  # type: ignore[arg-type]
    budget = next(item for item in result.findings if item.code == "coverage.page_budget")
    assert budget.data["pages"] == mini_config.pdf.page_budget.max + 1


def test_a_machine_limit_is_reported_on_a_fixture_and_enforced_on_the_manual(
    repo_root: Path,
    mini_spec_dir: Path,
    mini_config: BuildConfig,
    mini_manual: Manual,
    expectations: tuple[Expectation, ...],
) -> None:
    limits = [item.key for item in expectations if item.category == "machine_limit"]
    assert limits
    pdf = document(expectations, drop=limits)
    for profile, level, status in (
        (Profile.FIXTURE, Level.REPORT, Status.PASS),
        (Profile.FULL, Level.MUST, Status.FAIL),
    ):
        ctx = ctx_for(repo_root, mini_spec_dir, mini_config, mini_manual, pdf, profile=profile)
        result = CoverageCleanCheck().run(ctx)  # type: ignore[arg-type]
        found = [item for item in result.findings if item.code == "coverage.missing_machine_limit"]
        assert {item.level for item in found} == {level}
        assert result.status is status


def test_a_missing_pdf_fails_by_default_and_skips_when_allowed(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = ctx_for(repo_root, mini_spec_dir, mini_config, mini_manual, None)
    failed = CoverageCleanCheck().run(ctx)  # type: ignore[arg-type]
    assert failed.status is Status.FAIL
    assert [item.code for item in failed.findings] == ["coverage.pdf_missing"]

    allowed = ctx_for(repo_root, mini_spec_dir, mini_config, mini_manual, None, require_pdf=False)
    skipped = CoverageCleanCheck().run(allowed)  # type: ignore[arg-type]
    assert skipped.status is Status.SKIPPED
    assert [item.code for item in skipped.findings] == ["check.pdf_absent"]
