# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-init``: the one-shot initialisation entry point.

The parser knows every sub-command; the implementations live in
:mod:`fdp_init.commands` and are imported only when they run, so adding a
sub-command never touches the others. A sub-command whose module is missing
says so and exits 1.

Exit codes are :class:`~fdp_init.errors.ExitCode`: an
:class:`~fdp_init.errors.InitError` carries its own, anything unexpected is
logged with its traceback and exits 1.
"""

from __future__ import annotations

import argparse
import importlib
import logging
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from fdp_init import __version__
from fdp_init.config import Settings
from fdp_init.errors import ExitCode, InitError
from fdp_init.logging import configure_logging

PROGRAM = "fdp-init"

PACKAGE = "fdp_init.commands"


@dataclass(frozen=True, slots=True)
class Command:
    """A sub-command: its name, its module and its help line.

    Attributes:
        name: The word on the command line.
        module: The module under :mod:`fdp_init.commands`; it differs from
            ``name`` only for ``export-catalog``.
        help: One line for ``--help``.
        add_arguments: Registers the sub-command's own options. They live here
            rather than in the module because the module is not imported until
            the sub-command runs.
    """

    name: str
    module: str
    help: str
    add_arguments: Callable[[argparse.ArgumentParser], None] | None = None


def _wait_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--only",
        choices=("all", "postgres", "mqtt"),
        default="all",
        help="wait for one dependency instead of both (default: all)",
    )


def _migrate_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--status",
        action="store_true",
        help="list applied and pending migrations instead of applying them",
    )


def _dataset_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--rehash",
        action="store_true",
        help="ignore the sidecar cache and hash the CSV again",
    )


def _export_catalog_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--manual",
        type=Path,
        help="PDF to extract (default: MANUAL_PATH)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="where to write the catalog document",
    )


COMMANDS: tuple[Command, ...] = (
    Command("run", "run", "the whole sequence; the container default"),
    Command("wait", "wait", "wait for Postgres and the MQTT broker", _wait_arguments),
    Command("migrate", "migrate", "apply db/migrations", _migrate_arguments),
    Command("dataset", "dataset", "download and verify MetroPT-3", _dataset_arguments),
    Command("model", "model", "fill the embedding model cache"),
    Command("ingest", "ingest", "extract, embed and store the manual"),
    Command("report", "report", "print the latest ingest report"),
    Command(
        "export-catalog",
        "export_catalog",
        "write the extracted catalog document to a file",
        _export_catalog_arguments,
    ),
)
"""Every sub-command, in the order ``--help`` shows them."""

logger = logging.getLogger("fdp_init.cli")


def build_parser() -> argparse.ArgumentParser:
    """Build the full parser, sub-commands included."""
    parser = argparse.ArgumentParser(
        prog=PROGRAM,
        description="One-shot initialisation for the fault-diagnosis PoC.",
    )
    parser.add_argument("--version", action="version", version=f"{PROGRAM} {__version__}")
    subparsers = parser.add_subparsers(dest="command", metavar="COMMAND")
    for command in COMMANDS:
        subparser = subparsers.add_parser(command.name, help=command.help, description=command.help)
        if command.add_arguments is not None:
            command.add_arguments(subparser)
        subparser.set_defaults(selected=command)
    return parser


def load(command: Command) -> Callable[[argparse.Namespace, Settings], int] | None:
    """Import the module of ``command`` and return its ``run``.

    Returns:
        The handler, or ``None`` when the module has not been written yet. A
        ``ModuleNotFoundError`` about a *different* module — a missing
        third-party dependency inside the handler — propagates, because that
        is a broken install, not a missing step.
    """
    name = f"{PACKAGE}.{command.module}"
    try:
        module = importlib.import_module(name)
    except ModuleNotFoundError as exc:
        if exc.name != name:
            raise
        return None
    handler: Callable[[argparse.Namespace, Settings], int] = module.run
    return handler


def main(argv: Sequence[str] | None = None) -> int:
    """Parse the command line, run one sub-command, return its exit code."""
    parser = build_parser()
    args = parser.parse_args(argv)
    command: Command | None = getattr(args, "selected", None)
    if command is None:
        parser.print_help()
        return int(ExitCode.CONFIG)

    try:
        settings = Settings.from_env()
    except InitError as error:
        # Logging is not configured yet: the settings are what failed.
        sys.stderr.write(f"{PROGRAM}: {error.message}\n")
        return int(error.exit_code)

    configure_logging(settings)
    handler = load(command)
    if handler is None:
        sys.stderr.write(
            f"{PROGRAM} {command.name}: not implemented yet"
            f" ({PACKAGE}.{command.module} is missing)\n"
        )
        return int(ExitCode.UNEXPECTED)

    try:
        return handler(args, settings)
    except InitError as error:
        logger.error(
            "%s",
            error.message,
            extra={"step": error.step, "event": "failed", "exit_code": int(error.exit_code)},
        )
        return int(error.exit_code)
    except Exception:
        logger.exception("unexpected failure", extra={"step": command.name, "event": "failed"})
        return int(ExitCode.UNEXPECTED)
