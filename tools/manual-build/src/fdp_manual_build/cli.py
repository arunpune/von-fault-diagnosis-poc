# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-manual-build``: build, render, export-catalog, check, scanned.

Every subcommand is implemented by its own module and imported lazily, so the
five entry points exist even when a module behind one of them is missing. A
subcommand whose module is not there says so and exits 2.

Exit codes follow the convention of the repository's Python tools: ``0``
success, ``1`` findings, ``2`` a usage or environment error. A subcommand's
``main(argv, repo_root)`` returns one of them.
"""

from __future__ import annotations

import argparse
import importlib
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, cast

from fdp_manual_build import __version__
from fdp_manual_build.errors import BuildError

__all__ = ["main"]

EXIT_ERROR: Final = 2

_MARKER = Path("manual") / "build.yaml"


@dataclass(frozen=True)
class _Subcommand:
    """One lazily imported subcommand and the module that implements it."""

    module: str
    help: str


#: Subcommand name → where its ``main`` lives.
SUBCOMMANDS: Final[dict[str, _Subcommand]] = {
    "build": _Subcommand("fdp_manual_build.build", "assemble the HTML and render both variants"),
    "render": _Subcommand("fdp_manual_build.render", "render one prepared HTML file to PDF"),
    "export-catalog": _Subcommand(
        "fdp_manual_build.export", "write tools/eval/fixtures/catalog.json"
    ),
    "check": _Subcommand("fdp_manual_build.checks.runner", "run the manual acceptance checks"),
    "scanned": _Subcommand("fdp_manual_build.scanned", "render the optional scanned variant"),
}


def main(argv: Sequence[str] | None = None) -> int:
    """Parse the command line and hand over to the subcommand's module."""
    parser = _parser()
    namespace, rest = parser.parse_known_args(argv)
    if namespace.command is None:
        parser.print_help()
        return EXIT_ERROR
    subcommand = SUBCOMMANDS[namespace.command]
    entry = _entry_point(subcommand)
    if entry is None:
        print(f"not implemented yet ({subcommand.module} is missing)", file=sys.stderr)
        return EXIT_ERROR
    repo_root = _repo_root(namespace.repo_root)
    if repo_root is None:
        print(
            f"fdp-manual-build: no {_MARKER.as_posix()} here or above; pass --repo-root",
            file=sys.stderr,
        )
        return EXIT_ERROR
    try:
        return entry(tuple(rest), repo_root)
    except BuildError as error:
        print(f"fdp-manual-build: {error}", file=sys.stderr)
        return EXIT_ERROR


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fdp-manual-build",
        description="Build the CAU-7 instruction manual from manual/spec.",
    )
    parser.add_argument("--version", action="version", version=f"fdp-manual-build {__version__}")
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=None,
        help=f"checkout that holds {_MARKER.as_posix()} (default: search upwards)",
    )
    subparsers = parser.add_subparsers(dest="command", metavar="command")
    for name, subcommand in SUBCOMMANDS.items():
        subparsers.add_parser(name, help=subcommand.help, add_help=False)
    return parser


def _repo_root(given: Path | None) -> Path | None:
    if given is not None:
        return given.resolve() if (given / _MARKER).is_file() else None
    start = Path.cwd().resolve()
    for candidate in (start, *start.parents):
        if (candidate / _MARKER).is_file():
            return candidate
    return None


def _entry_point(subcommand: _Subcommand) -> Callable[[Sequence[str], Path], int] | None:
    """Import the subcommand's ``main``, or ``None`` while its module is missing."""
    try:
        module = importlib.import_module(subcommand.module)
    except ModuleNotFoundError:
        return None
    entry = getattr(module, "main", None)
    if entry is None:
        return None
    return cast("Callable[[Sequence[str], Path], int]", entry)


if __name__ == "__main__":  # pragma: no cover - module entry point
    sys.exit(main())
