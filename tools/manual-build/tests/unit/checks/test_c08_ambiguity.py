# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #8 maps the manual's A1-A5 and N2 onto the ambiguity row."""

from __future__ import annotations

from pathlib import Path

from fdp_manual_build.checks.base import CheckResult, Level, Profile, Status
from fdp_manual_build.checks.c08_ambiguity import AmbiguityCheck
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.model import Manual

from .factories import context, tool_run

_ALL_RULES = (
    "A1 spec/faults.yaml:/conditions 3 conditions, expected at least 12",
    "A2 spec/faults.yaml:/causes subsystem 'reservoirs' has a signal but no cause",
    "A3 spec/faults.yaml:/causes 1 benign causes, expected at least 2",
    "A4 spec/faults.yaml:/causes the distribution leak is listed under one condition only",
    "A5 spec/faults.yaml:/causes/3 cause 'F-004' has no signal move",
    "N2 spec/faults.yaml:/causes/2/signal_moves/0/note note states a number",
)


def _codes(result: CheckResult) -> list[str]:
    return [finding.code for finding in result.findings]


def test_clean_sources_pass(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root, manual_root=mini_spec_dir, cfg=mini_config, manual=mini_manual
    )
    result = AmbiguityCheck().run(ctx)
    assert result.status is Status.PASS
    assert result.metrics["conditions"] == len(mini_manual.conditions)
    assert result.metrics["causes"] == len(mini_manual.causes)
    assert result.metrics["mapped_signals"] == 3
    assert result.metrics["benign_causes"] == 1


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
    result = AmbiguityCheck().run(ctx)
    assert result.status is Status.FAIL
    assert _codes(result) == [
        "ambiguity.catalog_size",
        "ambiguity.subsystem_coverage",
        "ambiguity.benign_causes",
        "ambiguity.single_leak_cause",
        "ambiguity.signal_moves",
        "ambiguity.bare_number",
    ]
    assert result.metrics["violations"] == 6


def test_catalog_floors_are_reported_not_enforced_on_a_fixture(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        validate=tool_run("validate.py", *_ALL_RULES[:3]),
    )
    result = AmbiguityCheck().run(ctx)
    assert result.status is Status.PASS
    assert {finding.level for finding in result.findings} == {Level.REPORT}
    assert result.metrics["violations"] == 0


def test_evidence_rules_still_fail_a_fixture(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        validate=tool_run("validate.py", _ALL_RULES[4], _ALL_RULES[5]),
    )
    result = AmbiguityCheck().run(ctx)
    assert result.status is Status.FAIL
    assert _codes(result) == ["ambiguity.signal_moves", "ambiguity.bare_number"]


def test_a_validator_that_cannot_run_is_a_failure(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        validate=tool_run("validate.py", error="exited 3: MemoryError"),
    )
    result = AmbiguityCheck().run(ctx)
    assert result.status is Status.FAIL
    assert _codes(result) == ["ambiguity.tool_error"]
