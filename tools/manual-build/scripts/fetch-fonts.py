#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Fetch the six IBM Plex faces the manual embeds.

The script downloads the two IBM Plex release zips pinned below, verifies
their SHA-256, extracts only the static TrueType faces the manual needs plus
the zip's ``LICENSE.txt``, and writes ``manual/fonts/fonts.json`` with a
per-file hash and byte size.

The extracted files are committed, so the usual run is a no-op: with nothing to
do the script touches the network at all only when a file is missing or its
hash drifted. ``--check`` never downloads and is what the tests and a pre-build
guard use.

Every hash here is a pin, not a record of what happened to be downloaded. A
mismatch is a hard failure with the expected and the actual digest side by
side: re-pinning belongs in a reviewed change to the pins in this file, never
in a silent rewrite.

Standard library only, so it runs from a bare checkout before ``uv sync``.

Usage::

    python3 tools/manual-build/scripts/fetch-fonts.py            # fetch if needed
    python3 tools/manual-build/scripts/fetch-fonts.py --check    # verify, offline
    python3 tools/manual-build/scripts/fetch-fonts.py --force    # re-download
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

#: ``fonts.json`` schema identifier; bump when the shape changes.
SCHEMA = "urn:fdp:fonts:v1"

#: Where the fonts live, relative to the repository root.
FONTS_RELATIVE = Path("manual") / "fonts"

#: The licence file both release zips ship, copied next to the faces.
LICENSE_NAME = "LICENSE.txt"

#: Only ``https`` URLs are ever opened (the pins below are the only sources).
_ALLOWED_SCHEME = "https://"

#: Read the download in chunks so a 10 MB zip never sits in memory twice.
_CHUNK = 1 << 16


class FontFetchError(RuntimeError):
    """A pin did not hold: a bad digest, a bad size or a missing member."""


@dataclass(frozen=True)
class Face:
    """One static TrueType face taken from a release zip."""

    file: str
    weight: int
    style: str
    size: int
    """Expected byte size, pinned here."""


@dataclass(frozen=True)
class Family:
    """One IBM Plex release: the zip it comes from and the faces we keep."""

    family: str
    release: str
    url: str
    zip_sha256: str
    root: str
    """Top-level directory inside the zip."""
    faces: tuple[Face, ...]

    @property
    def archive_name(self) -> str:
        return self.url.rsplit("/", 1)[-1]

    def member(self, face: Face) -> str:
        return f"{self.root}/fonts/complete/ttf/{face.file}"

    @property
    def license_member(self) -> str:
        return f"{self.root}/{LICENSE_NAME}"


#: The two pinned IBM Plex releases. No other font, no woff2, no variable fonts.
FAMILIES: tuple[Family, ...] = (
    Family(
        family="IBM Plex Sans",
        release="@ibm/plex-sans@1.1.0",
        url=(
            "https://github.com/IBM/plex/releases/download/"
            "%40ibm%2Fplex-sans%401.1.0/ibm-plex-sans.zip"
        ),
        zip_sha256="fb365d910566e6d199cc2c15579a7dd9a267128e18431a394ed81f1970c69200",
        root="ibm-plex-sans",
        faces=(
            Face(file="IBMPlexSans-Regular.ttf", weight=400, style="normal", size=200_500),
            Face(file="IBMPlexSans-Italic.ttf", weight=400, style="italic", size=207_920),
            Face(file="IBMPlexSans-Bold.ttf", weight=700, style="normal", size=200_872),
            Face(file="IBMPlexSans-BoldItalic.ttf", weight=700, style="italic", size=208_588),
        ),
    ),
    Family(
        family="IBM Plex Mono",
        release="@ibm/plex-mono@2.5.0",
        url=(
            "https://github.com/IBM/plex/releases/download/"
            "%40ibm%2Fplex-mono%402.5.0/ibm-plex-mono.zip"
        ),
        zip_sha256="6d23f01257663d8cc49a0d64c22ced630b79e0e2a0ac08a0da86e9a38bbc481c",
        root="ibm-plex-mono",
        faces=(
            Face(file="IBMPlexMono-Regular.ttf", weight=400, style="normal", size=173_052),
            Face(file="IBMPlexMono-Bold.ttf", weight=700, style="normal", size=175_096),
        ),
    ),
)


