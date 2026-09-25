# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #5 — coverage of the realistic PDF — REPORT (docs/manual.md#acceptance-checks).

The same expected set as check #3 and the same table recovery as check #4,
measured on the hard document. The status is always ``report``: a miss here
is never fixed by simplifying the layout, because the
point of the realistic variant is to measure how hard a real manual is to read
back. What the report has to carry is therefore *why* each miss happened.

Four classes, the three check #5 names plus one of its own:

``two_column_interleave``
    the needle comes back when the page is re-extracted from its left or right
    half, so only the line-by-line read of a two-column page lost it;
``imperial_split``
    the number and its unit are in the text with the imperial conversion
    between them (``10 bar (145 psi)`` broken over a line);
``prose_only_fact``
    ``build.yaml`` keeps this anchor out of the realistic tables, so the
    variant prints the default in the prose and states no bound at all. That is
    a deliberate variant difference, not an extraction difficulty, and calling
    it ``unknown`` would hide the one class a reader can act on;
``unknown``
    everything else.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Final

from fdp_manual_build.checks.base import BaseCheck, Finding, Level
from fdp_manual_build.checks.c03_coverage import (
    Expectation,
    Outcome,
    expected_set,
    imperial_split,
    measure,
)
from fdp_manual_build.checks.c04_tables import recover
from fdp_manual_build.checks.pdftext import PdfText

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.checks.base import CheckContext, CheckResult
    from fdp_manual_build.config import VariantConfig

__all__ = ["CLASSES", "CoverageRealisticCheck", "classify"]

#: The miss classes this check reports, most specific first.
CLASSES: Final[tuple[str, ...]] = (
    "two_column_interleave",
    "imperial_split",
    "prose_only_fact",
    "unknown",
)


def classify(pdf: PdfText, expectation: Expectation, variant: VariantConfig | None) -> str:
    """Name the likely reason ``expectation`` is not in ``pdf``."""
    if any(pdf.in_any_half(spelling) is not None for spelling in expectation.spellings):
        return "two_column_interleave"
    if imperial_split(pdf, expectation):
        return "imperial_split"
    if variant is not None and expectation.anchor and not variant.fact_in_table(expectation.anchor):
        return "prose_only_fact"
    return "unknown"


class CoverageRealisticCheck(BaseCheck):
    """How much of the manual survives the hard layout — measured, never failed."""

    number = 5
    id = "coverage.realistic"
    title = "Coverage, realistic PDF"
    level = Level.REPORT
    variant = "realistic"

    def run(self, ctx: CheckContext) -> CheckResult:
        """Skip with a reason when the PDF is absent and it is not required."""
        if self.variant not in ctx.pdfs and not ctx.require_pdf:
            return self.skipped(
                f"{self.variant}: no built PDF under {ctx.variant_dir} (--no-require-pdf)",
                code="check.pdf_absent",
            )
        return super().run(ctx)

    def evaluate(
        self, ctx: CheckContext
    ) -> tuple[Sequence[Finding], Mapping[str, float | int | str]]:
        """Measure coverage and row recovery, and classify every miss."""
        manual, cfg = ctx.manual, ctx.cfg
        pdf = ctx.pdfs.get(self.variant)
        if manual is None or cfg is None or pdf is None:
            return [
                Finding(
                    code="coverage.pdf_missing",
                    message=f"{self.variant}: no built PDF under {ctx.variant_dir}",
                    location=str(ctx.variant_dir),
                    level=Level.REPORT,
                )
            ], {"expected": 0, "found": 0}
        variant = cfg.variants.get(self.variant)
        outcomes = measure(pdf, expected_set(manual))
        classified = [
            (outcome, classify(pdf, outcome.expectation, variant))
            for outcome in outcomes
            if not outcome.found
        ]
        findings = [_miss(outcome, miss_class) for outcome, miss_class in classified]
        recovery = recover(pdf, cfg, manual)
        metrics = _metrics(outcomes, classified, pdf)
        if recovery is None:
            findings.append(
                Finding(
                    code="tables.chapter_not_found",
                    message=f"{pdf.path.name}: chapter 8 never opens, so no row was measured",
                    location=pdf.path.name,
                    level=Level.REPORT,
                )
            )
            return findings, metrics
        metrics |= {
            "rows_expected": len(recovery.expected),
            "rows_recovered": len(recovery.recovered),
            "rows_recovery_pct": recovery.percent,
        }
        findings += [
            Finding(
                code="tables.row_not_recovered",
                message=f"the row ({condition}, {fault}) did not come back as a table row",
                location=f"{pdf.path.name} pp.{recovery.pages[0]}-{recovery.pages[-1]}",
                level=Level.REPORT,
                data={"condition": condition, "fault": fault},
            )
            for condition, fault in recovery.missing
        ]
        return findings, metrics


def _miss(outcome: Outcome, miss_class: str) -> Finding:
    expectation = outcome.expectation
    return Finding(
        code=f"coverage.missing_{expectation.category}",
        message=(
            f"{expectation.key}: the realistic variant does not print "
            f"{expectation.needle!r} ({miss_class})"
        ),
        location=expectation.location,
        level=Level.REPORT,
        data={
            "category": expectation.category,
            "key": expectation.key,
            "class": miss_class,
            "spellings": list(expectation.spellings),
        },
    )


def _metrics(
    outcomes: Sequence[Outcome],
    classified: Sequence[tuple[Outcome, str]],
    pdf: PdfText,
) -> dict[str, float | int | str]:
    found = len(outcomes) - len(classified)
    metrics: dict[str, float | int | str] = {
        "expected": len(outcomes),
        "found": found,
        "coverage_pct": round(100.0 * found / len(outcomes), 2) if outcomes else 100.0,
        "pages": pdf.page_count,
    }
    for name in CLASSES:
        count = sum(1 for _, miss_class in classified if miss_class == name)
        if count:
            metrics[name] = count
    return metrics
