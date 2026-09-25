# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #7 maps the manual's P1-P6, M2 and B1 onto the plausibility row."""

from __future__ import annotations

from pathlib import Path

from fdp_manual_build.checks.base import CheckResult, Level, Profile, Status
from fdp_manual_build.checks.c07_plausibility import PlausibilityCheck
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.model import Manual

from .factories import context, tool_run

_ALL_RULES = (
    "P1 spec/alarms.yaml:/alarms/0 warning at 100 degC is not below shutdown at 95 degC",
    "P2 spec/alarms.yaml:/alarms/1 threshold 20 bar is outside the range of 'line_pressure'",
    "P3 spec/settings.yaml:/settings/0 min 9 is not below max 4",
    "P4 spec/signals.yaml:/signals/1 band high 96 leaves no room below the shutdown",
    "P5 spec/alarms.yaml:/alarms/1 shutdown waits 600 s, longer than its warning",
    "P6 spec/machine.yaml:/limits ambient maximum is above the oil warning",
    "M2 spec/signals.yaml:/signals expected 7 analog tags, found 2",
    "B1 spec/signals.yaml:/signals/0 band does not match spec/derived/normal-bands.json",
)


def _codes(result: CheckResult) -> list[str]:
    return [finding.code for finding in result.findings]


def test_clean_sources_pass(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root, manual_root=mini_spec_dir, cfg=mini_config, manual=mini_manual
    )
    result = PlausibilityCheck().run(ctx)
    assert result.status is Status.PASS
    assert result.metrics["violations"] == 0
    assert result.metrics["rules_evaluated"] == 8


def test_every_finding_code(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        profile=Profile.FULL,
        validate=tool_run("validate.py", *_ALL_RULES),
    )
    result = PlausibilityCheck().run(ctx)
    assert result.status is Status.FAIL
    assert _codes(result) == [
        "plausibility.ordering",
        "plausibility.range",
        "plausibility.setting_bounds",
        "plausibility.band_headroom",
        "plausibility.timing",
        "plausibility.cross_quantity",
        "plausibility.modbus_scale",
        "plausibility.band_source",
    ]
    assert result.metrics["rules_violated"] == 8
    assert result.metrics["violations"] == 8


def test_a_warning_above_its_shutdown_is_an_ordering_violation(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        validate=tool_run("validate.py", _ALL_RULES[0]),
    )
    result = PlausibilityCheck().run(ctx)
    assert result.status is Status.FAIL
    ordering = result.findings[0]
    assert ordering.code == "plausibility.ordering"
    assert ordering.location == "spec/alarms.yaml#/alarms/0"
    assert ordering.data == {"rule": "P1", "tool": "validate.py"}


def test_group_sizes_are_reported_not_enforced_on_a_fixture(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        validate=tool_run("validate.py", _ALL_RULES[6]),
    )
    result = PlausibilityCheck().run(ctx)
    assert result.status is Status.PASS
    assert [finding.level for finding in result.findings] == [Level.REPORT]
    assert result.metrics["reported"] == 1


def test_a_validator_that_cannot_run_is_a_failure(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        validate=tool_run("validate.py", error="validate.py: not in this checkout"),
    )
    result = PlausibilityCheck().run(ctx)
    assert result.status is Status.FAIL
    assert _codes(result) == ["plausibility.tool_error"]
