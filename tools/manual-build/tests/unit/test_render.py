# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""WeasyPrint renders the same bytes twice and never falls back on a font.

Everything here needs a working Pango/Cairo stack, so the whole module carries
the ``weasyprint`` marker; on macOS run it with
``DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib``. The fixture it renders is a
static HTML file, not the real manual, so the renderer is testable apart from
the build engine and the stylesheets.
"""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path

import pdfplumber
import pytest

from fdp_manual_build.config import BuildConfig, load_build_config
from fdp_manual_build.errors import BuildError
from fdp_manual_build.manifest import PdfOutput
from fdp_manual_build.render import (
    ALLOW_MISSING_ENV,
    CSS_DIR,
    FONTS_MANIFEST,
    PAGE_SEPARATOR,
    extract_pages,
    main,
    page_count,
    stylesheets,
    to_pdf,
    verify_fonts,
)

pytestmark = pytest.mark.weasyprint

SAMPLE = Path(__file__).resolve().parents[1] / "fixtures" / "html" / "sample.html"
#: The fixture rendered with the clean stylesheets of manual/templates/css.
#: It was 3 before fonts.css and base.css existed, 4 until base.css was set at
#: 9.5 pt on 1.26 to bring the manual inside `pdf.page_budget`, and 3 again
#: since: the sixty-row table still breaks over
#: a page boundary, and the two-column section now follows it on the same
#: page. A change to those sheets moves this number and is meant to be
#: noticed.
EXPECTED_PAGES = 3
SANS_FACES = (
    "IBMPlexSans-Regular.ttf",
    "IBMPlexSans-Italic.ttf",
    "IBMPlexSans-Bold.ttf",
    "IBMPlexSans-BoldItalic.ttf",
)
MONO_FACES = ("IBMPlexMono-Regular.ttf", "IBMPlexMono-Bold.ttf")
#: The shape ``tools/manual-build/scripts/fetch-fonts.py`` writes into
#: ``manual/fonts/fonts.json``.
FONT_FACES = (
    ("IBM Plex Sans", "@ibm/plex-sans@1.1.0", SANS_FACES),
    ("IBM Plex Mono", "@ibm/plex-mono@2.5.0", MONO_FACES),
)


@pytest.fixture(scope="module")
def build_config(repo_root: Path) -> BuildConfig:
    """The real ``manual/build.yaml``: its ``pdf_identifier`` fixes the trailer."""
    return load_build_config(repo_root)


@pytest.fixture
def allow_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Render without the committed fonts and stylesheets."""
    monkeypatch.setenv(ALLOW_MISSING_ENV, "1")


@pytest.fixture(scope="module")
def weasyprint_ready() -> None:
    """Skip the module when WeasyPrint cannot load Pango on this host."""
    try:
        import weasyprint  # noqa: F401, PLC0415
    except Exception as error:  # pragma: no cover - environment dependent
        pytest.skip(f"WeasyPrint is not usable here: {error}")


def _render(repo_root: Path, cfg: BuildConfig, variant: str = "clean") -> bytes:
    return to_pdf(
        SAMPLE.read_text(encoding="utf-8"),
        base_url=cfg.manual_root,
        cfg=cfg,
        variant=cfg.variant(variant),
        font_dir=repo_root / cfg.fonts.dir,
    )


def _fonts_json(directory: Path, digests: dict[str, str]) -> None:
    families = [
        {
            "family": family,
            "release": release,
            "zip_sha256": "0" * 64,
            "files": [
                {"file": name, "weight": 400, "style": "normal", "sha256": digests[name]}
                for name in names
            ],
        }
        for family, release, names in FONT_FACES
    ]
    payload = {"schema": "urn:fdp:fonts:v1", "families": families}
    (directory / FONTS_MANIFEST).write_text(json.dumps(payload), encoding="utf-8")


@pytest.fixture
def font_dir(tmp_path: Path) -> Path:
    """A font directory that passes :func:`verify_fonts`."""
    directory = tmp_path / "fonts"
    directory.mkdir()
    digests: dict[str, str] = {}
    for _, _, names in FONT_FACES:
        for name in names:
            payload = name.encode("utf-8")
            (directory / name).write_bytes(payload)
            digests[name] = hashlib.sha256(payload).hexdigest()
    _fonts_json(directory, digests)
    return directory


def test_two_renders_of_the_fixture_are_identical(
    weasyprint_ready: None,
    allow_missing: None,
    repo_root: Path,
    build_config: BuildConfig,
) -> None:
    first = _render(repo_root, build_config)
    second = _render(repo_root, build_config)
    assert first == second
    assert page_count(first) == EXPECTED_PAGES


def test_the_metadata_names_weasyprint_and_carries_no_creation_date(
    weasyprint_ready: None,
    allow_missing: None,
    repo_root: Path,
    build_config: BuildConfig,
) -> None:
    pdf_bytes = _render(repo_root, build_config)
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        metadata = dict(pdf.metadata)
    assert metadata["Producer"] == "WeasyPrint 70.0"
    assert "CreationDate" not in metadata
    assert "ModDate" not in metadata


def test_the_pinned_identifier_and_version_reach_the_file(
    weasyprint_ready: None,
    allow_missing: None,
    repo_root: Path,
    build_config: BuildConfig,
) -> None:
    pdf_bytes = _render(repo_root, build_config)
    assert pdf_bytes.startswith(b"%PDF-1.7")
    # WeasyPrint writes the trailer as `/ID [(<identifier>) (<content hash>)]`,
    # so the first half is fixed by build.yaml instead of drawn per run.
    identifier = build_config.pdf.pdf_identifier.encode()
    assert b"/ID [(" + identifier + b") (" in pdf_bytes


