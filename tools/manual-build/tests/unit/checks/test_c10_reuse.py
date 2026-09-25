# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #10: the REUSE verdict, filtered to what the PDF build owns.

The tool itself is not run here — that is the end-to-end test's job. What is
tested is the reading: which of its complaints block the manual, which are
reported, and the six explicit annotations check #10 asks for on top of the
tool's own verdict.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from fdp_manual_build.checks import c10_reuse
from fdp_manual_build.checks.base import Level, Status
from fdp_manual_build.checks.c10_reuse import REUSE_REQUIREMENT, ReuseCheck, annotation_findings

from .factories import context

HEADER = "file-header"
TOML = "reuse-toml"


def entry(
    path: str, license_id: str, *, copyright_text: str = "2026 someone", source: str = HEADER
) -> dict[str, Any]:
    """One file as ``reuse lint --json`` reports it."""
    return {
        "path": path,
        "copyrights": [{"value": f"SPDX-FileCopyrightText: {copyright_text}", "source_type": TOML}],
        "spdx_expressions": [{"value": license_id, "is_valid": True, "source_type": source}],
    }


def report(*files: dict[str, Any], **non_compliant: list[str]) -> dict[str, Any]:
    """A whole ``reuse lint --json`` document."""
    return {
        "reuse_tool_version": "6.2.0",
        "files": list(files),
        "non_compliant": {
            "bad_licenses": [],
            "deprecated_licenses": [],
            "missing_licenses": [],
            "unused_licenses": [],
            "missing_copyright_info": [],
            "missing_licensing_info": [],
            "read_errors": [],
            **non_compliant,
        },
        "summary": {"files_total": len(files)},
    }


def run(
    repo_root: Path,
    monkeypatch: pytest.MonkeyPatch,
    document: dict[str, Any],
) -> Any:
    """Run the check against a canned tool report."""
    monkeypatch.setattr(c10_reuse, "reuse_lint", lambda root: (document, None))
    ctx = context(repo_root=repo_root, manual_root=repo_root / "manual")
    return ReuseCheck().run(ctx)


def codes(result: Any) -> list[str]:
    return [item.code for item in result.findings]


# --- the annotations ---------------------------------------------------------


def test_a_compliant_tree_reports_nothing() -> None:
    document = report(
        entry("manual/fonts/IBMPlexSans-Regular.ttf", "OFL-1.1", copyright_text="2017 IBM Corp."),
        entry("data/manual/cau-7-clean.pdf", "CC-BY-4.0", source=TOML),
        entry("tools/eval/fixtures/catalog.json", "CC-BY-4.0", source=TOML),
        entry("manual/content/01-safety.md", "CC-BY-4.0"),
        entry("manual/templates/base.html.j2", "Apache-2.0"),
        entry("manual/spec/alarms.yaml", "CC-BY-4.0"),
    )
    assert annotation_findings(document) == []


def test_a_font_without_the_upstream_copyright_is_a_finding() -> None:
    document = report(
        entry("manual/fonts/IBMPlexMono-Bold.ttf", "OFL-1.1", copyright_text="2026 someone")
    )
    findings = annotation_findings(document)
    assert [item.code for item in findings] == ["reuse.annotation"]
    assert "2017 IBM Corp." in findings[0].message


def test_a_font_under_the_wrong_licence_is_a_finding() -> None:
    document = report(
        entry("manual/fonts/IBMPlexMono-Bold.ttf", "Apache-2.0", copyright_text="2017 IBM Corp.")
    )
    assert "is licensed Apache-2.0, not OFL-1.1" in annotation_findings(document)[0].message


def test_a_built_pdf_must_be_cc_by(mini_config: object) -> None:
    del mini_config
    document = report(entry("data/manual/cau-7-realistic.pdf", "Apache-2.0", source=TOML))
    assert [item.code for item in annotation_findings(document)] == ["reuse.annotation"]


def test_a_chapter_partial_needs_its_own_header() -> None:
    document = report(entry("manual/content/08-troubleshooting.md", "CC-BY-4.0", source=TOML))
    findings = annotation_findings(document)
    assert "needs its own SPDX header" in findings[0].message


