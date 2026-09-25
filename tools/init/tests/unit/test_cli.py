# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The CLI: the sub-command list, lazy dispatch and exit-code mapping.

Lazy dispatch: a new sub-command adds a module under ``fdp_init.commands`` and
never edits ``cli.py``. The fake module below is what such a module looks like
from the CLI's side.
"""

from __future__ import annotations

import argparse
import importlib.machinery
import logging
import sys
import types
from collections.abc import Callable, Iterator

import pytest

from fdp_init import cli
from fdp_init.config import Settings
from fdp_init.errors import ExitCode, InitError

Env = Callable[..., dict[str, str]]

EXPECTED_COMMANDS = (
    "run",
    "wait",
    "migrate",
    "dataset",
    "model",
    "ingest",
    "report",
    "export-catalog",
)

UNWRITTEN = cli.Command("ghost", "ghost_never_written", "a stand-in")
"""A sub-command whose module is never written, for the "not implemented" path."""


@pytest.fixture
def fake_command() -> Iterator[Callable[[str, Callable[..., int]], types.ModuleType]]:
    """Install a stand-in for a ``fdp_init.commands.<name>`` module."""
    installed: list[str] = []

    def install(name: str, run: Callable[[argparse.Namespace, Settings], int]) -> types.ModuleType:
        full = f"{cli.PACKAGE}.{name}"
        module = types.ModuleType(full)
        module.__spec__ = importlib.machinery.ModuleSpec(full, None)
        module.run = run  # type: ignore[attr-defined]
        sys.modules[full] = module
        installed.append(full)
        return module

    yield install
    for full in installed:
        sys.modules.pop(full, None)


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch: pytest.MonkeyPatch, env: Env) -> None:
    """``main()`` reads ``os.environ``; point it at the test's own root."""
    for name, value in env().items():
        monkeypatch.setenv(name, value)


@pytest.fixture(autouse=True)
def _restore_logging() -> Iterator[None]:
    """``main()`` configures logging; hand the root logger back untouched."""
    root = logging.getLogger()
    handlers = list(root.handlers)
    level = root.level
    yield
    root.handlers = handlers
    root.setLevel(level)


def test_help_lists_every_subcommand(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as caught:
        cli.main(["--help"])

    assert caught.value.code == 0
    out = capsys.readouterr().out
    for name in EXPECTED_COMMANDS:
        assert name in out


def test_command_table_is_the_plan_order() -> None:
    assert tuple(command.name for command in cli.COMMANDS) == EXPECTED_COMMANDS
    assert {command.module for command in cli.COMMANDS} >= {"wait", "export_catalog"}


def test_no_subcommand_prints_help(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main([]) == int(ExitCode.CONFIG)
    assert "COMMAND" in capsys.readouterr().out


def test_missing_module_names_its_module(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # Every real sub-command has its module, so a stand-in that is never
    # written is registered instead.
    monkeypatch.setattr(cli, "COMMANDS", (*cli.COMMANDS, UNWRITTEN))

    assert cli.main([UNWRITTEN.name]) == int(ExitCode.UNEXPECTED)

    assert (
        f"not implemented yet (fdp_init.commands.{UNWRITTEN.module} is missing)"
        in capsys.readouterr().err
    )


def test_dispatch_passes_args_and_settings(
    fake_command: Callable[[str, Callable[..., int]], types.ModuleType],
) -> None:
    seen: dict[str, object] = {}

    def run(args: argparse.Namespace, settings: Settings) -> int:
        seen["rehash"] = args.rehash
        seen["host"] = settings.postgres_host
        return 0

    fake_command("dataset", run)

    assert cli.main(["dataset", "--rehash"]) == 0
    assert seen == {"rehash": True, "host": "postgres"}


def test_init_error_becomes_its_exit_code(
    fake_command: Callable[[str, Callable[..., int]], types.ModuleType],
    capsys: pytest.CaptureFixture[str],
) -> None:
    def run(args: argparse.Namespace, settings: Settings) -> int:
        raise InitError(ExitCode.DATASET, "the mirror is empty", "dataset")

    fake_command("dataset", run)

    assert cli.main(["dataset"]) == int(ExitCode.DATASET)
    assert "the mirror is empty" in capsys.readouterr().out


def test_unexpected_exception_exits_one(
    fake_command: Callable[[str, Callable[..., int]], types.ModuleType],
    capsys: pytest.CaptureFixture[str],
) -> None:
    def run(args: argparse.Namespace, settings: Settings) -> int:
        raise ZeroDivisionError("nope")

    fake_command("model", run)

    assert cli.main(["model"]) == int(ExitCode.UNEXPECTED)
    assert "ZeroDivisionError" in capsys.readouterr().out


def test_configuration_error_exits_two(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("POSTGRES_PORT", "not-a-number")

    assert cli.main(["wait"]) == int(ExitCode.CONFIG)
    assert "POSTGRES_PORT" in capsys.readouterr().err


def command_named(name: str) -> cli.Command:
    return next(one for one in cli.COMMANDS if one.name == name)


def test_load_returns_none_for_a_missing_module() -> None:
    assert cli.load(UNWRITTEN) is None


def test_import_error_inside_a_command_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    """A missing third-party package is a broken install, not a missing step."""

    def boom(name: str) -> types.ModuleType:
        raise ModuleNotFoundError(
            f"No module named 'pdfplumber' (loading {name})", name="pdfplumber"
        )

    monkeypatch.setattr(cli.importlib, "import_module", boom)

    with pytest.raises(ModuleNotFoundError):
        cli.load(command_named("ingest"))


def test_version_flag(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as caught:
        cli.main(["--version"])

    assert caught.value.code == 0
    assert "fdp-init" in capsys.readouterr().out