def test_the_layout_features_survive_into_the_text(
    weasyprint_ready: None,
    allow_missing: None,
    repo_root: Path,
    build_config: BuildConfig,
) -> None:
    pages = extract_pages(_render(repo_root, build_config))
    assert len(pages) == EXPECTED_PAGES
    # The table header repeats on the page the table breaks onto.
    assert pages[1].count("Row Tag Nominal Note") == 1
    assert pages[2].count("Row Tag Nominal Note") == 1
    # `target-counter()` resolved both cross references.
    assert "the tabulated values (page 2)" in pages[0]
    assert "the two-column section (page 3)" in pages[0]
    # The floated footnote body is on the page that calls it.
    assert "Footnotes are floated into the page footnote area" in pages[0]


def test_the_embedded_fonts_are_ibm_plex(
    weasyprint_ready: None,
    allow_missing: None,
    repo_root: Path,
    build_config: BuildConfig,
) -> None:
    if not (build_config.manual_root / CSS_DIR / "fonts.css").is_file():
        pytest.skip("manual/templates/css/fonts.css is not in this checkout")
    pdf_bytes = _render(repo_root, build_config)
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        names = {char["fontname"] for page in pdf.pages for char in page.chars}
    assert names
    # pdfplumber reports the subset names hyphenated, "XXXXXX+IBM-Plex-Sans".
    assert all("IBMPlex" in name.replace("-", "") for name in names), names


def test_a_pdf_output_entry_hashes_the_pages_the_way_check_9_does(
    weasyprint_ready: None,
    allow_missing: None,
    repo_root: Path,
    build_config: BuildConfig,
) -> None:
    pdf_bytes = _render(repo_root, build_config)
    entry = PdfOutput.of("data/manual/probe.pdf", pdf_bytes)
    joined = PAGE_SEPARATOR.join(extract_pages(pdf_bytes))
    assert entry.pages == EXPECTED_PAGES
    assert entry.size == len(pdf_bytes)
    assert entry.as_json()["bytes"] == len(pdf_bytes)
    assert entry.pdf_sha256 == hashlib.sha256(pdf_bytes).hexdigest()
    assert entry.text_sha256 == hashlib.sha256(joined.encode("utf-8")).hexdigest()


def test_verify_fonts_accepts_the_six_recorded_faces(font_dir: Path) -> None:
    faces = verify_fonts(font_dir)
    assert [face.name for face in faces] == [name for _, _, names in FONT_FACES for name in names]


def test_a_changed_font_hash_stops_the_render(
    font_dir: Path,
    build_config: BuildConfig,
) -> None:
    (font_dir / "IBMPlexSans-Bold.ttf").write_bytes(b"a different outline")
    with pytest.raises(BuildError) as raised:
        to_pdf(
            "<html><body>never rendered</body></html>",
            base_url=build_config.manual_root,
            cfg=build_config,
            variant=build_config.variant("clean"),
            font_dir=font_dir,
        )
    message = str(raised.value)
    assert "the committed fonts no longer match" in message
    assert "IBMPlexSans-Bold.ttf hashes to" in message


def test_a_missing_font_file_stops_the_render(font_dir: Path) -> None:
    (font_dir / "IBMPlexMono-Bold.ttf").unlink()
    with pytest.raises(BuildError, match=r"IBMPlexMono-Bold\.ttf is not in the fonts directory"):
        verify_fonts(font_dir)


def test_a_manifest_with_the_wrong_number_of_faces_is_rejected(font_dir: Path) -> None:
    payload = json.loads((font_dir / FONTS_MANIFEST).read_text(encoding="utf-8"))
    payload["families"][1]["files"] = []
    (font_dir / FONTS_MANIFEST).write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(BuildError, match="lists 4 font files, expected 6"):
        verify_fonts(font_dir)


def test_a_missing_font_manifest_is_an_error_without_the_escape_hatch(tmp_path: Path) -> None:
    with pytest.raises(BuildError, match="the font manifest is missing"):
        verify_fonts(tmp_path)


def test_a_missing_stylesheet_is_an_error_without_the_escape_hatch(
    tmp_path: Path,
    build_config: BuildConfig,
) -> None:
    with pytest.raises(BuildError, match="stylesheet is missing"):
        stylesheets(tmp_path, build_config.variant("clean"))


def test_a_missing_stylesheet_is_only_a_warning_with_the_escape_hatch(
    allow_missing: None,
    tmp_path: Path,
    build_config: BuildConfig,
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert stylesheets(tmp_path, build_config.variant("clean")) == ()
    warnings = capsys.readouterr().err
    assert warnings.count("stylesheet is missing") == 3
    assert "clean.css" in warnings


def test_the_render_subcommand_writes_the_pdf(
    weasyprint_ready: None,
    allow_missing: None,
    repo_root: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    out = tmp_path / "nested" / "probe.pdf"
    assert main(["--html", str(SAMPLE), "--out", str(out), "--variant", "clean"], repo_root) == 0
    assert page_count(out.read_bytes()) == EXPECTED_PAGES
    assert f"{EXPECTED_PAGES} pages" in capsys.readouterr().out


def test_the_render_subcommand_reports_an_unreadable_html_file(
    allow_missing: None,
    repo_root: Path,
    tmp_path: Path,
) -> None:
    missing = tmp_path / "absent.html"
    with pytest.raises(BuildError, match="cannot be read"):
        main(["--html", str(missing), "--out", str(tmp_path / "out.pdf")], repo_root)
