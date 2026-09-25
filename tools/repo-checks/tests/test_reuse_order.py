# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-checks reuse-order``: the committed REUSE.toml still resolves right.

The happy case is the repository itself; the failure cases are
copies of its ``REUSE.toml`` with the two mistakes the marker exists to
prevent.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from fdp_repo_checks import cli
from fdp_repo_checks.commands import reuse_order
from fdp_repo_checks.findings import EXIT_ERROR, EXIT_FINDINGS, EXIT_OK
from fdp_repo_checks.reuse_toml import MARKER, glob_to_regex
from fdp_repo_checks.reuse_toml import load as load_reuse_toml
from helpers import FixtureRepo

REPO_ROOT = Path(__file__).resolve().parents[3]
REAL_REUSE_TOML = REPO_ROOT / "REUSE.toml"
REAL_TABLE = REPO_ROOT / reuse_order.DEFAULT_TABLE
GENERAL_JSON_PATTERN = '"**/*.json"'
RELICENSED_PATH = "packages/contracts/fixtures/valid-1.json"


def annotation_blocks(text: str) -> tuple[str, list[str]]:
    """Split a REUSE.toml into its preamble and its ``[[annotations]]`` blocks."""
    lines = text.splitlines(keepends=True)
    starts = [index for index, line in enumerate(lines) if line.strip() == "[[annotations]]"]
    assert starts, "the fixture needs at least one annotation"
    bounds = [*starts, len(lines)]
    blocks = [
        "".join(lines[bounds[position] : bounds[position + 1]]) for position in range(len(starts))
    ]
    return "".join(lines[: starts[0]]), blocks


def move_general_json_table_last(text: str) -> str:
    """Reproduce the mistake the check guards against: the general table goes last."""
    preamble, blocks = annotation_blocks(text)
    general = [block for block in blocks if GENERAL_JSON_PATTERN in block]
    assert len(general) == 1, "expected exactly one general JSON table"
    rest = [block for block in blocks if block not in general]
    return preamble + "".join(rest) + "\n" + general[0]


def stage(repo: FixtureRepo, reuse_text: str) -> None:
    """Put a REUSE.toml under test into the fixture repository."""
    repo.write("REUSE.toml", reuse_text)


def test_the_committed_repository_resolves_clean(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["reuse-order", "--root", str(REPO_ROOT)]) == EXIT_OK
    assert "reuse-order: ok" in capsys.readouterr().out


def test_moving_the_general_table_below_the_marker_fails(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    stage(repo, move_general_json_table_last(REAL_REUSE_TOML.read_text(encoding="utf-8")))
    assert repo.run("reuse-order", "--table", str(REAL_TABLE)) == EXIT_FINDINGS
    out = capsys.readouterr().out
    assert RELICENSED_PATH in out
    assert "resolves to Apache-2.0 but must be CC-BY-4.0" in out
    assert "sits below the ordering marker" in out


def test_deleting_the_marker_fails(repo: FixtureRepo, capsys: pytest.CaptureFixture[str]) -> None:
    text = REAL_REUSE_TOML.read_text(encoding="utf-8")
    assert MARKER in text
    stage(repo, text.replace(f"{MARKER}\n", ""))
    assert repo.run("reuse-order", "--table", str(REAL_TABLE)) == EXIT_FINDINGS
    assert "the ordering marker is missing" in capsys.readouterr().out


def test_a_drifted_copyright_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    text = REAL_REUSE_TOML.read_text(encoding="utf-8")
    stage(repo, text.replace("2017 IBM Corp.", "2026 Meddle S.r.l."))
    assert repo.run("reuse-order", "--table", str(REAL_TABLE)) == EXIT_FINDINGS
    assert "copyright resolves to" in capsys.readouterr().out


def test_an_uncovered_path_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    stage(repo, f"version = 1\n\n{MARKER}\n")
    repo.write(
        "expected.toml",
        'version = 1\n\n[[expected]]\npath = "data/manual/x.pdf"\n'
        'why = "content"\nSPDX-License-Identifier = "CC-BY-4.0"\n',
    )
    assert repo.run("reuse-order", "--table", "expected.toml") == EXIT_FINDINGS
    assert "no REUSE.toml table covers it" in capsys.readouterr().out


def test_a_missing_expectation_table_is_an_environment_error(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    stage(repo, f"version = 1\n\n{MARKER}\n")
    assert repo.run("reuse-order", "--table", "nope.toml") == EXIT_ERROR
    assert "cannot be read" in capsys.readouterr().err


def test_an_entry_without_a_reason_is_an_environment_error(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    stage(repo, f"version = 1\n\n{MARKER}\n")
    repo.write(
        "expected.toml",
        'version = 1\n\n[[expected]]\npath = "a.json"\nSPDX-License-Identifier = "MIT"\n',
    )
    assert repo.run("reuse-order", "--table", "expected.toml") == EXIT_ERROR
    assert "has no `why`" in capsys.readouterr().err


def test_json_output_lists_the_findings(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    text = REAL_REUSE_TOML.read_text(encoding="utf-8")
    stage(repo, text.replace(f"{MARKER}\n", ""))
    exit_code = repo.run("reuse-order", "--table", str(REAL_TABLE), "--format", "json")
    assert exit_code == EXIT_FINDINGS
    payload = json.loads(capsys.readouterr().out)
    assert payload["check"] == "reuse-order"
    assert payload["findings"][0]["path"] == "REUSE.toml"


def test_the_last_matching_table_wins(repo: FixtureRepo) -> None:
    stage(
        repo,
        "version = 1\n\n"
        "[[annotations]]\n"
        'path = ["**/*.json"]\n'
        'SPDX-License-Identifier = "Apache-2.0"\n\n'
        f"{MARKER}\n\n"
        "[[annotations]]\n"
        'path = ["data/**"]\n'
        'SPDX-License-Identifier = "CC-BY-4.0"\n',
    )
    parsed = load_reuse_toml(repo.path / "REUSE.toml")
    first = parsed.covered("src/a.json")
    last = parsed.covered("data/a.json")
    assert first is not None and first.license_id == "Apache-2.0"
    assert last is not None and last.license_id == "CC-BY-4.0"


@pytest.mark.parametrize(
    ("pattern", "path", "matches"),
    [
        ("**/*.json", "a.json", True),
        ("**/*.json", "deep/nested/a.json", True),
        ("**/*.json", "a.jsonl", False),
        ("docs/img/**/*.json", "docs/img/data/a.json", True),
        ("docs/img/**/*.json", "docs/a.json", False),
        ("data/fixtures/*.json", "data/fixtures/a.json", True),
        ("data/fixtures/*.json", "data/fixtures/deep/a.json", False),
        ("manual/fonts/**", "manual/fonts/IBMPlexSans-Regular.ttf", True),
        ("data/SHA256SUMS", "data/SHA256SUMS", True),
        ("data/fixtures/metropt3-*", "data/fixtures/metropt3-slices.json", True),
        ("apps/**/test/fixtures/**", "apps/backend/test/fixtures/a.json", True),
    ],
)
def test_glob_to_regex_follows_the_reuse_specification(
    pattern: str, path: str, matches: bool
) -> None:
    assert bool(glob_to_regex(pattern).match(path)) is matches
