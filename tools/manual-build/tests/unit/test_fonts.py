# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The committed IBM Plex faces, their manifest and ``fonts.css``.

Three things have to agree or the manual stops being reproducible: the bytes
under ``manual/fonts/``, the hashes ``manual/fonts/fonts.json`` records for
them, and the six ``@font-face`` rules of ``manual/templates/css/fonts.css``.
The pinned table below is kept apart from the fetch script, so a silent re-pin
in the fetch script fails here instead of shipping.

The ``weasyprint``-marked test at the end is the one that proves the point:
it renders the manual's awkward glyphs and asserts that nothing fell back to a
system font. On macOS run it with
``DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib``.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from fdp_manual_build.config import load_build_config

#: The pinned faces: file, weight, style, bytes.
PINNED_FACES: tuple[tuple[str, int, str, int], ...] = (
    ("IBMPlexSans-Regular.ttf", 400, "normal", 200_500),
    ("IBMPlexSans-Italic.ttf", 400, "italic", 207_920),
    ("IBMPlexSans-Bold.ttf", 700, "normal", 200_872),
    ("IBMPlexSans-BoldItalic.ttf", 700, "italic", 208_588),
    ("IBMPlexMono-Regular.ttf", 400, "normal", 173_052),
    ("IBMPlexMono-Bold.ttf", 700, "normal", 175_096),
)

#: family -> (release tag, release zip SHA-256), pinned the same way.
PINNED_RELEASES: dict[str, tuple[str, str]] = {
    "IBM Plex Sans": (
        "@ibm/plex-sans@1.1.0",
        "fb365d910566e6d199cc2c15579a7dd9a267128e18431a394ed81f1970c69200",
    ),
    "IBM Plex Mono": (
        "@ibm/plex-mono@2.5.0",
        "6d23f01257663d8cc49a0d64c22ced630b79e0e2a0ac08a0da86e9a38bbc481c",
    ),
}

#: The characters that are the manual's hard cases for a font:
#: degree sign, en dash, superscript three, middle dot, less/greater-or-equal,
#: plus-minus. They are literal on purpose -- this is the test that proves the
#: embedded faces carry them.
GLYPHS = "°–³·≤≥±"  # noqa: RUF001 - the ambiguity is the subject

#: A subsetted embedded font: six upper-case letters, ``+``, then the face name.
SUBSET_FONTNAME = re.compile(r"^[A-Z]{6}\+\S+$")

_FONT_FACE = re.compile(r"@font-face\s*\{(?P<body>[^}]*)\}", re.MULTILINE)
_DECLARATION = re.compile(r"(?P<property>[\w-]+)\s*:\s*(?P<value>[^;]+);")
_SRC_URL = re.compile(r'url\("(?P<url>[^"]+)"\)\s+format\("truetype"\)')


@dataclass(frozen=True)
class FontFace:
    """One ``@font-face`` rule of ``fonts.css``, reduced to what has to match."""

    family: str
    url: str
    weight: int
    style: str
    display: str


@pytest.fixture(scope="session")
def fonts_dir(repo_root: Path) -> Path:
    """The committed ``manual/fonts`` directory."""
    return repo_root / "manual" / "fonts"


@pytest.fixture(scope="session")
def manifest(fonts_dir: Path) -> dict[str, Any]:
    """``manual/fonts/fonts.json`` parsed."""
    document: dict[str, Any] = json.loads((fonts_dir / "fonts.json").read_text(encoding="utf-8"))
    return document


@pytest.fixture(scope="session")
def css_path(repo_root: Path) -> Path:
    """The stylesheet that declares the faces."""
    return repo_root / "manual" / "templates" / "css" / "fonts.css"


@pytest.fixture(scope="session")
def css_text(css_path: Path) -> str:
    return css_path.read_text(encoding="utf-8")


@pytest.fixture(scope="session")
def css_faces(css_text: str) -> tuple[FontFace, ...]:
    """Every ``@font-face`` rule of ``fonts.css``, in file order."""
    return tuple(_parse_face(match.group("body")) for match in _FONT_FACE.finditer(css_text))


