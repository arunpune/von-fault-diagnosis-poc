# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #3 — coverage of the clean PDF — MUST (docs/manual.md#acceptance-checks).

Everything the sources promise a reader must be in the extracted text of the
easy document: every fault id, condition id, tag id and controller message
code verbatim, and every threshold, programmable-setting bound, machine limit
and signal range as the templates print it. This module also owns the expected
set itself, because check #5 measures the same set on the hard document.

Three decisions this check makes:

* **Two spellings per quantity.** The generated tables print through
  :func:`fdp_manual_build.units.fmt_qty` (``10 bar``) while the manual's
  ``num()`` keeps the decimals of the authored literal (``10.0 bar``); both are the same
  fact, so an expectation carries both spellings and is found when either is.
* **A cell counts as text.** The expected set may be read from the cells the
  tables hold, because a narrow
  cell wraps a measuring range or a bound over two lines and pdfplumber reads a
  page line by line. A needle is therefore searched in the page text first and
  in the table cells second — the number and its unit are still one cell of one
  row. Single tokens get no such licence: an id or a message code that wraps is
  a layout fault, and the stylesheet is built so they never do.
* **Machine limits on a fixture tree.** ``machine.limits`` reach the reader
  through ``tables.technical_data()``, which the shipping chapter 9 calls and
  the mini fixture's does not (it prints the signal list alone). Under
  :attr:`~fdp_manual_build.checks.base.Profile.FIXTURE` that category is
  therefore reported instead of enforced, the way the delegated whole-catalog
  rules already are; ``full`` enforces it.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final

from fdp_manual_build.checks.base import BaseCheck, Finding, Level, Profile
from fdp_manual_build.checks.pdftext import PdfText, normalize
from fdp_manual_build.model import (
    Alarm,
    Cause,
    Condition,
    Machine,
    Manual,
    Parameter,
    Quantity,
    SettingRef,
    Signal,
    Span,
)
from fdp_manual_build.units import EN_DASH, fmt_qty, natural_decimals, qty_range, unit_symbol

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.checks.base import CheckContext, CheckResult

__all__ = [
    "CATEGORIES",
    "FIXTURE_REPORT_CATEGORIES",
    "CoverageCleanCheck",
    "Expectation",
    "Outcome",
    "expected_set",
    "measure",
]

#: Expected-set categories, in the order the metrics list them.
CATEGORIES: Final[tuple[str, ...]] = (
    "fault_id",
    "condition_id",
    "tag_id",
    "alarm_code",
    "alarm_threshold",
    "parameter_value",
    "machine_limit",
    "signal_range",
)

#: Categories a deliberately tiny manual tree cannot print (see the docstring).
FIXTURE_REPORT_CATEGORIES: Final[frozenset[str]] = frozenset({"machine_limit"})

#: Where an expectation was found, for the report and for #5's classification.
_IN_TEXT: Final = "text"
_IN_CELL: Final = "cell"


@dataclass(frozen=True)
class Expectation:
    """One string the manual must print, with every spelling that counts.

    Attributes:
        category: one of :data:`CATEGORIES`.
        key: the identifier the value belongs to, for the message.
        location: the source pointer a reader follows to fix a miss.
        spellings: the accepted renderings; the first one is the canonical
            spelling the message quotes.
        number: the bare number of a quantity, when this is one.
        symbol: the printed unit symbol of a quantity, when this is one.
        anchor: the fact-placement anchor of ``build.yaml``'s ``prose_only`` and
            ``table_only`` lists, when the value has one. A variant that keeps
            an anchor out of its tables prints only the default in the prose,
            so check #5 classifies such a miss instead of counting it as an
            extraction difficulty.
    """

    category: str
    key: str
    location: str
    spellings: tuple[str, ...]
    number: str = ""
    symbol: str = ""
    anchor: str = ""

    @property
    def needle(self) -> str:
        """The canonical spelling, the one a finding quotes."""
        return self.spellings[0]


