# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Fixture repositories and header samples the checks are driven over.

Every test builds a throw-away repository with ``git init`` in ``tmp_path``
and runs the real CLI against it, so the checks are exercised through the
same enumeration path they use in anger. Nothing reaches the network, the
clock or the surrounding repository: ``git`` runs with a fixed identity, an
empty global configuration and a fixed commit date.

``conftest.py`` puts this directory on ``sys.path``, so a test module imports
from it by name.

The header samples below sit between REUSE ignore markers: they are test
data, not this file's own licence.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from fdp_repo_checks import cli

# REUSE-IgnoreStart
HEADER_OK = "# SPDX-FileCopyrightText: 2026 Meddle S.r.l.\n# SPDX-License-Identifier: Apache-2.0\n"
HEADER_UNKNOWN_ID = (
    "# SPDX-FileCopyrightText: 2026 Meddle S.r.l.\n# SPDX-License-Identifier: BSD-3-Clause\n"
)
HEADER_NO_COPYRIGHT = "# SPDX-License-Identifier: Apache-2.0\n"
HEADER_NO_LICENSE = "# SPDX-FileCopyrightText: 2026 Meddle S.r.l.\n"
SIDECAR = "SPDX-FileCopyrightText: 2026 Meddle S.r.l.\nSPDX-License-Identifier: CC-BY-4.0\n"
# REUSE-IgnoreEnd

LICENSE_IDS = ("Apache-2.0", "CC-BY-4.0", "CC0-1.0")
"""Licence texts every fixture repository ships, so ``spdx`` has an allow-set."""

_GIT_ENV = {
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
    "GIT_AUTHOR_NAME": "Fixture",
    "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
    "GIT_AUTHOR_DATE": "2026-01-01T00:00:00+00:00",
    "GIT_COMMITTER_NAME": "Fixture",
    "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
    "GIT_COMMITTER_DATE": "2026-01-01T00:00:00+00:00",
}


@dataclass(frozen=True)
class FixtureRepo:
    """A throw-away git repository a check can be pointed at."""

    path: Path

    def git(self, *args: str) -> subprocess.CompletedProcess[str]:
        """Run git inside the fixture with a fixed identity."""
        return subprocess.run(
            ["git", "-C", str(self.path), *args],
            capture_output=True,
            check=True,
            text=True,
            env={"PATH": os.environ.get("PATH", ""), **_GIT_ENV},
        )

    def write(self, relative: str, content: str | bytes) -> Path:
        """Create a file (and its parents) inside the fixture."""
        target = self.path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_text(content, encoding="utf-8")
        return target

    def commit_all(self, message: str = "fixture") -> None:
        """Stage everything and commit it."""
        self.git("add", "-A")
        self.git("commit", "-m", message)

    def run(self, *argv: str) -> int:
        """Run the real CLI against this fixture and return its exit code."""
        return cli.main([*argv, "--root", str(self.path)])


def make_repo(path: Path) -> FixtureRepo:
    """Initialise a repository at ``path`` and commit the licence texts."""
    path.mkdir(parents=True, exist_ok=True)
    repo = FixtureRepo(path)
    repo.git("init", "-b", "main")
    for identifier in LICENSE_IDS:
        repo.write(f"LICENSES/{identifier}.txt", f"Text of {identifier}.\n")
    repo.commit_all("licences")
    return repo
