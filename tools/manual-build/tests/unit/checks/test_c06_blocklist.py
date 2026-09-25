# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #6 delegates to the brand blocklist scanner and maps its hits.

The repository holds exactly one term list and it is not in plain text,
so a hit is provoked with a synthetic term list the
test writes itself; no real brand name appears anywhere in this file.
"""

from __future__ import annotations

import sys
from pathlib import Path

from fdp_manual_build.checks.base import CheckResult, Level, Profile, Status
from fdp_manual_build.checks.c06_blocklist import BlocklistCheck
from fdp_manual_build.config import BuildConfig

from .factories import blocklist_stub, context

#: Fictional names that stand in for the real ones the committed list holds.
SYNTHETIC_LIST = "[makers]\nZorblax Kompressoren\n\n[product-lines]\nre:\\bZX-?9[0-9]{3}\\b\n"


def _codes(result: CheckResult) -> list[str]:
    return [finding.code for finding in result.findings]


def _wrapper(tmp_path: Path, term_list: Path) -> Path:
    """A ``scripts/blocklist.sh`` stand-in that matches ``term_list`` instead."""
    script = tmp_path / "blocklist-with-list.py"
    script.write_text(
        f"#!{sys.executable}\n"
        "import sys\n"
        "from fdp_blocklist.cli import main\n"
        f"raise SystemExit(main(['scan', '--list', {str(term_list)!r}, *sys.argv[1:]]))\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    return script


def test_the_real_sources_have_no_hits(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig
) -> None:
    ctx = context(repo_root=repo_root, manual_root=repo_root / "manual", cfg=mini_config)
    ctx.profile = Profile.FULL
    result = BlocklistCheck().run(ctx)
    assert result.status is Status.PASS
    assert result.metrics["hits"] == 0
    assert result.metrics["terms"] > 0
    assert "tools/manual-build" in str(result.metrics["scope"])
    del mini_spec_dir


def test_the_mini_fixture_has_no_hits(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig
) -> None:
    ctx = context(repo_root=repo_root, manual_root=mini_spec_dir, cfg=mini_config)
    result = BlocklistCheck().run(ctx)
    assert result.status is Status.PASS
    assert result.metrics["hits"] == 0
    assert result.metrics["scope"] == "tools/manual-build/tests/fixtures/mini-spec"


def test_three_blocked_terms_in_a_partial_are_three_hits(
    tmp_path: Path, repo_root: Path, mini_config: BuildConfig
) -> None:
    tree = tmp_path / "manual"
    (tree / "content").mkdir(parents=True)
    (tree / "content" / "02-description.md").write_text(
        "The skid carries a Zorblax Kompressoren airend.\n"
        "The nameplate reads zorblax-kompressoren, rebuilt last spring.\n"
        "Its controller is a ZX-9000 with the original firmware.\n",
        encoding="utf-8",
    )
    term_list = tmp_path / "terms.txt"
    term_list.write_text(SYNTHETIC_LIST, encoding="utf-8")
    ctx = context(
        repo_root=tmp_path,
        manual_root=tree,
        cfg=mini_config,
        blocklist_cmd=_wrapper(tmp_path, term_list),
    )
    result = BlocklistCheck().run(ctx)
    assert result.status is Status.FAIL
    assert result.metrics["hits"] == 3
    hits = [finding for finding in result.findings if finding.code == "blocklist.hit"]
    assert [finding.location for finding in hits] == [
        "manual/content/02-description.md:1",
        "manual/content/02-description.md:2",
        "manual/content/02-description.md:3",
    ]
    assert all(finding.level is Level.MUST for finding in hits)
    del repo_root


def test_missing_pdfs_are_reported_not_claimed_clean(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, tmp_path: Path
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        variant_dir=tmp_path / "no-pdfs",
    )
    result = BlocklistCheck().run(ctx)
    assert result.status is Status.PASS
    assert result.metrics["pdfs_scanned"] == 0
    reported = [item for item in result.findings if item.code == "blocklist.pdfs_not_scanned"]
    assert [item.level for item in reported] == [Level.REPORT]


def test_a_scanner_that_cannot_run_is_an_error(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, tmp_path: Path
) -> None:
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        blocklist_cmd=tmp_path / "not-here.sh",
    )
    result = BlocklistCheck().run(ctx)
    assert result.status is Status.ERROR
    assert _codes(result) == ["blocklist.scanner_error"]


def test_output_that_is_not_json_is_an_error(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, tmp_path: Path
) -> None:
    stub = tmp_path / "noise.py"
    stub.write_text(f"#!{sys.executable}\nprint('not json')\n", encoding="utf-8")
    stub.chmod(0o755)
    ctx = context(
        repo_root=repo_root, manual_root=mini_spec_dir, cfg=mini_config, blocklist_cmd=stub
    )
    result = BlocklistCheck().run(ctx)
    assert result.status is Status.ERROR
    assert "not JSON" in result.findings[0].message


def test_a_hit_on_a_pdf_page_is_located_by_page(
    repo_root: Path, mini_spec_dir: Path, mini_config: BuildConfig, tmp_path: Path
) -> None:
    payload = {
        "hits": [
            {
                "path": "data/manual/cau-7-clean.pdf",
                "page": 12,
                "line": 4,
                "col": 7,
                "term": "zorblax kompressoren",
                "section": "makers",
            }
        ],
        "digests": 1,
        "patterns": 0,
        "text_files": 0,
        "pdf_files": 1,
    }
    ctx = context(
        repo_root=repo_root,
        manual_root=mini_spec_dir,
        cfg=mini_config,
        blocklist_cmd=blocklist_stub(tmp_path, payload, exit_code=1),
    )
    result = BlocklistCheck().run(ctx)
    assert result.status is Status.FAIL
    assert result.findings[0].location == "data/manual/cau-7-clean.pdf:p12:4"