def test_a_template_is_code_and_a_spec_document_is_content() -> None:
    document = report(
        entry("manual/templates/css/base.css", "CC-BY-4.0"),
        entry("manual/spec/signals.yaml", "Apache-2.0"),
    )
    assert [item.location for item in annotation_findings(document)] == [
        "manual/spec/signals.yaml",
        "manual/templates/css/base.css",
    ]


def test_a_file_in_a_spec_subdirectory_is_not_judged_as_a_spec_document() -> None:
    document = report(entry("manual/spec/schemas/common.schema.json", "Apache-2.0", source=TOML))
    assert annotation_findings(document) == []


# --- the tool's verdict ------------------------------------------------------


def test_a_missing_header_inside_the_scope_fails_the_check(
    repo_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    document = report(missing_licensing_info=["manual/content/03-controller.md"])
    result = run(repo_root, monkeypatch, document)
    assert result.status is Status.FAIL
    assert codes(result) == ["reuse.missing_licensing_info"]
    assert result.metrics["scope_problems"] == 1


def test_a_missing_header_outside_the_scope_is_reported_only(
    repo_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    document = report(missing_licensing_info=["apps/frontend/src/main.tsx"])
    result = run(repo_root, monkeypatch, document)
    assert result.status is Status.PASS
    assert [item.level for item in result.findings] == [Level.REPORT]
    assert result.metrics["repository_problems"] == 1
    assert result.metrics["scope_problems"] == 0


def test_an_unused_licence_of_another_area_never_blocks_the_manual(
    repo_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    result = run(repo_root, monkeypatch, report(unused_licenses=["MIT"]))
    assert result.status is Status.PASS
    assert [item.level for item in result.findings] == [Level.REPORT]


def test_a_licence_text_the_manual_needs_blocks_the_check(
    repo_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    result = run(repo_root, monkeypatch, report(missing_licenses=["OFL-1.1"]))
    assert result.status is Status.FAIL
    assert codes(result) == ["reuse.missing_licenses"]


def test_a_licence_text_that_is_not_in_the_tree_is_named(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "manual").mkdir()
    result = run(tmp_path, monkeypatch, report())
    assert result.status is Status.FAIL
    assert codes(result) == ["reuse.missing_license_text"] * 3


# --- running the tool --------------------------------------------------------


def test_a_missing_uvx_is_an_error_not_a_pass(
    repo_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(c10_reuse.shutil, "which", lambda name: None)
    ctx = context(repo_root=repo_root, manual_root=repo_root / "manual")
    result = ReuseCheck().run(ctx)
    assert result.status is Status.ERROR
    assert codes(result) == ["reuse.tool_error"]
    assert result.findings[0].location == REUSE_REQUIREMENT


def test_output_that_is_not_json_is_an_error(
    repo_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(c10_reuse.shutil, "which", lambda name: "/usr/bin/uvx")

    def fake_run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        del args, kwargs
        return subprocess.CompletedProcess([], 2, stdout="boom", stderr="no such option")

    monkeypatch.setattr(c10_reuse.subprocess, "run", fake_run)
    ctx = context(repo_root=repo_root, manual_root=repo_root / "manual")
    result = ReuseCheck().run(ctx)
    assert result.status is Status.ERROR
    assert "no such option" in result.findings[0].message


def test_the_command_is_the_pinned_one(repo_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        del kwargs
        seen.append(command)
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(report()), stderr="")

    monkeypatch.setattr(c10_reuse.shutil, "which", lambda name: "/usr/bin/uvx")
    monkeypatch.setattr(c10_reuse.subprocess, "run", fake_run)
    document, failure = c10_reuse.reuse_lint(repo_root)
    assert failure is None
    assert document["reuse_tool_version"] == "6.2.0"
    assert seen[0][:4] == ["uvx", "--from", REUSE_REQUIREMENT, "reuse"]
    assert seen[0][-2:] == ["lint", "--json"]
