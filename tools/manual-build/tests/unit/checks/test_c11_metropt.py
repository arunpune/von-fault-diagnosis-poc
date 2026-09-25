# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #11 maps M1 and B2 and owns the fifteen-column mapping assertion."""

from __future__ import annotations

import dataclasses
from pathlib import Path

from fdp_manual_build.checks.base import CheckResult, Level, Profile, Status
from fdp_manual_build.checks.c11_metropt import STATE_COLUMNS, MetroptFitCheck
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.model import Manual, Signal

from .factories import FakePdf, context, tool_run


def _codes(result: CheckResult) -> list[str]:
    return [finding.code for finding in result.findings]


def _with_signals(manual: Manual, *signals: Signal) -> Manual:
    return dataclasses.replace(manual, signals=signals)


def _signal(manual: Manual, column: str) -> Signal:
    return next(item for item in manual.signals if item.metropt_column == column)


def test_a_fixture_passes_with_its_columns_reported(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root, manual_root=mini_spec_dir, cfg=mini_config, manual=mini_manual
    )
    result = MetroptFitCheck().run(ctx)
    assert result.status is Status.PASS
    assert result.metrics["columns_expected"] == 15
    assert result.metrics["columns_mapped"] == 3
    assert {finding.level for finding in result.findings} == {Level.REPORT}


def test_unmapped_columns_fail_the_full_profile(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        profile=Profile.FULL,
    )
    result = MetroptFitCheck().run(ctx)
    assert result.status is Status.FAIL
    unmapped = [item for item in result.findings if item.code == "metropt_fit.unmapped_column"]
    assert len(unmapped) == 12
    assert {item.data["column"] for item in unmapped} >= {"TP2", "Motor_current", "LPS"}


def test_delegated_rules_are_mapped(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        profile=Profile.FULL,
        validate=tool_run(
            "validate.py",
            "M1 spec/signals.yaml:/signals MetroPT-3 column 'TP2' is mapped by no tag",
            "B2 spec/derived/normal-bands.json:/source sha256 does not match the dataset",
        ),
    )
    result = MetroptFitCheck().run(ctx)
    assert "metropt_fit.column_mapping" in _codes(result)
    assert "metropt_fit.band_provenance" in _codes(result)


def test_a_duplicate_column_always_fails(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    line_pressure = _signal(mini_manual, "TP3")
    twin = dataclasses.replace(line_pressure, id="line_pressure_copy")
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=_with_signals(mini_manual, line_pressure, twin),
    )
    result = MetroptFitCheck().run(ctx)
    assert result.status is Status.FAIL
    duplicate = next(
        item for item in result.findings if item.code == "metropt_fit.duplicate_mapping"
    )
    assert duplicate.data["signals"] == ["line_pressure", "line_pressure_copy"]


def test_the_wrong_group_or_unit_fails(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    oil = _signal(mini_manual, "Oil_temperature")
    broken = dataclasses.replace(oil, group="digital", unit="bar")
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=_with_signals(mini_manual, broken),
    )
    result = MetroptFitCheck().run(ctx)
    assert result.status is Status.FAIL
    assert "metropt_fit.column_group" in _codes(result)
    assert "metropt_fit.column_unit" in _codes(result)


def test_a_column_the_dataset_has_not_fails(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    invented = dataclasses.replace(_signal(mini_manual, "TP3"), metropt_column="TP9")
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=_with_signals(mini_manual, invented),
    )
    result = MetroptFitCheck().run(ctx)
    assert result.status is Status.FAIL
    unknown = next(item for item in result.findings if item.code == "metropt_fit.unknown_column")
    assert unknown.data["column"] == "TP9"


def test_statistics_from_another_file_fail(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        stats={"source": {"sha256": "f" * 64}},
    )
    result = MetroptFitCheck().run(ctx)
    assert result.status is Status.FAIL
    source = next(item for item in result.findings if item.code == "metropt_fit.stats_source")
    assert source.data["found"] == "f" * 64


def test_a_missing_quirk_is_reported(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    silent = dataclasses.replace(
        _signal(mini_manual, "COMP"), description_md="A valve.", source_note=None
    )
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=_with_signals(mini_manual, silent),
    )
    result = MetroptFitCheck().run(ctx)
    quirk = next(item for item in result.findings if item.code == "metropt_fit.quirk_wording")
    assert quirk.level is Level.REPORT


def test_rule_four_says_so_when_there_is_no_built_manual(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root, manual_root=mini_spec_dir, cfg=mini_config, manual=mini_manual
    )
    result = MetroptFitCheck().run(ctx)
    unchecked = next(
        item for item in result.findings if item.code == "metropt_fit.state_logic_unchecked"
    )
    assert unchecked.level is Level.REPORT


def test_rule_four_reads_the_clean_pdf_for_the_three_states(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    """The three tags and the three state words have to meet on one page."""
    tags = ("intake_closed", "load_valve", "motor_current")
    signals = tuple(
        dataclasses.replace(
            _signal(mini_manual, "COMP"), id=name, metropt_column=column, panel_label=f"X{index}"
        )
        for index, (name, column) in enumerate(zip(tags, STATE_COLUMNS, strict=True))
    )
    manual = _with_signals(mini_manual, *signals)
    page = "The unit runs loaded or unloaded, and off: " + " ".join(tags)
    for text, expected in ((page, []), ("nothing about the states", ["metropt_fit.state_logic"])):
        ctx = context(
            repo_root=repo_root,
            manual_root=mini_spec_dir,
            cfg=mini_config,
            manual=manual,
            profile=Profile.FULL,
            pdfs={"clean": FakePdf([text], name="mini-clean.pdf")},
        )
        result = MetroptFitCheck().run(ctx)
        found = [item for item in result.findings if item.code == "metropt_fit.state_logic"]
        assert [item.code for item in found] == expected
        assert [item.level for item in found] == [Level.MUST] * len(expected)


def test_a_validator_that_cannot_run_is_a_failure(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, mini_manual: Manual
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        manual=mini_manual,
        validate=tool_run("validate.py", error="exited 3: OSError"),
    )
    result = MetroptFitCheck().run(ctx)
    assert result.status is Status.FAIL
    assert "metropt_fit.tool_error" in _codes(result)
