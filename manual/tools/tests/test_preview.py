# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""End-to-end tests for preview.py.

Runs the CLI as a subprocess over ``fixtures/spec-minimal`` and
``fixtures/content-minimal``, so YAML -> Jinja -> Markdown -> HTML is exercised
the way a writer runs it, and asserts what the two variants must differ in:
numbering, footnoted cross-references and imperial units::

    uv run --no-project --with-requirements manual/tools/requirements.txt \\
        pytest manual/tools/tests/test_preview.py -q
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
SPEC_MINIMAL = FIXTURES / "spec-minimal"
CONTENT_MINIMAL = FIXTURES / "content-minimal"
REPO_ROOT = TOOLS.parents[1]


def run_preview(out: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    """Run ``preview.py`` as its own process, the way a writer runs it."""
    return subprocess.run(
        [
            sys.executable,
            str(TOOLS / "preview.py"),
            "--spec",
            str(SPEC_MINIMAL),
            "--content",
            str(CONTENT_MINIMAL),
            "--out",
            str(out),
            *extra,
        ],
        capture_output=True,
        text=True,
        check=False,
        cwd=REPO_ROOT,
    )


@pytest.fixture(scope="module")
def pages(tmp_path_factory: pytest.TempPathFactory) -> dict[str, str]:
    """Both variant pages, rendered once through the CLI."""
    out = tmp_path_factory.mktemp("preview")
    completed = run_preview(out, "--variant", "both")
    assert completed.returncode == 0, completed.stdout + completed.stderr
    return {
        variant: (out / f"{variant}.html").read_text(encoding="utf-8")
        for variant in ("clean", "realistic")
    }


# --- the pipeline runs ----------------------------------------------------


def test_the_cli_writes_one_page_per_variant(tmp_path: Path) -> None:
    completed = run_preview(tmp_path, "--variant", "both")
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert (tmp_path / "clean.html").is_file()
    assert (tmp_path / "realistic.html").is_file()


def test_the_cli_honours_a_single_variant_and_chapter(tmp_path: Path) -> None:
    completed = run_preview(tmp_path, "--variant", "clean", "--chapters", "8")
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert not (tmp_path / "realistic.html").exists()
    page = (tmp_path / "clean.html").read_text(encoding="utf-8")
    assert 'id="ch-8"' in page
    assert 'id="ch-2"' not in page


def test_the_cli_fails_on_an_empty_content_directory(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    completed = subprocess.run(
        [
            sys.executable,
            str(TOOLS / "preview.py"),
            "--spec",
            str(SPEC_MINIMAL),
            "--content",
            str(empty),
            "--out",
            str(tmp_path / "out"),
        ],
        capture_output=True,
        text=True,
        check=False,
        cwd=REPO_ROOT,
    )
    assert completed.returncode == 1
    assert "holds no NN-<slug>.md partial" in completed.stderr


def test_the_output_is_deterministic(tmp_path: Path) -> None:
    first, second = tmp_path / "a", tmp_path / "b"
    assert run_preview(first, "--variant", "both").returncode == 0
    assert run_preview(second, "--variant", "both").returncode == 0
    for variant in ("clean", "realistic"):
        left = (first / f"{variant}.html").read_text(encoding="utf-8")
        right = (second / f"{variant}.html").read_text(encoding="utf-8")
        assert left == right


# --- numbering ------------------------------------------------------------


@pytest.mark.parametrize("variant", ["clean", "realistic"])
def test_the_page_numbers_the_authored_headings(pages: dict[str, str], variant: str) -> None:
    page = pages[variant]
    assert '<h2 id="sec-overview">2.1 Overview</h2>' in page
    assert '<h2 id="sec-message-list">3.4 Message list</h2>' in page
    assert '<h2 id="sec-after-repair">8.6 After a repair</h2>' in page


@pytest.mark.parametrize("variant", ["clean", "realistic"])
def test_the_page_numbers_the_generated_headings(pages: dict[str, str], variant: str) -> None:
    page = pages[variant]
    assert '<h2 id="cond-oil_temperature_high">8.3 Oil temperature high</h2>' in page
    assert '<h2 id="cond-frequent_cycling">8.5 Compressor starts and loads too often</h2>' in page


@pytest.mark.parametrize("variant", ["clean", "realistic"])
def test_the_page_numbers_the_figures(pages: dict[str, str], variant: str) -> None:
    assert "Figure 2.1 — Air and oil path of the unit" in pages[variant]
    assert "Figure 3.1 — Front of the controller" in pages[variant]


@pytest.mark.parametrize("variant", ["clean", "realistic"])
def test_the_page_renders_the_generated_tables(pages: dict[str, str], variant: str) -> None:
    page = pages[variant]
    assert '<table class="alarms">' in page
    assert '<table class="troubleshooting">' in page
    assert '<tr id="fault-oil_cooler_fouled">' in page
    assert "Oil temperature (T1) rises gradually in every state." in page


@pytest.mark.parametrize("variant", ["clean", "realistic"])
def test_the_page_holds_no_unrendered_jinja(pages: dict[str, str], variant: str) -> None:
    """Prose and generated cells alike go through the environment."""
    assert "{{" not in pages[variant]
    assert "{%" not in pages[variant]


@pytest.mark.parametrize("variant", ["clean", "realistic"])
def test_the_page_points_the_figures_at_the_figures_directory(
    pages: dict[str, str], variant: str
) -> None:
    assert 'src="figures/' not in pages[variant]
    assert "spec-minimal/figures/system-schematic.svg" in pages[variant]


# --- the two variants differ ----------------------------------------------


def test_only_realistic_footnotes_its_cross_references(pages: dict[str, str]) -> None:
    assert "footnote-ref" in pages["realistic"]
    assert "Section 3.4, Message list" in pages["realistic"]
    assert "footnote-ref" not in pages["clean"]
    assert "[^xref-" not in pages["clean"]


def test_clean_spells_the_word_section_out(pages: dict[str, str]) -> None:
    assert '<a class="xref" href="#sec-acknowledging">section 3.5</a>' in pages["clean"]
    assert '<a class="xref" href="#sec-acknowledging">3.5</a>' in pages["realistic"]


def test_only_realistic_prints_imperial_units(pages: dict[str, str]) -> None:
    assert "11.0 bar (160 psi)" in pages["realistic"]
    assert "75 °C (167 °F)" in pages["realistic"]
    assert "psi" not in pages["clean"]
    assert "°F" not in pages["clean"]
    assert "11.0 bar" in pages["clean"]


def test_both_variants_state_the_prose_only_facts_in_the_fixture(pages: dict[str, str]) -> None:
    sentence = "the motor keeps turning for the run-on time"
    assert sentence in pages["clean"]
    assert sentence in pages["realistic"]
