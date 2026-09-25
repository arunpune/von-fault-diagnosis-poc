# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The whole acceptance runner on a built manual.

A temporary checkout is assembled from the mini fixture — the manual's loader,
the schemas, the templates and the fonts from this checkout, the spec, the content
and the figures from ``tests/fixtures/mini-spec`` — both variants are built
into its ``data/manual`` with a build manifest, and then ``fdp-manual-check``
is run over it exactly as ``make check-manual`` runs it over the real manual.
That is where the eleven acceptance rows meet a real PDF built from a tree
other than the committed manual.

Three mutations follow, each on a copy of the built tree, because a check that
only ever passes proves nothing:

* one source YAML value changes without a rebuild → #9 fails on
  ``reproducibility.inputs_changed``;
* the committed PDF is replaced by an older build → #9 fails on
  ``reproducibility.text_hash``;
* an invented brand name is added to a chapter and the manual is rebuilt → #6
  fails on the page of the PDF that carries it.

Everything here needs a working Pango and Cairo, so the module carries the
``weasyprint`` marker. On macOS::

    DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib uv run --package fdp-manual-build \\
        pytest tools/manual-build/tests/e2e/test_check_fixture.py -m weasyprint
"""

from __future__ import annotations

import contextlib
import json
import shutil
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from fdp_manual_build.build import Options, build_all
from fdp_manual_build.checks.runner import main
from fdp_manual_build.config import BuildConfig, load_build_config
from fdp_manual_build.load import load_manual
from fdp_manual_build.manifest import BuildRecord, PdfOutput, hash_file, write_manifest
from fdp_manual_build.manual_tools import find_repo_root

pytestmark = pytest.mark.weasyprint

#: Check #10 shells out to the REUSE tool through ``uvx``. The row may stay
#: unjudged where ``uvx`` is not installed, and nowhere else.
HAS_UVX = shutil.which("uvx") is not None
#: Every MUST row of the acceptance checks; #5 is the one report-only row.
MUST_ROWS = (1, 2, 3, 4, 6, 7, 8, 9, 11) + ((10,) if HAS_UVX else ())
#: What every run adds when the licence row cannot be judged here.
UVX_ARGS = () if HAS_UVX else ("--skip", "10")
#: Where the built manual lands inside the temporary checkout.
VARIANT_DIR = Path("data") / "manual"
#: The fixed moment the manifest records; the build itself reads no clock.
WALL_TIME = datetime(2026, 1, 15, tzinfo=UTC)

#: An invented manufacturer, in the shape ``tools/blocklist/tests`` uses for
#: its own synthetic list. No real brand appears in this repository.
BRAND_TERM = "Zorblax Kompressoren"

# The two files this module writes carry the header their kind of file would
# carry in the repository; the markers keep `reuse lint` from reading these
# string literals as this file's own licensing.
# REUSE-IgnoreStart
_SPDX = "# SPDX-FileCopyrightText: 2026 Meddle S.r.l.\n# SPDX-License-Identifier: Apache-2.0\n"
SYNTHETIC_LIST = f"""\
{_SPDX}#
# Invented names only, written by the acceptance end-to-end test.
[makers]
{BRAND_TERM}
"""
# REUSE-IgnoreEnd


# --- building the temporary checkout ----------------------------------------


@pytest.fixture(scope="module")
def weasyprint_ready() -> None:
    """Skip the module when WeasyPrint cannot load Pango on this host."""
    try:
        import weasyprint  # noqa: F401, PLC0415
    except Exception as error:  # pragma: no cover - environment dependent
        pytest.skip(f"WeasyPrint is not usable here: {error}")


@pytest.fixture(scope="module")
def built_repo(
    request: pytest.FixtureRequest,
    weasyprint_ready: None,
    tmp_path_factory: pytest.TempPathFactory,
) -> Path:
    """A checkout holding the mini manual, both PDFs and a build manifest."""
    repo_root: Path = request.getfixturevalue("repo_root")
    fixture: Path = request.getfixturevalue("mini_spec_dir")
    target = tmp_path_factory.mktemp("checked-repo") / "repo"
    assemble(target, repo_root, fixture)
    build(target)
    return target


def assemble(target: Path, repo_root: Path, fixture: Path) -> Path:
    """Lay out a checkout the runner accepts, around the mini manual tree."""
    manual = target / "manual"
    manual.mkdir(parents=True)
    for name in ("tools", "templates", "fonts"):
        shutil.copytree(repo_root / "manual" / name, manual / name)
    shutil.copytree(repo_root / "manual" / "spec" / "schemas", manual / "spec" / "schemas")
    shutil.copytree(fixture / "spec", manual / "spec", dirs_exist_ok=True)
    shutil.copytree(fixture / "content", manual / "content")
    shutil.copytree(fixture / "figures", manual / "figures")
    shutil.copy(fixture / "build.yaml", manual / "build.yaml")
    shutil.copytree(repo_root / "LICENSES", target / "LICENSES")
    shutil.copy(repo_root / "REUSE.toml", target / "REUSE.toml")
    write_scanner(target)
    return target


def write_scanner(target: Path, term_list: Path | None = None) -> Path:
    """Write the ``scripts/blocklist.sh`` check #6 calls in this checkout.

    The console script of the installed ``fdp-blocklist`` is called directly:
    ``uv run`` would need a project, and the temporary checkout is not one.
    The scanner finds its own configuration and digests next to the package it
    was installed from, so only ``--root`` changes.
    """
    scanner = Path(sys.executable).parent / "fdp-blocklist"
    override = f' --list "{term_list}"' if term_list is not None else ""
    script = target / "scripts" / "blocklist.sh"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(
        f'#!/bin/sh\n{_SPDX}\nexec "{scanner}" scan{override} "$@"\n', encoding="utf-8"
    )
    script.chmod(0o755)
    return script


def build(target: Path) -> BuildConfig:
    """Build both variants into ``data/manual`` and write the build manifest.

    The stylesheets and the fonts are addressed relative to the working
    directory, which is how ``make manual`` runs the build, so the build runs
    with the temporary checkout as its working directory.
    """
    cfg = load_build_config(target)
    with contextlib.chdir(target):
        build_all(
            cfg,
            target,
            Options(
                out_dir=target / VARIANT_DIR,
                strict_pages=False,
                html_dir=target / ".build",
            ),
        )
    write_manifest(target / VARIANT_DIR / "build-manifest.json", record(target, cfg))
    return cfg


def record(target: Path, cfg: BuildConfig) -> BuildRecord:
    """The build manifest for the build just made."""
    manual = load_manual(target, cfg)
    inputs = {f"manual/{name}": digest for name, digest in manual.source_hashes.items()}
    inputs |= {
        f"manual/fonts/{path.name}": hash_file(path)
        for path in sorted((target / "manual" / "fonts").glob("*.ttf"))
    }
    outputs = {
        name: PdfOutput.of(
            (VARIANT_DIR / cfg.outputs.pdf_name(name)).as_posix(),
            (target / VARIANT_DIR / cfg.outputs.pdf_name(name)).read_bytes(),
        )
        for name in sorted(cfg.variants)
        if (target / VARIANT_DIR / cfg.outputs.pdf_name(name)).is_file()
    }
    return BuildRecord(
        source_date_epoch=cfg.source_date_epoch,
        inputs=inputs,
        outputs=outputs,
        wall_time=WALL_TIME,
    )


# --- running the runner ------------------------------------------------------


def check(repo: Path, report_dir: Path, *extra: str) -> tuple[int, dict[str, Any]]:
    """Run ``fdp-manual-check`` over ``repo`` and read the JSON report back."""
    argv = [
        "--repo-root",
        str(repo),
        "--report-dir",
        str(report_dir),
        "--profile",
        "fixture",
        "--stats",
        str(stats_path()),
        *UVX_ARGS,
        *extra,
    ]
    with contextlib.chdir(repo):
        code = main(argv)
    document = json.loads((report_dir / "manual-check.json").read_text(encoding="utf-8"))
    assert isinstance(document, dict)
    return code, document


def stats_path() -> Path:
    """The MetroPT-3 statistics live in the real checkout, never in a copy."""
    root = find_repo_root(Path(__file__).resolve())
    assert root is not None, "the tests live inside the checkout"
    return root / "data" / "metropt3-first-month-stats.json"


def row(document: dict[str, Any], number: int) -> dict[str, Any]:
    """One check's row of the JSON report."""
    return next(item for item in document["checks"] if item["number"] == number)


