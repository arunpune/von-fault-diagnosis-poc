# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Run the manual's validators and map their rule lines onto the report rows.

``manual/tools/validate.py`` (rules S1-S2, R1-R5, P1-P6, M1-M2, B1-B2, A1-A5,
N2, L1) and ``manual/tools/content_checks.py`` (N1, N3, C1-C6) are the
reference implementation of the source-level acceptance checks.
This module runs them as subprocesses with the interpreter that runs the
checks, parses their one-line-per-finding output and turns each line into a
:class:`~fdp_manual_build.checks.base.Finding` with a stable PDF finding code.

They are run as subprocesses, not imported: both files insert their own
directory into ``sys.path`` and import top-level modules called ``load``,
``context`` and ``figure_checks``, which would collide with anything else of
that name in the process that runs the checks. The interpreter running the
checks is used, not ``uv run --with-requirements``: this package pins the same
versions of pyyaml, jsonschema, jinja2, markdown-it-py and mdit-py-plugins as
``manual/tools/requirements.txt``, and its one extra pin (pandas) belongs to
``derive_bands.py``, which the checks never call. That keeps the run offline
and under a second.
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Final

from fdp_manual_build.checks.base import Finding, Level, Profile

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.checks.base import CheckContext

__all__ = [
    "CATALOG_SCALE_RULES",
    "CONTENT_CHECKS_RELATIVE",
    "VALIDATE_RELATIVE",
    "RuleFinding",
    "ToolRun",
    "content_checks_run",
    "map_rules",
    "rules_seen",
    "tool_error",
    "validate_run",
]

#: The manual's spec-level validator, relative to the repository root.
VALIDATE_RELATIVE: Final = Path("manual") / "tools" / "validate.py"
#: The manual's text-level validator, relative to the repository root.
CONTENT_CHECKS_RELATIVE: Final = Path("manual") / "tools" / "content_checks.py"

#: Rules that judge the catalog as a whole and cannot hold on a fixture tree:
#: the catalog floors (A1), one cause per signal subsystem (A2), the two benign
#: causes (A3), the fifteen MetroPT-3 columns (M1) and the register order and
#: group sizes (M2). They are reported instead of enforced under
#: ``Profile.FIXTURE``; ``Profile.FULL`` enforces every one of them.
CATALOG_SCALE_RULES: Final = frozenset({"A1", "A2", "A3", "M1", "M2"})

_TIMEOUT_S: Final = 300

#: ``content_checks.py``: ``RULE file:<path> <message>``.
_CONTENT_LINE = re.compile(r"^(?P<rule>[A-Z]\d+) file:(?P<file>\S+)[ ]?(?P<message>.*)$")
#: ``validate.py``: ``RULE <file>:<pointer> <message>``.
_VALIDATE_LINE = re.compile(
    r"^(?P<rule>[A-Z]\d+) (?P<file>[^:\s]+):(?P<pointer>\S*)[ ]?(?P<message>.*)$"
)


@dataclass(frozen=True)
class RuleFinding:
    """One ``RULE file:pointer message`` line of a manual validator."""

    rule: str
    file: str
    pointer: str
    message: str

    @property
    def location(self) -> str:
        """``file#pointer``, the location the report prints."""
        return f"{self.file}#{self.pointer}" if self.pointer else self.file


@dataclass(frozen=True)
class ToolRun:
    """The outcome of one validator subprocess."""

    tool: str
    command: tuple[str, ...]
    returncode: int
    findings: tuple[RuleFinding, ...] = ()
    notices: tuple[str, ...] = ()
    #: Set when the tool could not be run or crashed; then ``findings`` is empty.
    error: str | None = None
    #: Set when the tool was deliberately not run; then ``findings`` is empty.
    skipped: str | None = None
    unparsed: tuple[str, ...] = field(default_factory=tuple)

    @property
    def ran(self) -> bool:
        """Whether the tool produced usable output."""
        return self.error is None and self.skipped is None

    @classmethod
    def from_stdout(
        cls,
        tool: str,
        stdout: str,
        *,
        returncode: int = 1,
        command: Sequence[str] = (),
    ) -> ToolRun:
        """Parse one validator's standard output into a run."""
        findings, notices, unparsed = _parse(stdout)
        return cls(
            tool=tool,
            command=tuple(command),
            returncode=returncode,
            findings=findings,
            notices=notices,
            unparsed=unparsed,
        )


def validate_run(ctx: CheckContext) -> ToolRun:
    """Run ``manual/tools/validate.py --strict`` over ``ctx.manual_root``."""
    return _memoised(ctx, "validate", _validate)


def content_checks_run(ctx: CheckContext) -> ToolRun:
    """Run ``manual/tools/content_checks.py`` when the partials justify it.

    The tool judges the rendered text, so it needs every chapter partial of
    ``build.yaml``. Under :attr:`~fdp_manual_build.checks.base.Profile.FIXTURE`
    it is not run at all: its rules (required anchors, macro counts, the word
    budget, prose-only fact coverage) describe the shipping manual, not a
    deliberately tiny fixture.
    """
    return _memoised(ctx, "content_checks", _content_checks)


