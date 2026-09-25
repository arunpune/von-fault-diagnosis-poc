# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-checks commits``: the Conventional Commits rule of the repository.

Every test drives the real CLI over a throw-away ``git init`` repository, so
the check is exercised through the same ``git log`` path it uses in anger.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from fdp_repo_checks import cli
from fdp_repo_checks.commands import commits
from fdp_repo_checks.findings import EXIT_ERROR, EXIT_FINDINGS, EXIT_OK
from helpers import HEADER_OK, FixtureRepo

BODY = "Refs: #123\n"
"""A typical commit body."""


def commit(repo: FixtureRepo, message: str, *, name: str | None = None) -> str:
    """Add one file and commit it with ``message``; returns the new hash."""
    path = name or f"file-{hashlib.sha256(message.encode()).hexdigest()[:12]}.py"
    repo.write(path, HEADER_OK)
    repo.git("add", path)
    repo.git("commit", "-m", message)
    return repo.git("rev-parse", "HEAD").stdout.strip()


def since(repo: FixtureRepo) -> str:
    """The current HEAD, to be used as the exclusive start of a range."""
    return repo.git("rev-parse", "HEAD").stdout.strip()


def check_range(repo: FixtureRepo, start: str, *extra: str) -> int:
    """Run the check over ``start..HEAD``."""
    return repo.run("commits", "--range", f"{start}..HEAD", *extra)


# --- the command is wired into the CLI ---------------------------------------


def test_the_command_is_discovered() -> None:
    assert commits.NAME in {command.name for command in cli.discover()}


# --- subjects that pass -------------------------------------------------------


@pytest.mark.parametrize("commit_type", commits.TYPES)
def test_every_type_is_accepted(repo: FixtureRepo, commit_type: str) -> None:
    start = since(repo)
    commit(repo, f"{commit_type}(repo): wire the gate\n\n{BODY}")
    assert check_range(repo, start) == EXIT_OK


@pytest.mark.parametrize("scope", commits.SCOPES)
def test_every_scope_is_accepted(repo: FixtureRepo, scope: str) -> None:
    start = since(repo)
    commit(repo, f"feat({scope}): wire the gate\n\n{BODY}")
    assert check_range(repo, start) == EXIT_OK


def test_a_breaking_change_marker_is_accepted(repo: FixtureRepo) -> None:
    start = since(repo)
    commit(repo, f"refactor(contracts)!: drop the legacy envelope\n\n{BODY}")
    assert check_range(repo, start) == EXIT_OK


def test_a_subject_of_exactly_the_limit_is_accepted(repo: FixtureRepo) -> None:
    start = since(repo)
    text = "a" * commits.MAX_SUBJECT_TEXT
    commit(repo, f"docs(repo): {text}\n\n{BODY}")
    assert check_range(repo, start) == EXIT_OK


