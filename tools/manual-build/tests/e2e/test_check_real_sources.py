# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The manual sources ↔ PDF build integration test.

Runs the six source-level acceptance checks — #1 schema, #2 referential
integrity, #6 brand blocklist, #7 physical plausibility, #8 diagnostic
ambiguity and #11 MetroPT-3 fit — against the real ``manual/`` sources, with
no PDF anywhere. It is skipped when the manual's YAML is absent from the
checkout.

Marker ``sources``: ``uv run --package fdp-manual-build pytest tools/manual-build -m sources``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from fdp_manual_build.checks.runner import main

pytestmark = pytest.mark.sources

#: The rows that judge the sources alone; the rest read the built PDFs.
SOURCE_LEVEL = (1, 2, 6, 7, 8, 11)
#: The catalog size the real sources must reach.
SPEC_MINIMUMS = {"conditions": 12, "causes": 30, "alarms": 20, "maintenance": 8}

_SPEC_FILES = ("machine", "signals", "settings", "alarms", "faults", "maintenance")


@pytest.fixture(scope="module")
def real_sources(repo_root: Path) -> Path:
    """The real manual tree, or a skip while the manual's YAML is not merged."""
    manual_root = repo_root / "manual"
    missing = [
        name for name in _SPEC_FILES if not (manual_root / "spec" / f"{name}.yaml").is_file()
    ]
    if missing:
        pytest.skip(f"manual/spec is incomplete: {', '.join(missing)} not merged yet")
    return manual_root


@pytest.fixture(scope="module")
def report(repo_root: Path, real_sources: Path, tmp_path_factory: pytest.TempPathFactory) -> Any:
    """Run the whole runner once and hand every test the same report."""
    del real_sources
    report_dir = tmp_path_factory.mktemp("real-sources")
    # No manual is built here, so the four rows that read a PDF say they were
    # skipped instead of failing; the built manual is what
    # ``test_check_fixture.py`` and ``make check-manual`` judge. The checkout
    # ships both PDFs under ``data/manual``, so
    # ``--variant-dir`` points the run at an empty directory to keep this
    # module about the sources alone.
    exit_code = main(
        [
            "--repo-root",
            str(repo_root),
            "--report-dir",
            str(report_dir),
            "--variant-dir",
            str(tmp_path_factory.mktemp("no-pdf")),
            "--no-require-pdf",
        ]
    )
    document = json.loads((report_dir / "manual-check.json").read_text(encoding="utf-8"))
    document["exit_code"] = exit_code
    return document


def _check(report: dict[str, Any], number: int) -> dict[str, Any]:
    return next(item for item in report["checks"] if item["number"] == number)


def test_every_source_level_check_passes(report: dict[str, Any]) -> None:
    failed = {
        item["number"]: [finding["message"] for finding in item["findings"]]
        for item in report["checks"]
        if item["number"] in SOURCE_LEVEL and item["status"] != "pass"
    }
    assert failed == {}, failed
    assert report["exit_code"] == 0
    assert report["profile"] == "full"


def test_the_run_judges_the_shipping_catalog_not_a_fixture(report: dict[str, Any]) -> None:
    ambiguity = _check(report, 8)
    for key, minimum in SPEC_MINIMUMS.items():
        assert ambiguity["metrics"][key] >= minimum, key
    assert ambiguity["metrics"]["mapped_signals"] == 15


def test_all_fifteen_metropt_columns_are_mapped(report: dict[str, Any]) -> None:
    metropt = _check(report, 11)
    assert metropt["metrics"]["columns_mapped"] == 15
    assert metropt["metrics"]["violations"] == 0
    assert [finding["level"] for finding in metropt["findings"]] == ["REPORT"]


def test_the_sources_carry_no_blocked_brand(report: dict[str, Any]) -> None:
    blocklist = _check(report, 6)
    assert blocklist["metrics"]["hits"] == 0
    assert blocklist["metrics"]["files_scanned"] > 0
    assert blocklist["metrics"]["terms"] > 0


def test_the_pdf_level_rows_wait_for_a_built_manual(report: dict[str, Any]) -> None:
    assert [item["number"] for item in report["checks"]] == [1, 2, 11, 7, 8, 6, 3, 4, 5, 9, 10]
    for number in (3, 4, 5, 9):
        row = _check(report, number)
        assert row["status"] == "skipped"
        assert row["findings"][0]["code"] == "check.pdf_absent"


def test_the_licence_row_judges_the_real_checkout(report: dict[str, Any]) -> None:
    """#10 needs no PDF: it is the one PDF-level row that runs on the sources."""
    reuse = _check(report, 10)
    assert reuse["status"] == "pass", [item["message"] for item in reuse["findings"]]
    assert reuse["metrics"]["scope_problems"] == 0
