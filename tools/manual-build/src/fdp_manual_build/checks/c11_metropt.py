# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #11 — MetroPT-3 fit — MUST (docs/manual.md#acceptance-checks).

Adapter over ``manual/tools/validate.py``: M1 asserts that the fifteen
MetroPT-3 columns are mapped and B2 that the committed bands carry the
provenance of the verified CSV. On top of that this check owns the three
things the report row needs and the manual's rules do not cover: the
column-to-signal mapping table of rule 1 (group and unit per column), the
sha256 of the statistics file the bands were derived from, and the documented
dataset quirks of docs/dataset.md (rule 3, informative).

Rule 4 (the loaded/unloaded/off definition) reads the rendered clean PDF: one
page of it has to name the three machine states and the three tags a reader
tells them apart by — the intake command, the outlet valve and the motor
current. On a fixture tree the rule is reported rather than enforced, like the
other rules that judge the whole registry: the mini fixture maps one of those
three columns by design.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Final

from fdp_manual_build.checks.base import BaseCheck, Finding, Level, Profile
from fdp_manual_build.checks.mantools import (
    CATALOG_SCALE_RULES,
    map_rules,
    tool_error,
    validate_run,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.checks.base import CheckContext
    from fdp_manual_build.model import Signal

__all__ = [
    "METROPT_COLUMNS",
    "STATE_COLUMNS",
    "STATE_WORDS",
    "STATS_SOURCE_SHA256",
    "MetroptFitCheck",
]

#: sha256 of ``MetroPT3(AirCompressor).csv``; the statistics must come from it.
STATS_SOURCE_SHA256: Final = "db30ccb4ea402e3c8bf2c99db06e288d4f2a772f6928f9dbe26a920d69793e24"

#: Column → the signal group and unit it must map to (rule 1 of check #11).
METROPT_COLUMNS: Final[Mapping[str, tuple[str, str]]] = {
    "TP2": ("analog", "bar"),
    "TP3": ("analog", "bar"),
    "H1": ("analog", "bar"),
    "DV_pressure": ("analog", "bar"),
    "Reservoirs": ("analog", "bar"),
    "Oil_temperature": ("analog", "degC"),
    "Motor_current": ("analog", "A"),
    "COMP": ("digital", "bool"),
    "DV_eletric": ("digital", "bool"),
    "Towers": ("digital", "bool"),
    "MPG": ("digital", "bool"),
    "LPS": ("digital", "bool"),
    "Pressure_switch": ("digital", "bool"),
    "Oil_level": ("digital", "bool"),
    "Caudal_impulses": ("digital", "bool"),
}

#: validate.py rule → the finding code this check reports it under.
SPEC_CODES: Final[Mapping[str, str]] = {
    "M1": "metropt_fit.column_mapping",
    "B2": "metropt_fit.band_provenance",
}

#: The three machine states the normal bands are given per (rule 4 of check #11).
STATE_WORDS: Final[tuple[str, ...]] = ("loaded", "unloaded", "off")

#: The columns whose tags the state definition has to name: the intake command,
#: the outlet valve and the motor current (rule 4 of check #11).
STATE_COLUMNS: Final[tuple[str, ...]] = ("COMP", "DV_eletric", "Motor_current")

#: The variant rule 4 is read from; ``clean`` is the document with no columns.
_STATE_VARIANT: Final = "clean"

#: Column → the wording its description must carry for the dataset quirk (rule 3).
QUIRK_WORDING: Final[Mapping[str, re.Pattern[str]]] = {
    "Oil_level": re.compile(r"resting state .*\blevel\b", re.IGNORECASE | re.DOTALL),
    "Reservoirs": re.compile(r"equal to the line pressure|tracks? the line pressure", re.I),
    "MPG": re.compile(r"\bregulator\b.*\bload\b", re.IGNORECASE | re.DOTALL),
    "COMP": re.compile(r"\bintake\b.*\b(load|unload)", re.IGNORECASE | re.DOTALL),
}


class MetroptFitCheck(BaseCheck):
    """The signal registry really describes the MetroPT-3 recording."""

    number = 11
    id = "metropt_fit"
    title = "MetroPT-3 fit"
    level = Level.MUST

    def evaluate(
        self, ctx: CheckContext
    ) -> tuple[Sequence[Finding], Mapping[str, float | int | str]]:
        """Collect M1 and B2, then the mapping, provenance and quirk rules."""
        spec = validate_run(ctx)
        demoted = CATALOG_SCALE_RULES if ctx.profile is Profile.FIXTURE else frozenset()
        findings: list[Finding] = []
        failure = tool_error(spec, "metropt_fit.tool_error")
        if failure is not None:
            findings.append(failure)
        findings += map_rules(spec, SPEC_CODES, demoted=demoted)
        findings += _stats_provenance(ctx)
        by_column = _by_column(ctx)
        findings += _mapping(by_column, demoted=bool(demoted))
        findings += _quirks(by_column)
        findings += _state_logic(ctx, by_column, demoted=bool(demoted))
        return findings, {
            "columns_expected": len(METROPT_COLUMNS),
            "columns_mapped": len(by_column),
            "stats": ctx.stats_path.name,
            "violations": sum(1 for item in findings if item.level is Level.MUST),
        }


def _by_column(ctx: CheckContext) -> dict[str, list[Signal]]:
    """Every mapped signal, grouped by the MetroPT-3 column it claims."""
    grouped: dict[str, list[Signal]] = {}
    manual = ctx.manual
    for signal in () if manual is None else manual.signals:
        if signal.metropt_column is not None:
            grouped.setdefault(signal.metropt_column, []).append(signal)
    return grouped


def _mapping(by_column: Mapping[str, list[Signal]], *, demoted: bool) -> list[Finding]:
    """Rule 1 of check #11: one signal per column, with the right group and unit."""
    level = Level.REPORT if demoted else Level.MUST
    findings: list[Finding] = []
    for column, (group, unit) in METROPT_COLUMNS.items():
        signals = by_column.get(column, [])
        if not signals:
            findings.append(
                Finding(
                    code="metropt_fit.unmapped_column",
                    message=f"column {column!r} is mapped by no signal",
                    location="spec/signals.yaml#/signals",
                    level=level,
                    data={"column": column},
                )
            )
            continue
        if len(signals) > 1:
            listed = ", ".join(signal.id for signal in signals)
            findings.append(
                Finding(
                    code="metropt_fit.duplicate_mapping",
                    message=f"column {column!r} is mapped by {len(signals)} signals: {listed}",
                    location="spec/signals.yaml#/signals",
                    level=Level.MUST,
                    data={"column": column, "signals": [signal.id for signal in signals]},
                )
            )
        findings += _shape(column, signals[0], group, unit)
    for column in sorted(set(by_column) - set(METROPT_COLUMNS)):
        findings.append(
            Finding(
                code="metropt_fit.unknown_column",
                message=(
                    f"{by_column[column][0].id} claims column {column!r}, "
                    "which the MetroPT-3 CSV has not"
                ),
                location="spec/signals.yaml#/signals",
                level=Level.MUST,
                data={"column": column},
            )
        )
    return findings


def _shape(column: str, signal: Signal, group: str, unit: str) -> list[Finding]:
    findings: list[Finding] = []
    if signal.group != group:
        findings.append(
            Finding(
                code="metropt_fit.column_group",
                message=f"column {column!r} is {group}, but {signal.id} is {signal.group}",
                location=f"spec/signals.yaml#/signals/{signal.id}/group",
                level=Level.MUST,
                data={"column": column, "expected": group, "found": signal.group},
            )
        )
    if signal.unit != unit:
        findings.append(
            Finding(
                code="metropt_fit.column_unit",
                message=f"column {column!r} is in {unit}, but {signal.id} is in {signal.unit}",
                location=f"spec/signals.yaml#/signals/{signal.id}/unit",
                level=Level.MUST,
                data={"column": column, "expected": unit, "found": signal.unit},
            )
        )
    return findings


def _quirks(by_column: Mapping[str, list[Signal]]) -> list[Finding]:
    """Rule 3 of check #11: the documented quirks are stated in the descriptions."""
    findings: list[Finding] = []
    for column, pattern in QUIRK_WORDING.items():
        signals = by_column.get(column, [])
        if not signals:
            continue
        signal = signals[0]
        text = f"{signal.description_md} {signal.source_note or ''}"
        if pattern.search(text) is None:
            findings.append(
                Finding(
                    code="metropt_fit.quirk_wording",
                    message=(
                        f"{signal.id} does not state the documented dataset quirk "
                        f"for column {column!r} (looking for /{pattern.pattern}/)"
                    ),
                    location=f"spec/signals.yaml#/signals/{signal.id}/description",
                    level=Level.REPORT,
                    data={"column": column},
                )
            )
    return findings


def _state_logic(
    ctx: CheckContext, by_column: Mapping[str, list[Signal]], *, demoted: bool
) -> list[Finding]:
    """Rule 4 of check #11: one page of the clean PDF defines the three states.

    The page has to carry the three state words and name the three tags a
    technician tells the states apart by, so a reader of the manual alone can
    judge a reading against the right band.
    """
    level = Level.REPORT if demoted else Level.MUST
    pdf = ctx.pdfs.get(_STATE_VARIANT)
    if pdf is None:
        return [
            Finding(
                code="metropt_fit.state_logic_unchecked",
                message=(
                    f"rule 4 needs the built {_STATE_VARIANT} PDF; none was found under "
                    f"{ctx.variant_dir}"
                ),
                location=str(ctx.variant_dir),
                level=Level.REPORT,
            )
        ]
    tags = [signal for column in STATE_COLUMNS for signal in by_column.get(column, [])[:1]]
    if any(_defines_states(text, tags) for text in pdf.normalized_pages):
        return []
    named = ", ".join(signal.id for signal in tags) or "no mapped tag"
    return [
        Finding(
            code="metropt_fit.state_logic",
            message=(
                f"no page of {pdf.path.name} defines {', '.join(STATE_WORDS)} next to "
                f"{named}; chapter 6 or 9 has to state the machine states in words"
            ),
            location=pdf.path.name,
            level=level,
            data={"columns": list(STATE_COLUMNS), "tags": [signal.id for signal in tags]},
        )
    ]


def _defines_states(text: str, tags: Sequence[Signal]) -> bool:
    """Whether one page carries the three state words and all three tags."""
    if len(tags) < len(STATE_COLUMNS):
        return False
    lowered = text.lower()
    if not all(re.search(rf"\b{word}\b", lowered) for word in STATE_WORDS):
        return False
    return all(
        signal.id in text or signal.panel_label in text or signal.name.lower() in lowered
        for signal in tags
    )


def _stats_provenance(ctx: CheckContext) -> list[Finding]:
    """The statistics must carry the sha256 of the verified MetroPT-3 CSV."""
    source = ctx.stats.get("source", {})
    found = source.get("sha256") if isinstance(source, dict) else None
    if found == STATS_SOURCE_SHA256:
        return []
    return [
        Finding(
            code="metropt_fit.stats_source",
            message=(
                f"{ctx.stats_path.name} was derived from {found or 'an unrecorded file'}, "
                f"not from the verified CSV"
            ),
            location=str(ctx.stats_path),
            level=Level.MUST,
            data={"expected": STATS_SOURCE_SHA256, "found": found},
        )
    ]
