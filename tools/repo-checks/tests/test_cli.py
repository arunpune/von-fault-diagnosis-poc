# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The ``fdp-checks`` front end: discovery, global options and exit codes."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from fdp_repo_checks import cli
from fdp_repo_checks.findings import EXIT_ERROR, EXIT_OK
from helpers import FixtureRepo

EXPECTED_COMMANDS = {"env", "gt-paths", "reuse-order", "spdx"}


def test_discovery_finds_every_shipped_command() -> None:
    assert {command.name for command in cli.discover()} >= EXPECTED_COMMANDS


def test_every_discovered_command_has_a_help_line() -> None:
    assert all(command.help.strip() for command in cli.discover())


def test_help_lists_every_command(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        cli.main(["--help"])
    assert raised.value.code == EXIT_OK
    out = capsys.readouterr().out
    assert set(out.split()) >= EXPECTED_COMMANDS


def test_no_command_prints_help_and_fails(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main([]) == EXIT_ERROR
    assert "usage: fdp-checks" in capsys.readouterr().out


def test_an_unknown_command_is_a_usage_error() -> None:
    with pytest.raises(SystemExit) as raised:
        cli.main(["no-such-check"])
    assert raised.value.code == EXIT_ERROR


def test_root_is_accepted_before_and_after_the_command(repo: FixtureRepo) -> None:
    assert cli.main(["--root", str(repo.path), "spdx"]) == EXIT_OK
    assert cli.main(["spdx", "--root", str(repo.path)]) == EXIT_OK


def test_format_is_accepted_before_the_command(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main(["--format", "json", "--root", str(repo.path), "spdx"]) == EXIT_OK
    assert json.loads(capsys.readouterr().out)["ok"] is True


def test_a_root_that_is_not_a_directory_is_an_environment_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    missing = tmp_path / "nowhere"
    assert cli.main(["spdx", "--root", str(missing)]) == EXIT_ERROR
    assert "not a directory" in capsys.readouterr().err


def test_outside_a_work_tree_the_root_must_be_given(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    monkeypatch.chdir(outside)
    monkeypatch.setattr(cli, "git_toplevel", lambda _start: None)
    assert cli.main(["spdx"]) == EXIT_ERROR
    assert "not inside a git work tree" in capsys.readouterr().err


def test_the_installed_console_script_runs_the_checks(repo: FixtureRepo) -> None:
    executable = shutil.which("fdp-checks")
    assert executable, "fdp-checks must be on PATH under `uv run`"
    completed = subprocess.run(
        [executable, "--root", str(repo.path), "--format", "json", "spdx"],
        capture_output=True,
        check=False,
        text=True,
    )
    assert completed.returncode == EXIT_OK, completed.stderr
    assert json.loads(completed.stdout)["check"] == "spdx"
