# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The optional scanned variant.

Every build here starts from ``tests/fixtures/pdf/two-page.pdf``, the committed
two-page A4 document, so the whole raster pipeline — pypdfium2, the
six degradations and Pillow's PDF writer — runs deterministically without
WeasyPrint and without the real manual. ``make manual-scanned`` on the real
realistic PDF is the manual smoke test.
"""

from __future__ import annotations

import ast
import hashlib
import json
import random
from datetime import UTC, datetime
from pathlib import Path

import pdfplumber
import pytest
from PIL import Image, ImageChops, ImageDraw, ImageStat

from fdp_manual_build import cli, scanned
from fdp_manual_build.config import BuildConfig, load_build_config
from fdp_manual_build.errors import BuildError
from fdp_manual_build.manifest import BuildRecord, PdfOutput, write_manifest
from fdp_manual_build.scanned import (
    DEFAULT_DPI,
    DEFAULT_SEED,
    MAX_SHADING,
    MAX_SHIFT_PX,
    MAX_SKEW_DEG,
    NOISE_SIGMA,
    Distortion,
    build_scanned,
    default_paths,
    gaussian_noise,
    scan_page,
)

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "pdf" / "two-page.pdf"
FIXTURE_PAGES = 2
#: ISO 216 A4 in PDF points.
A4_POINTS = (595.276, 841.890)
POINTS_PER_INCH = 72
#: "within 1 % of A4 at dpi".
SIZE_TOLERANCE = 0.01
MANIFEST_NAME = "build-manifest.json"


@pytest.fixture(scope="module")
def seven(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """The fixture scanned once with the default seed and dpi."""
    out = tmp_path_factory.mktemp("seven") / "scanned.pdf"
    build_scanned(FIXTURE, out)
    return out


def _cli(repo_root: Path, *arguments: str) -> int:
    return cli.main(["--repo-root", str(repo_root), "scanned", *arguments])


# --- acceptance: an image-only PDF with the source's pages -----------------


def test_the_command_line_writes_an_image_only_pdf(
    repo_root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "s.pdf"
    assert _cli(repo_root, "--source", str(FIXTURE), "--out", str(out)) == 0
    assert f"scanned: {FIXTURE_PAGES} pages at {DEFAULT_DPI} dpi" in capsys.readouterr().out
    with pdfplumber.open(out) as pdf:
        assert len(pdf.pages) == FIXTURE_PAGES
        for page in pdf.pages:
            assert page.chars == []
            assert (page.extract_text() or "") == ""
            assert len(page.images) == 1


def test_the_source_has_text_the_scan_does_not(seven: Path) -> None:
    # The fixture is a real text PDF, so zero characters above is the raster's doing.
    with pdfplumber.open(FIXTURE) as source, pdfplumber.open(seven) as scan:
        assert all(page.chars for page in source.pages)
        assert sum(len(page.chars) for page in scan.pages) == 0


@pytest.mark.parametrize("dpi", [100, DEFAULT_DPI])
def test_every_page_keeps_its_a4_size_at_the_requested_dpi(tmp_path: Path, dpi: int) -> None:
    out = tmp_path / "scanned.pdf"
    build_scanned(FIXTURE, out, dpi=dpi)
    expected_pixels = tuple(side * dpi / POINTS_PER_INCH for side in A4_POINTS)
    with pdfplumber.open(out) as pdf:
        for page in pdf.pages:
            assert (page.width, page.height) == pytest.approx(A4_POINTS, rel=SIZE_TOLERANCE)
            (image,) = page.images
            assert tuple(image["srcsize"]) == pytest.approx(expected_pixels, rel=SIZE_TOLERANCE)


def test_the_result_describes_the_file_it_wrote(tmp_path: Path) -> None:
    out = tmp_path / "again.pdf"
    result = build_scanned(FIXTURE, out, dpi=DEFAULT_DPI, seed=DEFAULT_SEED)
    data = out.read_bytes()
    assert result.out == out
    assert result.source == FIXTURE
    assert result.pages == FIXTURE_PAGES
    assert result.size == len(data)
    assert result.sha256 == hashlib.sha256(data).hexdigest()
    assert result.source_sha256 == hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
    assert (result.dpi, result.seed) == (DEFAULT_DPI, DEFAULT_SEED)


# --- acceptance: seed 7 twice is byte-identical, seed 8 is not -------------


def test_the_same_seed_gives_the_same_bytes_under_another_name(seven: Path, tmp_path: Path) -> None:
    # A different file name on purpose: Pillow would title the PDF after it.
    again = tmp_path / "another-name.pdf"
    build_scanned(FIXTURE, again, seed=7)
    assert again.read_bytes() == seven.read_bytes()


def test_another_seed_gives_other_bytes(seven: Path, tmp_path: Path) -> None:
    eight = tmp_path / "eight.pdf"
    build_scanned(FIXTURE, eight, seed=8)
    assert eight.read_bytes() != seven.read_bytes()


def test_the_pdf_carries_no_title_and_no_date(seven: Path) -> None:
    with pdfplumber.open(seven) as pdf:
        assert pdf.metadata == {}


# --- the six degradations --------------------------------------------------


def test_every_distortion_stays_inside_section_8() -> None:
    draws = [Distortion.draw(random.Random(seed)) for seed in range(2000)]
    angles = [draw.angle_deg for draw in draws]
    shadings = [draw.shading for draw in draws]
    shifts = {offset for draw in draws for offset in draw.shift}
    assert all(-MAX_SKEW_DEG <= angle <= MAX_SKEW_DEG for angle in angles)
    assert all(-MAX_SHADING <= shading <= MAX_SHADING for shading in shadings)
    assert shifts == set(range(-MAX_SHIFT_PX, MAX_SHIFT_PX + 1))
    # The ranges are used, not just respected.
    assert max(angles) > 0.95 * MAX_SKEW_DEG
    assert min(angles) < -0.95 * MAX_SKEW_DEG
    assert max(shadings) > 0.95 * MAX_SHADING
    assert min(shadings) < -0.95 * MAX_SHADING


def test_the_noise_has_the_documented_deviation() -> None:
    noise = gaussian_noise((512, 512), random.Random(1))
    stat = ImageStat.Stat(noise)
    assert noise.mode == "L"
    assert stat.mean[0] == pytest.approx(128, abs=0.2)
    assert stat.stddev[0] == pytest.approx(NOISE_SIGMA * 255, rel=0.05)
    low, high = noise.getextrema()
    assert (low, high) == (111, 145)


def test_the_noise_comes_from_the_generator_alone() -> None:
    first = gaussian_noise((64, 64), random.Random(5)).tobytes()
    assert gaussian_noise((64, 64), random.Random(5)).tobytes() == first
    assert gaussian_noise((64, 64), random.Random(6)).tobytes() != first


def _page() -> Image.Image:
    page = Image.new("L", (400, 300), 255)
    ImageDraw.Draw(page).rectangle((100, 80, 300, 220), fill=0)
    return page


def test_a_scanned_page_keeps_its_size_and_mode_and_is_degraded() -> None:
    page = _page()
    scan = scan_page(page, random.Random(3))
    assert (scan.mode, scan.size) == ("L", page.size)
    assert ImageChops.difference(scan, page).getbbox() is not None
    # Still a white page with a dark block: noise, blur and shading are faint.
    assert ImageStat.Stat(scan.crop((10, 10, 60, 60))).mean[0] > 230
    assert ImageStat.Stat(scan.crop((150, 120, 250, 180))).mean[0] < 30


def test_scanning_a_page_twice_with_the_same_generator_seed_agrees() -> None:
    first = scan_page(_page(), random.Random(11)).tobytes()
    assert scan_page(_page(), random.Random(11)).tobytes() == first
    assert scan_page(_page(), random.Random(12)).tobytes() != first


# --- paths, the manifest and the Git ignore --------------------------------


def test_default_paths_come_from_build_yaml(repo_root: Path) -> None:
    cfg = load_build_config(repo_root)
    assert default_paths(cfg, repo_root) == (
        repo_root / "data" / "manual" / "cau-7-realistic.pdf",
        repo_root / "data" / "manual" / "cau-7-scanned.pdf",
    )


def test_default_paths_follow_another_tree(mini_config: BuildConfig, tmp_path: Path) -> None:
    source, out = default_paths(mini_config, tmp_path)
    assert source == tmp_path / mini_config.outputs.dir / "mini-realistic.pdf"
    assert out == tmp_path / mini_config.outputs.dir / "mini-scanned.pdf"


def test_git_ignores_the_default_output(repo_root: Path) -> None:
    _, out = default_paths(load_build_config(repo_root), repo_root)
    ignore = out.parent / ".gitignore"
    patterns = [
        line.strip()
        for line in ignore.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert patterns == [out.name]


def _manifest(directory: Path) -> Path:
    path = directory / MANIFEST_NAME
    record = BuildRecord(
        source_date_epoch=1768435200,
        inputs={"manual/build.yaml": "a" * 64},
        outputs={},
        wall_time=datetime(2026, 1, 15, tzinfo=UTC),
    )
    write_manifest(path, record, environ={}, system_packages_path=directory / "absent")
    return path


def test_update_manifest_adds_the_scan_and_keeps_everything_else(
    repo_root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = _manifest(tmp_path)
    before = json.loads(path.read_text(encoding="utf-8"))
    out = tmp_path / "cau-7-scanned.pdf"
    argv = ["--source", str(FIXTURE), "--out", str(out), "--update-manifest"]
    assert _cli(repo_root, *argv) == 0
    assert f"scanned: manifest -> {path}" in capsys.readouterr().out
    after = json.loads(path.read_text(encoding="utf-8"))
    entry = after["outputs"].pop("scanned")
    assert after == before
    assert entry == PdfOutput.of(out.resolve().as_posix(), out.read_bytes()).as_json()
    assert entry["pages"] == FIXTURE_PAGES


def test_without_the_flag_the_manifest_is_left_alone(repo_root: Path, tmp_path: Path) -> None:
    path = _manifest(tmp_path)
    before = path.read_bytes()
    out = tmp_path / "cau-7-scanned.pdf"
    assert _cli(repo_root, "--source", str(FIXTURE), "--out", str(out)) == 0
    assert path.read_bytes() == before


def test_update_manifest_needs_a_manifest_beside_the_output(
    repo_root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "cau-7-scanned.pdf"
    argv = ["--source", str(FIXTURE), "--out", str(out), "--update-manifest"]
    assert _cli(repo_root, *argv) == 2
    assert MANIFEST_NAME in capsys.readouterr().err


# --- errors ----------------------------------------------------------------


def test_a_missing_source_is_an_error(
    repo_root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    argv = ["--source", str(tmp_path / "absent.pdf"), "--out", str(tmp_path / "s.pdf")]
    assert _cli(repo_root, *argv) == 2
    assert "cannot be read" in capsys.readouterr().err
    assert not (tmp_path / "s.pdf").exists()


def test_a_file_that_is_not_a_pdf_is_an_error(tmp_path: Path) -> None:
    source = tmp_path / "not.pdf"
    source.write_bytes(b"plain text, not a PDF\n")
    with pytest.raises(BuildError, match="is not a readable PDF"):
        build_scanned(source, tmp_path / "s.pdf")


def test_the_dpi_must_be_positive(repo_root: Path, tmp_path: Path) -> None:
    with pytest.raises(BuildError, match="dpi must be positive"):
        build_scanned(FIXTURE, tmp_path / "s.pdf", dpi=0)
    with pytest.raises(SystemExit) as raised:
        _cli(repo_root, "--dpi", "0")
    assert raised.value.code == 2


# --- determinism lint ------------------------------------------------------


def test_randomness_comes_only_from_seeded_generators() -> None:
    # test_determinism_lint.py exempts scanned.py; this is the narrower rule
    # the exemption stands on: `random` only as a seeded `random.Random`.
    tree = ast.parse(Path(scanned.__file__).read_text(encoding="utf-8"))
    nodes = list(ast.walk(tree))
    random_attributes = {
        node.attr
        for node in nodes
        if isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id == "random"
    }
    assert random_attributes == {"Random"}
    assert not [
        node for node in nodes if isinstance(node, ast.ImportFrom) and node.module == "random"
    ]
    constructions = [
        node
        for node in nodes
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "Random"
    ]
    assert constructions
    assert all(len(node.args) == 1 and not node.keywords for node in constructions)
    names = {node.id for node in nodes if isinstance(node, ast.Name)}
    names |= {node.attr for node in nodes if isinstance(node, ast.Attribute)}
    unseeded = {"effect_noise", "SystemRandom", "urandom", "time", "datetime", "uuid4"}
    assert not names & unseeded