def iter_faces() -> Iterator[tuple[Family, Face]]:
    """Yield every pinned face with the family it belongs to, in file order."""
    for family in FAMILIES:
        for face in family.faces:
            yield family, face


def digest(data: bytes) -> str:
    """SHA-256 of ``data`` as lowercase hex."""
    return hashlib.sha256(data).hexdigest()


def digest_file(path: Path) -> str:
    """SHA-256 of a file read in chunks."""
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            hasher.update(chunk)
    return hasher.hexdigest()


def verify_digest(label: str, actual: str, expected: str) -> None:
    """Raise :class:`FontFetchError` unless ``actual`` is the pinned digest."""
    if actual != expected:
        raise FontFetchError(
            f"{label}: SHA-256 mismatch\n"
            f"  expected {expected}\n"
            f"  actual   {actual}\n"
            "Refusing to pin the new hash. If the upstream release really changed, "
            "update the pins in tools/manual-build/scripts/fetch-fonts.py in a reviewed "
            "change first."
        )


def verify_size(label: str, actual: int, expected: int) -> None:
    """Raise :class:`FontFetchError` unless ``actual`` is the pinned byte size."""
    if actual != expected:
        raise FontFetchError(
            f"{label}: size mismatch, expected {expected} bytes, got {actual} bytes"
        )


def download(family: Family, cache_dir: Path) -> Path:
    """Return the verified release zip, downloading it only when needed."""
    if not family.url.startswith(_ALLOWED_SCHEME):
        raise FontFetchError(f"{family.release}: only https downloads are allowed")
    cache_dir.mkdir(parents=True, exist_ok=True)
    archive = cache_dir / family.archive_name
    if archive.is_file() and digest_file(archive) == family.zip_sha256:
        return archive
    print(f"downloading {family.url}", file=sys.stderr)
    with tempfile.NamedTemporaryFile(dir=cache_dir, delete=False) as scratch:
        partial = Path(scratch.name)
        with urllib.request.urlopen(family.url) as response:  # noqa: S310 - https pin above
            shutil.copyfileobj(response, scratch, _CHUNK)
    verify_digest(family.archive_name, digest_file(partial), family.zip_sha256)
    partial.replace(archive)
    return archive


def extract(family: Family, archive: Path, fonts_dir: Path) -> bytes:
    """Write the family's faces into ``fonts_dir``; return the zip's licence text."""
    fonts_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as zf:
        for face in family.faces:
            member = family.member(face)
            try:
                payload = zf.read(member)
            except KeyError as error:
                raise FontFetchError(f"{family.archive_name}: no member {member}") from error
            verify_size(face.file, len(payload), face.size)
            (fonts_dir / face.file).write_bytes(payload)
        try:
            return zf.read(family.license_member)
        except KeyError as error:
            raise FontFetchError(
                f"{family.archive_name}: no member {family.license_member}"
            ) from error


def write_license(fonts_dir: Path, texts: Sequence[bytes]) -> None:
    """Write the shared OFL text once, with the repository's LF line endings.

    Both release zips carry the same ``LICENSE.txt`` (the OFL with the Reserved
    Font Name notice) with CRLF endings; ``.gitattributes`` normalises tracked
    text to LF, so the bytes are normalised here too and the working tree stays
    clean after a fetch. The wording is untouched.
    """
    if len({text.replace(b"\r\n", b"\n") for text in texts}) != 1:
        raise FontFetchError("the release zips carry different LICENSE.txt texts")
    (fonts_dir / LICENSE_NAME).write_bytes(texts[0].replace(b"\r\n", b"\n"))


def manifest(fonts_dir: Path) -> dict[str, object]:
    """Build ``fonts.json`` from the files now on disk, hashing each one."""
    families: list[dict[str, object]] = []
    for family in FAMILIES:
        files: list[dict[str, object]] = []
        for face in family.faces:
            path = fonts_dir / face.file
            if not path.is_file():
                raise FontFetchError(f"{face.file}: missing from {fonts_dir}")
            payload = path.read_bytes()
            verify_size(face.file, len(payload), face.size)
            files.append(
                {
                    "file": face.file,
                    "weight": face.weight,
                    "style": face.style,
                    "sha256": digest(payload),
                    "bytes": len(payload),
                }
            )
        families.append(
            {
                "family": family.family,
                "release": family.release,
                "source": family.url,
                "zip_sha256": family.zip_sha256,
                "license": "OFL-1.1",
                "files": files,
            }
        )
    return {"schema": SCHEMA, "families": families}


