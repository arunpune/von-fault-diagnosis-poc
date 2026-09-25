# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-checks env`` over git fixture repositories.

Each of the four rules of the check gets a tree that passes and a tree that
fails.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence

import pytest

from fdp_repo_checks.commands import env
from fdp_repo_checks.envvars import REQUIRED_VARS, SECRETS
from fdp_repo_checks.findings import EXIT_ERROR, EXIT_FINDINGS, EXIT_OK
from helpers import FixtureRepo

# REUSE-IgnoreStart
ENV_HEADER = (
    "# SPDX-FileCopyrightText: 2026 Meddle S.r.l.\n"
    "# SPDX-License-Identifier: CC0-1.0\n"
    "#\n"
    "# Copy to .env (git-ignored).\n"
)
# REUSE-IgnoreEnd
README_HEADER = "<!-- a README -->\n\n# Title\n\n## Overview\n\nProse.\n\n"


def env_example(names: Iterable[str], *, extra_lines: Sequence[str] = ()) -> str:
    """A dotenv example listing ``names``: secrets empty, the rest commented."""
    lines = [ENV_HEADER, "## Everything\n"]
    for name in sorted(names):
        lines.append(f"{name}=\n" if name in SECRETS else f"# {name}=a-default\n")
    lines.extend(extra_lines)
    return "".join(lines)


def readme(cells: Iterable[str]) -> str:
    """A README whose Configuration table has one row per cell."""
    rows = "".join(f"| {cell} | `a-default` | What it does |\n" for cell in cells)
    return (
        README_HEADER
        + "## Configuration\n\n"
        + "| Variable | Default | What it does |\n| --- | --- | --- |\n"
        + rows
        + "\n## Commands\n\nA table `NOT_A_VARIABLE` outside the section is ignored.\n"
    )


def write_tree(
    repo: FixtureRepo,
    *,
    env_names: Iterable[str] | None = None,
    readme_cells: Iterable[str] | None = None,
    extra_env_lines: Sequence[str] = (),
) -> None:
    """Write a consistent ``.env.example`` and README into the fixture."""
    names = sorted(REQUIRED_VARS if env_names is None else env_names)
    cells = [f"`{name}`" for name in names] if readme_cells is None else list(readme_cells)
    repo.write(".env.example", env_example(names, extra_lines=extra_env_lines))
    repo.write("README.md", readme(cells))


def test_the_canonical_tree_passes(repo: FixtureRepo, capsys: pytest.CaptureFixture[str]) -> None:
    write_tree(repo)
    assert repo.run("env", "--no-compose") == EXIT_OK
    assert "env: ok" in capsys.readouterr().out


def test_rule_1_a_missing_required_variable_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    kept = sorted(REQUIRED_VARS - {"LOG_LEVEL"})
    write_tree(repo, env_names=kept, readme_cells=[f"`{name}`" for name in kept])
    assert repo.run("env", "--no-compose") == EXIT_FINDINGS
    assert "LOG_LEVEL is required in .env.example but absent" in capsys.readouterr().out


def test_rule_2_a_variable_missing_from_the_readme_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    names = sorted(REQUIRED_VARS | {"NEW_KNOB"})
    write_tree(repo, env_names=names, readme_cells=[f"`{name}`" for name in sorted(REQUIRED_VARS)])
    assert repo.run("env", "--no-compose") == EXIT_FINDINGS
    assert "NEW_KNOB is in .env.example but not in the Configuration table" in (
        capsys.readouterr().out
    )


def test_rule_2_a_variable_only_in_the_readme_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    cells = [f"`{name}`" for name in sorted(REQUIRED_VARS)] + ["`GHOST_KNOB`"]
    write_tree(repo, readme_cells=cells)
    assert repo.run("env", "--no-compose") == EXIT_FINDINGS
    assert "GHOST_KNOB is in the README Configuration table but not here" in (
        capsys.readouterr().out
    )


def test_rule_2_a_readme_cell_may_group_names(repo: FixtureRepo) -> None:
    names = sorted(REQUIRED_VARS)
    grouped = f"`{names[0]}` / `{names[1]}`"
    cells = [grouped] + [f"`{name}`" for name in names[2:]]
    write_tree(repo, readme_cells=cells)
    assert repo.run("env", "--no-compose") == EXIT_OK


def test_rule_3_a_non_empty_assignment_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    write_tree(repo)
    text = (repo.path / ".env.example").read_text(encoding="utf-8")
    repo.write(".env.example", text.replace("LLM_API_KEY=\n", "LLM_API_KEY=sk-not-a-real-key\n"))
    assert repo.run("env", "--no-compose") == EXIT_FINDINGS
    assert "LLM_API_KEY carries a value" in capsys.readouterr().out


