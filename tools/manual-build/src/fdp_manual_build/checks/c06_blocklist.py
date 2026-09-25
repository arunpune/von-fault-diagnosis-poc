# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #6 — brand blocklist — MUST (docs/manual.md#acceptance-checks).

There is one term list in the repository and the PDF build does not own it:
the list lives as salted digests in ``tools/blocklist/data/blocklist.sha256``
and only the brand blocklist scanner can match it. This check therefore runs
``scripts/blocklist.sh --format json`` over the manual tree and the manual
build's own sources and turns each hit into a ``blocklist.hit`` finding with its
file and line.

The scanner also reads PDFs, so every built variant under ``--variant-dir`` is
passed with ``--pdf``. Before a build has produced them there is nothing to
scan and the check says so instead of claiming the PDFs are clean.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

from fdp_manual_build.checks.base import BaseCheck, Finding, Level, Profile, Status

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.checks.base import CheckContext, CheckResult

__all__ = ["BlocklistCheck"]

#: The manual build's own sources are in scope of check #6 next to ``manual/``.
TOOL_SCOPE: Final = "tools/manual-build"
_TIMEOUT_S: Final = 300
#: ``fdp-blocklist`` exits 0 clean, 1 with hits, 2 on a usage or setup error.
_EXIT_ERROR: Final = 2


class BlocklistCheck(BaseCheck):
    """No real manufacturer, controller or product line is named anywhere."""

    number = 6
    id = "blocklist"
    title = "Brand blocklist"
    level = Level.MUST

    def run(self, ctx: CheckContext) -> CheckResult:
        """Run the scanner; a scanner that cannot run is an ``error``, not a pass."""
        result = super().run(ctx)
        if any(finding.code == "blocklist.scanner_error" for finding in result.findings):
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
        """Scan the sources and the built PDFs with the brand blocklist scanner."""
        root, paths = _scope(ctx)
        pdfs = _variant_pdfs(ctx)
        command = [str(ctx.blocklist_cmd), "--format", "json", "--root", str(root), *paths]
        for pdf in pdfs:
            command += ["--pdf", str(pdf)]
        payload, failure = _scan(command, ctx.repo_root)
        if failure is not None:
            return [failure], {"scope": " ".join(paths), "hits": -1}

        findings = [_hit(item) for item in payload.get("hits", [])]
        if not pdfs:
            findings.append(
                Finding(
                    code="blocklist.pdfs_not_scanned",
                    message=(
                        f"no built manual under {ctx.variant_dir}; only the sources were scanned"
                    ),
                    location=str(ctx.variant_dir),
                    level=Level.REPORT,
                )
            )
        return findings, {
            "terms": int(payload.get("digests", 0)),
            "patterns": int(payload.get("patterns", 0)),
            "files_scanned": int(payload.get("text_files", 0)),
            "pdfs_scanned": int(payload.get("pdf_files", 0)),
            "hits": sum(1 for finding in findings if finding.code == "blocklist.hit"),
            "scope": " ".join(paths),
        }


def _scope(ctx: CheckContext) -> tuple[Path, list[str]]:
    """The scan root and the paths under it the scanner walks.

    A manual tree outside the checkout — a copy a test mutated, say — becomes
    the scan root itself, so hits are still located by a path the reader can
    follow.
    """
    manual = _relative(ctx.manual_root, ctx.repo_root)
    if manual is None:
        return ctx.manual_root, ["."]
    if ctx.profile is Profile.FIXTURE:
        return ctx.repo_root, [manual]
    return ctx.repo_root, sorted({manual, TOOL_SCOPE})


def _relative(path: Path, root: Path) -> str | None:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None


def _variant_pdfs(ctx: CheckContext) -> list[Path]:
    cfg = ctx.cfg
    if cfg is None or not ctx.variant_dir.is_dir():
        return []
    names = [cfg.outputs.pdf_name(name) for name in sorted(cfg.variants)]
    return [path for path in (ctx.variant_dir / name for name in names) if path.is_file()]


def _scan(command: Sequence[str], cwd: Path) -> tuple[dict[str, Any], Finding | None]:
    script = Path(command[0])
    if not script.is_file():
        return {}, _scanner_error(command, f"{script}: not in this checkout")
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
        return {}, _scanner_error(command, str(error))
    if completed.returncode >= _EXIT_ERROR:
        detail = completed.stderr.strip().splitlines()
        return {}, _scanner_error(
            command, f"exited {completed.returncode}: {detail[-1] if detail else 'no output'}"
        )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        return {}, _scanner_error(command, f"output is not JSON: {error}")
    if not isinstance(payload, dict):
        return {}, _scanner_error(command, "output is not a JSON object")
    return payload, None


def _scanner_error(command: Sequence[str], message: str) -> Finding:
    return Finding(
        code="blocklist.scanner_error",
        message=message,
        location=" ".join(command),
        level=Level.MUST,
    )


def _hit(item: Mapping[str, Any]) -> Finding:
    """One scanner hit, located by file and line or by PDF page."""
    path = str(item.get("path", "?"))
    line = int(item.get("line", 0))
    page = item.get("page")
    where = f"{path}:{line}" if page is None else f"{path}:p{page}:{line}"
    term = str(item.get("term", "?"))
    return Finding(
        code="blocklist.hit",
        message=f"blocked term {term!r} in section {item.get('section', '?')}",
        location=where,
        level=Level.MUST,
        data={"path": path, "line": line, "page": page, "term": term},
    )