def codes(document: dict[str, Any], number: int) -> list[str]:
    """Every finding code of one check, in order."""
    return [str(item["code"]) for item in row(document, number)["findings"]]


def copy_of(built_repo: Path, tmp_path: Path) -> Path:
    """A private copy of the built checkout, for a mutation."""
    target = tmp_path / "repo"
    shutil.copytree(built_repo, target, symlinks=True)
    return target


@pytest.fixture(scope="module")
def report(built_repo: Path, tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    """One full run over the built fixture, shared by the reading tests."""
    report_dir = tmp_path_factory.mktemp("report")
    code, document = check(built_repo, report_dir)
    document["exit_code"] = code
    return document


# --- the green run -----------------------------------------------------------


def test_every_must_check_passes_on_the_built_fixture(report: dict[str, Any]) -> None:
    failed = {
        item["number"]: [finding["message"] for finding in item["findings"]]
        for item in report["checks"]
        if item["number"] in MUST_ROWS and item["status"] != "pass"
    }
    assert failed == {}
    assert report["exit_code"] == 0
    assert report["summary"]["must_passed"] == len(MUST_ROWS)


def test_the_clean_coverage_is_complete_and_the_rows_come_back(
    report: dict[str, Any],
) -> None:
    """Every category the fixture prints is complete, and every row is a row.

    ``machine.limits`` reach a reader through ``tables.technical_data()``,
    which the shipping chapter 9 calls and the mini fixture's does not, so that
    one category is reported here instead of enforced; the rest of the expected
    set is found verbatim.
    """
    coverage = row(report, 3)
    assert coverage["metrics"]["expected"] > 0
    per_category = {
        key: str(value)
        for key, value in coverage["metrics"].items()
        if isinstance(value, str) and "/" in value and key != "machine_limit"
    }
    assert per_category
    for key, value in per_category.items():
        found, _, total = value.partition("/")
        assert found == total, f"{key}: {value}"
    misses = row(report, 3)["findings"]
    assert {item["code"] for item in misses} == {"coverage.missing_machine_limit"}
    assert {item["level"] for item in misses} == {"REPORT"}
    tables = row(report, 4)
    assert tables["metrics"]["recovery_pct"] == 100.0
    assert tables["metrics"]["expected_rows"] > 0


def test_the_realistic_row_reports_its_misses_and_never_fails(
    report: dict[str, Any],
) -> None:
    realistic = row(report, 5)
    assert realistic["status"] == "report"
    assert realistic["metrics"]["expected"] == row(report, 3)["metrics"]["expected"]
    misses = [item for item in realistic["findings"] if item["code"].startswith("coverage.")]
    assert misses, "the hard document is expected to lose something"
    for miss in misses:
        assert miss["level"] == "REPORT"
        assert miss["data"]["class"] in {
            "two_column_interleave",
            "imperial_split",
            "prose_only_fact",
            "unknown",
        }


def test_the_reproducibility_row_compared_a_real_rebuild(report: dict[str, Any]) -> None:
    reproducibility = row(report, 9)
    assert reproducibility["metrics"]["rebuild"] == "in-process"
    assert reproducibility["metrics"]["clean_text_sha256"]
    assert "reproducibility.inputs_changed" not in codes(report, 9)


@pytest.mark.skipif(not HAS_UVX, reason="check #10 needs uvx to run the REUSE tool")
def test_the_licence_row_judged_the_manual_tree(report: dict[str, Any]) -> None:
    reuse = row(report, 10)
    assert reuse["status"] == "pass", codes(report, 10)
    assert reuse["metrics"]["scope_problems"] == 0
    assert reuse["metrics"]["files_total"] > 0


def test_the_state_logic_rule_read_the_built_clean_pdf(report: dict[str, Any]) -> None:
    """The fixture maps one of the three tags, so rule 4 reports rather than fails."""
    metropt = row(report, 11)
    assert metropt["status"] == "pass"
    state = [item for item in metropt["findings"] if item["code"] == "metropt_fit.state_logic"]
    assert [item["level"] for item in state] == ["REPORT"]


# --- the mutations -----------------------------------------------------------


def test_a_source_edited_after_the_build_fails_reproducibility(
    built_repo: Path, tmp_path: Path
) -> None:
    repo = copy_of(built_repo, tmp_path)
    alarms = repo / "manual" / "spec" / "alarms.yaml"
    alarms.write_text(
        alarms.read_text(encoding="utf-8").replace("value: 85", "value: 86"), encoding="utf-8"
    )
    code, document = check(repo, tmp_path / "rep", "--only", "9")
    assert code == 1
    assert row(document, 9)["status"] == "fail"
    assert "reproducibility.inputs_changed" in codes(document, 9)


def test_a_committed_pdf_that_is_not_the_rebuild_fails_reproducibility(
    built_repo: Path, tmp_path: Path
) -> None:
    """The clean PDF is replaced by the realistic one: same tree, other text."""
    repo = copy_of(built_repo, tmp_path)
    variants = repo / VARIANT_DIR
    shutil.copy(variants / "mini-realistic.pdf", variants / "mini-clean.pdf")
    code, document = check(repo, tmp_path / "rep", "--only", "9")
    assert code == 1
    found = codes(document, 9)
    assert "reproducibility.text_hash" in found
    assert "reproducibility.manifest_stale" in found


def test_a_brand_name_in_a_rebuilt_manual_fails_the_blocklist(
    built_repo: Path, tmp_path: Path
) -> None:
    repo = copy_of(built_repo, tmp_path)
    term_list = tmp_path / "terms.txt"
    term_list.write_text(SYNTHETIC_LIST, encoding="utf-8")
    write_scanner(repo, term_list)
    safety = repo / "manual" / "content" / "01-safety.md"
    safety.write_text(
        safety.read_text(encoding="utf-8") + f"\nThe unit is a {BRAND_TERM} machine.\n",
        encoding="utf-8",
    )
    build(repo)

    code, document = check(repo, tmp_path / "rep", "--only", "6")
    assert code == 1
    assert row(document, 6)["status"] == "fail"
    hits = [item for item in row(document, 6)["findings"] if item["code"] == "blocklist.hit"]
    assert [item for item in hits if item["data"]["path"].endswith(".pdf")], [
        item["location"] for item in hits
    ]


def test_without_a_built_manual_the_pdf_rows_fail(built_repo: Path, tmp_path: Path) -> None:
    repo = copy_of(built_repo, tmp_path)
    shutil.rmtree(repo / VARIANT_DIR)
    code, document = check(repo, tmp_path / "rep", "--only", "3,4,5,9")
    assert code == 1
    assert [row(document, number)["status"] for number in (3, 4, 9)] == ["fail"] * 3
    assert row(document, 5)["status"] == "report"


def test_no_require_pdf_skips_the_pdf_rows_instead(built_repo: Path, tmp_path: Path) -> None:
    repo = copy_of(built_repo, tmp_path)
    shutil.rmtree(repo / VARIANT_DIR)
    code, document = check(repo, tmp_path / "rep", "--only", "3,4,5,9", "--no-require-pdf")
    assert code == 0
    for number in (3, 4, 5, 9):
        assert row(document, number)["status"] == "skipped"
        assert codes(document, number) == ["check.pdf_absent"]
