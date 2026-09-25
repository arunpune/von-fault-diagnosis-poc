# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #2 — referential integrity — MUST (docs/manual.md#acceptance-checks).

Adapter over the manual's validators. ``validate.py`` resolves the
reference table of check #2 (R1), the condition and cause graph (R2), message
reachability (R3), setting use (R4) and the service-message pairing (R5);
``content_checks.py`` resolves the cross-references, anchors, macros, fact
placement and figures of the rendered text (C1-C3, C5, C6).

Per check #2 an orphan message (R3) and an unused setting (R4) are listed but do
not fail the run.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Final

from fdp_manual_build.checks.base import BaseCheck, Finding, Level
from fdp_manual_build.checks.mantools import (
    content_checks_run,
    map_rules,
    tool_error,
    validate_run,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.checks.base import CheckContext

__all__ = ["IntegrityCheck"]

#: validate.py rule → finding code; ``report:`` marks an informative rule.
SPEC_CODES: Final[Mapping[str, str]] = {
    "R1": "integrity.missing_reference",
    "R2": "integrity.orphan_cause",
    "R3": "report:integrity.orphan_alarm",
    "R4": "report:integrity.unused_setting",
    "R5": "integrity.service_message",
}
#: content_checks.py rule → finding code.
TEXT_CODES: Final[Mapping[str, str]] = {
    "C1": "integrity.unknown_xref",
    "C2": "integrity.missing_anchor",
    "C3": "integrity.macro_count",
    "C5": "integrity.fact_placement",
    "C6": "integrity.figure",
}


class IntegrityCheck(BaseCheck):
    """Every reference resolves and nothing in the catalog is orphaned."""

    number = 2
    id = "integrity"
    title = "Referential integrity"
    level = Level.MUST

    def evaluate(
        self, ctx: CheckContext
    ) -> tuple[Sequence[Finding], Mapping[str, float | int | str]]:
        """Collect the manual's R1-R5 and, when the text was checked, C1-C6 lines."""
        spec = validate_run(ctx)
        text = content_checks_run(ctx)
        findings: list[Finding] = []
        failure = tool_error(spec, "integrity.tool_error")
        if failure is not None:
            findings.append(failure)
        findings += map_rules(spec, SPEC_CODES)
        findings += map_rules(text, TEXT_CODES)
        if text.skipped is not None:
            findings.append(
                Finding(
                    code="integrity.content_rules_skipped",
                    message=f"rules C1-C6 were not run: {text.skipped}",
                    location=str(ctx.manual_root),
                    level=Level.REPORT,
                )
            )
        return findings, {
            "references": _references(ctx),
            "missing": sum(1 for item in findings if item.level is Level.MUST),
            "orphan_causes": _count(findings, "integrity.orphan_cause"),
            "orphan_alarms": _count(findings, "integrity.orphan_alarm"),
            "unused_settings": _count(findings, "integrity.unused_setting"),
            "content_rules": "checked" if text.ran else "skipped",
        }


def _count(findings: Sequence[Finding], code: str) -> int:
    return sum(1 for finding in findings if finding.code == code)


def _references(ctx: CheckContext) -> int:
    """How many cross-document references rule R1 had to resolve."""
    manual = ctx.manual
    if manual is None:
        return 0
    total = len(manual.alarms) + sum(1 for item in manual.parameters if item.signal is not None)
    total += sum(len(item.alarms) + len(item.causes) for item in manual.conditions)
    total += sum(len(item.maintenance) + len(item.parts) for item in manual.causes.values())
    total += sum(len(item.related_causes) + len(item.components) for item in manual.maintenance)
    return total
