# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-checks spdx`` over git fixture repositories.

Every branch of the check's algorithm gets a case that passes and a case that
fails.
"""

from __future__ import annotations

import json

import pytest

from fdp_repo_checks.commands import spdx
from fdp_repo_checks.findings import EXIT_ERROR, EXIT_FINDINGS, EXIT_OK
from helpers import (
    HEADER_NO_COPYRIGHT,
    HEADER_NO_LICENSE,
    HEADER_OK,
    HEADER_UNKNOWN_ID,
    SIDECAR,
    FixtureRepo,
)

REUSE_TOML = """# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: CC0-1.0
version = 1

[[annotations]]
path = ["**/*.json"]
precedence = "closest"
SPDX-FileCopyrightText = "2026 Meddle S.r.l."
SPDX-License-Identifier = "Apache-2.0"

# --- specific annotations: append below this line, never above ---
"""


def test_a_correct_header_passes(repo: FixtureRepo, capsys: pytest.CaptureFixture[str]) -> None:
    repo.write("src/ok.py", HEADER_OK + "value = 1\n")
    assert repo.run("spdx") == EXIT_OK
    assert "spdx: ok" in capsys.readouterr().out


def test_an_identifier_without_a_licence_text_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write("src/wrong.py", HEADER_UNKNOWN_ID + "value = 1\n")
    assert repo.run("spdx") == EXIT_FINDINGS
    out = capsys.readouterr().out
    assert "src/wrong.py: unknown" in out
    assert "BSD-3-Clause" in out


def test_a_missing_copyright_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write("src/nocopy.py", HEADER_NO_COPYRIGHT + "value = 1\n")
    assert repo.run("spdx") == EXIT_FINDINGS
    assert f"src/nocopy.py: the {spdx.COPYRIGHT_NAME} tag is missing" in capsys.readouterr().out


def test_a_missing_identifier_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write("src/nolicence.py", HEADER_NO_LICENSE + "value = 1\n")
    assert repo.run("spdx") == EXIT_FINDINGS
    assert f"src/nolicence.py: the {spdx.LICENSE_NAME} tag is missing" in capsys.readouterr().out


def test_a_file_without_any_header_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write("src/bare.py", "value = 1\n")
    assert repo.run("spdx") == EXIT_FINDINGS
    assert "src/bare.py: no SPDX header" in capsys.readouterr().out


def test_a_tag_below_the_window_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    padding = "# filler\n" * spdx.HEADER_LINES
    repo.write("src/late.py", padding + HEADER_OK)
    assert repo.run("spdx") == EXIT_FINDINGS
    assert "src/late.py: no SPDX header" in capsys.readouterr().out


def test_a_json_file_covered_by_reuse_toml_passes(repo: FixtureRepo) -> None:
    repo.write("REUSE.toml", REUSE_TOML)
    repo.write("data/covered.json", '{"a": 1}\n')
    assert repo.run("spdx") == EXIT_OK


def test_a_json_file_without_a_reuse_toml_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write("data/uncovered.json", '{"a": 1}\n')
    assert repo.run("spdx") == EXIT_FINDINGS
    assert "data/uncovered.json: no SPDX header" in capsys.readouterr().out


def test_a_license_sidecar_is_checked_instead_of_the_file(repo: FixtureRepo) -> None:
    repo.write("docs/diagram.png", b"\x89PNG\r\n\x1a\n\x00binary")
    repo.write("docs/diagram.png.license", SIDECAR)
    assert repo.run("spdx") == EXIT_OK


def test_a_sidecar_with_an_unknown_identifier_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write("docs/diagram.png", b"\x89PNG\r\n\x1a\n\x00binary")
    repo.write("docs/diagram.png.license", HEADER_UNKNOWN_ID)
    assert repo.run("spdx") == EXIT_FINDINGS
    assert "docs/diagram.png.license: unknown" in capsys.readouterr().out


def test_a_binary_without_annotation_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write("docs/diagram.png", b"\x89PNG\r\n\x1a\n\x00binary")
    assert repo.run("spdx") == EXIT_FINDINGS
    assert f"docs/diagram.png: {spdx.BINARY_REASON}" in capsys.readouterr().out


def test_a_zero_byte_placeholder_passes(repo: FixtureRepo) -> None:
    repo.write("data/.gitkeep", "")
    assert repo.run("spdx") == EXIT_OK


def test_the_licence_texts_and_notice_are_exempt(repo: FixtureRepo) -> None:
    repo.write("NOTICE", "Plain text with no comment syntax.\n")
    repo.write("LICENSE", "Apache License, Version 2.0\n")
    assert repo.run("spdx") == EXIT_OK


def test_a_symlink_is_skipped(repo: FixtureRepo) -> None:
    repo.write("src/ok.py", HEADER_OK)
    (repo.path / "src" / "link.py").symlink_to("ok.py")
    assert repo.run("spdx") == EXIT_OK


def test_staged_mode_sees_only_what_is_staged(repo: FixtureRepo) -> None:
    repo.write("src/ok.py", HEADER_OK)
    repo.commit_all("clean tree")
    repo.write("src/bad.py", "value = 1\n")
    assert repo.run("spdx", "--staged") == EXIT_OK, "unstaged files are not the hook's business"
    repo.git("add", "src/bad.py")
    assert repo.run("spdx", "--staged") == EXIT_FINDINGS


def test_an_oversized_file_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(spdx, "MAX_FILE_BYTES", 8)
    repo.write("data/big.bin", b"\x00" * 64)
    assert repo.run("spdx") == EXIT_FINDINGS
    assert "data/big.bin: 64 bytes exceeds the limit of 8 bytes" in capsys.readouterr().out


def test_json_output_lists_the_findings(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write("src/bare.py", "value = 1\n")
    assert repo.run("spdx", "--format", "json") == EXIT_FINDINGS
    payload = json.loads(capsys.readouterr().out)
    assert payload["check"] == "spdx"
    assert payload["ok"] is False
    assert [finding["path"] for finding in payload["findings"]] == ["src/bare.py"]


def test_a_repository_without_licence_texts_is_an_environment_error(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    for text in (repo.path / "LICENSES").glob("*.txt"):
        text.unlink()
    assert repo.run("spdx") == EXIT_ERROR
    assert "holds no *.txt licence text" in capsys.readouterr().err


def test_a_broken_reuse_toml_is_an_environment_error(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write("REUSE.toml", "version = 1\nthis is not toml\n")
    assert repo.run("spdx") == EXIT_ERROR
    assert "not valid TOML" in capsys.readouterr().err