def test_rule_3_a_commented_out_secret_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    write_tree(repo)
    text = (repo.path / ".env.example").read_text(encoding="utf-8")
    repo.write(".env.example", text.replace("TYPESAFE_API_KEY=\n", "# TYPESAFE_API_KEY=\n"))
    assert repo.run("env", "--no-compose") == EXIT_FINDINGS
    assert "secret TYPESAFE_API_KEY must be present as an empty assignment" in (
        capsys.readouterr().out
    )


def test_rule_4_a_reference_with_a_default_passes(repo: FixtureRepo) -> None:
    write_tree(repo)
    repo.write("compose.yaml", "services:\n  ui:\n    ports: ['${UI_PORT:-8080}:80']\n")
    assert repo.run("env") == EXIT_OK


def test_rule_4_a_secret_reference_needs_no_default(repo: FixtureRepo) -> None:
    write_tree(repo)
    repo.write(
        "compose.yaml",
        "services:\n  backend:\n    environment:\n      LLM_API_KEY: ${LLM_API_KEY}\n",
    )
    assert repo.run("env") == EXIT_OK


def test_rule_4_a_reference_without_a_default_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    write_tree(repo)
    repo.write("compose.yaml", "services:\n  ui:\n    ports: ['${UI_PORT}:80']\n")
    assert repo.run("env") == EXIT_FINDINGS
    out = capsys.readouterr().out
    assert "compose.yaml:3:" in out
    assert "must supply its default" in out


def test_rule_4_an_unlisted_reference_is_a_finding(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    write_tree(repo)
    repo.write("compose.yaml", "services:\n  ui:\n    image: ${UNDECLARED:-nginx}\n")
    assert repo.run("env") == EXIT_FINDINGS
    assert "${UNDECLARED} is not listed in .env.example" in capsys.readouterr().out


def test_rule_4_an_escaped_dollar_is_not_a_reference(repo: FixtureRepo) -> None:
    write_tree(repo)
    repo.write("compose.yaml", "services:\n  ui:\n    command: echo $${UNDECLARED}\n")
    assert repo.run("env") == EXIT_OK


def test_rule_4_is_skipped_with_no_compose(repo: FixtureRepo) -> None:
    write_tree(repo)
    repo.write("compose.yaml", "services:\n  ui:\n    image: ${UNDECLARED}\n")
    assert repo.run("env") == EXIT_FINDINGS
    assert repo.run("env", "--no-compose") == EXIT_OK


def test_rule_4_can_be_asked_for_explicitly(repo: FixtureRepo) -> None:
    """``--compose`` names the default, which is how compose-check.sh calls it."""
    write_tree(repo)
    repo.write("compose.yaml", "services:\n  ui:\n    image: ${UNDECLARED}\n")
    assert repo.run("env", "--compose") == EXIT_FINDINGS


def test_every_compose_overlay_is_read(repo: FixtureRepo) -> None:
    write_tree(repo)
    repo.write("compose.yaml", "services:\n  ui:\n    ports: ['${UI_PORT:-8080}:80']\n")
    repo.write("compose.ci.yaml", "services:\n  ui:\n    image: ${UNDECLARED:-nginx}\n")
    assert repo.run("env") == EXIT_FINDINGS


def test_a_missing_env_example_is_an_environment_error(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.write("README.md", readme([]))
    assert repo.run("env", "--no-compose") == EXIT_ERROR
    assert ".env.example is missing" in capsys.readouterr().err


def test_json_output_lists_the_findings(
    repo: FixtureRepo, capsys: pytest.CaptureFixture[str]
) -> None:
    kept = sorted(REQUIRED_VARS - {"LOG_LEVEL"})
    write_tree(repo, env_names=kept, readme_cells=[f"`{name}`" for name in kept])
    assert repo.run("env", "--no-compose", "--format", "json") == EXIT_FINDINGS
    payload = json.loads(capsys.readouterr().out)
    assert payload["check"] == "env"
    assert payload["findings"][0]["path"] == ".env.example"


def test_the_section_header_lines_are_not_variables() -> None:
    parsed = env.parse_env_example("## Decision backend\n# A comment with no assignment\nA_VAR=\n")
    assert parsed.names == frozenset({"A_VAR"})
    assert parsed.assignments == {"A_VAR": (3, "")}


def test_only_the_configuration_section_of_the_readme_counts() -> None:
    text = (
        "## Overview\n\n| `NOT_A_VARIABLE` | x |\n\n"
        "## Configuration\n\n| `REAL_VARIABLE` | x |\n\n"
        "## Commands\n\n| `ALSO_NOT` | x |\n"
    )
    assert env.parse_readme_table(text) == frozenset({"REAL_VARIABLE"})
