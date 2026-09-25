# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-checks reuse-order``: ``REUSE.toml`` still resolves as intended.

REUSE resolves a path against the **last** matching ``[[annotations]]`` table,
so the order of the file is load-bearing and several branches may append to it
at once:

* a general table appended below the ordering marker silently relicenses
  every specific path above it — the CC-BY-4.0 manual, catalog, ground-truth
  and fixture data would become Apache-2.0;
* a specific table inserted above the marker is silently swallowed by the
  general tables that follow it.

``reuse lint`` sees neither, because it only checks that every path is
covered. This check resolves a committed expectation table — one
representative path per licence class — through ``REUSE.toml`` and compares
the effective licence and copyright, and it guards the marker itself.

The listed paths need not exist on disk: the subject is table resolution, so
the check works before the files themselves are created.
"""

from __future__ import annotations

import argparse
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path

from fdp_repo_checks.findings import EXIT_ERROR, Finding, report
from fdp_repo_checks.reuse_toml import MARKER, ReuseToml, ReuseTomlError
from fdp_repo_checks.reuse_toml import load as load_reuse_toml

NAME = "reuse-order"
HELP = "check that REUSE.toml still resolves every licence class as intended"

DEFAULT_TABLE = "tools/repo-checks/reuse-expected.toml"
REUSE_TOML = "REUSE.toml"

_LICENSE_KEY = "SPDX-License-Identifier"
_COPYRIGHT_KEY = "SPDX-FileCopyrightText"


class ExpectationError(ValueError):
    """The expectation table is missing or not shaped as this module needs."""


@dataclass(frozen=True)
class Expectation:
    """One representative path and the licence it must resolve to."""

    path: str
    license_id: str
    copyright_texts: tuple[str, ...]
    why: str


def register(parser: argparse.ArgumentParser) -> None:
    """Add the sub-command's own options."""
    parser.add_argument(
        "--table",
        metavar="FILE",
        default=DEFAULT_TABLE,
        help=f"expectation table, absolute or relative to --root (default: {DEFAULT_TABLE})",
    )


def _as_tuple(value: object, field: str, path: str) -> tuple[str, ...]:
    if isinstance(value, str):
        return (value,)
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return tuple(str(item) for item in value)
    raise ExpectationError(f"{path}: {field} must be a string or a list of strings")


def load_expectations(table: Path) -> tuple[Expectation, ...]:
    """Parse the committed expectation table.

    Raises:
        ExpectationError: the file is missing, is not valid TOML, or an entry
            lacks ``path``, the licence or the reason it is listed.
    """
    try:
        raw_text = table.read_text(encoding="utf-8")
    except OSError as error:
        raise ExpectationError(f"{table}: cannot be read ({error.strerror})") from error
    try:
        data = tomllib.loads(raw_text)
    except tomllib.TOMLDecodeError as error:
        raise ExpectationError(f"{table}: not valid TOML ({error})") from error

    entries = data.get("expected", [])
    if not isinstance(entries, list) or not entries:
        raise ExpectationError(f"{table}: needs at least one [[expected]] entry")

    expectations: list[Expectation] = []
    for position, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ExpectationError(f"{table}: entry {position} is not a table")
        path = entry.get("path")
        if not isinstance(path, str) or not path:
            raise ExpectationError(f"{table}: entry {position} has no `path`")
        license_id = entry.get(_LICENSE_KEY)
        if not isinstance(license_id, str) or not license_id:
            raise ExpectationError(f"{table}: {path} has no {_LICENSE_KEY}")
        why = entry.get("why")
        if not isinstance(why, str) or not why:
            raise ExpectationError(f"{table}: {path} has no `why` (say which licence class)")
        expectations.append(
            Expectation(
                path=path,
                license_id=license_id,
                copyright_texts=_as_tuple(entry.get(_COPYRIGHT_KEY, []), _COPYRIGHT_KEY, path),
                why=why,
            )
        )
    return tuple(expectations)


def check_marker(reuse: ReuseToml) -> list[Finding]:
    """The ordering marker exists and no general table sits below it."""
    if reuse.marker_line is None:
        return [
            Finding(
                REUSE_TOML,
                f"the ordering marker is missing; the file must carry the line {MARKER!r}",
            )
        ]
    return [
        Finding(
            REUSE_TOML,
            "general table "
            + ", ".join(repr(pattern) for pattern in annotation.patterns)
            + " sits below the ordering marker and relicenses the specific tables above it",
            line=annotation.index,
        )
        for annotation in reuse.general_annotations_below_marker()
    ]


def check_expectations(reuse: ReuseToml, expectations: tuple[Expectation, ...]) -> list[Finding]:
    """Resolve every listed path and compare licence and copyright."""
    findings: list[Finding] = []
    for expectation in expectations:
        annotation = reuse.covered(expectation.path)
        if annotation is None:
            findings.append(
                Finding(
                    expectation.path,
                    f"no REUSE.toml table covers it; expected {expectation.license_id} "
                    f"({expectation.why})",
                )
            )
            continue
        if annotation.license_id != expectation.license_id:
            findings.append(
                Finding(
                    expectation.path,
                    f"resolves to {annotation.license_id} but must be "
                    f"{expectation.license_id} ({expectation.why})",
                    line=annotation.index,
                )
            )
        if expectation.copyright_texts and annotation.copyright_texts != (
            expectation.copyright_texts
        ):
            findings.append(
                Finding(
                    expectation.path,
                    f"copyright resolves to {list(annotation.copyright_texts)} but must be "
                    f"{list(expectation.copyright_texts)}",
                    line=annotation.index,
                )
            )
    return findings


def run(args: argparse.Namespace) -> int:
    """Load both files, apply both checks and report."""
    root: Path = args.root
    table = Path(args.table)
    if not table.is_absolute():
        table = root / table
    try:
        expectations = load_expectations(table)
        reuse = load_reuse_toml(root / REUSE_TOML)
    except (ExpectationError, ReuseTomlError) as error:
        print(f"fdp-checks reuse-order: {error}", file=sys.stderr)
        return EXIT_ERROR

    findings = check_marker(reuse) + check_expectations(reuse, expectations)
    return report(
        NAME,
        findings,
        output_format=args.output_format,
        checked=len(expectations),
        unit="paths",
    )