@pytest.fixture(scope="session")
def fetch_fonts(repo_root: Path) -> ModuleType:
    """``tools/manual-build/scripts/fetch-fonts.py`` loaded by path.

    The file name is not a Python identifier on purpose (it is a script, not
    part of the package), so it cannot be imported by name.
    """
    path = repo_root / "tools" / "manual-build" / "scripts" / "fetch-fonts.py"
    spec = importlib.util.spec_from_file_location("fdp_fetch_fonts", path)
    if spec is None or spec.loader is None:  # pragma: no cover - the file is committed
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _parse_face(body: str) -> FontFace:
    declarations = {
        match["property"]: match["value"].strip() for match in _DECLARATION.finditer(body)
    }
    src = _SRC_URL.search(declarations.get("src", ""))
    if src is None:
        raise AssertionError(f"@font-face src is not a single truetype url: {body!r}")
    return FontFace(
        family=declarations["font-family"].strip('"'),
        url=src["url"],
        weight=int(declarations["font-weight"]),
        style=declarations["font-style"],
        display=declarations.get("font-display", ""),
    )


def _rule(css: str, selector: str) -> dict[str, str]:
    match = re.search(rf"(?:^|}}|\*/)\s*{re.escape(selector)}\s*\{{(?P<body>[^}}]*)\}}", css)
    if match is None:
        raise AssertionError(f"fonts.css has no `{selector}` rule")
    return {
        item["property"]: item["value"].strip() for item in _DECLARATION.finditer(match["body"])
    }


# --- the committed files -------------------------------------------------


def test_manifest_records_the_two_pinned_releases(manifest: dict[str, Any]) -> None:
    assert manifest["schema"] == "urn:fdp:fonts:v1"
    releases = {
        family["family"]: (family["release"], family["zip_sha256"])
        for family in manifest["families"]
    }
    assert releases == PINNED_RELEASES
    assert {family["license"] for family in manifest["families"]} == {"OFL-1.1"}


def test_manifest_records_exactly_the_six_pinned_faces(manifest: dict[str, Any]) -> None:
    recorded = tuple(
        (entry["file"], entry["weight"], entry["style"], entry["bytes"])
        for family in manifest["families"]
        for entry in family["files"]
    )
    assert recorded == PINNED_FACES


def test_every_recorded_file_matches_its_hash_and_size(
    fonts_dir: Path, manifest: dict[str, Any]
) -> None:
    for family in manifest["families"]:
        for entry in family["files"]:
            payload = (fonts_dir / entry["file"]).read_bytes()
            assert len(payload) == entry["bytes"], entry["file"]
            assert hashlib.sha256(payload).hexdigest() == entry["sha256"], entry["file"]


def test_the_directory_holds_exactly_those_six_ttfs(fonts_dir: Path) -> None:
    committed = sorted(path.name for path in fonts_dir.glob("*.ttf"))
    assert committed == sorted(name for name, _weight, _style, _bytes in PINNED_FACES)


def test_no_woff2_or_variable_font_sneaked_in(fonts_dir: Path) -> None:
    # `.license` is the REUSE sidecar of fonts.json, which the manual's rule L1
    # requires beside every JSON file under the manual root.
    allowed = {".ttf", ".json", ".txt", ".license"}
    extras = sorted(path.name for path in fonts_dir.iterdir() if path.suffix not in allowed)
    assert extras == []
    assert not any("[" in path.name for path in fonts_dir.glob("*.ttf"))


def test_the_ofl_texts_are_committed(repo_root: Path, fonts_dir: Path) -> None:
    spdx_text = (repo_root / "LICENSES" / "OFL-1.1.txt").read_text(encoding="utf-8")
    assert "SIL OPEN FONT LICENSE" in spdx_text
    shipped = (fonts_dir / "LICENSE.txt").read_text(encoding="utf-8")
    assert "IBM Corp." in shipped
    assert 'Reserved Font Name "Plex"' in shipped
    assert "SIL OPEN FONT LICENSE" in shipped


# --- fonts.css -----------------------------------------------------------


