# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``reports/manual-check.json`` and ``.md``.

The JSON is complete and machine-readable; the Markdown is the artefact a
reviewer reads, so it caps each check at :data:`MARKDOWN_FINDING_CAP` findings
and says how many it left out.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from fdp_manual_build.checks.base import CheckResult, Finding, Level, Status

__all__ = [
    "EXIT_ERROR",
    "EXIT_FINDINGS",
    "EXIT_OK",
    "EXIT_SCHEMA",
    "MARKDOWN_FINDING_CAP",
    "REPORT_SCHEMA",
    "RunResult",
    "Summary",
    "summarise",
    "write_json",
    "write_markdown",
]

#: Exit codes of ``fdp-manual-check``.
EXIT_OK: Final = 0
EXIT_FINDINGS: Final = 1
EXIT_ERROR: Final = 2
EXIT_SCHEMA: Final = 3

#: The ``schema`` value of ``reports/manual-check.json``.
REPORT_SCHEMA: Final = "urn:fdp:report:manual-check:v1"
#: How many findings per check the Markdown report prints.
MARKDOWN_FINDING_CAP: Final = 200

_STATUS_MARK: Final[Mapping[Status, str]] = {
    Status.PASS: "pass",
    Status.FAIL: "FAIL",
    Status.REPORT: "report",
    Status.SKIPPED: "skipped",
    Status.ERROR: "ERROR",
}


@dataclass(frozen=True)
class Summary:
    """The counts the report's first line shows."""

    must_total: int
    must_passed: int
    report_total: int
    status: str
    exit_code: int

    def as_dict(self) -> dict[str, Any]:
        """The JSON shape of the summary block."""
        return {
            "must_total": self.must_total,
            "must_passed": self.must_passed,
            "report_total": self.report_total,
            "status": self.status,
            "exit_code": self.exit_code,
        }


@dataclass(frozen=True)
class RunResult:
    """Everything one ``fdp-manual-check`` run produced."""

    generated_at: str
    repo_root: Path
    manual_root: Path
    profile: str
    inputs: Mapping[str, Any]
    checks: tuple[CheckResult, ...]
    summary: Summary

    def check(self, number: int) -> CheckResult:
        """The result of check ``number``."""
        for result in self.checks:
            if result.number == number:
                return result
        raise KeyError(f"no check #{number} in this run")

    def as_dict(self) -> dict[str, Any]:
        """The whole ``reports/manual-check.json`` document."""
        return {
            "schema": REPORT_SCHEMA,
            "generated_at": self.generated_at,
            "repo_root": str(self.repo_root),
            "manual_root": str(self.manual_root),
            "profile": self.profile,
            "inputs": dict(self.inputs),
            "checks": [result.as_dict() for result in self.checks],
            "summary": self.summary.as_dict(),
        }


def write_json(path: Path, result: RunResult) -> Path:
    """Write the complete report to ``path`` and return it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(result.as_dict(), indent=2, sort_keys=True, ensure_ascii=False)
    path.write_text(f"{text}\n", encoding="utf-8")
    return path


def write_markdown(path: Path, result: RunResult) -> Path:
    """Write the reviewer's report to ``path`` and return it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(_markdown(result)) + "\n", encoding="utf-8")
    return path


def _markdown(result: RunResult) -> list[str]:
    summary = result.summary
    skipped = sum(
        1 for check in result.checks if check.level is Level.MUST and check.status is Status.SKIPPED
    )
    lines = [
        # REUSE-IgnoreStart - the header of the report we write, not of this file
        "<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->",
        "<!-- SPDX-License-Identifier: CC-BY-4.0 -->",
        # REUSE-IgnoreEnd
        "",
        "# Manual acceptance checks",
        "",
        f"**{summary.status.upper()}** — {summary.must_passed} of {summary.must_total} MUST "
        f"checks passed, {skipped} skipped, {summary.report_total} report-only; "
        f"exit code {summary.exit_code}.",
        "",
        f"- Generated: {result.generated_at}",
        f"- Manual tree: `{result.manual_root}` (profile `{result.profile}`)",
        "",
        "| # | id | level | status | metrics |",
        "| --- | --- | --- | --- | --- |",
    ]
    lines += [_row(check) for check in result.checks]
    for check in result.checks:
        lines += _section(check)
    return lines


def _row(check: CheckResult) -> str:
    metrics = ", ".join(f"{key} {value}" for key, value in check.metrics.items())
    return (
        f"| {check.number} | `{check.id}` | {check.level} "
        f"| {_STATUS_MARK[check.status]} | {metrics or '—'} |"
    )


def _section(check: CheckResult) -> list[str]:
    lines = [
        "",
        f"## {check.number}. {check.title} — {_STATUS_MARK[check.status]}",
        "",
        f"`{check.id}`, {check.level}, {check.duration_s:.2f} s.",
        "",
    ]
    if not check.findings:
        lines.append("No findings.")
        return lines
    lines += [_bullet(finding) for finding in check.findings[:MARKDOWN_FINDING_CAP]]
    left = len(check.findings) - MARKDOWN_FINDING_CAP
    if left > 0:
        lines.append(f"- … and {left} more (see `manual-check.json`)")
    return lines


def _bullet(finding: Finding) -> str:
    where = f" — `{finding.location}`" if finding.location else ""
    mark = "" if finding.level is Level.MUST else " _(report only)_"
    return f"- `{finding.code}`{mark}: {finding.message}{where}"


def summarise(checks: Sequence[CheckResult], *, fail_on_report: bool) -> Summary:
    """Count the MUST checks and derive the run's status and exit code."""
    must = [check for check in checks if check.level is Level.MUST]
    reports = [check for check in checks if check.level is Level.REPORT]
    failed = [check for check in must if check.failed]
    if fail_on_report:
        failed += [check for check in reports if check.findings]
    skipped_model = any(
        check.status is Status.SKIPPED
        and any(finding.code == "check.blocked_by_schema" for finding in check.findings)
        for check in checks
    )
    exit_code = EXIT_OK
    if failed:
        exit_code = EXIT_FINDINGS
    if skipped_model:
        exit_code = EXIT_SCHEMA
    return Summary(
        must_total=len(must),
        must_passed=sum(1 for check in must if check.status is Status.PASS),
        report_total=len(reports),
        status="fail" if exit_code else "pass",
        exit_code=exit_code,
    )
