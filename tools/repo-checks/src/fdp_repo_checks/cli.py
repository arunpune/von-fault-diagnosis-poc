# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-checks``: the repository hygiene entry point.

Sub-commands are discovered with :func:`pkgutil.iter_modules` over
:mod:`fdp_repo_checks.commands`, so adding a check never touches this module.
``--root`` and ``--format`` are accepted on either side of the sub-command.

Exit codes: 0 clean, 1 findings, 2 usage or environment error.
"""

from __future__ import annotations

import argparse
import importlib
import pkgutil
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from fdp_repo_checks import commands
from fdp_repo_checks.findings import EXIT_ERROR
from fdp_repo_checks.gitfiles import git_toplevel

RegisterFn = Callable[[argparse.ArgumentParser], None]
RunFn = Callable[[argparse.Namespace], int]

_CONTRACT = ("NAME", "HELP", "register", "run")


@dataclass(frozen=True)
class Command:
    """A discovered sub-command."""

    name: str
    help: str
    register: RegisterFn
    run: RunFn


def discover() -> list[Command]:
    """Return every sub-command, sorted by name.

    A module that does not expose the full contract of
    :mod:`fdp_repo_checks.commands` is skipped rather than crashing the CLI.
    """
    found: list[Command] = []
    for info in pkgutil.iter_modules(commands.__path__):
        if info.name.startswith("_"):
            continue
        module = importlib.import_module(f"{commands.__name__}.{info.name}")
        if not all(hasattr(module, attribute) for attribute in _CONTRACT):
            continue
        found.append(
            Command(
                name=str(module.NAME),
                help=str(module.HELP),
                register=cast(RegisterFn, module.register),
                run=cast(RunFn, module.run),
            )
        )
    return sorted(found, key=lambda command: command.name)


def _add_global_options(parser: argparse.ArgumentParser) -> None:
    """Options that work before and after the sub-command.

    ``argparse.SUPPRESS`` keeps the sub-parser from overwriting a value the
    main parser already took.
    """
    parser.add_argument(
        "--root",
        metavar="DIR",
        default=argparse.SUPPRESS,
        help="repository root to check (default: the git top level of the current directory)",
    )
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default=argparse.SUPPRESS,
        dest="output_format",
        help="output format (default: text)",
    )


def build_parser(found: Sequence[Command]) -> argparse.ArgumentParser:
    """Build the argument parser for the given sub-commands."""
    common = argparse.ArgumentParser(add_help=False)
    _add_global_options(common)

    parser = argparse.ArgumentParser(
        prog="fdp-checks",
        description="Repository hygiene checks (offline, standard library only).",
        parents=[common],
    )
    subparsers = parser.add_subparsers(dest="command", metavar="COMMAND")
    for command in found:
        subparser = subparsers.add_parser(
            command.name,
            help=command.help,
            description=command.help,
            parents=[common],
        )
        command.register(subparser)
        subparser.set_defaults(handler=command.run)
    return parser


def resolve_root(raw: str | None) -> Path:
    """Turn ``--root`` into an existing directory.

    Raises:
        FileNotFoundError: the directory does not exist, or the default was
            requested outside a git work tree.
    """
    if raw is not None:
        root = Path(raw).expanduser().resolve()
        if not root.is_dir():
            raise FileNotFoundError(f"--root {raw}: not a directory")
        return root
    top = git_toplevel(Path.cwd())
    if top is None:
        raise FileNotFoundError(
            "not inside a git work tree; pass --root to say which repository to check"
        )
    return top.resolve()


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point of the ``fdp-checks`` console script."""
    parser = build_parser(discover())
    args = parser.parse_args(argv)
    handler = cast(RunFn | None, getattr(args, "handler", None))
    if handler is None:
        parser.print_help()
        return EXIT_ERROR
    try:
        args.root = resolve_root(getattr(args, "root", None))
    except FileNotFoundError as error:
        print(f"fdp-checks: {error}", file=sys.stderr)
        return EXIT_ERROR
    args.output_format = getattr(args, "output_format", "text")
    return handler(args)


if __name__ == "__main__":  # pragma: no cover - exercised through the console script
    raise SystemExit(main())
