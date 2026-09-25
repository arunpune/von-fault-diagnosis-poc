# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``data/manual/build-manifest.json``.

The manifest is the audit trail behind acceptance check #9: it records where
the PDFs were built (the pinned container or a developer's machine), which tool
and system package versions produced them, the SHA-256 of every input file, and
the PDF and extracted-text hashes of every output. A rebuild writes a second
manifest and :func:`compare` names every field that moved.

Everything here is a pure function of its arguments except ``wall_time``,
which the caller passes in — from :func:`wall_time_now`, the one clock reading
of the whole build — and which :func:`compare` ignores. This module is the one
file ``tests/unit/test_determinism_lint.py`` exempts from the no-clock rule,
and it stays importable without Pango: :mod:`fdp_manual_build.render` only
reaches for WeasyPrint when it actually renders.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, Final

from fdp_manual_build import __version__
from fdp_manual_build.errors import BuildError
from fdp_manual_build.render import PAGE_SEPARATOR, extract_pages

__all__ = [
    "CONTAINER_ENV",
    "IMAGE_DIGEST_ENV",
    "IMAGE_REF_ENV",
    "SCHEMA",
    "SYSTEM_PACKAGES_PATH",
    "TOOL_DISTRIBUTIONS",
    "WALL_TIME_KEY",
    "BuildRecord",
    "FileOutput",
    "Manifest",
    "PdfOutput",
    "compare",
    "hash_file",
    "inputs_tree_sha256",
    "manifest_document",
    "read_manifest",
    "refresh_manifest",
    "text_sha256",
    "tool_versions",
    "wall_time_now",
    "write_manifest",
]

#: The JSON document; the keys are written in this order.
type Manifest = dict[str, Any]
#: One PDF or one exported file, as ``outputs`` records it.
type Output = PdfOutput | FileOutput

#: ``schema`` of the manifest document.
SCHEMA: Final = "urn:fdp:manifest:manual-build:v1"
#: Set to ``1`` by the Dockerfile; how ``built_in`` is decided.
CONTAINER_ENV: Final = "FDP_BUILD_IN_CONTAINER"
#: The base image the Dockerfile records into the image, without the digest.
IMAGE_REF_ENV: Final = "FDP_BUILD_IMAGE_REF"
#: The base image digest the Dockerfile records into the image.
IMAGE_DIGEST_ENV: Final = "FDP_BUILD_IMAGE_DIGEST"
#: ``dpkg-query`` output the Dockerfile leaves behind.
SYSTEM_PACKAGES_PATH: Final = Path("/etc/fdp-system-packages.txt")
#: The one field a rebuild is allowed to differ in.
WALL_TIME_KEY: Final = "wall_time"
#: ``tool_versions`` keys → the installed distribution they are read from.
TOOL_DISTRIBUTIONS: Final[tuple[tuple[str, str], ...]] = (
    ("weasyprint", "weasyprint"),
    ("pydyf", "pydyf"),
    ("fonttools", "fonttools"),
    ("markdown-it-py", "markdown-it-py"),
    ("jinja2", "jinja2"),
)


@dataclass(frozen=True)
class PdfOutput:
    """One rendered variant, as ``outputs.<variant>`` records it.

    ``size`` is written as ``bytes`` in the document; the field is not called
    ``bytes`` so that the built-in stays usable inside the class body.
    """

    path: str
    pdf_sha256: str
    text_sha256: str
    pages: int
    size: int

    @classmethod
    def of(cls, path: str, pdf_bytes: bytes) -> PdfOutput:
        """Hash and measure ``pdf_bytes`` the way check #9 does."""
        pages = extract_pages(pdf_bytes)
        return cls(
            path=path,
            pdf_sha256=hashlib.sha256(pdf_bytes).hexdigest(),
            text_sha256=_sha256_text(PAGE_SEPARATOR.join(pages)),
            pages=len(pages),
            size=len(pdf_bytes),
        )

    def as_json(self) -> dict[str, Any]:
        """The entry as the manifest writes it."""
        return {
            "path": self.path,
            "pdf_sha256": self.pdf_sha256,
            "text_sha256": self.text_sha256,
            "pages": self.pages,
            "bytes": self.size,
        }


@dataclass(frozen=True)
class FileOutput:
    """A non-PDF output such as ``tools/eval/fixtures/catalog.json``."""

    path: str
    sha256: str

    @classmethod
    def of(cls, path: str, data: bytes) -> FileOutput:
        """Hash ``data`` and record it under ``path``."""
        return cls(path=path, sha256=hashlib.sha256(data).hexdigest())

    def as_json(self) -> dict[str, Any]:
        """The entry as the manifest writes it."""
        return {"path": self.path, "sha256": self.sha256}


@dataclass(frozen=True)
class BuildRecord:
    """What one build contributes to its manifest.

    Attributes:
        source_date_epoch: ``build.yaml``'s fixed timestamp. WeasyPrint does
            not read it; the manifest records it so a change is visible.
        inputs: repository-relative path → SHA-256 of every file read.
        outputs: name → the artefact it produced, in the order to write them.
        wall_time: when the build ran; the only non-reproducible field.
    """

    source_date_epoch: int
    inputs: Mapping[str, str]
    outputs: Mapping[str, Output]
    wall_time: datetime


def write_manifest(
    path: Path,
    record: BuildRecord,
    *,
    environ: Mapping[str, str] | None = None,
    system_packages_path: Path = SYSTEM_PACKAGES_PATH,
) -> Manifest:
    """Write ``record`` to ``path`` as the build manifest and return it."""
    document = manifest_document(record, environ=environ, system_packages_path=system_packages_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_serialize(document), encoding="utf-8")
    return document


def refresh_manifest(
    path: Path,
    record: BuildRecord,
    *,
    environ: Mapping[str, str] | None = None,
    system_packages_path: Path = SYSTEM_PACKAGES_PATH,
) -> Manifest:
    """Write ``record`` to ``path``, keeping a still-valid manifest byte-identical.

    ``wall_time`` is the one field of the manifest that moves on every run, and the
    manifest is a *committed* artefact: written blindly it would leave
    ``data/manual/build-manifest.json`` modified after every ``make manual``,
    which is exactly what the reproducibility acceptance forbids. So when a
    manifest is already there and :func:`compare` finds nothing but the clock
    between the two, the recorded ``wall_time`` is kept — it then says when
    this content was first built, which is the honest answer.

    Returns the document as written.
    """
    document = manifest_document(record, environ=environ, system_packages_path=system_packages_path)
    previous = _previous(path)
    if previous is not None and not compare(previous, document):
        document[WALL_TIME_KEY] = previous[WALL_TIME_KEY]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_serialize(document), encoding="utf-8")
    return document


