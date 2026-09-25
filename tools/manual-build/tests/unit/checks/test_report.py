# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The JSON and Markdown report writers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest

from fdp_manual_build.checks.base import CheckResult, Finding, Level, Status
from fdp_manual_build.checks.report import (
    MARKDOWN_FINDING_CAP,
    REPORT_SCHEMA,
    RunResult,
    Summary,
    summarise,
    write_json,
    write_markdown,
)

#: What every consumer of ``reports/manual-check.json`` may rely on.
REPORT_JSON_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["schema", "generated_at", "repo_root", "inputs", "checks", "summary"],
    "additionalProperties": True,
    "properties": {
        "schema": {"const": REPORT_SCHEMA},
        "generated_at": {"type": "string", "minLength": 1},
        "repo_root": {"type": "string"},
        "inputs": {
            "type": "object",
            "required": ["stats_sha256", "tool_versions"],
            "properties": {
                "stats_sha256": {"type": "string"},
                "tool_versions": {"type": "object"},
            },
        },
        "checks": {
            "type": "array",
            "minItems": 11,
            "maxItems": 11,
            "items": {
                "type": "object",
                "required": [
                    "number",
                    "id",
                    "title",
                    "level",
                    "status",
                    "metrics",
                    "findings",
                    "duration_s",
                ],
                "properties": {
                    "number": {"type": "integer", "minimum": 1, "maximum": 11},
                    "id": {"type": "string"},
                    "level": {"enum": ["MUST", "REPORT"]},
                    "status": {"enum": ["pass", "fail", "report", "skipped", "error"]},
                    "findings": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["code", "message", "location", "level", "data"],
                        },
                    },
                },
            },
        },
        "summary": {
            "type": "object",
            "required": ["must_total", "must_passed", "report_total", "status", "exit_code"],
        },
    },
}


def _check(
    number: int, status: Status, level: Level = Level.MUST, findings: int = 0
) -> CheckResult:
    return CheckResult(
        number=number,
        id=f"check{number}",
        title=f"Check {number}",
        level=level,
        status=status,
        metrics={"count": findings},
        findings=tuple(
            Finding(code=f"c{number}.f{index}", message=f"finding {index}", location="a.yaml#/x")
            for index in range(findings)
        ),
        duration_s=0.125,
    )


def _result(checks: tuple[CheckResult, ...], *, fail_on_report: bool = False) -> RunResult:
    return RunResult(
        generated_at="2026-09-20T00:00:00Z",
        repo_root=Path("/repo"),
        manual_root=Path("/repo/manual"),
        profile="full",
        inputs={"stats_sha256": "0" * 64, "tool_versions": {"fdp-manual-build": "0.1.0"}},
        checks=checks,
        summary=summarise(checks, fail_on_report=fail_on_report),
    )


@pytest.fixture
def eleven() -> tuple[CheckResult, ...]:
    """Ten passing MUST rows plus the one REPORT row (check #5)."""
    return tuple(
        _check(5, Status.REPORT, Level.REPORT) if number == 5 else _check(number, Status.PASS)
        for number in range(1, 12)
    )


def test_the_json_report_validates(tmp_path: Path, eleven: tuple[CheckResult, ...]) -> None:
    path = write_json(tmp_path / "manual-check.json", _result(eleven))
    document = json.loads(path.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator(REPORT_JSON_SCHEMA).validate(document)
    assert document["summary"]["must_total"] == 10
    assert document["summary"]["exit_code"] == 0


def test_the_markdown_report_has_one_row_per_check(
    tmp_path: Path, eleven: tuple[CheckResult, ...]
) -> None:
    text = write_markdown(tmp_path / "manual-check.md", _result(eleven)).read_text(encoding="utf-8")
    rows = [line for line in text.splitlines() if line.startswith("| ") and "| ---" not in line]
    assert len(rows) == 12  # the header row plus eleven checks
    assert text.startswith("<!-- SPDX-FileCopyrightText")
    assert "## 11. Check 11" in text


def test_the_markdown_report_caps_the_findings(tmp_path: Path) -> None:
    checks = (_check(1, Status.FAIL, findings=MARKDOWN_FINDING_CAP + 3),)
    text = write_markdown(tmp_path / "manual-check.md", _result(checks)).read_text(encoding="utf-8")
    bullets = [line for line in text.splitlines() if line.startswith("- `c1.")]
    assert len(bullets) == MARKDOWN_FINDING_CAP
    assert "… and 3 more" in text


def test_a_failing_must_check_sets_exit_one(eleven: tuple[CheckResult, ...]) -> None:
    checks = (_check(1, Status.FAIL, findings=1), *eleven[1:])
    assert summarise(checks, fail_on_report=False) == Summary(10, 9, 1, "fail", 1)


def test_a_blocked_check_sets_exit_three() -> None:
    blocked = CheckResult(
        number=2,
        id="integrity",
        title="Referential integrity",
        level=Level.MUST,
        status=Status.SKIPPED,
        metrics={},
        findings=(Finding(code="check.blocked_by_schema", message="#1 first", level=Level.REPORT),),
        duration_s=0.0,
    )
    assert summarise((blocked,), fail_on_report=False).exit_code == 3


def test_fail_on_report_turns_a_report_check_into_a_failure(
    eleven: tuple[CheckResult, ...],
) -> None:
    checks = tuple(
        _check(5, Status.REPORT, Level.REPORT, findings=2) if item.number == 5 else item
        for item in eleven
    )
    assert summarise(checks, fail_on_report=False).exit_code == 0
    assert summarise(checks, fail_on_report=True).exit_code == 1
