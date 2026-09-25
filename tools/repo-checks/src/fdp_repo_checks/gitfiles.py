# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Enumerate the files a check looks at.

The authoritative list is Git's: tracked files plus untracked files that are
not ignored, so a check sees exactly what a commit would carry. When Git is
absent or the directory is not a work tree the module walks the directory
instead, skipping the directories that never hold source.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

WALK_SKIP_DIRS = frozenset({".git", "node_modules", ".venv", "dist", "coverage", "__pycache__"})
"""Directory names the os.walk fallback never descends into."""

_GIT_TIMEOUT_S = 60


def git_toplevel(start: Path) -> Path | None:
    """Return the work-tree root that contains ``start``, or None."""
    try:
        completed = subprocess.run(
            ["git", "-C", str(start), "rev-parse", "--show-toplevel"],
            capture_output=True,
            check=False,
            text=True,
            timeout=_GIT_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    top = completed.stdout.strip()
    return Path(top) if top else None


def _git_lines(root: Path, args: list[str]) -> list[str] | None:
    """Run a NUL-separated git command in ``root``; None when git cannot."""
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            check=False,
            timeout=_GIT_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    out = completed.stdout.decode("utf-8", errors="surrogateescape")
    return [entry for entry in out.split("\0") if entry]


def _walk(root: Path) -> list[str]:
    """Fallback enumeration: every file below ``root`` worth checking."""
    found: list[str] = []
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = sorted(current.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.is_symlink():
                found.append(entry.relative_to(root).as_posix())
                continue
            if entry.is_dir():
                if entry.name not in WALK_SKIP_DIRS:
                    stack.append(entry)
            elif entry.is_file():
                found.append(entry.relative_to(root).as_posix())
    return sorted(found)


def list_files(root: Path, *, staged: bool = False) -> list[str]:
    """Return repository-relative POSIX paths, sorted and de-duplicated.

    With ``staged`` the list is what ``git commit`` would record right now,
    which is what the pre-commit hook needs; deleted paths are dropped.
    """
    if staged:
        lines = _git_lines(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=d"])
        return sorted(set(lines)) if lines is not None else []
    lines = _git_lines(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    if lines is None:
        return _walk(root)
    return sorted(set(lines))
