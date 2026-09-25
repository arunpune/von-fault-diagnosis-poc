# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #1 — schema validation — MUST (docs/manual.md#acceptance-checks).

Adapter over the manual's validators: S1 is the JSON Schema pass, S2
the uniqueness of every identifier, code, bit and label, L1 the SPDX headers of
the sources and N1 the bare-number lint of the prose. The loader's own errors
are added because they are source errors too.

So are the Jinja errors of the YAML text fields. Every ``*_md`` field of the
model is a template in the manual's namespace, so an unknown ``xref``, ``alarm`` or
``signal``, a ``StrictUndefined`` name or a bare number printed without
``num()`` is a source error that only shows when the field is resolved — check #1
lists exactly those. This check therefore resolves the model once, for the
default variant, and reports a failure as ``schema.jinja`` instead of letting
``make manual`` be the first thing that notices.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Final

import jinja2

from fdp_manual_build.build import read_sources
from fdp_manual_build.checks.base import BaseCheck, Finding, Level
from fdp_manual_build.checks.mantools import (
    content_checks_run,
    map_rules,
    tool_error,
    validate_run,
)
from fdp_manual_build.errors import BuildError
from fdp_manual_build.templating import make_templating

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.checks.base import CheckContext

__all__ = ["SchemaCheck"]

#: validate.py rule → the finding code this check reports it under.
SPEC_CODES: Final[Mapping[str, str]] = {
    "S1": "schema.invalid",
    "S2": "schema.duplicate_id",
    "L1": "schema.license_header",
}
#: content_checks.py rule → finding code (bare numbers in prose are check #1).
TEXT_CODES: Final[Mapping[str, str]] = {"N1": "schema.bare_number"}


class SchemaCheck(BaseCheck):
    """Every source document validates and every identifier is unique."""

    number = 1
    id = "schema"
    title = "Schema validation"
    level = Level.MUST

    def evaluate(
        self, ctx: CheckContext
    ) -> tuple[Sequence[Finding], Mapping[str, float | int | str]]:
        """Collect the loader's errors and the manual's S1, S2, L1 and N1 lines."""
        spec = validate_run(ctx)
        text = content_checks_run(ctx)
        findings = [*ctx.load_errors]
        failure = tool_error(spec, "schema.tool_error")
        if failure is not None:
            findings.append(failure)
        findings += map_rules(spec, SPEC_CODES)
        findings += map_rules(text, TEXT_CODES)
        findings += _jinja(ctx)
        if text.skipped is not None:
            findings.append(
                Finding(
                    code="schema.number_lint_skipped",
                    message=f"rule N1 was not run: {text.skipped}",
                    location=str(ctx.manual_root),
                    level=Level.REPORT,
                )
            )
        manual = ctx.manual
        return findings, {
            "files": len(manual.source_hashes) if manual is not None else 0,
            "errors": sum(1 for finding in findings if finding.level is Level.MUST),
            "ids_checked": _ids_checked(ctx),
            "rules": (
                "S1, S2, L1"
                + (", N1" if text.ran else "")
                + (", jinja" if ctx.sections is not None else "")
            ),
        }


def _jinja(ctx: CheckContext) -> list[Finding]:
    """Resolve every ``*_md`` field once, and report what does not render.

    The outline is what binds ``xref`` and ``ref`` to a real heading, so the
    pass waits for every chapter partial; until then the loader has already
    said so with ``schema.partials_absent`` and there is nothing to add.
    """
    cfg, manual, sections = ctx.cfg, ctx.manual, ctx.sections
    if cfg is None or manual is None or sections is None:
        return []
    try:
        sources = read_sources(cfg, ctx.repo_root)
        rendering = make_templating(
            cfg, cfg.variant(cfg.default_variant), manual, sections, sources
        )
        rendering.resolve(manual)
    except (BuildError, jinja2.TemplateError) as error:
        return [
            Finding(
                code="schema.jinja",
                message=f"a source text field does not render: {error}",
                location=str(cfg.manual_root),
                level=Level.MUST,
                data={"variant": cfg.default_variant},
            )
        ]
    return []


def _ids_checked(ctx: CheckContext) -> int:
    """How many identifiers rule S2 had to keep apart."""
    manual = ctx.manual
    if manual is None:
        return 0
    return (
        len(manual.signals)
        + len(manual.alarms)
        + len(manual.conditions)
        + len(manual.causes)
        + len(manual.maintenance)
        + len(manual.parameters)
        + (len(ctx.sections) if ctx.sections is not None else 0)
    )
