# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""What every sub-command reports and how it is printed.

A finding names a path, optionally a line, and says in one sentence what is
wrong. Text output is ``path: reason`` (``path:line: reason`` when the line is
known) so an editor can jump to it; ``--format json`` prints the same data as
an object a CI job can read.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_ERROR = 2


@dataclass(frozen=True)
class Finding:
    """One problem worth failing the build for."""

    path: str
    reason: str
    line: int | None = None

    def as_text(self) -> str:
        where = f"{self.path}:{self.line}" if self.line is not None else self.path
        return f"{where}: {self.reason}"

    def as_dict(self) -> dict[str, object]:
        return {"path": self.path, "line": self.line, "reason": self.reason}


def report(
    check: str,
    findings: Sequence[Finding],
    *,
    output_format: str,
    checked: int | None = None,
    unit: str = "files",
) -> int:
    """Print ``findings`` and return the process exit code."""
    if output_format == "json":
        payload: dict[str, object] = {
            "check": check,
            "ok": not findings,
            "findings": [finding.as_dict() for finding in findings],
        }
        if checked is not None:
            payload["checked"] = checked
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        for finding in findings:
            print(finding.as_text())
        if findings:
            plural = "" if len(findings) == 1 else "s"
            print(f"{check}: {len(findings)} finding{plural}", file=sys.stderr)
        else:
            suffix = f" ({checked} {unit} checked)" if checked is not None else ""
            print(f"{check}: ok{suffix}")
    return EXIT_FINDINGS if findings else EXIT_OK
