# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-manual-build scanned``: the optional raster variant.

An optional extra: the realistic manual as a flatbed scanner would hand it
back, so that a future OCR path has something to read. Every page is
rasterised with pypdfium2 (installed with pdfplumber) to 8-bit grayscale and
then degraded with Pillow alone, in this order:

1. a rotation by a uniform angle in ±0.8°, bilinear, with white fill;
2. Gaussian noise with a standard deviation of 6/255 — six grey levels —
   added to every pixel;
3. a Gaussian blur of radius 0.6 px;
4. a linear vertical shading whose two ends differ from the middle by up to
   ±4 %;
5. a shift of up to ±3 px on each axis, white fill;
6. a requantisation to 8 bit.

Page ``i`` draws everything above — its four parameters, then its noise — from
``random.Random(seed + i)`` and from nothing else. The noise is inverse
transform sampling: one uniform byte per pixel from that generator, mapped
through the Gaussian quantile function onto an integer offset. Pillow's own
``Image.effect_noise`` is not used, because it draws from the C library's
unseeded generator. The output bytes are therefore a function of the source
bytes, ``dpi`` and ``seed`` for a given pypdfium2, Pillow and Python, which the
pinned manual container fixes.

The pages are assembled with Pillow's PDF writer: one DCT-encoded (JPEG) image
per page, sized so the page keeps its physical size at ``dpi``, and no text
layer, so pdfplumber extracts nothing. The writer would otherwise title the
document after the output file and stamp it with the wall clock; both are
switched off. The JPEG quality is fixed at :data:`JPEG_QUALITY` rather than
left to Pillow's default of 75: the noise is what dominates the file, and at 75
the 47-page realistic manual comes to 20.6 MB against the ≈ 8 to 14 MB
expected; at 50, with optimised Huffman tables, it is 12.8 MB and the text
stays sharp enough to read.

The raster parameters are fixed numbers. The ``skew_deg`` and
``noise`` knobs of ``build.yaml``'s disabled ``scanned`` variant are not read.
The PDF-level acceptance checks leave the output alone, because the runner
opens enabled variants only; check #6 hands it to the brand scanner like any
file named after a variant, and the scanner finds no text in it. The output is
not committed (``data/manual/.gitignore``).
``--update-manifest`` records it as ``outputs.scanned`` in the manifest beside
it. That is off by default because the manifest is committed and the scanned
PDF is not, and because the next ``make manual`` rewrites the manifest without
the entry.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import random
import sys
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from statistics import NormalDist
from typing import Final, cast

import pypdfium2 as pdfium  # type: ignore[import-untyped]
from PIL import Image, ImageChops, ImageFilter, ImageMath

from fdp_manual_build import manifest
from fdp_manual_build.config import BuildConfig, load_build_config
from fdp_manual_build.errors import BuildError

__all__ = [
    "BLUR_RADIUS_PX",
    "DEFAULT_DPI",
    "DEFAULT_SEED",
    "JPEG_QUALITY",
    "MAX_SHADING",
    "MAX_SHIFT_PX",
    "MAX_SKEW_DEG",
    "NOISE_SIGMA",
    "SCANNED_VARIANT",
    "Distortion",
    "ScannedResult",
    "build_scanned",
    "default_paths",
    "gaussian_noise",
    "main",
    "rasterise",
    "record_in_manifest",
    "scan_page",
]

#: The resolution the pages are rasterised at.
DEFAULT_DPI: Final = 200
#: The fixed seed; page ``i`` uses ``seed + i``.
DEFAULT_SEED: Final = 7
#: The skew is uniform in ``[-MAX_SKEW_DEG, MAX_SKEW_DEG]`` degrees.
MAX_SKEW_DEG: Final = 0.8
#: Standard deviation of the noise, as a fraction of full scale.
NOISE_SIGMA: Final = 6 / 255
#: Standard deviation of the blur kernel, in pixels.
BLUR_RADIUS_PX: Final = 0.6
#: The shading is uniform in ``[-MAX_SHADING, MAX_SHADING]`` at the page ends.
MAX_SHADING: Final = 0.04
#: Each axis shifts by an integer in ``[-MAX_SHIFT_PX, MAX_SHIFT_PX]``.
MAX_SHIFT_PX: Final = 3
#: Quality of the JPEG every page is stored as.
JPEG_QUALITY: Final = 50
#: The name the output takes in ``build.yaml``'s naming and in the manifest.
SCANNED_VARIANT: Final = "scanned"

_EXIT_OK: Final = 0
_EXIT_ERROR: Final = 2
_POINTS_PER_INCH: Final = 72
_WHITE: Final = 255
_LEVELS: Final = 256
#: The grey level the noise image is centred on before it is added.
_NOISE_ZERO: Final = 128


