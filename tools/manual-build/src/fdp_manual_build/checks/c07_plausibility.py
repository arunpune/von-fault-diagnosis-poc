# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #7 — physical plausibility — MUST (docs/manual.md#acceptance-checks).

Adapter over ``manual/tools/validate.py``. Its rules cover the
six of check #7 one for one: P1 the severity ordering inside a message family, P2
thresholds against signal ranges, P3 setting bounds and constraints, P4 the
head-room between a normal band and the thresholds above it, P5 dwell, start
mask and hysteresis, P6 the ambient limits and the document metadata. M2 adds
the register order and the Modbus scales and B1 that the bands really are the
derived ones.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Final

from fdp_manual_build.checks.base import BaseCheck, Finding, Level, Profile
from fdp_manual_build.checks.mantools import (
    CATALOG_SCALE_RULES,
    map_rules,
    rules_seen,
    tool_error,
    validate_run,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.checks.base import CheckContext

__all__ = ["PlausibilityCheck"]

#: validate.py rule → the finding code this check reports it under.
SPEC_CODES: Final[Mapping[str, str]] = {
    "P1": "plausibility.ordering",
    "P2": "plausibility.range",
    "P3": "plausibility.setting_bounds",
    "P4": "plausibility.band_headroom",
    "P5": "plausibility.timing",
    "P6": "plausibility.cross_quantity",
    "M2": "plausibility.modbus_scale",
    "B1": "plausibility.band_source",
}


class PlausibilityCheck(BaseCheck):
    """Nothing in the sources contradicts the physics of the machine."""

    number = 7
    id = "plausibility"
    title = "Physical plausibility"
    level = Level.MUST

    def evaluate(
        self, ctx: CheckContext
    ) -> tuple[Sequence[Finding], Mapping[str, float | int | str]]:
        """Collect the manual's P1-P6, M2 and B1 lines."""
        spec = validate_run(ctx)
        demoted = CATALOG_SCALE_RULES if ctx.profile is Profile.FIXTURE else frozenset()
        findings: list[Finding] = []
        failure = tool_error(spec, "plausibility.tool_error")
        if failure is not None:
            findings.append(failure)
        findings += map_rules(spec, SPEC_CODES, demoted=demoted)
        rules = tuple(SPEC_CODES)
        return findings, {
            "rules_evaluated": len(rules),
            "rules_violated": rules_seen(spec, rules),
            "violations": sum(1 for item in findings if item.level is Level.MUST),
            "reported": sum(1 for item in findings if item.level is Level.REPORT),
        }
