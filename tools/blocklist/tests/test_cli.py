# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""End to end: the real CLI process over a temporary git repository and a PDF."""

import json
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

import pytest

from fdp_blocklist.cli import EXIT_ERROR, EXIT_FINDINGS, EXIT_OK

WritePdf = Callable[[Path, Sequence[Sequence[str]]], Path]


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    """Run the installed console script's module in a real child process."""
    return subprocess.run(
        [sys.executable, "-m", "fdp_blocklist.cli", *args],
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.fixture
def repo_with_list(git_repo: Path, synthetic_list: str) -> Path:
    (git_repo / "list.txt").write_text(synthetic_list, encoding="utf-8")
    (git_repo / ".gitignore").write_text("list.txt\n", encoding="utf-8")
    return git_repo


def test_a_clean_repository_exits_zero(repo_with_list: Path) -> None:
    (repo_with_list / "clean.md").write_text("a twin tower dryer\n", encoding="utf-8")
    result = run_cli(
        "scan", "--root", str(repo_with_list), "--list", str(repo_with_list / "list.txt")
    )
    assert result.returncode == EXIT_OK
    assert "0 hit(s)" in result.stdout


def test_a_hit_exits_one_and_reports_its_location(repo_with_list: Path) -> None:
    (repo_with_list / "dirty.md").write_text("first\nplate: Zorbal drum\n", encoding="utf-8")
    result = run_cli(
        "scan", "--root", str(repo_with_list), "--list", str(repo_with_list / "list.txt")
    )
    assert result.returncode == EXIT_FINDINGS
    assert "dirty.md:2:8: Zorbal  [lubricants]" in result.stdout


def test_json_output_carries_every_field(repo_with_list: Path) -> None:
    (repo_with_list / "dirty.md").write_text("plate: Zorbal drum\n", encoding="utf-8")
    result = run_cli(
        "scan",
        "--root",
        str(repo_with_list),
        "--list",
        str(repo_with_list / "list.txt"),
        "--format",
        "json",
    )
    assert result.returncode == EXIT_FINDINGS
    payload = json.loads(result.stdout)
    assert payload["hits"] == [
        {
            "path": "dirty.md",
            "page": None,
            "line": 1,
            "col": 8,
            "term": "Zorbal",
            "section": "lubricants",
            "context": "plate: Zorbal drum",
        }
    ]
    assert payload["patterns"] == 1


def test_an_exclude_glob_drops_a_file(repo_with_list: Path) -> None:
    (repo_with_list / "dirty.md").write_text("plate: Zorbal drum\n", encoding="utf-8")
    result = run_cli(
        "scan",
        "--root",
        str(repo_with_list),
        "--list",
        str(repo_with_list / "list.txt"),
        "--exclude",
        "*.md",
    )
    assert result.returncode == EXIT_OK


def test_an_extra_pdf_is_scanned(repo_with_list: Path, pdf_writer: WritePdf) -> None:
    path = pdf_writer(repo_with_list / "out.pdf", [["clean"], ["plate Zorbal unit"]])
    result = run_cli(
        "scan",
        "--root",
        str(repo_with_list),
        "--list",
        str(repo_with_list / "list.txt"),
        "--exclude",
        "**/*.pdf",
        "--pdf",
        str(path),
        "--format",
        "json",
    )
    assert result.returncode == EXIT_FINDINGS
    payload = json.loads(result.stdout)
    assert payload["pdf_files"] == 1
    assert payload["hits"][0]["page"] == 2


def test_a_missing_extra_pdf_is_an_environment_error(repo_with_list: Path) -> None:
    result = run_cli(
        "scan",
        "--root",
        str(repo_with_list),
        "--list",
        str(repo_with_list / "list.txt"),
        "--pdf",
        str(repo_with_list / "absent.pdf"),
    )
    assert result.returncode == EXIT_ERROR
    assert "no such PDF" in result.stderr


def test_a_malformed_list_is_an_environment_error(tmp_path: Path) -> None:
    bad = tmp_path / "bad.txt"
    bad.write_text("[makers]\nab\n", encoding="utf-8")
    result = run_cli("scan", "--root", str(tmp_path), "--list", str(bad))
    assert result.returncode == EXIT_ERROR
    assert "shorter than 4 characters" in result.stderr


def test_the_self_test_passes(tmp_path: Path) -> None:
    result = run_cli("self-test", "--format", "json")
    assert result.returncode == EXIT_OK
    payload = json.loads(result.stdout)
    assert payload["missing"] == []
    assert payload["unexpected"] == []
    assert len(payload["hits"]) == 4


def test_list_reports_the_sections_and_their_minimums() -> None:
    result = run_cli("list", "--format", "json")
    assert result.returncode == EXIT_OK
    payload = json.loads(result.stdout)
    assert [row["section"] for row in payload["sections"]] == [
        "makers",
        "controllers",
        "product-lines",
        "dryers-filters",
        "lubricants",
        "rail-apu",
    ]
    assert all(row["terms"] >= row["minimum"] for row in payload["sections"])
    assert payload["variants"] > 0


def test_list_flags_a_section_below_its_minimum(tmp_path: Path) -> None:
    short = tmp_path / "short.sha256"
    short.write_text("makers\t1\t" + "0" * 64 + "\n", encoding="utf-8")
    result = run_cli("list", "--list", str(short))
    assert result.returncode == EXIT_FINDINGS
    assert "below the section minimum" in result.stderr


def test_the_digest_file_is_regenerated_and_verified(tmp_path: Path, synthetic_list: str) -> None:
    source = tmp_path / "list.txt"
    source.write_text(synthetic_list, encoding="utf-8")
    target = tmp_path / "out.sha256"
    written = run_cli("hash", "--from", str(source), "--out", str(target))
    assert written.returncode == EXIT_OK
    assert target.is_file()

    verified = run_cli("hash", "--from", str(source), "--out", str(target), "--check")
    assert verified.returncode == EXIT_OK

    source.write_text(synthetic_list + "Extra Airworks\n", encoding="utf-8")
    stale = run_cli("hash", "--from", str(source), "--out", str(target), "--check")
    assert stale.returncode == EXIT_FINDINGS
    assert "out of date" in stale.stderr


def test_the_committed_digest_file_matches_the_private_list() -> None:
    from fdp_blocklist.config import load_config  # noqa: PLC0415

    config = load_config()
    if not config.private_list.is_file():
        pytest.skip(f"{config.private_list} is gitignored and absent in this checkout")
    result = run_cli("hash", "--from", str(config.private_list), "--check")
    assert result.returncode == EXIT_OK, result.stderr