def test_css_declares_exactly_the_six_faces(css_faces: tuple[FontFace, ...]) -> None:
    declared = tuple(
        (Path(face.url).name, face.weight, face.style, _expected_size(Path(face.url).name))
        for face in css_faces
    )
    assert declared == PINNED_FACES
    assert {face.display for face in css_faces} == {"block"}


def test_css_family_names_are_the_two_pinned_families(css_faces: tuple[FontFace, ...]) -> None:
    for face in css_faces:
        expected = "IBM Plex Mono" if "Mono" in face.url else "IBM Plex Sans"
        assert face.family == expected
    assert {face.family for face in css_faces} == set(PINNED_RELEASES)


def test_css_urls_resolve_into_the_configured_fonts_dir(
    repo_root: Path, css_path: Path, css_faces: tuple[FontFace, ...]
) -> None:
    """The ``src`` urls must land in ``fonts.dir`` of ``manual/build.yaml``."""
    config = load_build_config(repo_root)
    fonts_dir = (repo_root / config.fonts.dir).resolve()
    for face in css_faces:
        resolved = (css_path.parent / face.url).resolve()
        assert resolved.parent == fonts_dir, face.url
        assert resolved.is_file(), face.url


def test_css_sets_the_body_family_and_manual_hyphenation(css_text: str) -> None:
    html = _rule(css_text, "html")
    assert html["font-family"] == '"IBM Plex Sans", sans-serif'
    assert html["hyphens"] == "manual"


def test_css_maps_tags_and_alarm_codes_to_the_mono_family(css_text: str) -> None:
    mono = _rule(css_text, "code,\n.tag,\n.alarm-code,\n.mono")
    assert mono["font-family"] == '"IBM Plex Mono", monospace'


def test_css_families_match_build_yaml(repo_root: Path, css_faces: tuple[FontFace, ...]) -> None:
    config = load_build_config(repo_root)
    assert {config.fonts.body, config.fonts.mono} == {face.family for face in css_faces}


def _expected_size(name: str) -> int:
    return next(size for face, _weight, _style, size in PINNED_FACES if face == name)


# --- fetch-fonts.py ------------------------------------------------------


def test_script_pins_agree_with_the_manifest(fetch_fonts: ModuleType) -> None:
    pinned = tuple(
        (face.file, face.weight, face.style, face.size)
        for _family, face in fetch_fonts.iter_faces()
    )
    assert pinned == PINNED_FACES
    releases = {
        family.family: (family.release, family.zip_sha256) for family in fetch_fonts.FAMILIES
    }
    assert releases == PINNED_RELEASES


def test_check_passes_on_the_committed_fonts(fetch_fonts: ModuleType, fonts_dir: Path) -> None:
    assert fetch_fonts.check(fonts_dir) == []


def test_verify_digest_names_both_hashes(fetch_fonts: ModuleType) -> None:
    with pytest.raises(fetch_fonts.FontFetchError) as caught:
        fetch_fonts.verify_digest("ibm-plex-sans.zip", "a" * 64, "b" * 64)
    message = str(caught.value)
    assert "ibm-plex-sans.zip" in message
    assert "expected " + "b" * 64 in message
    assert "actual   " + "a" * 64 in message
    assert "Refusing to pin the new hash" in message


def test_check_reports_a_tampered_font(
    fetch_fonts: ModuleType, fonts_dir: Path, tmp_path: Path
) -> None:
    copy = tmp_path / "fonts"
    shutil.copytree(fonts_dir, copy)
    target = copy / "IBMPlexSans-Regular.ttf"
    payload = bytearray(target.read_bytes())
    payload[-1] ^= 0xFF
    target.write_bytes(bytes(payload))

    problems = fetch_fonts.check(copy)

    assert len(problems) == 1
    assert "IBMPlexSans-Regular.ttf" in problems[0]
    assert "fonts.json records" in problems[0]


