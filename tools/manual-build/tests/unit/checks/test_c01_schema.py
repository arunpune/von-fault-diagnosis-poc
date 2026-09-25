# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #1 maps the manual's S1, S2, L1 and N1 onto the schema row."""

from __future__ import annotations

from pathlib import Path

from fdp_manual_build.checks.base import CheckResult, Finding, Level, Status
from fdp_manual_build.checks.c01_schema import SchemaCheck
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.model import Manual

from .factories import context, tool_run


def _codes(result: CheckResult) -> list[str]:
    return [finding.code for finding in result.findings]


def test_clean_sources_pass(repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig) -> None:
    ctx = context(repo_root=repo_root, manual_root=mini_spec_dir, cfg=mini_config)
    result = SchemaCheck().run(ctx)
    assert result.status is Status.PASS
    assert result.number == 1
    assert result.metrics["errors"] == 0


def test_every_finding_code(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        validate=tool_run(
            "validate.py",
            "S1 spec/signals.yaml:/signals/0 'unit' is a required property",
            "S2 spec/alarms.yaml:/alarms/1/bit duplicate bit 3",
            "L1 spec/derived/normal-bands.json:/ missing .license sidecar",
        ),
        content_checks=tool_run(
            "content_checks.py",
            "N1 file:content/01-safety.md line 12: bare number '7 bar' in prose",
        ),
    )
    result = SchemaCheck().run(ctx)
    assert result.status is Status.FAIL
    assert _codes(result) == [
        "schema.invalid",
        "schema.duplicate_id",
        "schema.license_header",
        "schema.bare_number",
    ]
    assert result.metrics["errors"] == 4
    assert result.metrics["ids_checked"] > 0
    first = result.findings[0]
    assert first.location == "spec/signals.yaml#/signals/0"
    assert first.data["rule"] == "S1"


def test_loader_errors_are_reported_here(repo_root: Path, mini_spec_dir: Path) -> None:
    loader = Finding(code="schema.invalid", message="build.yaml does not validate")
    ctx = context(repo_root=repo_root, manual_root=mini_spec_dir, load_errors=[loader])
    result = SchemaCheck().run(ctx)
    assert result.status is Status.FAIL
    assert result.findings[0] is loader
    assert result.metrics["files"] == 0


def test_a_validator_that_cannot_run_is_a_failure(repo_root: Path, mini_spec_dir: Path) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        validate=tool_run("validate.py", error="manual/tools/validate.py: not in this checkout"),
    )
    result = SchemaCheck().run(ctx)
    assert result.status is Status.FAIL
    assert "schema.tool_error" in _codes(result)


def test_a_skipped_number_lint_is_reported_not_failed(repo_root: Path, mini_spec_dir: Path) -> None:
    ctx = context(repo_root=repo_root, manual_root=mini_spec_dir)
    result = SchemaCheck().run(ctx)
    skipped = [item for item in result.findings if item.code == "schema.number_lint_skipped"]
    assert [item.level for item in skipped] == [Level.REPORT]
    assert result.status is Status.PASS