def write_manifest(fonts_dir: Path) -> bool:
    """Write ``fonts.json``; return True when the file changed on disk."""
    path = fonts_dir / "fonts.json"
    text = json.dumps(manifest(fonts_dir), indent=2) + "\n"
    if path.is_file() and path.read_text(encoding="utf-8") == text:
        return False
    path.write_text(text, encoding="utf-8")
    return True


def check(fonts_dir: Path) -> list[str]:
    """Return one message per drift between ``fonts.json`` and the files.

    Offline and side-effect free: it is the guard a build runs before rendering
    and what the unit tests assert on.
    """
    path = fonts_dir / "fonts.json"
    if not path.is_file():
        return [f"{path}: missing"]
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return [f"{path}: unreadable ({error})"]
    problems: list[str] = []
    if document.get("schema") != SCHEMA:
        problems.append(f"{path}: schema is {document.get('schema')!r}, expected {SCHEMA!r}")
    expected = manifest_expectations()
    recorded = {
        entry["file"]: (entry.get("sha256"), entry.get("bytes"))
        for family in document.get("families", [])
        for entry in family.get("files", [])
    }
    if sorted(recorded) != sorted(expected):
        problems.append(
            f"{path}: records {sorted(recorded)}, expected {sorted(expected)}",
        )
    problems.extend(_file_problems(fonts_dir, recorded))
    if not (fonts_dir / LICENSE_NAME).is_file():
        problems.append(f"{fonts_dir / LICENSE_NAME}: missing")
    return problems


def manifest_expectations() -> dict[str, int]:
    """The pinned ``file -> byte size`` map, independent of what is on disk."""
    return {face.file: face.size for _family, face in iter_faces()}


def _file_problems(fonts_dir: Path, recorded: dict[str, tuple[str, int]]) -> list[str]:
    problems: list[str] = []
    for name, (sha256, size) in sorted(recorded.items()):
        path = fonts_dir / name
        if not path.is_file():
            problems.append(f"{path}: missing")
            continue
        actual_size = path.stat().st_size
        if actual_size != size:
            problems.append(f"{path}: {actual_size} bytes, fonts.json records {size}")
        actual = digest_file(path)
        if actual != sha256:
            problems.append(f"{path}: SHA-256 {actual}, fonts.json records {sha256}")
    return problems


def fetch(fonts_dir: Path, cache_dir: Path) -> bool:
    """Download, verify and extract every family; return True when files changed."""
    before = {
        path.name: digest_file(path) for path in sorted(fonts_dir.glob("*")) if path.is_file()
    }
    texts = [extract(family, download(family, cache_dir), fonts_dir) for family in FAMILIES]
    write_license(fonts_dir, texts)
    changed = write_manifest(fonts_dir)
    after = {path.name: digest_file(path) for path in sorted(fonts_dir.glob("*")) if path.is_file()}
    return changed or before != after


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument(
        "--fonts-dir",
        type=Path,
        default=Path(__file__).resolve().parents[3] / FONTS_RELATIVE,
        help="where the faces are written (default: manual/fonts of this checkout)",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path(tempfile.gettempdir()) / "fdp-plex-zips",
        help="where the release zips are kept between runs",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the committed files against fonts.json and exit; never downloads",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="download and extract even when the committed files already verify",
    )
    args = parser.parse_args(argv)

    fonts_dir: Path = args.fonts_dir
    problems = check(fonts_dir)
    if args.check:
        for problem in problems:
            print(problem, file=sys.stderr)
        print("fonts: up to date" if not problems else f"fonts: {len(problems)} problem(s)")
        return 0 if not problems else 1
    if not problems and not args.force:
        print("fonts: up to date, nothing downloaded")
        return 0
    try:
        changed = fetch(fonts_dir, args.cache_dir)
    except FontFetchError as error:
        print(f"fetch-fonts: {error}", file=sys.stderr)
        return 1
    remaining = check(fonts_dir)
    if remaining:
        for problem in remaining:
            print(problem, file=sys.stderr)
        return 1
    print(f"fonts: {'updated' if changed else 'up to date'} in {fonts_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
