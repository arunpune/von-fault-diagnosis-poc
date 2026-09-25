# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-checks commits``: every commit message is a Conventional Commit.

The grammar (CONTRIBUTING.md, docs/development.md) is ``type(scope): subject``,
the scope required, an optional ``!`` for a breaking change, and a subject text
of at most :data:`MAX_SUBJECT_TEXT` characters that does not start with a space.
``Merge …`` and ``Revert "…"`` subjects are exempt, because Git writes them.

Two modes:

``--range A..B``
    every commit of a range, read from ``git log``. Without it the range is
    the merge base with ``--base`` (the branch the work forked from),
    and without that the last :data:`DEFAULT_DEPTH` commits.
``--message FILE``
    one message file, which is what the ``commit-msg`` hook passes. Git's
    comment lines and everything below the scissors line are dropped first,
    exactly as ``git commit`` would drop them.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from fdp_repo_checks.findings import EXIT_ERROR, Finding, report

NAME = "commits"
HELP = "check that every commit message follows Conventional Commits"

TYPES = (
    "feat",
    "fix",
    "docs",
    "test",
    "build",
    "ci",
    "chore",
    "refactor",
    "perf",
    "style",
)
"""The accepted commit types."""

SCOPES = (
    "repo",
    "manual",
    "pdf",
    "contracts",
    "gt",
    "db",
    "sim",
    "gateway",
    "init",
    "backend",
    "frontend",
    "eval",
    "infra",
    "ci",
    "deps",
    "docs",
    "data",
    "merge",
)
"""The accepted commit scopes; ``merge`` is for merge commits."""

MAX_SUBJECT_TEXT = 72
"""How long the text after ``type(scope): `` may be."""

DEFAULT_DEPTH = 20
"""How far back the check looks when neither ``--range`` nor ``--base`` is given."""

SUBJECT_RE = re.compile(
    rf"^({'|'.join(TYPES)})\(({'|'.join(SCOPES)})\)!?: [^ ].{{0,{MAX_SUBJECT_TEXT - 1}}}$"
)
"""The subject rule as one regular expression."""

_LOOSE_RE = re.compile(
    r"^(?P<type>[A-Za-z]+)(?:\((?P<scope>[^)]*)\))?!?:(?P<gap>[ \t]*)(?P<text>.*)$"
)
"""A permissive parse used only to say *why* a subject was rejected."""

EXEMPT_PREFIXES = ("Merge ", 'Revert "')
"""Subjects Git itself writes, which no rule of ours applies to."""

_LOG_FORMAT = "%H%x00%s%x00%b%x1e"
"""Hash, subject and body per commit; NUL between fields, RS between commits."""

_RECORD_SEPARATOR = "\x1e"
_ABBREV = 12
_GIT_TIMEOUT_S = 60
_COMMENT_PREFIX = "#"
SCISSORS = "# ------------------------ >8 ------------------------"
"""The line below which ``git commit --verbose`` puts the diff."""


class GitError(RuntimeError):
    """Git could not answer the question this check asks."""


@dataclass(frozen=True)
class Commit:
    """One message to judge, named by where it came from."""

    ref: str
    """The abbreviated hash, or the path of the message file."""

    subject: str
    body: str


def register(parser: argparse.ArgumentParser) -> None:
    """Add the sub-command's own options."""
    source = parser.add_mutually_exclusive_group()
    source.add_argument(
        "--range",
        dest="commit_range",
        metavar="A..B",
        help=f"the commit range to check (default: the last {DEFAULT_DEPTH} commits)",
    )
    source.add_argument(
        "--message",
        dest="message_file",
        metavar="FILE",
        help="check a single message file instead of a range (the commit-msg hook)",
    )
    parser.add_argument(
        "--base",
        metavar="REF",
        help="check the commits since the merge base with REF, e.g. origin/main",
    )


def _git(root: Path, args: Sequence[str]) -> str:
    """Run git inside ``root`` and return its stdout.

    Raises:
        GitError: git is missing, or the command failed.
    """
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            check=False,
            text=True,
            timeout=_GIT_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise GitError(f"cannot run git in {root}: {error}") from error
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "no output"
        raise GitError(f"git {' '.join(args)} failed: {detail}")
    return completed.stdout


def _revision_exists(root: Path, revision: str) -> bool:
    """True when ``revision`` names a commit in ``root``."""
    try:
        _git(root, ["rev-parse", "--verify", "--quiet", f"{revision}^{{commit}}"])
    except GitError:
        return False
    return True


