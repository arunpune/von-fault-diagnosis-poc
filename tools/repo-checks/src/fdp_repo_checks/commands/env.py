# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-checks env``: ``.env.example``, the README table and Compose agree.

Secrets come from the environment only, so ``.env.example`` lists every
variable without values, and the defaults must still be documented. The file
satisfies both: the two secrets are empty assignments, every other variable is
commented out with its default, and the Compose files carry the default in
``${VAR:-default}``. So ``cp .env.example .env`` sets nothing and a missing
variable still starts the stack.

Four rules:

1. every name of :data:`fdp_repo_checks.envvars.REQUIRED_VARS` appears in
   ``.env.example``;
2. the set in ``.env.example`` equals the set in the README "Configuration"
   table, so an area that adds a variable to both files stays green without
   touching :mod:`fdp_repo_checks.envvars`;
3. no assignment carries a value, and both secrets are present and empty;
4. every ``${VAR}`` a ``compose*.yaml`` references is listed, and a
   non-secret reference supplies a default (``--no-compose`` skips this).
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from fdp_repo_checks.envvars import REQUIRED_VARS, SECRETS
from fdp_repo_checks.findings import EXIT_ERROR, Finding, report

NAME = "env"
HELP = "check .env.example against the README table and the compose files"

ENV_EXAMPLE = ".env.example"
README = "README.md"
COMPOSE_GLOB = "compose*.yaml"
README_SECTION = "## Configuration"

_ASSIGNMENT = re.compile(r"^(?P<name>[A-Z][A-Z0-9_]*)=(?P<value>.*)$")
_COMMENTED = re.compile(r"^#\s*(?P<name>[A-Z][A-Z0-9_]*)=")
_BACKTICKED = re.compile(r"`([A-Z][A-Z0-9_]*)`")
_INTERPOLATION = re.compile(r"\$\{(?P<name>[A-Za-z_][A-Za-z0-9_]*)(?P<suffix>[^}]*)\}")


@dataclass(frozen=True)
class EnvExample:
    """What ``.env.example`` declares."""

    names: frozenset[str]
    """Every variable, whether it is commented out or an empty assignment."""

    assignments: dict[str, tuple[int, str]]
    """Uncommented ``NAME=value`` lines, by name: (line number, value)."""


def register(parser: argparse.ArgumentParser) -> None:
    """Add the sub-command's own options.

    Rule 4 is on by default. ``--compose`` names it explicitly, which is how
    ``scripts/ops/compose-check.sh`` spells the call;
    ``--no-compose`` is the opt-out for a checkout without compose files.
    """
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--compose",
        dest="no_compose",
        action="store_false",
        help="run rule 4 (the compose*.yaml cross-check); the default",
    )
    group.add_argument(
        "--no-compose",
        dest="no_compose",
        action="store_true",
        help="skip rule 4 (the compose*.yaml cross-check)",
    )
    parser.set_defaults(no_compose=False)


def parse_env_example(text: str) -> EnvExample:
    """Read the names and the live assignments out of a dotenv example."""
    names: set[str] = set()
    assignments: dict[str, tuple[int, str]] = {}
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        assignment = _ASSIGNMENT.match(line)
        if assignment is not None:
            name = assignment.group("name")
            names.add(name)
            assignments[name] = (number, assignment.group("value").strip())
            continue
        commented = _COMMENTED.match(line)
        if commented is not None:
            names.add(commented.group("name"))
    return EnvExample(names=frozenset(names), assignments=assignments)


def parse_readme_table(text: str) -> frozenset[str]:
    """Names in the first cell of the README "Configuration" table.

    A cell may group names with ``` / ```; every backticked upper-case name
    in it counts.
    """
    names: set[str] = set()
    inside = False
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("## "):
            inside = line == README_SECTION
            continue
        if not inside or not line.startswith("|"):
            continue
        cells = line.strip("|").split("|")
        if not cells:
            continue
        names.update(_BACKTICKED.findall(cells[0]))
    return frozenset(names)


def _rule_required(example: EnvExample) -> list[Finding]:
    missing = sorted(REQUIRED_VARS - example.names)
    return [
        Finding(ENV_EXAMPLE, f"{name} is required in {ENV_EXAMPLE} but absent") for name in missing
    ]


def _rule_readme(example: EnvExample, documented: frozenset[str]) -> list[Finding]:
    findings = [
        Finding(README, f"{name} is in {ENV_EXAMPLE} but not in the Configuration table")
        for name in sorted(example.names - documented)
    ]
    findings.extend(
        Finding(ENV_EXAMPLE, f"{name} is in the README Configuration table but not here")
        for name in sorted(documented - example.names)
    )
    return findings


def _rule_values(example: EnvExample) -> list[Finding]:
    findings: list[Finding] = []
    for name, (number, value) in sorted(example.assignments.items()):
        if value:
            findings.append(
                Finding(
                    ENV_EXAMPLE,
                    f"{name} carries a value; the default stays commented out",
                    line=number,
                )
            )
    findings.extend(
        Finding(ENV_EXAMPLE, f"secret {name} must be present as an empty assignment")
        for name in sorted(SECRETS)
        if name not in example.assignments
    )
    return findings


def _rule_compose(root: Path, example: EnvExample) -> list[Finding]:
    findings: list[Finding] = []
    for path in sorted(root.glob(COMPOSE_GLOB)):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            findings.append(Finding(relative, f"cannot be read ({error})"))
            continue
        for number, raw in enumerate(text.splitlines(), start=1):
            # `$$` is Compose's escape for a literal dollar sign.
            line = raw.replace("$$", "")
            for match in _INTERPOLATION.finditer(line):
                name = match.group("name")
                if name not in example.names:
                    findings.append(
                        Finding(
                            relative,
                            f"${{{name}}} is not listed in {ENV_EXAMPLE}",
                            line=number,
                        )
                    )
                elif name not in SECRETS and not match.group("suffix").startswith(":-"):
                    findings.append(
                        Finding(
                            relative,
                            f"${{{name}}} must supply its default as ${{{name}:-…}}",
                            line=number,
                        )
                    )
    return findings


def run(args: argparse.Namespace) -> int:
    """Apply the four rules and report."""
    root: Path = args.root
    env_path = root / ENV_EXAMPLE
    readme_path = root / README
    for path in (env_path, readme_path):
        if not path.is_file():
            print(f"fdp-checks env: {path} is missing", file=sys.stderr)
            return EXIT_ERROR

    example = parse_env_example(env_path.read_text(encoding="utf-8"))
    documented = parse_readme_table(readme_path.read_text(encoding="utf-8"))

    findings = _rule_required(example)
    findings += _rule_readme(example, documented)
    findings += _rule_values(example)
    if not args.no_compose:
        findings += _rule_compose(root, example)
    return report(NAME, findings, output_format=args.output_format)