def map_rules(
    run: ToolRun,
    codes: Mapping[str, str],
    *,
    demoted: frozenset[str] = frozenset(),
) -> list[Finding]:
    """Turn the lines of ``run`` whose rule is in ``codes`` into findings.

    Args:
        run: the validator run to read.
        codes: rule id → the PDF finding code it maps to. A value prefixed
            with ``"report:"`` marks the rule informative for this check.
        demoted: rule ids to report instead of enforce, on top of ``codes``.
    """
    findings: list[Finding] = []
    for item in run.findings:
        code = codes.get(item.rule)
        if code is None:
            continue
        informative = code.startswith("report:")
        findings.append(
            Finding(
                code=code.removeprefix("report:"),
                message=item.message,
                location=item.location,
                level=Level.REPORT if informative or item.rule in demoted else Level.MUST,
                data={"rule": item.rule, "tool": run.tool},
            )
        )
    return findings


def tool_error(run: ToolRun, code: str) -> Finding | None:
    """The finding that reports a validator that could not be run."""
    if run.error is None:
        return None
    return Finding(
        code=code,
        message=run.error,
        location=" ".join(run.command) or run.tool,
        level=Level.MUST,
    )


def rules_seen(run: ToolRun, rules: Sequence[str]) -> int:
    """How many of ``rules`` produced at least one line in ``run``."""
    reported = {item.rule for item in run.findings}
    return sum(1 for rule in rules if rule in reported)


# --- running the tools ----------------------------------------------------


def _memoised(ctx: CheckContext, key: str, factory: Callable[[CheckContext], ToolRun]) -> ToolRun:
    """Run ``factory`` once per context; every check reads the same output."""
    cached = ctx.tool_runs.get(key)
    if isinstance(cached, ToolRun):
        return cached
    run = factory(ctx)
    ctx.tool_runs[key] = run
    return run


def _validate(ctx: CheckContext) -> ToolRun:
    script = ctx.repo_root / VALIDATE_RELATIVE
    command = (
        sys.executable,
        str(script),
        "--spec",
        str(ctx.manual_root),
        "--strict",
    )
    return _execute("validate.py", script, command, ctx.repo_root)


def _content_checks(ctx: CheckContext) -> ToolRun:
    script = ctx.repo_root / CONTENT_CHECKS_RELATIVE
    command = (
        sys.executable,
        str(script),
        "--spec",
        str(ctx.manual_root),
        "--variant",
        "both",
    )
    if ctx.profile is Profile.FIXTURE:
        return ToolRun(
            tool="content_checks.py",
            command=command,
            returncode=0,
            skipped="the text rules describe the shipping manual, not a fixture tree",
        )
    missing = _missing_partials(ctx)
    if missing:
        return ToolRun(
            tool="content_checks.py",
            command=command,
            returncode=0,
            skipped=f"{missing} chapter partial(s) are not written yet",
        )
    return _execute("content_checks.py", script, command, ctx.repo_root)


def _missing_partials(ctx: CheckContext) -> int:
    cfg = ctx.cfg
    if cfg is None:
        return 0
    return sum(1 for chapter in cfg.chapters if not cfg.chapter_path(chapter).is_file())


def _execute(tool: str, script: Path, command: Sequence[str], cwd: Path) -> ToolRun:
    if not script.is_file():
        return ToolRun(
            tool=tool,
            command=tuple(command),
            returncode=2,
            error=f"{script}: not in this checkout",
        )
    try:
        completed = subprocess.run(
            list(command),
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return ToolRun(tool=tool, command=tuple(command), returncode=2, error=str(error))
    if completed.returncode not in (0, 1):
        detail = completed.stderr.strip().splitlines()
        return ToolRun(
            tool=tool,
            command=tuple(command),
            returncode=completed.returncode,
            error=f"exited {completed.returncode}: {detail[-1] if detail else 'no output'}",
        )
    return ToolRun.from_stdout(
        tool,
        completed.stdout,
        returncode=completed.returncode,
        command=command,
    )


def _parse(stdout: str) -> tuple[tuple[RuleFinding, ...], tuple[str, ...], tuple[str, ...]]:
    findings: list[RuleFinding] = []
    notices: list[str] = []
    unparsed: list[str] = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        if line.startswith(("SKIP ", "NOTICE ")):
            notices.append(line)
            continue
        parsed = _parse_line(line)
        if parsed is None:
            unparsed.append(line)
        else:
            findings.append(parsed)
    return tuple(findings), tuple(notices), tuple(unparsed)


def _parse_line(line: str) -> RuleFinding | None:
    content = _CONTENT_LINE.match(line)
    if content is not None:
        return RuleFinding(
            rule=content["rule"],
            file=content["file"],
            pointer="",
            message=content["message"].strip(),
        )
    spec = _VALIDATE_LINE.match(line)
    if spec is not None:
        return RuleFinding(
            rule=spec["rule"],
            file=spec["file"],
            pointer=spec["pointer"],
            message=spec["message"].strip(),
        )
    return None
