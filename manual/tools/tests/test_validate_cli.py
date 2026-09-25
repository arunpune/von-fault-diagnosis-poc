# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""End-to-end tests: validate.py driven as a subprocess, the way CI runs it."""

from __future__ import annotations

import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

VALIDATE = Path(__file__).resolve().parent.parent / "validate.py"

MutateFn = Callable[[Path, Path, str, str, Any], Path]


def run(*args: str) -> subprocess.CompletedProcess[str]:
    """Run validate.py with ``args`` and capture its output."""
    return subprocess.run(
        [sys.executable, str(VALIDATE), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def test_minimal_spec_passes_strict(minimal_spec_dir: Path) -> None:
    result = run("--spec", str(minimal_spec_dir), "--strict", "--minimums", "2,3,1,1")
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == ""


def test_report_prints_the_catalog_metrics(minimal_spec_dir: Path) -> None:
    result = run("--spec", str(minimal_spec_dir), "--strict", "--minimums", "2,3,1,1", "--report")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "REPORT" in result.stdout
    assert "  signals: 16" in result.stdout
    assert "  conditions: 3" in result.stdout
    assert "benign causes (1): high_air_demand" in result.stdout
    assert "sharing matrix:" in result.stdout
    assert "subsystem coverage:" in result.stdout
    assert "evaluable bits: 3" in result.stdout


def test_mutated_spec_exits_one_and_names_the_rule(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "signals", "/signals/0/modbus/scale", 100)
    result = run("--spec", str(mutated), "--strict", "--minimums", "2,3,1,1")
    assert result.returncode == 1
    assert "M2 spec/signals.yaml:/signals/0/modbus/scale" in result.stdout


def test_schema_failure_is_reported_under_s1(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "signals", "/signals/0/id", "Nope")
    result = run("--spec", str(mutated), "--minimums", "2,3,1,1")
    assert result.returncode == 1
    assert result.stdout.startswith("S1 spec/signals.yaml:/signals/0/id ")


def test_only_signals_on_a_partial_directory(minimal_spec_dir: Path, tmp_path: Path) -> None:
    partial = tmp_path / "partial"
    (partial / "spec").mkdir(parents=True)
    shutil.copy(minimal_spec_dir / "spec" / "signals.yaml", partial / "spec" / "signals.yaml")
    result = run("--spec", str(partial), "--only", "signals")
    assert result.returncode == 0, result.stdout + result.stderr
    lines = result.stdout.splitlines()
    assert all(line.startswith("SKIP ") for line in lines)
    assert "SKIP R2 needs spec/faults.yaml" in lines
    assert not any(line.startswith("SKIP M1") for line in lines)


def test_strict_reports_every_missing_document(tmp_path: Path) -> None:
    result = run("--spec", str(tmp_path), "--strict")
    assert result.returncode == 1
    assert "S1 spec/machine.yaml:/ missing (--strict)" in result.stdout
    assert "S1 spec/derived/normal-bands.json:/ missing (--strict)" in result.stdout


def test_without_strict_a_missing_document_only_skips(tmp_path: Path) -> None:
    result = run("--spec", str(tmp_path))
    assert result.returncode == 0
    assert "SKIP B2 needs spec/derived/normal-bands.json" in result.stdout


def test_bad_minimums_is_a_usage_error(minimal_spec_dir: Path) -> None:
    result = run("--spec", str(minimal_spec_dir), "--minimums", "2,3")
    assert result.returncode == 2
    assert "four comma-separated integers" in result.stderr


def test_unknown_only_key_is_a_usage_error(minimal_spec_dir: Path) -> None:
    result = run("--spec", str(minimal_spec_dir), "--only", "signals,nope")
    assert result.returncode == 2
    assert "unknown file key(s) nope" in result.stderr