@dataclass(frozen=True)
class Outcome:
    """What one expectation did in one document."""

    expectation: Expectation
    page: int | None
    where: str

    @property
    def found(self) -> bool:
        """Whether the document holds this expectation at all."""
        return self.page is not None


def expected_set(manual: Manual) -> tuple[Expectation, ...]:
    """Build the expected set ``E`` of check #3 from the mapped model."""
    items: list[Expectation] = []
    items += [_cause(cause) for cause in manual.causes.values()]
    items += [_condition(condition) for condition in manual.conditions]
    items += [_tag(signal) for signal in manual.signals]
    items += [_code(alarm) for alarm in manual.alarms]
    items += [item for alarm in manual.alarms for item in _threshold(manual, alarm)]
    items += [item for parameter in manual.parameters for item in _parameter(parameter)]
    items += list(_limits(manual.machine))
    items += [item for signal in manual.signals for item in _range(signal)]
    return tuple(items)


def measure(pdf: PdfText, expectations: Iterable[Expectation]) -> tuple[Outcome, ...]:
    """Look every expectation up in ``pdf``, page text first, cells second."""
    return tuple(_locate(pdf, item) for item in expectations)


class CoverageCleanCheck(BaseCheck):
    """Every promise of the sources is in the text of the clean PDF."""

    number = 3
    id = "coverage.clean"
    title = "Coverage, clean PDF"
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
        """Measure the expected set and the two cheap renderer assertions."""
        manual = ctx.manual
        pdf = ctx.pdfs.get(self.variant)
        if manual is None or pdf is None:
            return [_no_pdf(self.variant, ctx.variant_dir)], {"expected": 0, "found": 0}
        outcomes = measure(pdf, expected_set(manual))
        findings = [_miss(outcome, ctx.profile) for outcome in outcomes if not outcome.found]
        findings += _blank_pages(pdf)
        findings += _page_budget(ctx, pdf)
        return findings, _metrics(outcomes, pdf)


# --- the expected set -------------------------------------------------------


def _cause(cause: Cause) -> Expectation:
    return Expectation(
        category="fault_id",
        key=cause.fault_id,
        location=f"spec/faults.yaml#/causes/{cause.fault_id}",
        spellings=(cause.fault_id,),
    )


def _condition(condition: Condition) -> Expectation:
    return Expectation(
        category="condition_id",
        key=condition.id,
        location=f"spec/faults.yaml#/conditions/{condition.id}",
        spellings=(condition.id,),
    )


def _tag(signal: Signal) -> Expectation:
    return Expectation(
        category="tag_id",
        key=signal.id,
        location=f"spec/signals.yaml#/signals/{signal.id}",
        spellings=(signal.id,),
    )


def _code(alarm: Alarm) -> Expectation:
    return Expectation(
        category="alarm_code",
        key=alarm.code,
        location=f"spec/alarms.yaml#/alarms/{alarm.code}",
        spellings=(alarm.code,),
    )


def _threshold(manual: Manual, alarm: Alarm) -> list[Expectation]:
    """The threshold the message list prints, resolved the way ``thr()`` does."""
    condition = alarm.trigger.condition
    if condition is None or not condition.leaves:
        return []
    leaf = condition.leaves[0]
    resolved = _resolve(manual, leaf.threshold)
    if resolved is None:
        return []
    value, unit, decimals = resolved
    unit = _signal_unit(manual, leaf.signal, unit)
    origin = _Origin(
        category="alarm_threshold",
        key=alarm.code,
        location=f"spec/alarms.yaml#/alarms/{alarm.code}/trigger/condition/threshold",
    )
    return [_quantity(origin, value, unit, decimals=decimals)]


