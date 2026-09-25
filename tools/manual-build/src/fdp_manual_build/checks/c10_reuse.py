# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #10 — license hygiene — MUST (docs/manual.md#acceptance-checks).

The manual ships as a document under CC BY 4.0 with fonts under OFL-1.1 inside
it, so its licensing is part of the deliverable rather than a repository
chore. This check runs the REUSE tool over the whole checkout and then judges
only what the PDF build owns: ``manual/``, ``tools/manual-build/``,
``data/manual/``, the exported catalog and the three licence texts the manual
points at. The whole-repository counts are reported as metrics, so a missing
header in another area is visible here but cannot block the manual — that is
``make reuse``.

On top of the tool's verdict the check asks for six explicit annotations, which
are the ones a reviewer would otherwise have to confirm by hand: the six IBM
Plex faces (2017 IBM Corp., OFL-1.1), the built PDFs and the catalog
(CC BY 4.0), and a real file header on every chapter partial, every template
and every spec document.

The tool is run as ``uvx --from "reuse[charset-normalizer]==6.2.0" reuse``: the
extra is what makes it work where ``libmagic`` is absent, macOS included. A
missing ``uvx`` makes this check ``error``, never ``pass``.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

from fdp_manual_build.checks.base import BaseCheck, Finding, Level, Status

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.checks.base import CheckContext, CheckResult

__all__ = [
    "REQUIRED_LICENSES",
    "REUSE_REQUIREMENT",
    "SCOPE_PREFIXES",
    "ReuseCheck",
    "annotation_findings",
    "reuse_lint",
]

#: The pinned REUSE tool, with the extra macOS needs.
REUSE_REQUIREMENT: Final = "reuse[charset-normalizer]==6.2.0"
#: Directories this check judges; everything else is a metric only.
SCOPE_PREFIXES: Final[tuple[str, ...]] = ("manual/", "tools/manual-build/", "data/manual/")
#: Single files inside the scope that are not under one of the prefixes.
_SCOPE_FILES: Final[tuple[str, ...]] = ("tools/eval/fixtures/catalog.json",)
#: Licence texts the manual and its fonts reference; they have to be present.
REQUIRED_LICENSES: Final[tuple[str, ...]] = ("OFL-1.1", "CC-BY-4.0", "Apache-2.0")

_TIMEOUT_S: Final = 120
#: ``non_compliant`` keys whose entries are paths, judged by the scope above.
_FILE_RULES: Final[frozenset[str]] = frozenset(
    {"missing_copyright_info", "missing_licensing_info", "read_errors"}
)
#: ``non_compliant`` keys whose entries are licence identifiers. Only the three
#: the manual points at block this check; the rest is what ``make reuse`` is.
_LICENSE_RULES: Final[frozenset[str]] = frozenset(
    {"bad_licenses", "deprecated_licenses", "missing_licenses"}
)
#: The six IBM Plex faces, annotated in ``REUSE.toml`` (they carry no comment).
_FONT_COPYRIGHT: Final = "2017 IBM Corp."
_FONT_LICENSE: Final = "OFL-1.1"
_CONTENT_LICENSE: Final = "CC-BY-4.0"
_TEMPLATE_LICENSE: Final = "Apache-2.0"
#: A spec document is ``manual/spec/<name>.yaml``, never one in a subdirectory.
_SPEC_YAML: Final = re.compile(r"^manual/spec/[^/]+\.yaml$")
#: Where a licence statement may come from for the header assertions.
_HEADER: Final = "file-header"


class ReuseCheck(BaseCheck):
    """Every file of the manual says who owns it and under what licence."""

    number = 10
    id = "reuse"
    title = "License hygiene"
    level = Level.MUST

    def run(self, ctx: CheckContext) -> CheckResult:
        """A tool that cannot run is an ``error``, never a silent pass."""
        result = super().run(ctx)
        if any(finding.code == "reuse.tool_error" for finding in result.findings):
            return self.result(
                status=Status.ERROR,
                metrics=result.metrics,
                findings=result.findings,
                duration_s=result.duration_s,
            )
        return result

    def evaluate(
        self, ctx: CheckContext
    ) -> tuple[Sequence[Finding], Mapping[str, float | int | str]]:
        """Run the tool, filter its verdict to the manual, then assert the six."""
        report, failure = reuse_lint(ctx.repo_root)
        if failure is not None:
            return [failure], {"scope": " ".join(SCOPE_PREFIXES)}
        findings = list(_non_compliant(report))
        findings += list(_missing_license_texts(ctx.repo_root))
        findings += annotation_findings(report)
        return findings, _metrics(report, findings)


