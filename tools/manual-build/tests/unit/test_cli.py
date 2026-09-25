# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The command line dispatches every subcommand, and says so when one is missing."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from fdp_manual_build.cli import SUBCOMMANDS, main

EXPECTED_COMMANDS = ("build", "render", "export-catalog", "check", "scanned")


def test_help_lists_every_subcommand(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        main(["--help"])
    assert raised.value.code == 0
    printed = capsys.readouterr().out
    for command in EXPECTED_COMMANDS:
        assert command in printed


def test_without_a_subcommand_it_prints_the_help(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([]) == 2
    assert "usage: fdp-manual-build" in capsys.readouterr().out


def test_an_open_subcommand_says_which_module_is_missing(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # Every subcommand has landed; a module that is not there yet stands in.
    open_command = replace(SUBCOMMANDS["scanned"], module="fdp_manual_build.not_written_yet")
    monkeypatch.setitem(SUBCOMMANDS, "scanned", open_command)
    assert main(["scanned"]) == 2
    assert capsys.readouterr().err.strip() == (
        f"not implemented yet ({open_command.module} is missing)"
    )


@pytest.mark.parametrize("command", EXPECTED_COMMANDS)
def test_an_implemented_subcommand_is_dispatched_to_its_module(command: str) -> None:
    from fdp_manual_build.cli import _entry_point  # noqa: PLC0415 - the dispatch under test

    assert _entry_point(SUBCOMMANDS[command]) is not None


def test_render_reaches_its_own_parser() -> None:
    # Its module is imported and its parser rejects the empty argument list,
    # instead of the placeholder reporting a missing module. `build` cannot be
    # driven the same way: with no arguments it would run a whole build.
    with pytest.raises(SystemExit) as raised:
        main(["render"])
    assert raised.value.code == 2


def test_check_hands_over_to_the_acceptance_runner(
    repo_root: Path,
    mini_spec_dir: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # The same two flags ``tests/unit/checks/test_runner.py`` uses: no manual
    # is built for a unit test, and check #10 shells out to the REUSE tool.
    # What is under test here is the hand-over, not the checks themselves.
    argv = [
        "--repo-root",
        str(repo_root),
        "check",
        "--repo-root",
        str(mini_spec_dir),
        "--report-dir",
        str(tmp_path),
        "--no-require-pdf",
        "--skip",
        "10",
    ]
    assert main(argv) == 0
    assert "fdp-manual-check: pass" in capsys.readouterr().out
    assert (tmp_path / "manual-check.json").is_file()


def test_build_names_its_module() -> None:
    assert SUBCOMMANDS["build"].module == "fdp_manual_build.build"


def test_an_unusable_repo_root_is_reported(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # Pretend `build` exists so the repo-root check is the one that fires.
    monkeypatch.setitem(
        SUBCOMMANDS,
        "build",
        type(SUBCOMMANDS["build"])(module="fdp_manual_build.cli", help="stand-in"),
    )
    monkeypatch.chdir(tmp_path)
    assert main(["build"]) == 2
    assert "no manual/build.yaml here or above" in capsys.readouterr().err
