# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Parsing and running the manual's validators."""

from __future__ import annotations

from pathlib import Path

from fdp_manual_build.checks.base import Level, Profile
from fdp_manual_build.checks.mantools import (
    ToolRun,
    content_checks_run,
    map_rules,
    rules_seen,
    tool_error,
    validate_run,
)
from fdp_manual_build.config import BuildConfig, load_build_config

from .factories import context


def test_a_validate_line_keeps_its_pointer() -> None:
    run = ToolRun.from_stdout(
        "validate.py", "P1 spec/alarms.yaml:/alarms/0 warning above shutdown\n"
    )
    assert [item.rule for item in run.findings] == ["P1"]
    assert run.findings[0].file == "spec/alarms.yaml"
    assert run.findings[0].pointer == "/alarms/0"
    assert run.findings[0].location == "spec/alarms.yaml#/alarms/0"


def test_a_content_checks_line_has_no_pointer() -> None:
    run = ToolRun.from_stdout("content_checks.py", "C2 file:content/01-safety.md missing anchor\n")
    assert run.findings[0].file == "content/01-safety.md"
    assert run.findings[0].pointer == ""
    assert run.findings[0].location == "content/01-safety.md"


def test_skip_lines_are_notices_and_noise_is_kept() -> None:
    run = ToolRun.from_stdout(
        "validate.py",
        "SKIP R1 needs spec/machine.yaml\n\ncontent_checks: 10 partial(s), no findings\n",
    )
    assert run.findings == ()
    assert run.notices == ("SKIP R1 needs spec/machine.yaml",)
    assert run.unparsed == ("content_checks: 10 partial(s), no findings",)


def test_map_rules_ignores_rules_another_row_owns() -> None:
    run = ToolRun.from_stdout("validate.py", "P1 a.yaml:/ one\nA1 b.yaml:/ two\n")
    assert [item.code for item in map_rules(run, {"P1": "plausibility.ordering"})] == [
        "plausibility.ordering"
    ]


def test_a_demoted_rule_is_reported_not_enforced() -> None:
    run = ToolRun.from_stdout("validate.py", "M2 spec/signals.yaml:/signals wrong group size\n")
    mapped = map_rules(run, {"M2": "plausibility.modbus_scale"}, demoted=frozenset({"M2"}))
    assert [item.level for item in mapped] == [Level.REPORT]


def test_rules_seen_counts_distinct_rules() -> None:
    run = ToolRun.from_stdout("validate.py", "P1 a.yaml:/ one\nP1 a.yaml:/x two\nP3 b.yaml:/ x\n")
    assert rules_seen(run, ("P1", "P2", "P3")) == 2


def test_tool_error_is_none_for_a_healthy_run() -> None:
    assert tool_error(ToolRun("validate.py", (), 0), "x.tool_error") is None
    failed = ToolRun("validate.py", ("validate.py",), 2, error="boom")
    finding = tool_error(failed, "x.tool_error")
    assert finding is not None
    assert finding.code == "x.tool_error"


def test_validate_really_runs_on_the_mini_fixture(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig
) -> None:
    ctx = context(repo_root=repo_root, manual_root=mini_spec_dir, cfg=mini_config)
    del ctx.tool_runs["validate"]
    run = validate_run(ctx)
    assert run.ran
    assert run.error is None
    assert {item.rule for item in run.findings} <= {"A1", "A2", "A3", "M1", "M2"}
    assert validate_run(ctx) is run


def test_content_checks_is_not_run_on_a_fixture(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig
) -> None:
    ctx = context(repo_root=repo_root, manual_root=mini_spec_dir, cfg=mini_config)
    del ctx.tool_runs["content_checks"]
    run = content_checks_run(ctx)
    assert not run.ran
    assert run.skipped is not None


def test_content_checks_waits_for_the_chapter_partials(repo_root: Path) -> None:
    cfg = load_build_config(repo_root)
    written = sum(1 for chapter in cfg.chapters if cfg.chapter_path(chapter).is_file())
    ctx = context(
        repo_root=repo_root,
        manual_root=cfg.manual_root,
        cfg=cfg,
        profile=Profile.FULL,
    )
    del ctx.tool_runs["content_checks"]
    run = content_checks_run(ctx)
    if written < len(cfg.chapters):
        assert (
            run.skipped == f"{len(cfg.chapters) - written} chapter partial(s) are not written yet"
        )
    else:
        assert run.ran