def test_check_reports_a_missing_font(
    fetch_fonts: ModuleType, fonts_dir: Path, tmp_path: Path
) -> None:
    copy = tmp_path / "fonts"
    shutil.copytree(fonts_dir, copy)
    (copy / "IBMPlexMono-Bold.ttf").unlink()

    problems = fetch_fonts.check(copy)

    assert problems == [f"{copy / 'IBMPlexMono-Bold.ttf'}: missing"]


def test_check_mode_exits_nonzero_on_drift(
    fetch_fonts: ModuleType, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    empty = tmp_path / "fonts"
    empty.mkdir()

    assert fetch_fonts.main(["--check", "--fonts-dir", str(empty)]) == 1

    assert "fonts.json: missing" in capsys.readouterr().err


def test_a_run_over_the_committed_fonts_downloads_nothing(
    fetch_fonts: ModuleType,
    fonts_dir: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    cache = tmp_path / "never-used"

    exit_code = fetch_fonts.main(
        ["--fonts-dir", str(fonts_dir), "--cache-dir", str(cache)],
    )

    assert exit_code == 0
    assert "nothing downloaded" in capsys.readouterr().out
    assert not cache.exists()


def test_the_script_refuses_a_non_https_source(fetch_fonts: ModuleType, tmp_path: Path) -> None:
    family = fetch_fonts.FAMILIES[0]
    insecure = fetch_fonts.Family(
        family=family.family,
        release=family.release,
        url="http://example.invalid/ibm-plex-sans.zip",
        zip_sha256=family.zip_sha256,
        root=family.root,
        faces=family.faces,
    )
    with pytest.raises(fetch_fonts.FontFetchError, match="only https"):
        fetch_fonts.download(insecure, tmp_path)


# --- the glyphs actually embed --------------------------


def _weasyprint() -> tuple[ModuleType, type]:
    """Import WeasyPrint, or skip the test when its C libraries are missing.

    ``import weasyprint`` pulls in ``weasyprint.text.ffi``, which ``dlopen``s
    Pango and GObject: without them it raises ``OSError``, not ``ImportError``,
    so ``pytest.importorskip`` alone would report a failure. macOS needs
    ``DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib``; Linux CI installs the
    packages and runs the test for real.
    """
    try:
        import weasyprint  # noqa: PLC0415 - deferred so a missing Pango skips, not fails
        from weasyprint.text.fonts import FontConfiguration  # noqa: PLC0415 - same reason
    except (ImportError, OSError) as error:  # pragma: no cover - environment dependent
        pytest.skip(f"WeasyPrint is unavailable here: {error}")
    return weasyprint, FontConfiguration


@pytest.mark.weasyprint
def test_weasyprint_embeds_only_plex_subsets_for_the_hard_glyphs(
    repo_root: Path, css_path: Path
) -> None:
    """Render the manual's awkward glyphs and prove no system font crept in."""
    weasyprint, font_configuration = _weasyprint()
    pdfplumber = pytest.importorskip("pdfplumber")

    font_config = font_configuration()
    stylesheet = weasyprint.CSS(filename=str(css_path), font_config=font_config)
    document = (
        "<!DOCTYPE html><html lang='en'><body>"
        f"<p style=\"font-family:'IBM Plex Sans'\">{GLYPHS}</p>"
        "<p class='mono'>TAG-1</p>"
        "</body></html>"
    )
    pdf = weasyprint.HTML(string=document, base_url=str(repo_root / "manual")).write_pdf(
        stylesheets=[stylesheet],
        font_config=font_config,
        full_fonts=False,
        uncompressed_pdf=False,
    )

    with pdfplumber.open(io.BytesIO(pdf)) as opened:
        page = opened.pages[0]
        fontnames = {char["fontname"] for char in page.chars}
        text = page.extract_text()

    assert fontnames, "the page rendered no text at all"
    for fontname in fontnames:
        assert SUBSET_FONTNAME.match(fontname), fontname
        assert "IBMPlex" in fontname.replace("-", ""), fontname
    assert {fontname.split("+", 1)[1].replace("-", " ") for fontname in fontnames} == {
        "IBM Plex Sans",
        "IBM Plex Mono",
    }
    for glyph in GLYPHS:
        assert glyph in text, f"{glyph!r} did not survive the render"