@dataclass(frozen=True)
class Distortion:
    """The four parameters one page draws before its noise."""

    angle_deg: float
    shading: float
    shift: tuple[int, int]

    @classmethod
    def draw(cls, rng: random.Random) -> Distortion:
        """Draw the page's rotation, shading and shift, in that order."""
        return cls(
            angle_deg=rng.uniform(-MAX_SKEW_DEG, MAX_SKEW_DEG),
            shading=rng.uniform(-MAX_SHADING, MAX_SHADING),
            shift=(
                rng.randint(-MAX_SHIFT_PX, MAX_SHIFT_PX),
                rng.randint(-MAX_SHIFT_PX, MAX_SHIFT_PX),
            ),
        )


@dataclass(frozen=True)
class ScannedResult:
    """What one ``scanned`` run wrote."""

    source: Path
    out: Path
    source_sha256: str
    sha256: str
    pages: int
    size: int
    dpi: int
    seed: int


def build_scanned(
    source_pdf: Path,
    out_pdf: Path,
    dpi: int = DEFAULT_DPI,
    seed: int = DEFAULT_SEED,
) -> ScannedResult:
    """Rasterise ``source_pdf``, degrade every page and write ``out_pdf``.

    Raises:
        BuildError: when ``dpi`` is not positive, the source cannot be read or
            is not a PDF, or it has no pages.
    """
    if dpi <= 0:
        raise BuildError(f"dpi must be positive, got {dpi}")
    try:
        source = source_pdf.read_bytes()
    except OSError as error:
        raise BuildError(f"{source_pdf}: cannot be read ({error.strerror})") from error
    pages = [
        # Seeded noise for a test document, not a secret: S311 does not apply.
        scan_page(page, random.Random(seed + index))  # noqa: S311
        for index, page in enumerate(rasterise(source, dpi, name=str(source_pdf)))
    ]
    if not pages:
        raise BuildError(f"{source_pdf}: has no pages")
    data = _pdf_bytes(pages, dpi)
    out_pdf.parent.mkdir(parents=True, exist_ok=True)
    out_pdf.write_bytes(data)
    return ScannedResult(
        source=source_pdf,
        out=out_pdf,
        source_sha256=hashlib.sha256(source).hexdigest(),
        sha256=hashlib.sha256(data).hexdigest(),
        pages=len(pages),
        size=len(data),
        dpi=dpi,
        seed=seed,
    )


def rasterise(pdf_bytes: bytes, dpi: int, *, name: str = "<pdf>") -> Iterator[Image.Image]:
    """Every page of ``pdf_bytes`` as an 8-bit grayscale image at ``dpi``.

    Raises:
        BuildError: when PDFium cannot open the document; ``name`` says which.
    """
    try:
        document = pdfium.PdfDocument(pdf_bytes)
    except pdfium.PdfiumError as error:
        raise BuildError(f"{name}: is not a readable PDF ({error})") from error
    try:
        for page in document:
            bitmap = page.render(scale=dpi / _POINTS_PER_INCH, grayscale=True)
            # A copy in mode L, so nothing points into PDFium's buffer any more.
            image: Image.Image = bitmap.to_pil().convert("L")
            bitmap.close()
            page.close()
            yield image
    finally:
        document.close()


def scan_page(image: Image.Image, rng: random.Random) -> Image.Image:
    """Apply the six steps above to one grayscale page, drawing from ``rng``."""
    distortion = Distortion.draw(rng)
    noise = gaussian_noise(image.size, rng)
    rotated = image.rotate(
        distortion.angle_deg, resample=Image.Resampling.BILINEAR, fillcolor=_WHITE
    )
    noisy = ImageChops.add(rotated, noise, offset=-_NOISE_ZERO)
    blurred = noisy.filter(ImageFilter.GaussianBlur(BLUR_RADIUS_PX))
    shaded = _shade(blurred, distortion.shading)
    shifted = _shift(shaded, distortion.shift)
    return _requantise(shifted)


def gaussian_noise(size: tuple[int, int], rng: random.Random) -> Image.Image:
    """Gaussian noise of deviation :data:`NOISE_SIGMA` as a mode L image centred on 128.

    One uniform byte per pixel from ``rng``, mapped through the Gaussian
    quantile function at the byte's bin centre. The tails stop at 2.9 standard
    deviations, the farthest a 256-bin uniform reaches, and every offset is a
    whole grey level.
    """
    width, height = size
    uniform = Image.frombytes("L", size, rng.randbytes(width * height))
    return uniform.point(_NOISE_TABLE)


def default_paths(cfg: BuildConfig, checkout: Path) -> tuple[Path, Path]:
    """``(source, out)`` as ``build.yaml`` names them.

    The source is the default variant's PDF — the realistic one, the
    pipeline's input — and the output sits beside it under the
    variant name ``scanned``: ``data/manual/cau-7-scanned.pdf``.
    """
    out_dir = checkout / cfg.outputs.dir
    return (
        out_dir / cfg.outputs.pdf_name(cfg.default_variant),
        out_dir / cfg.outputs.pdf_name(SCANNED_VARIANT),
    )