def _resolve(manual: Manual, threshold: Quantity | SettingRef) -> tuple[float, str, int] | None:
    """``(value, unit, authored decimals)`` of a literal or a setting reference."""
    if isinstance(threshold, Quantity):
        return threshold.value, threshold.unit, natural_decimals(threshold.value)
    try:
        parameter = manual.parameter(threshold.setting)
    except KeyError:
        return None
    decimals = max(natural_decimals(threshold.offset), natural_decimals(parameter.default))
    return parameter.default + threshold.offset, parameter.unit, decimals


def _signal_unit(manual: Manual, signal_id: str, fallback: str) -> str:
    """The compared tag's unit, which is the one the message list prints."""
    try:
        return manual.signal(signal_id).unit
    except KeyError:
        return fallback


def _parameter(parameter: Parameter) -> list[Expectation]:
    """The three bounds of one programmable setting, each with its unit."""
    return [
        _quantity(
            _Origin(
                category="parameter_value",
                key=f"{parameter.id}.{name}",
                location=f"spec/settings.yaml#/settings/{parameter.id}/{name}",
                anchor=f"setting:{parameter.id}",
            ),
            value,
            parameter.unit,
        )
        for name, value in (
            ("min", parameter.min),
            ("default", parameter.default),
            ("max", parameter.max),
        )
    ]


def _limits(machine: Machine) -> Iterable[Expectation]:
    """Every ``machine.limits`` entry, a quantity or an inclusive span."""
    for key, value in machine.limits.items():
        origin = _Origin(
            category="machine_limit",
            key=key,
            location=f"spec/machine.yaml#/limits/{key}",
            anchor=f"machine.limits.{key}",
        )
        if isinstance(value, Span):
            yield _span(origin, value.min, value.max, value.unit)
        else:
            yield _quantity(origin, value.value, value.unit)


def _range(signal: Signal) -> list[Expectation]:
    """The measuring range of one tag, as ``qty_range`` prints it."""
    if signal.range is None:
        return []
    origin = _Origin(
        category="signal_range",
        key=signal.id,
        location=f"spec/signals.yaml#/signals/{signal.id}/range",
    )
    return [_span(origin, signal.range.min, signal.range.max, signal.unit)]


@dataclass(frozen=True)
class _Origin:
    """Where an expectation comes from, so the builders stay two-argument."""

    category: str
    key: str
    location: str
    anchor: str = ""


def _quantity(origin: _Origin, value: float, unit: str, decimals: int | None = None) -> Expectation:
    """One quantity with both accepted spellings (see the module docstring)."""
    symbol = unit_symbol(unit)
    spellings = [fmt_qty(value, unit)]
    authored = sorted({natural_decimals(value), decimals if decimals is not None else 0})
    spellings += [fmt_qty(value, unit, decimals=places) for places in authored]
    return Expectation(
        category=origin.category,
        key=origin.key,
        location=origin.location,
        spellings=_unique(spellings),
        number=spellings[0].removesuffix(f" {symbol}") if symbol else spellings[0],
        symbol=symbol,
        anchor=origin.anchor,
    )


def _span(origin: _Origin, low: float, high: float, unit: str) -> Expectation:
    """One inclusive range, with the dash and wrap variants check #3 tolerates."""
    canonical = qty_range(low, high, unit)
    spellings = [canonical]
    for dash in (EN_DASH, "-"):
        broken = canonical.replace(EN_DASH, dash)
        spellings += [broken, broken.replace(dash, f"{dash} ", 1)]
    return Expectation(
        category=origin.category,
        key=origin.key,
        location=origin.location,
        spellings=_unique(spellings),
        anchor=origin.anchor,
    )


def _unique(spellings: Sequence[str]) -> tuple[str, ...]:
    """The spellings without duplicates, first occurrence wins."""
    seen: dict[str, None] = {}
    for spelling in spellings:
        seen.setdefault(normalize(spelling), None)
    return tuple(seen)


# --- measuring --------------------------------------------------------------


