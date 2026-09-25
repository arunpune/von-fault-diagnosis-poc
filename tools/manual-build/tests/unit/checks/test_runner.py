# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The runner: ordering, selection, profiles, exit codes and the reports."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from fdp_manual_build.checks.base import CheckResult, Level, Profile, Status
from fdp_manual_build.checks.runner import CHECK_ORDER, checks, main, run
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.model import Manual

from .factories import context

#: ``conftest.mutate``: copy the mini fixture and edit one value in it.
MutateFn = Callable[[Path, str, str, Any], Path]

#: What keeps a runner test offline and fast: no manual is built in a unit
#: test, and check #10 shells out to the REUSE tool. Both rows have their own
#: unit tests (``test_c03_coverage.py`` and kin) and meet a real build in
#: ``tests/e2e/test_check_fixture.py``.
_OFFLINE = ("--no-require-pdf", "--skip", "10")


def _report(report_dir: Path) -> dict[str, Any]:
    document = json.loads((report_dir / "manual-check.json").read_text(encoding="utf-8"))
    assert isinstance(document, dict)
    return document


def _status(document: dict[str, Any], number: int) -> str:
    return next(str(item["status"]) for item in document["checks"] if item["number"] == number)


def test_the_registry_holds_eleven_checks_in_the_planned_order() -> None:
    assert CHECK_ORDER == (1, 2, 11, 7, 8, 6, 3, 4, 5, 9, 10)
    registered = checks()
    assert [check.number for check in registered] == list(CHECK_ORDER)
    assert len({check.id for check in registered}) == 11
    assert [check.number for check in registered if check.level is Level.REPORT] == [5]


def test_only_and_skip_deselect_without_losing_the_row(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root, manual_root=mini_spec_dir, cfg=mini_config, manual=mini_manual
    )
    results = run(ctx, only=frozenset({1, 7}), skip=frozenset({7}))
    assert len(results) == 11
    assert [item.number for item in results if item.status is not Status.SKIPPED] == [1]
    deselected = next(item for item in results if item.number == 7)
    assert deselected.findings[0].code == "check.deselected"


def test_checks_that_need_the_model_are_blocked_when_it_did_not_load(
    repo_root: Path, mini_spec_dir: Path
) -> None:
    ctx = context(repo_root=repo_root, manual_root=mini_spec_dir)
    results = {item.number: item for item in run(ctx)}
    for number in (2, 3, 4, 5, 7, 8, 11):
        assert results[number].status is Status.SKIPPED
        assert results[number].findings[0].code == "check.blocked_by_schema"
    for number in (1, 6):
        assert results[number].status in (Status.PASS, Status.FAIL, Status.ERROR)


def test_the_pdf_level_rows_fail_without_a_built_manual(
    tmp_path: Path,
    repo_root: Path,
    mini_spec_dir: Path,
    mini_config: BuildConfig,
    mini_manual: Manual,
) -> None:
    """Missing PDFs fail #3/#4/#5/#9 unless ``--no-require-pdf`` says not to.

    ``variant_dir`` is an empty directory rather than the factory's default:
    the checkout ships built PDFs and their manifest under ``data/manual``,
    and this row is about a tree that has none.
    """
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        variant_dir=tmp_path,
    )
    results = {item.number: item for item in run(ctx, only=frozenset({3, 4, 5, 9}))}
    assert results[3].findings[0].code == "coverage.pdf_missing"
    assert results[4].findings[0].code == "tables.pdf_missing"
    assert results[9].findings[0].code == "reproducibility.manifest_missing"
    assert [results[number].status for number in (3, 4, 9)] == [Status.FAIL] * 3
    assert results[5].status is Status.REPORT


def test_no_require_pdf_skips_the_pdf_level_rows(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        require_pdf=False,
    )
    results = {item.number: item for item in run(ctx, only=frozenset({3, 4, 5, 9}))}
    for number in (3, 4, 5, 9):
        assert results[number].status is Status.SKIPPED
        assert results[number].findings[0].code == "check.pdf_absent"