def record_in_manifest(result: ScannedResult, manifest_path: Path, checkout: Path) -> None:
    """Add ``result`` as ``outputs.scanned`` to the manifest at ``manifest_path``.

    Every other field is kept as it is, ``wall_time`` included: the manifest
    still describes the build of the committed PDFs, and the entry only says
    which scan was taken of them.

    Raises:
        BuildError: when there is no readable manifest at ``manifest_path``.
    """
    document = manifest.read_manifest(manifest_path)
    outputs = document.get("outputs")
    if not isinstance(outputs, dict):
        raise BuildError(f"{manifest_path}: has no `outputs` object to add to")
    entry = manifest.PdfOutput.of(_relative(result.out, checkout), result.out.read_bytes())
    outputs[SCANNED_VARIANT] = entry.as_json()
    manifest_path.write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def main(argv: Sequence[str], repo_root: Path) -> int:
    """``fdp-manual-build scanned``; see :mod:`fdp_manual_build.cli` for the codes."""
    args = _parser().parse_args(list(argv))
    manifest_path: Path | None = None
    try:
        cfg = load_build_config(repo_root)
        default_source, default_out = default_paths(cfg, repo_root)
        source: Path = args.source or default_source
        out: Path = args.out or default_out
        result = build_scanned(source, out, dpi=args.dpi, seed=args.seed)
        if args.update_manifest:
            manifest_path = out.parent / Path(cfg.pdf.manifest).name
            record_in_manifest(result, manifest_path, repo_root)
    except BuildError as error:
        print(f"fdp-manual-build scanned: {error}", file=sys.stderr)
        return _EXIT_ERROR
    print(
        f"scanned: {result.pages} pages at {result.dpi} dpi, seed {result.seed}, "
        f"{result.size} bytes -> {result.out}"
    )
    if manifest_path is not None:
        print(f"scanned: manifest -> {manifest_path}")
    return _EXIT_OK


# --- internals -------------------------------------------------------------


def _noise_table(sigma_levels: float) -> list[int]:
    """Uniform byte → grey level offset by a Gaussian quantile, centred on 128."""
    normal = NormalDist(mu=_NOISE_ZERO, sigma=sigma_levels)
    return [round(normal.inv_cdf((byte + 0.5) / _LEVELS)) for byte in range(_LEVELS)]


#: The lookup table :func:`gaussian_noise` maps uniform bytes through.
_NOISE_TABLE: Final = _noise_table(NOISE_SIGMA * _WHITE)


def _shade(image: Image.Image, shading: float) -> Image.Image:
    """``image`` times a factor running linearly from ``1 - shading`` to ``1 + shading``.

    The result is a mode F image; values above white are clipped when it is
    requantised.
    """
    width, height = image.size
    column = Image.new("F", (1, height))
    column.putdata([1 + shading * (2 * (row + 0.5) / height - 1) for row in range(height)])
    factors = column.resize((width, height), Image.Resampling.NEAREST)
    return cast(
        "Image.Image",
        ImageMath.lambda_eval(
            lambda operands: operands["page"] * operands["factors"], page=image, factors=factors
        ),
    )


def _shift(image: Image.Image, offset: tuple[int, int]) -> Image.Image:
    """``image`` moved by whole pixels, with white where the page moved away."""
    canvas = Image.new(image.mode, image.size, _WHITE)
    canvas.paste(image, offset)
    return canvas


def _requantise(image: Image.Image) -> Image.Image:
    """A mode F image rounded half up and clipped to an 8-bit mode L image."""
    return cast(
        "Image.Image",
        ImageMath.lambda_eval(
            lambda operands: operands["convert"](operands["page"] + 0.5, "L"), page=image
        ),
    )


def _pdf_bytes(pages: Sequence[Image.Image], dpi: int) -> bytes:
    """Pillow's image-only PDF of ``pages``, with no title and no dates."""
    first, *rest = pages
    buffer = io.BytesIO()
    first.save(
        buffer,
        format="PDF",
        save_all=True,
        append_images=rest,
        resolution=float(dpi),
        quality=JPEG_QUALITY,
        optimize=True,
        title=None,
        creationDate=None,
        modDate=None,
    )
    return buffer.getvalue()


def _relative(path: Path, checkout: Path) -> str:
    """``path`` as the manifest spells it: POSIX, relative to the checkout."""
    try:
        return path.resolve().relative_to(checkout.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def _positive(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError(f"must be a positive integer, got {value}")
    return number


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fdp-manual-build scanned",
        description="Rasterise the manual into a skewed, noisy, image-only PDF for OCR tests.",
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=None,
        help="PDF to scan (default: the default variant's PDF, data/manual/cau-7-realistic.pdf)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="where the scan goes (default: data/manual/cau-7-scanned.pdf, gitignored)",
    )
    parser.add_argument("--dpi", type=_positive, default=DEFAULT_DPI, help=f"default {DEFAULT_DPI}")
    parser.add_argument(
        "--seed",
        type=int,
        default=DEFAULT_SEED,
        help=f"page i uses seed + i (default {DEFAULT_SEED})",
    )
    parser.add_argument(
        "--update-manifest",
        action="store_true",
        help="record the scan as outputs.scanned in the build-manifest.json beside it",
    )
    return parser