def wall_time_now() -> datetime:
    """The clock reading a fresh :class:`BuildRecord` is stamped with.

    The build may not read a clock — ``tests/unit/test_determinism_lint.py``
    forbids it everywhere but here — so it asks this module for the one value
    that is allowed to move between two runs.
    """
    return datetime.now(UTC)


def manifest_document(
    record: BuildRecord,
    *,
    environ: Mapping[str, str] | None = None,
    system_packages_path: Path = SYSTEM_PACKAGES_PATH,
) -> Manifest:
    """Build the manifest document without touching the file system."""
    env = os.environ if environ is None else environ
    built_in = "container" if env.get(CONTAINER_ENV) == "1" else "native"
    inputs = dict(sorted(record.inputs.items()))
    return {
        "schema": SCHEMA,
        "built_in": built_in,
        "image": _image(env, system_packages_path) if built_in == "container" else None,
        "tool_versions": tool_versions(),
        "source_date_epoch": record.source_date_epoch,
        "inputs": inputs,
        "inputs_tree_sha256": inputs_tree_sha256(inputs),
        "outputs": {name: output.as_json() for name, output in record.outputs.items()},
        WALL_TIME_KEY: _iso_z(record.wall_time),
    }


def read_manifest(path: Path) -> Manifest:
    """Read a manifest written by :func:`write_manifest`.

    Raises:
        BuildError: when the file is unreadable, is not a JSON object, or
            carries a different ``schema``.
    """
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise BuildError(f"{path}: cannot be read ({error})") from error
    if not isinstance(document, dict):
        raise BuildError(f"{path}: is not a manifest object")
    found = document.get("schema")
    if found != SCHEMA:
        raise BuildError(f"{path}: schema is {found!r}, expected {SCHEMA!r}")
    return document


