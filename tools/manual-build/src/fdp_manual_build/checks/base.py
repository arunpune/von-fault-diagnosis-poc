# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Types every acceptance check shares.

A check reports :class:`Finding` records rather than raising: one run lists
every problem of every check, and the report writers turn the same records
into JSON and Markdown. A :class:`Finding` carries its own :class:`Level`, so
a MUST check can list an informative miss (``integrity.orphan_alarm``) without
failing the run, which is what checks #2 and #11 ask for.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.checks.pdftext import PdfText
    from fdp_manual_build.config import BuildConfig
    from fdp_manual_build.model import Manual
    from fdp_manual_build.numbering import SectionMap

__all__ = [
    "BaseCheck",
    "Check",
    "CheckContext",
    "CheckResult",
    "Finding",
    "Level",
    "Profile",
    "Status",
]


class Level(StrEnum):
    """Whether a check (or a single finding) can fail the run."""

    MUST = "MUST"
    REPORT = "REPORT"


class Status(StrEnum):
    """The outcome of one check."""

    PASS = "pass"  # noqa: S105 - a check outcome, not a credential
    FAIL = "fail"
    REPORT = "report"
    SKIPPED = "skipped"
    ERROR = "error"


class Profile(StrEnum):
    """What the tree under check is, which decides how strictly it is judged.

    ``FULL`` is the shipping manual: every delegated rule is enforced.
    ``FIXTURE`` is a test tree such as ``tests/fixtures/mini-spec``, which is
    deliberately far below catalog scale; the
    whole-catalog and whole-document rules are reported instead of enforced.
    """

    FULL = "full"
    FIXTURE = "fixture"


@dataclass(frozen=True)
class Finding:
    """One miss or one problem, addressed by file and JSON pointer."""

    code: str
    message: str
    location: str | None = None
    level: Level = Level.MUST
    data: Mapping[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        """The JSON shape of one finding in ``reports/manual-check.json``."""
        return {
            "code": self.code,
            "message": self.message,
            "location": self.location,
            "level": str(self.level),
            "data": dict(self.data),
        }


@dataclass(frozen=True)
class CheckResult:
    """What one check contributes to the report."""

    number: int
    id: str
    title: str
    level: Level
    status: Status
    metrics: Mapping[str, float | int | str]
    findings: tuple[Finding, ...]
    duration_s: float

    @property
    def failed(self) -> bool:
        """Whether this result must fail the run."""
        return self.status in (Status.FAIL, Status.ERROR)

    def as_dict(self) -> dict[str, Any]:
        """The JSON shape of one check in ``reports/manual-check.json``."""
        return {
            "number": self.number,
            "id": self.id,
            "title": self.title,
            "level": str(self.level),
            "status": str(self.status),
            "metrics": dict(self.metrics),
            "findings": [finding.as_dict() for finding in self.findings],
            "duration_s": round(self.duration_s, 4),
        }


class Check(Protocol):
    """The protocol the runner drives."""

    number: int
    id: str
    title: str
    level: Level

    def run(self, ctx: CheckContext) -> CheckResult:
        """Evaluate this check against ``ctx``."""
        ...


@dataclass
class CheckContext:
    """Everything the checks read, built once by the runner and shared.

    Attributes:
        repo_root: the checkout that provides ``manual/tools``, the schemas and
            ``scripts/blocklist.sh``. Never the fixture tree.
        manual_root: the manual tree under check; ``repo_root / "manual"`` for
            a real run and the fixture directory for a fixture run.
        profile: how strictly the delegated rules are judged.
        cfg: the parsed ``build.yaml``, or ``None`` when it did not load.
        manual: the mapped model, or ``None`` when the sources did not load.
        sections: the numbered outline, or ``None`` when the chapter partials
            are not all written yet.
        load_errors: one finding per loader problem; non-empty → #1 fails and
            the checks that need the model are skipped.
        pdfs: variant → the extracted text of the built PDF. The runner fills
            it once per run, and only when a check that reads a PDF is due.
        rebuilt_dir: the fresh build check #9 compares with, or ``None``.
        rebuilt: its extracted text, when ``rebuilt_dir`` named one; ``None``
            makes check #9 build a rebuild of its own.
        stats: ``data/metropt3-first-month-stats.json``.
        blocklist_cmd: the brand blocklist scanner's entry point.
    """

    repo_root: Path
    manual_root: Path
    profile: Profile
    cfg: BuildConfig | None
    manual: Manual | None
    sections: SectionMap | None
    load_errors: tuple[Finding, ...]
    stats: Mapping[str, Any]
    stats_path: Path
    stats_sha256: str
    reports_dir: Path
    variant_dir: Path
    blocklist_cmd: Path
    require_pdf: bool = True
    rebuilt_dir: Path | None = None
    pdfs: Mapping[str, PdfText] = field(default_factory=dict)
    rebuilt: Mapping[str, PdfText] | None = None
    #: Memoised subprocess runs of the manual's tools, keyed by tool name.
    tool_runs: dict[str, Any] = field(default_factory=dict)

    @property
    def model_available(self) -> bool:
        """Whether the checks that need the mapped model can run."""
        return self.manual is not None and self.cfg is not None


class BaseCheck(ABC):
    """A check that times itself and derives its status from its findings."""

    number: int
    id: str
    title: str
    level: Level

    def run(self, ctx: CheckContext) -> CheckResult:
        """Time :meth:`evaluate` and turn its findings into a result."""
        started = time.perf_counter()
        findings, metrics = self.evaluate(ctx)
        return self.result(
            status=self.status_for(findings),
            metrics=metrics,
            findings=findings,
            duration_s=time.perf_counter() - started,
        )

    @abstractmethod
    def evaluate(
        self, ctx: CheckContext
    ) -> tuple[Sequence[Finding], Mapping[str, float | int | str]]:
        """Return this check's findings and the metrics the report shows."""

    def status_for(self, findings: Iterable[Finding]) -> Status:
        """``report`` for a REPORT check, else ``fail`` on any MUST finding."""
        if self.level is Level.REPORT:
            return Status.REPORT
        blocking = any(finding.level is Level.MUST for finding in findings)
        return Status.FAIL if blocking else Status.PASS

    def result(
        self,
        *,
        status: Status,
        metrics: Mapping[str, float | int | str],
        findings: Sequence[Finding],
        duration_s: float = 0.0,
    ) -> CheckResult:
        """Build this check's :class:`CheckResult`."""
        return CheckResult(
            number=self.number,
            id=self.id,
            title=self.title,
            level=self.level,
            status=status,
            metrics=dict(metrics),
            findings=tuple(findings),
            duration_s=duration_s,
        )

    def skipped(self, reason: str, code: str = "check.skipped") -> CheckResult:
        """A ``skipped`` result carrying why this check did not run."""
        return self.result(
            status=Status.SKIPPED,
            metrics={"skipped": reason},
            findings=(Finding(code=code, message=reason, level=Level.REPORT),),
        )
