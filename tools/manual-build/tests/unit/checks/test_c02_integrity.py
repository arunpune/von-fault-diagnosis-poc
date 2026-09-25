# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #2 maps the manual's R1-R5 and C1-C6 onto the integrity row."""

from __future__ import annotations

from pathlib import Path

from fdp_manual_build.checks.base import CheckResult, Level, Status
from fdp_manual_build.checks.c02_integrity import IntegrityCheck
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.model import Manual

from .factories import context, tool_run


def _by_code(result: CheckResult, code: str) -> list[Level]:
    return [finding.level for finding in result.findings if finding.code == code]


def test_clean_sources_pass(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root, manual_root=mini_spec_dir, cfg=mini_config, manual=mini_manual
    )
    result = IntegrityCheck().run(ctx)
    assert result.status is Status.PASS
    assert result.metrics["references"] > 0
    assert result.metrics["content_rules"] == "skipped"


def test_every_spec_finding_code(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        validate=tool_run(
            "validate.py",
            "R1 spec/alarms.yaml:/alarms/0/trigger signal 'ghost' is not defined",
            "R2 spec/faults.yaml:/causes/2 cause 'F-003' is listed by no condition",
            "R3 spec/alarms.yaml:/alarms/4 message 'W999' is reachable from no condition",
            "R4 spec/settings.yaml:/settings/7 setting 'p_unused' is used by nothing",
            "R5 spec/alarms.yaml:/alarms/9 service message has no maintenance task",
        ),
    )
    result = IntegrityCheck().run(ctx)
    assert result.status is Status.FAIL
    assert _by_code(result, "integrity.missing_reference") == [Level.MUST]
    assert _by_code(result, "integrity.orphan_cause") == [Level.MUST]
    assert _by_code(result, "integrity.service_message") == [Level.MUST]
    assert result.metrics["missing"] == 3


def test_orphan_alarms_and_unused_settings_are_informative(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        validate=tool_run(
            "validate.py",
            "R3 spec/alarms.yaml:/alarms/4 message 'W999' is reachable from no condition",
            "R4 spec/settings.yaml:/settings/7 setting 'p_unused' is used by nothing",
        ),
    )
    result = IntegrityCheck().run(ctx)
    assert result.status is Status.PASS
    assert _by_code(result, "integrity.orphan_alarm") == [Level.REPORT]
    assert _by_code(result, "integrity.unused_setting") == [Level.REPORT]
    assert result.metrics["orphan_alarms"] == 1
    assert result.metrics["unused_settings"] == 1


def test_every_text_finding_code(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        content_checks=tool_run(
            "content_checks.py",
            "C1 file:manual/spec/alarms.yaml unknown cross-reference anchor 'cond:ghost'",
            "C2 file:content/01-safety.md does not define the required anchor 'sec:safety-signs'",
            "C3 file:content/09-technical-data.md calls tables.parts() 0 time(s), expected 1",
            "C5 file:content/04-settings.md prose-only fact 'setting:cut_in' is never stated",
            "C6 file:figures/system-schematic.svg uses a font that is not IBM Plex Sans",
        ),
    )
    result = IntegrityCheck().run(ctx)
    assert result.status is Status.FAIL
    assert [finding.code for finding in result.findings] == [
        "integrity.unknown_xref",
        "integrity.missing_anchor",
        "integrity.macro_count",
        "integrity.fact_placement",
        "integrity.figure",
    ]
    assert result.metrics["content_rules"] == "checked"


def test_a_validator_that_cannot_run_is_a_failure(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        validate=tool_run("validate.py", error="exited 3: Traceback"),
    )
    result = IntegrityCheck().run(ctx)
    assert result.status is Status.FAIL
    assert _by_code(result, "integrity.tool_error") == [Level.MUST]
