# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #4 — table recovery, clean PDF — MUST (docs/manual.md#acceptance-checks).

Chapter 8 is the chapter init has to read back out of the PDF, so it is
measured rather than assumed: every ``(condition id, fault id)`` pair the model
holds must come back as a row of a ruled table on the chapter's own pages.

The shape is fixed: each entry is an identification band row — condition id,
fault id, subsystem — and a detail row with the four prose columns. The band
carries the pair check #4 counts; the "Remedy" cell it asks about is on the
detail row below it, which is where :func:`_remedy` looks. Ids are the manual's
``snake_case`` registry ids, never ``F-\\d{3}``, so the row filter matches the
model's own ids instead of a pattern.

Check #5 reuses :func:`recover` to report the same measure on the realistic
variant.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Final

from fdp_manual_build.checks.base import BaseCheck, Finding, Level
from fdp_manual_build.checks.pdftext import PdfText
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.model import Manual

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.checks.base import CheckContext, CheckResult

__all__ = ["MINIMUM_RECOVERY", "Recovery", "TableRecoveryCheck", "expected_pairs", "recover"]

#: Check #4: at least this share of the printed rows must come back as rows.
MINIMUM_RECOVERY: Final = 0.90

#: Column index of the "Remedy" cell on a detail row (check #4).
_REMEDY_COLUMN: Final = 2
#: How far past a band row the detail row may sit: the two repeated header rows
#: of a page the table runs onto, then the detail row itself.
_LOOKAHEAD: Final = 3
#: Chapter the troubleshooting tables live in, and the one after it.
_CHAPTER: Final = 8
_NEXT_CHAPTER: Final = 9


@dataclass(frozen=True)
class Recovery:
    """What one variant's chapter 8 gave back."""

    expected: frozenset[tuple[str, str]]
    recovered: frozenset[tuple[str, str]]
    pages: tuple[int, ...]
    empty_remedies: tuple[tuple[str, str], ...] = field(default_factory=tuple)

    @property
    def percent(self) -> float:
        """Share of the expected pairs recovered, in percent."""
        if not self.expected:
            return 100.0
        return round(100.0 * len(self.recovered) / len(self.expected), 2)

    @property
    def missing(self) -> tuple[tuple[str, str], ...]:
        """The pairs no table row gave back, in a stable order."""
        return tuple(sorted(self.expected - self.recovered))


def expected_pairs(manual: Manual) -> frozenset[tuple[str, str]]:
    """Every ``(condition id, fault id)`` pair the manual prints as a row."""
    return frozenset(
        (condition.id, entry.fault_id)
        for condition in manual.conditions
        for entry in condition.causes
    )


def recover(pdf: PdfText, cfg: BuildConfig, manual: Manual) -> Recovery | None:
    """Read chapter 8 of ``pdf`` back into pairs, or ``None`` without a chapter.

    The chapter's pages run from the page that opens ``8 <title>`` to the page
    before the one that opens ``9 <title>``; both strings come from
    ``build.yaml``. A chapter that never opens means the document is not the
    manual, and the caller reports that instead of a recovery of zero.
    """
    pages = _chapter_pages(pdf, cfg)
    if pages is None:
        return None
    expected = expected_pairs(manual)
    rows = [row for table in pdf.rows_on(pages) for row in table]
    headers = _headers(rows, expected)
    recovered: set[tuple[str, str]] = set()
    empty: list[tuple[str, str]] = []
    for index, row in enumerate(rows):
        pairs = _pairs_in(row, expected)
        if not pairs:
            continue
        recovered |= pairs
        if not _remedy(rows, index, headers, expected):
            empty += sorted(pairs)
    return Recovery(
        expected=expected,
        recovered=frozenset(recovered),
        pages=tuple(pages),
        empty_remedies=tuple(empty),
    )


class TableRecoveryCheck(BaseCheck):
    """Chapter 8 of the clean PDF comes back out as rows, not as prose."""

    number = 4
    id = "tables.clean"
    title = "Table recovery, clean PDF"
    level = Level.MUST
    variant = "clean"

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
        """Measure the recovery rate of chapter 8 and the Remedy cells."""
        manual, cfg = ctx.manual, ctx.cfg
        pdf = ctx.pdfs.get(self.variant)
        if manual is None or cfg is None or pdf is None:
            return [
                Finding(
                    code="tables.pdf_missing",
                    message=(
                        f"{self.variant}: no built PDF under {ctx.variant_dir}; "
                        "run `make manual` first"
                    ),
                    location=str(ctx.variant_dir),
                    level=Level.MUST,
                )
            ], {"expected_rows": 0, "recovered_rows": 0}
        result = recover(pdf, cfg, manual)
        if result is None:
            return [_no_chapter(pdf, cfg)], {"expected_rows": len(expected_pairs(manual))}
        return _findings(result, pdf), _metrics(result)