def resolve_range(root: Path, commit_range: str | None, base: str | None) -> str:
    """Decide which revisions to read.

    ``--range`` wins; then the merge base with ``--base``; otherwise the last
    :data:`DEFAULT_DEPTH` commits. A repository younger than that has no
    ``HEAD~20``, so the whole history is read instead — still at most
    :data:`DEFAULT_DEPTH` commits.

    Raises:
        GitError: ``--base`` does not name a commit, or has no common ancestor.
    """
    if commit_range:
        return commit_range
    if base:
        if not _revision_exists(root, base):
            raise GitError(f"--base {base}: no such commit in {root}")
        merge_base = _git(root, ["merge-base", base, "HEAD"]).strip()
        if not merge_base:
            raise GitError(f"--base {base}: no common ancestor with HEAD")
        return f"{merge_base}..HEAD"
    deep = f"HEAD~{DEFAULT_DEPTH}"
    return f"{deep}..HEAD" if _revision_exists(root, deep) else "HEAD"


def parse_log(output: str) -> list[Commit]:
    """Turn the ``git log`` records of :data:`_LOG_FORMAT` into commits."""
    commits: list[Commit] = []
    for raw in output.split(_RECORD_SEPARATOR):
        record = raw.strip("\n")
        if not record:
            continue
        digest, subject, body = record.split("\0", 2)
        commits.append(Commit(ref=digest[:_ABBREV], subject=subject, body=body))
    return commits


def read_range(root: Path, commit_range: str) -> list[Commit]:
    """Read every commit of ``commit_range``.

    Raises:
        GitError: the range is not a range, or the repository has no commits.
    """
    return parse_log(_git(root, ["log", f"--format={_LOG_FORMAT}", commit_range, "--"]))


def strip_comments(text: str) -> str:
    """Drop what ``git commit`` drops: comment lines and the scissors tail."""
    kept: list[str] = []
    for line in text.splitlines():
        if line.rstrip() == SCISSORS:
            break
        if not line.startswith(_COMMENT_PREFIX):
            kept.append(line)
    return "\n".join(kept)


def read_message(path: Path) -> Commit:
    """Read one commit-message file the way the ``commit-msg`` hook gets it.

    Raises:
        GitError: the file cannot be read, or holds no message at all.
    """
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        raise GitError(f"--message {path}: cannot be read ({error.strerror})") from error
    lines = strip_comments(raw).splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    if not lines:
        raise GitError(f"--message {path}: the message is empty")
    return Commit(ref=path.as_posix(), subject=lines[0], body="\n".join(lines[1:]))


def is_exempt(subject: str) -> bool:
    """True for the merge and revert subjects Git writes itself."""
    return subject.startswith(EXEMPT_PREFIXES)


def _type_reason(found: str) -> str | None:
    if found in TYPES:
        return None
    return f"unknown type {found!r} (allowed: {', '.join(TYPES)})"


def _scope_reason(found: str | None) -> str | None:
    if found is None:
        return "the scope is missing; write `type(scope): subject`"
    if found in SCOPES:
        return None
    return f"unknown scope {found!r} (allowed: {', '.join(SCOPES)})"


def _gap_reason(found: str) -> str | None:
    if found == " ":
        return None
    return "exactly one space must follow the colon"


def _text_reason(found: str) -> str | None:
    if not found:
        return "the subject text after the colon is empty"
    if len(found) > MAX_SUBJECT_TEXT:
        return f"the subject text is {len(found)} characters, at most {MAX_SUBJECT_TEXT} allowed"
    return None


def subject_reason(subject: str) -> str | None:
    """Why ``subject`` is rejected, or None when it passes."""
    if is_exempt(subject) or SUBJECT_RE.match(subject) is not None:
        return None
    match = _LOOSE_RE.match(subject)
    if match is None:
        return "does not have the form `type(scope): subject`"
    reasons: Iterable[str | None] = (
        _type_reason(match["type"]),
        _scope_reason(match["scope"]),
        _gap_reason(match["gap"]),
        _text_reason(match["text"]),
    )
    for reason in reasons:
        if reason is not None:
            return reason
    return "does not have the form `type(scope): subject`"


def check(commit: Commit) -> Finding | None:
    """Judge one message; None when it is fine."""
    reason = subject_reason(commit.subject)
    if reason is not None:
        return Finding(commit.ref, f"{reason} (subject: {commit.subject!r})")
    return None


def collect(args: argparse.Namespace) -> list[Commit]:
    """The messages the given options ask for.

    Raises:
        GitError: the messages cannot be read.
    """
    root: Path = args.root
    message_file: str | None = args.message_file
    if message_file is not None:
        return [read_message(Path(message_file))]
    return read_range(root, resolve_range(root, args.commit_range, args.base))


def run(args: argparse.Namespace) -> int:
    """Check every message the options select and report."""
    try:
        commits = collect(args)
    except GitError as error:
        print(f"fdp-checks {NAME}: {error}", file=sys.stderr)
        return EXIT_ERROR
    findings = [finding for finding in (check(commit) for commit in commits) if finding is not None]
    return report(
        NAME,
        findings,
        output_format=args.output_format,
        checked=len(commits),
        unit="commits",
    )