def reuse_lint(repo_root: Path) -> tuple[Mapping[str, Any], Finding | None]:
    """``reuse lint --json`` over ``repo_root``, or the finding that says why not."""
    if shutil.which("uvx") is None:
        return {}, _tool_error("uvx is not on PATH; install uv")
    command = [
        "uvx",
        "--from",
        REUSE_REQUIREMENT,
        "reuse",
        "--root",
        str(repo_root),
        "lint",
        "--json",
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            cwd=repo_root,
            timeout=_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return {}, _tool_error(f"{' '.join(command)}: {error}")
    try:
        report = json.loads(completed.stdout)
    except json.JSONDecodeError:
        detail = completed.stderr.strip().splitlines()
        return {}, _tool_error(
            f"reuse exited {completed.returncode} without JSON: "
            f"{detail[-1] if detail else 'no output'}"
        )
    if not isinstance(report, dict):
        return {}, _tool_error("reuse lint --json did not return an object")
    return report, None


# --- the tool's own verdict -------------------------------------------------


def _non_compliant(report: Mapping[str, Any]) -> Iterator[Finding]:
    """The tool's problems, blocking only inside this check's scope.

    A per-file rule is judged by the path; a licence-identifier rule blocks
    only for the three texts the manual and its fonts point at. Everything
    else — an unused licence of another area, say — is listed as informative,
    which is exactly the split check #10 asks for.
    """
    block = report.get("non_compliant")
    if not isinstance(block, dict):
        return
    for key, value in sorted(block.items()):
        if not isinstance(value, list):
            continue
        for item in value:
            if not isinstance(item, str):
                continue
            blocking = _blocks(key, item)
            yield Finding(
                code=f"reuse.{key}",
                message=f"{item}: reported by `reuse lint` as {key.replace('_', ' ')}",
                location=item,
                level=Level.MUST if blocking else Level.REPORT,
                data={"rule": key, "in_scope": blocking},
            )


def _blocks(rule: str, item: str) -> bool:
    """Whether this problem is one the PDF build owns."""
    if rule in _FILE_RULES:
        return _in_scope(item)
    if rule in _LICENSE_RULES:
        return item in REQUIRED_LICENSES
    return False


def _missing_license_texts(repo_root: Path) -> Iterator[Finding]:
    """The three licence texts the manual and its fonts point at must exist."""
    for name in REQUIRED_LICENSES:
        path = repo_root / "LICENSES" / f"{name}.txt"
        if not path.is_file():
            yield Finding(
                code="reuse.missing_license_text",
                message=f"LICENSES/{name}.txt is referenced by the manual but not in the tree",
                location=f"LICENSES/{name}.txt",
                level=Level.MUST,
            )


# --- the six explicit annotations -------------------------------------------


def annotation_findings(report: Mapping[str, Any]) -> list[Finding]:
    """The annotations check #10 names, read out of the tool's file list."""
    files = report.get("files")
    if not isinstance(files, list):
        return []
    entries = {
        str(entry["path"]): entry
        for entry in files
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    }
    findings: list[Finding] = []
    for path, entry in sorted(entries.items()):
        findings += list(_expected(path, entry))
    return findings


def _expected(path: str, entry: Mapping[str, Any]) -> Iterator[Finding]:
    if path.startswith("manual/fonts/") and path.endswith(".ttf"):
        yield from _assert(path, entry, _FONT_LICENSE, copyright_text=_FONT_COPYRIGHT)
    elif (path.startswith("data/manual/") and path.endswith(".pdf")) or path in _SCOPE_FILES:
        yield from _assert(path, entry, _CONTENT_LICENSE)
    elif path.startswith("manual/content/") and path.endswith(".md"):
        yield from _assert(path, entry, _CONTENT_LICENSE, source_type=_HEADER)
    elif path.startswith("manual/templates/"):
        yield from _assert(path, entry, _TEMPLATE_LICENSE, source_type=_HEADER)
    elif _SPEC_YAML.match(path):
        yield from _assert(path, entry, _CONTENT_LICENSE, source_type=_HEADER)


def _assert(
    path: str,
    entry: Mapping[str, Any],
    license_id: str,
    *,
    copyright_text: str | None = None,
    source_type: str | None = None,
) -> Iterator[Finding]:
    """One file against the licence, copyright and source the check expects."""
    expressions = _items(entry, "spdx_expressions")
    if not any(str(item.get("value")) == license_id for item in expressions):
        found = ", ".join(sorted({str(item.get("value")) for item in expressions})) or "nothing"
        yield _annotation(path, f"is licensed {found}, not {license_id}", license_id)
        return
    if source_type is not None and not any(
        str(item.get("value")) == license_id and str(item.get("source_type")) == source_type
        for item in expressions
    ):
        yield _annotation(
            path,
            f"states {license_id} outside the file; it needs its own SPDX header",
            license_id,
        )
    if copyright_text is not None and not any(
        copyright_text in str(item.get("value")) for item in _items(entry, "copyrights")
    ):
        yield _annotation(path, f"does not carry the copyright {copyright_text!r}", license_id)


def _items(entry: Mapping[str, Any], key: str) -> list[Mapping[str, Any]]:
    value = entry.get(key)
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _annotation(path: str, problem: str, license_id: str) -> Finding:
    return Finding(
        code="reuse.annotation",
        message=f"{path} {problem}",
        location=path,
        level=Level.MUST,
        data={"expected": license_id},
    )


# --- helpers ----------------------------------------------------------------


def _in_scope(path: str) -> bool:
    if path in _SCOPE_FILES:
        return True
    if path.startswith("LICENSES/"):
        return any(path == f"LICENSES/{name}.txt" for name in REQUIRED_LICENSES)
    return path.startswith(SCOPE_PREFIXES)


def _metrics(
    report: Mapping[str, Any], findings: Sequence[Finding]
) -> dict[str, float | int | str]:
    summary = report.get("summary")
    block = report.get("non_compliant")
    counted = block if isinstance(block, dict) else {}
    repository = sum(len(value) for value in counted.values() if isinstance(value, list))
    return {
        "tool": f"reuse {report.get('reuse_tool_version', '?')}",
        "files_total": int(summary.get("files_total", 0)) if isinstance(summary, dict) else 0,
        "repository_problems": repository,
        "scope_problems": sum(1 for item in findings if item.level is Level.MUST),
        "scope": " ".join((*SCOPE_PREFIXES, *_SCOPE_FILES)),
    }


def _tool_error(message: str) -> Finding:
    return Finding(
        code="reuse.tool_error",
        message=message,
        location=REUSE_REQUIREMENT,
        level=Level.MUST,
    )