def test_several_good_commits_report_the_count(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    start = since(repo)
    commit(repo, f"feat(repo): one\n\n{BODY}")
    commit(repo, f"fix(repo): two\n\n{BODY}")
    assert check_range(repo, start) == EXIT_OK
    assert "2 commits checked" in capsys.readouterr().out


# --- subjects that fail -------------------------------------------------------


def test_an_unknown_type_is_rejected(repo: FixtureRepo, capsys: pytest.CaptureFixture[str]) -> None:
    start = since(repo)
    commit(repo, f"feet(repo): wire the gate\n\n{BODY}")
    assert check_range(repo, start) == EXIT_FINDINGS
    assert "unknown type 'feet'" in capsys.readouterr().out


def test_an_unknown_scope_is_rejected(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    start = since(repo)
    commit(repo, f"feat(nowhere): wire the gate\n\n{BODY}")
    assert check_range(repo, start) == EXIT_FINDINGS
    assert "unknown scope 'nowhere'" in capsys.readouterr().out


def test_a_missing_scope_is_rejected(repo: FixtureRepo, capsys: pytest.CaptureFixture[str]) -> None:
    start = since(repo)
    commit(repo, f"feat: wire the gate\n\n{BODY}")
    assert check_range(repo, start) == EXIT_FINDINGS
    assert "the scope is missing" in capsys.readouterr().out


def test_a_missing_colon_is_rejected(repo: FixtureRepo, capsys: pytest.CaptureFixture[str]) -> None:
    start = since(repo)
    commit(repo, f"feat(repo) wire the gate\n\n{BODY}")
    assert check_range(repo, start) == EXIT_FINDINGS
    assert "does not have the form" in capsys.readouterr().out


def test_a_free_text_subject_is_rejected(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    start = since(repo)
    commit(repo, f"bad message\n\n{BODY}")
    assert check_range(repo, start) == EXIT_FINDINGS
    assert "does not have the form" in capsys.readouterr().out


def test_a_too_long_subject_is_rejected(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    start = since(repo)
    text = "a" * (commits.MAX_SUBJECT_TEXT + 1)
    commit(repo, f"docs(repo): {text}\n\n{BODY}")
    assert check_range(repo, start) == EXIT_FINDINGS
    out = capsys.readouterr().out
    assert f"is {commits.MAX_SUBJECT_TEXT + 1} characters" in out


def test_two_spaces_after_the_colon_are_rejected(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    start = since(repo)
    commit(repo, f"feat(repo):  wire the gate\n\n{BODY}")
    assert check_range(repo, start) == EXIT_FINDINGS
    assert "exactly one space must follow the colon" in capsys.readouterr().out


def test_one_offending_line_is_printed_per_commit(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    start = since(repo)
    commit(repo, "first bad message")
    commit(repo, "second bad message")
    commit(repo, f"feat(repo): a good one\n\n{BODY}")
    assert check_range(repo, start) == EXIT_FINDINGS
    captured = capsys.readouterr()
    assert len(captured.out.strip().splitlines()) == 2
    assert "2 findings" in captured.err


# --- the exemptions Git writes ------------------------------------------------


def test_a_merge_subject_is_exempt(repo: FixtureRepo) -> None:
    commit(repo, f"feat(repo): base\n\n{BODY}")
    start = since(repo)
    repo.git("switch", "-c", "topic")
    commit(repo, f"feat(repo): on the topic branch\n\n{BODY}")
    repo.git("switch", "main")
    commit(repo, f"fix(repo): on main\n\n{BODY}")
    repo.git("merge", "--no-ff", "-m", "Merge branch 'topic'", "topic")
    assert check_range(repo, start) == EXIT_OK


def test_a_revert_subject_is_exempt(repo: FixtureRepo) -> None:
    start = since(repo)
    bad = commit(repo, f"feat(repo): a change to undo\n\n{BODY}")
    repo.git("revert", "--no-edit", bad)
    assert repo.git("log", "-1", "--format=%s").stdout.startswith('Revert "')
    assert check_range(repo, start) == EXIT_OK


# --- range selection ----------------------------------------------------------


def test_without_a_range_the_recent_history_is_checked(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    """The fixture's own 'licences' commit is in range and must be reported."""
    commit(repo, f"feat(repo): wire the gate\n\n{BODY}")
    assert repo.run("commits") == EXIT_FINDINGS
    assert "does not have the form" in capsys.readouterr().out


def test_a_base_selects_the_commits_since_the_merge_base(repo: FixtureRepo) -> None:
    commit(repo, f"feat(repo): on main\n\n{BODY}")
    repo.git("switch", "-c", "feature/x")
    commit(repo, f"feat(repo): on the feature branch\n\n{BODY}")
    assert repo.run("commits", "--base", "main") == EXIT_OK


def test_a_base_hides_the_history_before_the_branch_point(repo: FixtureRepo) -> None:
    """The bad 'licences' subject is before the merge base, so it is not read."""
    commit(repo, f"feat(repo): on main\n\n{BODY}")
    repo.git("switch", "-c", "feature/x")
    commit(repo, "bad message")
    assert repo.run("commits", "--base", "main") == EXIT_FINDINGS
    repo.git("commit", "--amend", "-m", f"feat(repo): fixed\n\n{BODY}")
    assert repo.run("commits", "--base", "main") == EXIT_OK


def test_an_unknown_base_is_an_environment_error(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    assert repo.run("commits", "--base", "no-such-branch") == EXIT_ERROR
    assert "no such commit" in capsys.readouterr().err


def test_an_unusable_range_is_an_environment_error(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    assert repo.run("commits", "--range", "no-such-ref..HEAD") == EXIT_ERROR
    assert "fdp-checks commits:" in capsys.readouterr().err


def test_range_and_message_are_mutually_exclusive(repo: FixtureRepo) -> None:
    with pytest.raises(SystemExit) as raised:
        repo.run("commits", "--range", "a..b", "--message", "MSG")
    assert raised.value.code == EXIT_ERROR


# --- --message mode (the commit-msg hook) -------------------------------------


def test_a_good_message_file_passes(repo: FixtureRepo, tmp_path: Path) -> None:
    message = tmp_path / "COMMIT_EDITMSG"
    message.write_text(f"feat(repo): wire the gate\n\n{BODY}", encoding="utf-8")
    assert repo.run("commits", "--message", str(message)) == EXIT_OK


def test_a_bad_message_file_is_rejected(
    repo: FixtureRepo, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    message = tmp_path / "COMMIT_EDITMSG"
    message.write_text("bad message\n", encoding="utf-8")
    assert repo.run("commits", "--message", str(message)) == EXIT_FINDINGS
    out = capsys.readouterr().out
    assert message.as_posix() in out
    assert "does not have the form" in out


def test_git_comment_lines_and_the_scissors_tail_are_ignored(
    repo: FixtureRepo, tmp_path: Path
) -> None:
    message = tmp_path / "COMMIT_EDITMSG"
    message.write_text(
        "# Please enter the commit message for your changes.\n"
        f"feat(repo): wire the gate\n\n{BODY}"
        "# On branch feature/x\n"
        f"{commits.SCISSORS}\n"
        "diff --git a/x b/x\n",
        encoding="utf-8",
    )
    assert repo.run("commits", "--message", str(message)) == EXIT_OK


def test_a_message_file_with_only_a_colon_reports_the_empty_subject(
    repo: FixtureRepo, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    message = tmp_path / "COMMIT_EDITMSG"
    message.write_text("feat(repo): \n", encoding="utf-8")
    assert repo.run("commits", "--message", str(message)) == EXIT_FINDINGS
    assert "the subject text after the colon is empty" in capsys.readouterr().out


def test_an_empty_message_file_is_an_environment_error(
    repo: FixtureRepo, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    message = tmp_path / "COMMIT_EDITMSG"
    message.write_text("# only a comment\n", encoding="utf-8")
    assert repo.run("commits", "--message", str(message)) == EXIT_ERROR
    assert "the message is empty" in capsys.readouterr().err


def test_a_missing_message_file_is_an_environment_error(
    repo: FixtureRepo, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert repo.run("commits", "--message", str(tmp_path / "nowhere")) == EXIT_ERROR
    assert "cannot be read" in capsys.readouterr().err


# --- machine-readable output --------------------------------------------------


def test_json_output_names_the_offending_commit(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    start = since(repo)
    bad = commit(repo, "bad message")
    assert repo.run("--format", "json", "commits", "--range", f"{start}..HEAD") == EXIT_FINDINGS
    payload = json.loads(capsys.readouterr().out)
    assert payload["check"] == commits.NAME
    assert payload["ok"] is False
    assert bad.startswith(payload["findings"][0]["path"])
