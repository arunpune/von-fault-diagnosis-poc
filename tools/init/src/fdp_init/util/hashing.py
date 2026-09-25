# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""SHA-256 helpers and the sidecar cache.

The MetroPT-3 CSV is about 218 MB, so re-hashing it on every ``make up`` would
add seconds to a run that otherwise does nothing. :class:`Sidecar` stores the
digest beside the file with the size and mtime it was computed from, and is
trusted only while both still match.
"""

from __future__ import annotations

import hashlib
import json
import re
from contextlib import suppress
from dataclasses import asdict, dataclass
from pathlib import Path

from fdp_init.errors import ExitCode, InitError

STEP = "config"

BLOCK_SIZE = 1024 * 1024
"""1 MiB, the same block the downloader streams with."""

SIDECAR_SUFFIX = ".sha256.json"

_SUMS_LINE = re.compile(r"^(?P<digest>[0-9a-f]{64})\s{1,2}[ *]?(?P<name>.+)$")
"""``sha256sum`` output: the digest, two spaces (one plus ``*`` in binary
mode), then the file name."""


def sha256_file(path: Path) -> str:
    """Return the hex SHA-256 of a file, read in :data:`BLOCK_SIZE` blocks."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(BLOCK_SIZE):
            digest.update(block)
    return digest.hexdigest()


def read_sha256sums(path: Path) -> dict[str, str]:
    """Parse a committed ``sha256sum`` file into ``{name: digest}``.

    Blank lines and ``#`` comments are skipped. Names are kept verbatim,
    including the parentheses of ``MetroPT3(AirCompressor).csv``.

    Raises:
        InitError: exit code 2, when the file is missing, unreadable or has a
            line that is not in ``sha256sum`` format.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise InitError(ExitCode.CONFIG, f"cannot read {path}: {exc}", STEP) from exc

    sums: dict[str, str] = {}
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = _SUMS_LINE.match(line)
        if match is None:
            raise InitError(
                ExitCode.CONFIG,
                f"{path}:{number} is not in sha256sum format: {raw!r}",
                STEP,
            )
        sums[match.group("name").strip()] = match.group("digest")
    return sums


@dataclass(frozen=True, slots=True)
class Sidecar:
    """A cached digest, valid only for one exact version of a file."""

    sha256: str
    size: int
    mtime_ns: int

    @staticmethod
    def path_for(target: Path) -> Path:
        """``<file>.sha256.json``, beside the file it describes."""
        return target.with_name(target.name + SIDECAR_SUFFIX)

    @classmethod
    def load(cls, target: Path) -> Sidecar | None:
        """Read the sidecar of ``target``, or ``None`` when it is unusable.

        A missing, truncated or hand-edited sidecar is not an error: the
        caller simply hashes the file again.
        """
        sidecar = cls.path_for(target)
        try:
            payload = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        try:
            return cls(
                sha256=str(payload["sha256"]),
                size=int(payload["size"]),
                mtime_ns=int(payload["mtime_ns"]),
            )
        except (KeyError, TypeError, ValueError):
            return None

    @classmethod
    def write(cls, target: Path, sha256: str) -> Sidecar:
        """Store ``sha256`` for the current size and mtime of ``target``."""
        stat = target.stat()
        sidecar = cls(sha256=sha256, size=stat.st_size, mtime_ns=stat.st_mtime_ns)
        cls.path_for(target).write_text(
            json.dumps(asdict(sidecar), sort_keys=True) + "\n", encoding="utf-8"
        )
        return sidecar

    def matches(self, target: Path) -> bool:
        """True when ``target`` still has the size and mtime that was hashed."""
        try:
            stat = target.stat()
        except OSError:
            return False
        return stat.st_size == self.size and stat.st_mtime_ns == self.mtime_ns


def cached_sha256(target: Path, *, rehash: bool = False) -> str:
    """Hash ``target``, reusing a trusted sidecar and refreshing it otherwise.

    ``rehash=True`` is ``fdp-init dataset --rehash``: ignore the sidecar and
    read the whole file.
    """
    if not rehash:
        sidecar = Sidecar.load(target)
        if sidecar is not None and sidecar.matches(target):
            return sidecar.sha256
    digest = sha256_file(target)
    # A read-only mount cannot take the sidecar; the digest is still correct.
    with suppress(OSError):
        Sidecar.write(target, digest)
    return digest