def _locate(pdf: PdfText, expectation: Expectation) -> Outcome:
    for spelling in expectation.spellings:
        page = pdf.page_of(spelling)
        if page is not None:
            return Outcome(expectation=expectation, page=page, where=_IN_TEXT)
    for spelling in expectation.spellings:
        page = pdf.cell_page_of(spelling)
        if page is not None:
            return Outcome(expectation=expectation, page=page, where=_IN_CELL)
    return Outcome(expectation=expectation, page=None, where="")


def _miss(outcome: Outcome, profile: Profile) -> Finding:
    expectation = outcome.expectation
    demoted = profile is Profile.FIXTURE and expectation.category in FIXTURE_REPORT_CATEGORIES
    return Finding(
        code=f"coverage.missing_{expectation.category}",
        message=(
            f"{expectation.key}: the manual does not print {expectation.needle!r} "
            f"(tried {len(expectation.spellings)} spelling(s))"
        ),
        location=expectation.location,
        level=Level.REPORT if demoted else Level.MUST,
        data={
            "category": expectation.category,
            "key": expectation.key,
            "spellings": list(expectation.spellings),
        },
    )


def _blank_pages(pdf: PdfText) -> list[Finding]:
    return [
        Finding(
            code="coverage.blank_page",
            message=f"page {number} of {pdf.path.name} has no extracted text",
            location=f"{pdf.path.name} p.{number}",
            level=Level.MUST,
            data={"page": number},
        )
        for number in pdf.blank_pages()
    ]


def _page_budget(ctx: CheckContext, pdf: PdfText) -> list[Finding]:
    cfg = ctx.cfg
    if cfg is None:
        return []
    budget = cfg.pdf.page_budget
    if budget.min <= pdf.page_count <= budget.max:
        return []
    return [
        Finding(
            code="coverage.page_budget",
            message=(
                f"{pdf.path.name} has {pdf.page_count} pages, outside the budget "
                f"{budget.min}-{budget.max}"
            ),
            location=str(cfg.path),
            level=Level.MUST,
            data={"pages": pdf.page_count, "min": budget.min, "max": budget.max},
        )
    ]


def _metrics(outcomes: Sequence[Outcome], pdf: PdfText) -> dict[str, float | int | str]:
    found = [outcome for outcome in outcomes if outcome.found]
    metrics: dict[str, float | int | str] = {
        "expected": len(outcomes),
        "found": len(found),
        "coverage_pct": round(100.0 * len(found) / len(outcomes), 2) if outcomes else 100.0,
        "from_cells": sum(1 for outcome in found if outcome.where == _IN_CELL),
        "pages": pdf.page_count,
    }
    for category in CATEGORIES:
        total = sum(1 for outcome in outcomes if outcome.expectation.category == category)
        hits = sum(1 for outcome in found if outcome.expectation.category == category)
        if total:
            metrics[category] = f"{hits}/{total}"
    return metrics


def _no_pdf(variant: str, variant_dir: Path) -> Finding:
    return Finding(
        code="coverage.pdf_missing",
        message=f"{variant}: no built PDF under {variant_dir}; run `make manual` first",
        location=str(variant_dir),
        level=Level.MUST,
    )


def imperial_split(pdf: PdfText, expectation: Expectation) -> bool:
    """Whether the number and its unit are separated by an imperial value.

    ``qty()`` prints ``10 bar (145 psi)`` in the realistic variant; when a line
    break lands inside that, the page text can hold the number and the symbol
    with the conversion between them and the SI needle is not a substring of
    either. Check #5 reports such a miss as ``imperial_split`` rather than as a
    real gap.
    """
    if not expectation.number or not expectation.symbol:
        return False
    pattern = re.compile(
        rf"{re.escape(expectation.number)}\s*\([^)]*\)\s*{re.escape(expectation.symbol)}"
    )
    return any(pattern.search(text) is not None for text in pdf.normalized_pages)