def test_the_fixture_run_passes_and_writes_both_reports(
    tmp_path: Path, mini_spec_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    report_dir = tmp_path / "rep"
    code = main([*_OFFLINE, "--repo-root", str(mini_spec_dir), "--report-dir", str(report_dir)])
    assert code == 0
    document = _report(report_dir)
    assert document["profile"] == "fixture"
    for number in (1, 2, 6, 7, 8, 11):
        assert _status(document, number) == "pass"
    for number in (3, 4, 5, 9, 10):
        assert _status(document, number) == "skipped"
    assert (report_dir / "manual-check.md").is_file()
    assert "fdp-manual-check: pass" in capsys.readouterr().out


def test_a_warning_above_its_shutdown_fails_check_seven(tmp_path: Path, mutate: MutateFn) -> None:
    broken = mutate(
        tmp_path, "spec/alarms.yaml", "/alarms/0/trigger/condition/threshold/value", 100
    )
    report_dir = tmp_path / "rep"
    code = main([*_OFFLINE, "--repo-root", str(broken), "--report-dir", str(report_dir)])
    assert code == 1
    document = _report(report_dir)
    assert _status(document, 7) == "fail"
    findings = next(item for item in document["checks"] if item["number"] == 7)["findings"]
    blocking = [item for item in findings if item["level"] == "MUST"]
    assert [item["code"] for item in blocking] == ["plausibility.ordering"]
    assert blocking[0]["location"].startswith("spec/alarms.yaml#")
    assert _status(document, 6) == "pass"


def test_a_broken_source_file_blocks_the_dependent_checks(
    tmp_path: Path, mutate: MutateFn, delete: object
) -> None:
    broken = mutate(tmp_path, "spec/signals.yaml", "/signals/0/unit", delete)
    report_dir = tmp_path / "rep"
    assert main([*_OFFLINE, "--repo-root", str(broken), "--report-dir", str(report_dir)]) == 3
    document = _report(report_dir)
    assert _status(document, 1) == "fail"
    assert _status(document, 2) == "skipped"
    assert document["summary"]["exit_code"] == 3


def test_the_full_profile_enforces_the_catalog_floors(tmp_path: Path, mini_spec_dir: Path) -> None:
    report_dir = tmp_path / "rep"
    code = main(
        [
            *_OFFLINE,
            "--repo-root",
            str(mini_spec_dir),
            "--report-dir",
            str(report_dir),
            "--profile",
            "full",
        ]
    )
    assert code == 1
    document = _report(report_dir)
    assert document["profile"] == "full"
    assert _status(document, 8) == "fail"


def test_an_unknown_root_is_a_runner_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["--repo-root", str(tmp_path), "--report-dir", str(tmp_path / "rep")]) == 2
    assert "build.yaml" in capsys.readouterr().err


def test_an_unreadable_stats_file_is_a_runner_error(tmp_path: Path, mini_spec_dir: Path) -> None:
    argv = [
        "--repo-root",
        str(mini_spec_dir),
        "--report-dir",
        str(tmp_path),
        "--stats",
        str(tmp_path / "no.json"),
    ]
    assert main(argv) == 2


def test_a_bad_check_list_is_a_runner_error(tmp_path: Path, mini_spec_dir: Path) -> None:
    argv = ["--repo-root", str(mini_spec_dir), "--report-dir", str(tmp_path), "--only", "schema"]
    assert main(argv) == 2


def test_the_context_exposes_the_fixture_profile(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig
) -> None:
    ctx = context(repo_root=repo_root, manual_root=mini_spec_dir, cfg=mini_config)
    assert ctx.profile is Profile.FIXTURE
    assert not ctx.model_available


def test_a_check_result_knows_whether_it_failed() -> None:
    result = CheckResult(1, "schema", "Schema", Level.MUST, Status.ERROR, {}, (), 0.0)
    assert result.failed