def _chapter_pages(pdf: PdfText, cfg: BuildConfig) -> range | None:
    """1-based page numbers of chapter 8, or ``None`` when it never opens."""
    first = pdf.page_opening(_title(cfg, _CHAPTER))
    if first is None:
        return None
    stop = pdf.page_opening(_title(cfg, _NEXT_CHAPTER))
    return range(first, stop if stop is not None else pdf.page_count + 1)


def _title(cfg: BuildConfig, number: int) -> str:
    """``"8 Problem solving"``, the running title ``build.yaml`` fixes."""
    for chapter in cfg.chapters:
        if chapter.number == number:
            return f"{chapter.number} {chapter.title}"
    raise KeyError(f"build.yaml has no chapter {number}")  # pragma: no cover - config fixes ten


def _pairs_in(row: Sequence[str], expected: frozenset[tuple[str, str]]) -> set[tuple[str, str]]:
    """The expected pairs whose two ids are both cells of ``row``.

    Both layouts check #4 allows are accepted, because the test is set
    containment: the band row prints the condition id first and the fault id
    second, and a variant that swapped them would still be read.
    """
    cells = {cell for cell in row if cell}
    if not cells:
        return set()
    return {pair for pair in expected if cells.issuperset(pair)}


def _headers(
    rows: Sequence[Sequence[str]], expected: frozenset[tuple[str, str]]
) -> frozenset[tuple[str, ...]]:
    """The ``<thead>`` rows, which the stylesheet repeats on every page.

    They are the rows before the first identification band, and the same rows
    come back at the top of each page the table runs onto — between the band of
    the entry the page break split and its detail row.
    """
    header: list[tuple[str, ...]] = []
    for row in rows:
        if _pairs_in(row, expected):
            break
        header.append(tuple(row))
    return frozenset(header)


def _remedy(
    rows: Sequence[Sequence[str]],
    band: int,
    headers: frozenset[tuple[str, ...]],
    expected: frozenset[tuple[str, str]],
) -> str:
    """The Remedy cell of the detail row that belongs to the band at ``band``.

    A repeated header may sit between the two rows of one entry, so the search
    walks past a header row; it stops at the next band, because an entry whose
    band is followed by another band printed no detail row at all.
    """
    for row in rows[band + 1 : band + 1 + _LOOKAHEAD]:
        if tuple(row) in headers:
            continue
        if _pairs_in(row, expected):
            return ""
        return row[_REMEDY_COLUMN] if len(row) > _REMEDY_COLUMN else ""
    return ""


def _findings(result: Recovery, pdf: PdfText) -> list[Finding]:
    findings: list[Finding] = []
    if result.percent < MINIMUM_RECOVERY * 100:
        findings.append(
            Finding(
                code="tables.recovery_below_floor",
                message=(
                    f"{result.percent:.1f} % of the {len(result.expected)} printed rows came "
                    f"back as table rows, below the {MINIMUM_RECOVERY:.0%} floor"
                ),
                location=f"{pdf.path.name} pp.{result.pages[0]}-{result.pages[-1]}",
                level=Level.MUST,
                data={"missing": [list(pair) for pair in result.missing]},
            )
        )
    findings += [
        Finding(
            code="tables.row_not_recovered",
            message=f"the row ({condition}, {fault}) did not come back as a table row",
            location=f"{pdf.path.name} pp.{result.pages[0]}-{result.pages[-1]}",
            level=Level.REPORT,
            data={"condition": condition, "fault": fault},
        )
        for condition, fault in result.missing
    ]
    findings += [
        Finding(
            code="tables.empty_cell",
            message=f"the Remedy cell of ({condition}, {fault}) came back empty",
            location=f"{pdf.path.name} pp.{result.pages[0]}-{result.pages[-1]}",
            level=Level.REPORT,
            data={"condition": condition, "fault": fault},
        )
        for condition, fault in result.empty_remedies
    ]
    return findings


def _metrics(result: Recovery) -> dict[str, float | int | str]:
    return {
        "expected_rows": len(result.expected),
        "recovered_rows": len(result.recovered),
        "recovery_pct": result.percent,
        "pages_scanned": len(result.pages),
        "empty_remedies": len(result.empty_remedies),
    }


def _no_chapter(pdf: PdfText, cfg: BuildConfig) -> Finding:
    return Finding(
        code="tables.chapter_not_found",
        message=(
            f"{pdf.path.name}: no page opens the chapter {_title(cfg, _CHAPTER)!r}, "
            "so the troubleshooting tables could not be located"
        ),
        location=pdf.path.name,
        level=Level.MUST,
    )
