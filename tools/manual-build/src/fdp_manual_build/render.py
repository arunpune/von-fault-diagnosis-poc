# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""One assembled HTML string → PDF bytes.

Every WeasyPrint option that could make two runs differ is pinned here: the
trailer identifier comes from ``build.yaml`` instead of being drawn per run,
the PDF version is fixed, subsetting is on, hinting and image optimisation are
off, and no custom metadata is written. Verified on 2026-09-19 with WeasyPrint 70.0:
identical inputs give identical bytes, ``SOURCE_DATE_EPOCH`` is not read, and
no ``CreationDate`` is written unless the HTML declares ``dcterms.created``.

The pinned IBM Plex fonts are checked before anything is rendered: a missing or
changed font file is an error, never a silent fallback to a system face, which
would change the extracted text between macOS and the container.

WeasyPrint is imported inside :func:`to_pdf` on purpose. Importing it needs
Pango and GObject at load time (on macOS only with
``DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib``), and :mod:`fdp_manual_build.manifest`
and the acceptance checks must stay importable on a host that has neither.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

import pdfplumber

from fdp_manual_build.config import load_build_config
from fdp_manual_build.errors import BuildError, LoadError

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.config import BuildConfig, VariantConfig

__all__ = [
    "ALLOW_MISSING_ENV",
    "CSS_DIR",
    "EXPECTED_FONT_COUNT",
    "FONTS_MANIFEST",
    "PAGE_SEPARATOR",
    "PDF_VERSION",
    "FontFile",
    "extract_pages",
    "main",
    "page_count",
    "stylesheets",
    "to_pdf",
    "verify_fonts",
]

#: ``manual/fonts/fonts.json``, written by ``tools/manual-build/scripts/fetch-fonts.py``.
FONTS_MANIFEST: Final = "fonts.json"
#: Four IBM Plex Sans faces plus two IBM Plex Mono faces.
EXPECTED_FONT_COUNT: Final = 6
#: Where the stylesheets sit below ``base_url`` (the ``manual/`` tree).
CSS_DIR: Final = Path("templates") / "css"
#: Set to ``1`` to downgrade a missing stylesheet or font manifest to a warning.
#:
#: The render tests need a way to exercise the renderer without the three
#: stylesheets (``fonts.css``, ``base.css``, ``<variant>.css``) and the font
#: manifest. It is never set by ``make manual``: a real build that cannot
#: find its stylesheets or its fonts must fail.
ALLOW_MISSING_ENV: Final = "FDP_MANUAL_ALLOW_MISSING_CSS"
#: The committed manuals are PDF 1.7.
PDF_VERSION: Final = "1.7"
#: What :func:`extract_pages` is joined with to form the manifest's text hash.
PAGE_SEPARATOR: Final = "\f"


@dataclass(frozen=True)
class FontFile:
    """One face listed in ``fonts.json``, with the hash it must still have."""

    name: str
    path: Path
    sha256: str
    size: int | None
    pointer: str


def to_pdf(
    html: str,
    *,
    base_url: Path,
    cfg: BuildConfig,
    variant: VariantConfig,
    font_dir: Path,
) -> bytes:
    """Render ``html`` to PDF bytes with the pinned options above.

    Args:
        html: the assembled document; ``--html-only`` writes the same string.
        base_url: the ``manual/`` tree, so ``templates/css/…``, ``fonts/…`` and
            ``figures/…`` resolve relatively.
        cfg: the build configuration; only ``pdf.pdf_identifier`` is read.
        variant: picks the third stylesheet, ``templates/css/<name>.css``.
        font_dir: the directory of ``fonts.json`` and the six faces.

    Raises:
        BuildError: when a font file is missing or its hash moved, when a
            stylesheet is missing and :data:`ALLOW_MISSING_ENV` is not set, or
            when WeasyPrint cannot be imported on this host.
    """
    verify_fonts(font_dir)
    sheets = stylesheets(base_url, variant)
    css_class, html_class, font_configuration = _weasyprint()
    font_config = font_configuration()
    # No base_url here: a stylesheet's url() values are relative to the
    # stylesheet, which is what fonts.css documents ("../../fonts/" is
    # manual/fonts/). Overriding it with the manual root sent every @font-face
    # src outside the tree and WeasyPrint fell back to a system font.
    compiled = [css_class(filename=str(path), font_config=font_config) for path in sheets]
    pdf = html_class(string=html, base_url=str(base_url)).write_pdf(
        stylesheets=compiled,
        font_config=font_config,
        pdf_identifier=cfg.pdf.pdf_identifier.encode(),
        pdf_version=PDF_VERSION,
        pdf_variant=None,
        full_fonts=False,
        hinting=False,
        uncompressed_pdf=False,
        optimize_images=False,
        presentational_hints=False,
        custom_metadata=False,
    )
    if pdf is None:  # pragma: no cover - only with a target= argument
        raise BuildError("WeasyPrint returned no PDF bytes")
    return bytes(pdf)


def stylesheets(base_url: Path, variant: VariantConfig) -> tuple[Path, ...]:
    """The three stylesheets, in cascade order, that exist."""
    css_dir = base_url / CSS_DIR
    wanted = ("fonts.css", "base.css", f"{variant.name}.css")
    found: list[Path] = []
    for name in wanted:
        path = css_dir / name
        if path.is_file():
            found.append(path)
        else:
            _require(f"{path}: stylesheet is missing")
    return tuple(found)