def compare(manifest: Manifest, rebuilt: Manifest) -> list[str]:
    """Every field in which ``rebuilt`` differs from ``manifest``.

    ``wall_time`` is skipped: it is the one field a reproducible rebuild is
    allowed to change. An empty list means the rebuild reproduced the build.
    """
    left = {key: value for key, value in manifest.items() if key != WALL_TIME_KEY}
    right = {key: value for key, value in rebuilt.items() if key != WALL_TIME_KEY}
    return list(_differences("", left, right))


def inputs_tree_sha256(inputs: Mapping[str, str]) -> str:
    """SHA-256 over the sorted ``(path, sha256)`` list of the manifest.

    The digest is taken over ``"<path>\\0<sha256>\\n"`` per entry, sorted by
    path, UTF-8 encoded — spelled out here because acceptance check #9
    recomputes it from the working tree.
    """
    lines = "".join(f"{path}\0{digest}\n" for path, digest in sorted(inputs.items()))
    return _sha256_text(lines)


def hash_file(path: Path) -> str:
    """The SHA-256 of one input file."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def text_sha256(pdf_bytes: bytes) -> str:
    """The text hash of check #9: pages joined with a form feed, SHA-256."""
    return _sha256_text(PAGE_SEPARATOR.join(extract_pages(pdf_bytes)))


def tool_versions() -> dict[str, str]:
    """The versions the manifest records, in its order.

    Raises:
        BuildError: when a declared dependency is not installed, which means
            the environment is not the one ``uv.lock`` describes.
    """
    versions: dict[str, str] = {}
    for key, distribution in TOOL_DISTRIBUTIONS:
        try:
            versions[key] = version(distribution)
        except PackageNotFoundError as error:
            raise BuildError(f"{distribution} is not installed in this environment") from error
    versions["python"] = platform.python_version()
    versions["fdp-manual-build"] = __version__
    return versions


def _image(environ: Mapping[str, str], system_packages_path: Path) -> dict[str, Any]:
    return {
        "ref": environ.get(IMAGE_REF_ENV),
        "digest": environ.get(IMAGE_DIGEST_ENV),
        "system_packages": _system_packages(system_packages_path),
    }


def _system_packages(path: Path) -> list[str]:
    if not path.is_file():
        return []
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _previous(path: Path) -> Manifest | None:
    """The manifest already at ``path``, or ``None`` when there is none to keep."""
    if not path.is_file():
        return None
    try:
        document = read_manifest(path)
    except BuildError:
        return None
    return document if WALL_TIME_KEY in document else None


def _serialize(document: Manifest) -> str:
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def _iso_z(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _differences(prefix: str, left: Any, right: Any) -> Iterator[str]:
    if isinstance(left, dict) and isinstance(right, dict):
        yield from _mapping_differences(prefix, left, right)
    elif isinstance(left, list) and isinstance(right, list):
        yield from _sequence_differences(prefix, left, right)
    elif left != right:
        yield f"{prefix}: {left!r} != {right!r}"


def _mapping_differences(
    prefix: str, left: Mapping[str, Any], right: Mapping[str, Any]
) -> Iterator[str]:
    for key in sorted(set(left) | set(right)):
        child = f"{prefix}.{key}" if prefix else key
        if key not in left:
            yield f"{child}: only in the rebuild"
        elif key not in right:
            yield f"{child}: missing from the rebuild"
        else:
            yield from _differences(child, left[key], right[key])


def _sequence_differences(prefix: str, left: list[Any], right: list[Any]) -> Iterator[str]:
    if len(left) != len(right):
        yield f"{prefix}: {len(left)} entries against {len(right)}"
        return
    for index, (one, other) in enumerate(zip(left, right, strict=True)):
        yield from _differences(f"{prefix}[{index}]", one, other)
