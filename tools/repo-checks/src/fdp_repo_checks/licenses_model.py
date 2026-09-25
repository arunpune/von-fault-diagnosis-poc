# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""What the three licence collectors produce, and how they call their tool.

``licenses_node``, ``licenses_python`` and ``licenses_go`` each speak to a
different package manager and all answer in the same shape, so the command
that judges them (:mod:`fdp_repo_checks.commands.licenses`) never learns the
difference. The type lives here rather than in the command because the
command imports the collectors, and the collectors would otherwise have to
import the command back.
"""

from __future__ import annotations

import subprocess
from collections.abc import Iterable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

TOOL_TIMEOUT_S = 600
"""Generous: ``go-licenses`` downloads its own module graph on a cold cache."""


class Scope(StrEnum):
    """Whether a dependency ships (and must be permissive) or only builds and tests."""

    RUNTIME = "runtime"
    DEV = "dev"


class CollectorError(RuntimeError):
    """A package manager could not be run, or answered in an unknown shape."""


@dataclass(frozen=True)
class Record:
    """One dependency as its package manager reports it."""

    ecosystem: str
    name: str
    version: str
    declared: str
    """The licence exactly as the tool printed it; ``""`` when it printed none."""
    scope: Scope

    @property
    def key(self) -> str:
        """``<ecosystem>:<name>``, the key the policy tables are written with."""
        return f"{self.ecosystem}:{self.name}"

    @property
    def label(self) -> str:
        """``<ecosystem>:<name>@<version>``, how a finding names the package."""
        return f"{self.key}@{self.version}" if self.version else self.key

    @property
    def sort_key(self) -> tuple[str, str, str]:
        return (self.ecosystem, self.name.casefold(), self.version)


@dataclass(frozen=True)
class Collected:
    """A collector's records plus what it wants the report to say about them."""

    records: tuple[Record, ...]
    notices: tuple[str, ...] = ()


def merge(records: Iterable[Record]) -> tuple[Record, ...]:
    """De-duplicate by package and version, sorted; runtime scope wins.

    A package manager lists a package that is both a production and a
    development dependency twice. Runtime is the stricter scope, so the
    runtime row is the one the audit keeps.
    """
    best: dict[tuple[str, str, str], Record] = {}
    for record in records:
        identity = (record.ecosystem, record.name, record.version)
        current = best.get(identity)
        if current is None or (current.scope is Scope.DEV and record.scope is Scope.RUNTIME):
            best[identity] = record
    return tuple(sorted(best.values(), key=lambda record: record.sort_key))


def run_tool(argv: list[str], *, cwd: Path) -> str:
    """Run a package manager and return its standard output.

    Raises:
        CollectorError: the tool is missing, timed out or exited non-zero.
    """
    printable = " ".join(argv)
    try:
        completed = subprocess.run(
            argv,
            capture_output=True,
            check=False,
            cwd=cwd,
            text=True,
            timeout=TOOL_TIMEOUT_S,
        )
    except FileNotFoundError as error:
        raise CollectorError(f"{argv[0]} is not installed ({error.strerror})") from error
    except subprocess.TimeoutExpired as error:
        raise CollectorError(f"`{printable}` did not finish in {TOOL_TIMEOUT_S}s") from error
    except (OSError, subprocess.SubprocessError) as error:
        raise CollectorError(f"`{printable}` could not be run ({error})") from error
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()
        tail = detail[-1] if detail else "no error output"
        raise CollectorError(f"`{printable}` exited {completed.returncode}: {tail}")
    return completed.stdout