def verify_fonts(font_dir: Path) -> tuple[FontFile, ...]:
    """Check the six pinned IBM Plex faces against ``fonts.json``.

    Returns the verified faces, or an empty tuple when the manifest is absent
    and :data:`ALLOW_MISSING_ENV` allows it.

    Raises:
        BuildError: when the manifest is unreadable, does not list exactly
            :data:`EXPECTED_FONT_COUNT` faces, or a file is missing or has a
            different SHA-256 or size than the manifest records.
    """
    manifest = font_dir / FONTS_MANIFEST
    if not manifest.is_file():
        _require(f"{manifest}: the font manifest is missing")
        return ()
    faces = _font_files(manifest, font_dir)
    errors = [error for face in faces for error in _face_errors(face)]
    if errors:
        raise BuildError(f"{manifest}: the committed fonts no longer match", errors)
    return faces


def extract_pages(pdf_bytes: bytes) -> list[str]:
    """Every page's text with pdfplumber 0.11.10 defaults, in page order.

    This is the definition acceptance check #9 uses: the manifest's
    ``text_sha256`` is the SHA-256 of these pages joined with a form feed.
    """
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        return [page.extract_text() or "" for page in pdf.pages]


def page_count(pdf_bytes: bytes) -> int:
    """How many pages ``pdf_bytes`` has."""
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        return len(pdf.pages)


def main(argv: Sequence[str], repo_root: Path) -> int:
    """``fdp-manual-build render``: one prepared HTML file → one PDF."""
    args = _parser().parse_args(list(argv))
    cfg = load_build_config(repo_root)
    variant = cfg.variant(args.variant)
    try:
        html = args.html.read_text(encoding="utf-8")
    except OSError as error:
        raise BuildError(f"{args.html}: cannot be read ({error.strerror})") from error
    pdf = to_pdf(
        html,
        base_url=cfg.manual_root,
        cfg=cfg,
        variant=variant,
        font_dir=repo_root / cfg.fonts.dir,
    )
    out: Path = args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(pdf)
    print(f"{out}: {variant.name}, {page_count(pdf)} pages, {len(pdf)} bytes")
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fdp-manual-build render",
        description="Render one prepared HTML file to PDF with the pinned options.",
    )
    parser.add_argument("--html", type=Path, required=True, help="the HTML file to render")
    parser.add_argument("--out", type=Path, required=True, help="where to write the PDF")
    parser.add_argument(
        "--variant",
        default="clean",
        help="which variant stylesheet to add (default: clean)",
    )
    return parser


def _weasyprint() -> tuple[Any, Any, Any]:
    """``(CSS, HTML, FontConfiguration)``, imported only when rendering."""
    try:
        # Deliberately not at module level: see this module's docstring.
        # WeasyPrint ships no py.typed marker, hence the import ignores.
        from weasyprint import CSS, HTML  # type: ignore[import-untyped]  # noqa: PLC0415
        from weasyprint.text.fonts import (  # type: ignore[import-untyped]  # noqa: PLC0415
            FontConfiguration,
        )
    # A missing Pango surfaces as OSError, not ImportError, so catch broadly.
    except Exception as error:
        raise BuildError(
            "WeasyPrint cannot be imported; it needs Pango and GObject "
            "(on macOS: DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib): "
            f"{error}"
        ) from error
    return CSS, HTML, FontConfiguration


def _require(message: str) -> None:
    """Raise ``message``, unless :data:`ALLOW_MISSING_ENV` downgrades it."""
    if os.environ.get(ALLOW_MISSING_ENV) != "1":
        raise BuildError(message)
    print(f"fdp-manual-build: {message} ({ALLOW_MISSING_ENV}=1)", file=sys.stderr)


def _font_files(manifest: Path, font_dir: Path) -> tuple[FontFile, ...]:
    try:
        document = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise BuildError(f"{manifest}: cannot be read ({error})") from error
    faces = tuple(_walk_families(manifest, font_dir, document))
    if len(faces) != EXPECTED_FONT_COUNT:
        raise BuildError(
            f"{manifest}: lists {len(faces)} font files, expected {EXPECTED_FONT_COUNT}"
        )
    return faces


def _walk_families(manifest: Path, font_dir: Path, document: Any) -> Iterator[FontFile]:
    families = document.get("families") if isinstance(document, dict) else None
    if not isinstance(families, list):
        raise BuildError(f"{manifest}: no `families` array")
    for family_index, family in enumerate(families):
        files = family.get("files") if isinstance(family, dict) else None
        if not isinstance(files, list):
            raise BuildError(f"{manifest}: /families/{family_index} has no `files` array")
        for file_index, entry in enumerate(files):
            pointer = f"/families/{family_index}/files/{file_index}"
            yield _font_file(manifest, font_dir, entry, pointer)


def _font_file(manifest: Path, font_dir: Path, entry: Any, pointer: str) -> FontFile:
    if not isinstance(entry, dict) or "file" not in entry or "sha256" not in entry:
        raise BuildError(f"{manifest}: {pointer} needs a `file` and a `sha256`")
    name = str(entry["file"])
    size = entry.get("bytes")
    return FontFile(
        name=name,
        path=font_dir / name,
        sha256=str(entry["sha256"]),
        size=int(size) if size is not None else None,
        pointer=pointer,
    )


def _face_errors(face: FontFile) -> Iterator[LoadError]:
    if not face.path.is_file():
        yield LoadError(FONTS_MANIFEST, face.pointer, f"{face.name} is not in the fonts directory")
        return
    data = face.path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != face.sha256:
        yield LoadError(
            FONTS_MANIFEST,
            f"{face.pointer}/sha256",
            f"{face.name} hashes to {digest}, not {face.sha256}",
        )
    if face.size is not None and len(data) != face.size:
        yield LoadError(
            FONTS_MANIFEST,
            f"{face.pointer}/bytes",
            f"{face.name} is {len(data)} bytes, not {face.size}",
        )
