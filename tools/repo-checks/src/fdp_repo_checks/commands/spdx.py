# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-checks spdx``: every file declares a copyright and a licence.

A fast offline stand-in for ``reuse lint``: it runs in a pre-commit hook and in
``make lint`` without a network round-trip, and it agrees with REUSE on the
committed tree. The allowed identifiers are
the basenames of ``LICENSES/*.txt``, so committing a new licence text extends
the set and nothing else has to change.

A file passes when one of these holds:

* it is exempt (the licence texts themselves, ``NOTICE``, ``REUSE.toml``,
  a symlink or a zero-byte placeholder);
* a ``<path>.license`` sidecar carries the two tags;
* a ``REUSE.toml`` table covers it;
* its first 25 lines carry an ``SPDX-FileCopyrightText`` tag and an
  ``SPDX-License-Identifier`` tag naming a committed licence.

The tag names are built from :data:`COPYRIGHT_NAME` and
:data:`LICENSE_NAME` rather than spelled out, so that ``reuse lint`` does not
read this module's own regular expressions and messages as licence
declarations.
"""

from __future__ import annotations

import argparse
import fnmatch
import re
import sys
from pathlib import Path

from fdp_repo_checks.findings import EXIT_ERROR, Finding, report
from fdp_repo_checks.gitfiles import list_files
from fdp_repo_checks.reuse_toml import ReuseToml, ReuseTomlError
from fdp_repo_checks.reuse_toml import load as load_reuse_toml

NAME = "spdx"
HELP = "check that every file declares a copyright and a known licence"

EXEMPT_GLOBS = (
    "LICENSES/**",
    "LICENSE",
    "LICENSE.*",
    "LICENSE-*",
    "COPYING",
    "COPYING.*",
    "NOTICE",
    "NOTICE.*",
    "REUSE.toml",
    ".reuse/**",
)
"""Paths the REUSE specification exempts from a header."""

HEADER_BYTES = 4096
"""How much of a file is read looking for the two tags."""

HEADER_LINES = 25
"""How far into a file a tag may sit."""

MAX_FILE_BYTES = 50 * 1024 * 1024
"""Nothing this large belongs in Git."""

COPYRIGHT_NAME = "SPDX-FileCopyrightText"
LICENSE_NAME = "SPDX-License-Identifier"

COPYRIGHT_TAG = re.compile(rf"{COPYRIGHT_NAME}:\s*\S")
LICENSE_TAG = re.compile(rf"{LICENSE_NAME}:\s*(\S+)")

BINARY_REASON = "binary file: needs a REUSE.toml annotation or .license sidecar"


def register(parser: argparse.ArgumentParser) -> None:
    """Add the sub-command's own options."""
    parser.add_argument(
        "--staged",
        action="store_true",
        help="check only the files staged for commit (pre-commit hook)",
    )


def is_exempt(path: str) -> bool:
    """True for the paths the REUSE specification needs no header on."""
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in EXEMPT_GLOBS)


def allowed_identifiers(root: Path) -> set[str]:
    """The SPDX identifiers this repository has a licence text for."""
    licenses = root / "LICENSES"
    if not licenses.is_dir():
        return set()
    return {entry.stem for entry in licenses.glob("*.txt")}


def _load_reuse(root: Path) -> ReuseToml | None:
    candidate = root / "REUSE.toml"
    return load_reuse_toml(candidate) if candidate.is_file() else None


def check_header(text: str, allowed: set[str]) -> str | None:
    """Return why ``text`` fails the header rule, or None when it passes."""
    head = text.splitlines()[:HEADER_LINES]
    joined = "\n".join(head)
    has_copyright = COPYRIGHT_TAG.search(joined) is not None
    match = LICENSE_TAG.search(joined)
    if not has_copyright and match is None:
        return f"no SPDX header in the first {HEADER_LINES} lines"
    if not has_copyright:
        return f"the {COPYRIGHT_NAME} tag is missing"
    if match is None:
        return f"the {LICENSE_NAME} tag is missing"
    identifier = match.group(1).rstrip(".,;:")
    if identifier not in allowed:
        known = ", ".join(sorted(allowed)) or "none committed"
        return f"unknown {LICENSE_NAME} {identifier!r} (LICENSES/ holds: {known})"
    return None


def _check_size(relative: str, absolute: Path) -> Finding | int:
    """The file's size, or the finding that keeps it out of Git."""
    try:
        size = absolute.stat().st_size
    except OSError as error:
        return Finding(relative, f"cannot be read ({error.strerror})")
    if size > MAX_FILE_BYTES:
        return Finding(
            relative,
            f"{size} bytes exceeds the limit of {MAX_FILE_BYTES} bytes for a tracked file",
        )
    return size


def _check_declaration(
    root: Path,
    relative: str,
    absolute: Path,
    *,
    allowed: set[str],
    reuse: ReuseToml | None,
) -> Finding | None:
    """Where the file's licence is declared: sidecar, table or own header."""
    sidecar = root / f"{relative}.license"
    if sidecar.is_file():
        reason = check_header(_read_head(sidecar), allowed)
        return Finding(f"{relative}.license", reason) if reason else None

    if reuse is not None and reuse.covered(relative) is not None:
        return None

    raw = absolute.read_bytes()[:HEADER_BYTES]
    if b"\0" in raw:
        return Finding(relative, BINARY_REASON)
    reason = check_header(raw.decode("utf-8", errors="replace"), allowed)
    return Finding(relative, reason) if reason else None


def check_file(
    root: Path,
    relative: str,
    *,
    allowed: set[str],
    reuse: ReuseToml | None,
) -> Finding | None:
    """Check one repository-relative path; None when it is fine."""
    absolute = root / relative
    if absolute.is_symlink() or not absolute.is_file():
        return None

    size = _check_size(relative, absolute)
    if isinstance(size, Finding):
        return size
    if size == 0:  # a placeholder such as .gitkeep declares nothing
        return None

    return _check_declaration(root, relative, absolute, allowed=allowed, reuse=reuse)


def _read_head(path: Path) -> str:
    return path.read_bytes()[:HEADER_BYTES].decode("utf-8", errors="replace")


def run(args: argparse.Namespace) -> int:
    """Check every enumerated file and report."""
    root: Path = args.root
    allowed = allowed_identifiers(root)
    if not allowed:
        print(
            f"fdp-checks spdx: {root}/LICENSES holds no *.txt licence text, "
            "so no identifier can be accepted",
            file=sys.stderr,
        )
        return EXIT_ERROR
    try:
        reuse = _load_reuse(root)
    except ReuseTomlError as error:
        print(f"fdp-checks spdx: {error}", file=sys.stderr)
        return EXIT_ERROR

    paths = [path for path in list_files(root, staged=args.staged) if not is_exempt(path)]
    findings = [
        finding
        for finding in (check_file(root, path, allowed=allowed, reuse=reuse) for path in paths)
        if finding is not None
    ]
    return report(NAME, findings, output_format=args.output_format, checked=len(paths))
