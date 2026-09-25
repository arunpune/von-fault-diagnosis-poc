# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #8 — diagnostic ambiguity — MUST (docs/manual.md#acceptance-checks).

Adapter over ``manual/tools/validate.py``: A1 the catalog
floors and the shared causes, A2 the subsystem coverage, A3 the benign causes,
A4 the distribution leak that must be listed under two conditions, A5 the
evidence and move vocabulary of every cause, and N2 the rule that a cause
describes a move in words and never in numbers.
"""

from __future__ import annotations

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

__all__ = ["AmbiguityCheck"]

#: validate.py rule → the finding code this check reports it under.
SPEC_CODES: Final[Mapping[str, str]] = {
    "A1": "ambiguity.catalog_size",
    "A2": "ambiguity.subsystem_coverage",
    "A3": "ambiguity.benign_causes",
    "A4": "ambiguity.single_leak_cause",
    "A5": "ambiguity.signal_moves",
    "N2": "ambiguity.bare_number",
}


class AmbiguityCheck(BaseCheck):
    """No symptom in the catalog has a single obvious cause."""

    number = 8
    id = "ambiguity"
    title = "Diagnostic ambiguity"
    level = Level.MUST

    def evaluate(
        self, ctx: CheckContext
    ) -> tuple[Sequence[Finding], Mapping[str, float | int | str]]:
        """Collect the manual's A1-A5 and N2 lines and count the catalog."""
        spec = validate_run(ctx)
        demoted = CATALOG_SCALE_RULES if ctx.profile is Profile.FIXTURE else frozenset()
        findings: list[Finding] = []
        failure = tool_error(spec, "ambiguity.tool_error")
        if failure is not None:
            findings.append(failure)
        findings += map_rules(spec, SPEC_CODES, demoted=demoted)
        manual = ctx.manual
        return findings, {
            "conditions": len(manual.conditions) if manual is not None else 0,
            "causes": len(manual.causes) if manual is not None else 0,
            "alarms": len(manual.alarms) if manual is not None else 0,
            "maintenance": len(manual.maintenance) if manual is not None else 0,
            "mapped_signals": _mapped(ctx),
            "benign_causes": _benign(ctx),
            "violations": sum(1 for item in findings if item.level is Level.MUST),
        }


def _mapped(ctx: CheckContext) -> int:
    manual = ctx.manual
    if manual is None:
        return 0
    return sum(1 for signal in manual.signals if signal.metropt_column is not None)


def _benign(ctx: CheckContext) -> int:
    manual = ctx.manual
    if manual is None:
        return 0
    return sum(1 for cause in manual.causes.values() if cause.benign)
