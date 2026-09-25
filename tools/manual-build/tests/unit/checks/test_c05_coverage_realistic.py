# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #5: the same measure on the hard document, and why a miss happened.

The status is always ``report``; what is worth testing is that it never fails
the run and that each of the four classes of check #5 is reached by the document
it describes.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from fdp_manual_build.checks.base import Level, Status
from fdp_manual_build.checks.c03_coverage import Expectation, expected_set
from fdp_manual_build.checks.c05_coverage_realistic import CLASSES, CoverageRealisticCheck, classify
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.model import Manual

from .factories import FakePdf, context


def expectation(**overrides: object) -> Expectation:
    """A quantity expectation, the kind every class of check #5 applies to."""
    defaults: dict[str, object] = {
        "category": "parameter_value",
        "key": "cut_in_pressure.min",
        "location": "spec/settings.yaml#/settings/cut_in_pressure/min",
        "spellings": ("5 bar", "5.0 bar"),
        "number": "5",
        "symbol": "bar",
        "anchor": "setting:cut_in_pressure",
    }
    return Expectation(**{**defaults, **overrides})  # type: ignore[arg-type]


@pytest.fixture
def variant(mini_config: BuildConfig) -> object:
    """The realistic variant of the mini fixture, with its ``prose_only`` list."""
    return mini_config.variant("realistic")


def test_a_needle_found_only_in_a_column_half_is_interleaving(variant: object) -> None:
    pdf = FakePdf(["nothing readable here"], halves={1: ("5 bar in the left column", "")})
    assert classify(pdf, expectation(), variant) == "two_column_interleave"


def test_a_number_split_from_its_unit_by_the_conversion_is_imperial(
    variant: object,
) -> None:
    pdf = FakePdf(["the setting is 5 (72.5 psi) bar in this line"])
    assert classify(pdf, expectation(), variant) == "imperial_split"


def test_an_anchor_the_variant_keeps_out_of_its_tables_is_named(variant: object) -> None:
    pdf = FakePdf(["nothing at all"])
    assert classify(pdf, expectation(), variant) == "prose_only_fact"


def test_anything_else_is_unknown(variant: object) -> None:
    pdf = FakePdf(["nothing at all"])
    assert classify(pdf, expectation(anchor=""), variant) == "unknown"
    assert classify(pdf, expectation(), None) == "unknown"


def test_every_class_of_the_plan_is_reachable() -> None:
    assert CLASSES == (
        "two_column_interleave",
        "imperial_split",
        "prose_only_fact",
        "unknown",
    )


def test_the_check_reports_its_misses_and_never_fails(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    pdf = FakePdf(["a document that prints nothing of the model"], name="mini-realistic.pdf")
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        pdfs={"realistic": pdf},
    )
    result = CoverageRealisticCheck().run(ctx)
    assert result.status is Status.REPORT
    assert not result.failed
    assert result.metrics["found"] == 0
    assert result.metrics["expected"] == len(expected_set(mini_manual))
    misses = [item for item in result.findings if item.code.startswith("coverage.missing_")]
    assert len(misses) == result.metrics["expected"]
    assert {item.level for item in misses} == {Level.REPORT}
    assert {item.data["class"] for item in misses} <= set(CLASSES)


def test_a_complete_document_reports_the_row_recovery_too(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    body = " ".join(item.needle for item in expected_set(mini_manual))
    pdf = FakePdf(
        [f"8 Problem solving\n{body}", "9 Technical data and signal list"],
        tables={1: [[["oil_temperature_high", "oil_cooler_fouled", "", "cooling"]]]},
        name="mini-realistic.pdf",
    )
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        pdfs={"realistic": pdf},
    )
    result = CoverageRealisticCheck().run(ctx)
    assert result.status is Status.REPORT
    assert result.metrics["coverage_pct"] == 100.0
    assert result.metrics["rows_expected"] > result.metrics["rows_recovered"] == 1
    assert "tables.row_not_recovered" in {item.code for item in result.findings}


def test_a_missing_pdf_is_reported_not_failed(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root, manual_root=mini_spec_dir, cfg=mini_config, manual=mini_manual
    )
    result = CoverageRealisticCheck().run(ctx)
    assert result.status is Status.REPORT
    assert [item.code for item in result.findings] == ["coverage.pdf_missing"]
