# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-manual-check``: the acceptance check runner.

Builds one :class:`~fdp_manual_build.checks.base.CheckContext`, runs the eleven
manual acceptance checks (docs/manual.md#acceptance-checks) in a fixed order
and writes ``reports/manual-check.json`` and ``reports/manual-check.md``.

Exit codes: ``0`` every MUST check passed, ``1`` at least one failed, ``2`` a
runner error (bad arguments, unreadable input), ``3`` the sources fail schema
validation so badly that the checks which need the model were skipped.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from importlib import metadata
from pathlib import Path
from typing import Any, Final

from fdp_manual_build import __version__
from fdp_manual_build.checks.base import (
    BaseCheck,
    Check,
    CheckContext,
    CheckResult,
    Finding,
    Level,
    Profile,
)
from fdp_manual_build.checks.c01_schema import SchemaCheck
from fdp_manual_build.checks.c02_integrity import IntegrityCheck
from fdp_manual_build.checks.c03_coverage import CoverageCleanCheck
from fdp_manual_build.checks.c04_tables import TableRecoveryCheck
from fdp_manual_build.checks.c05_coverage_realistic import CoverageRealisticCheck
from fdp_manual_build.checks.c06_blocklist import BlocklistCheck
from fdp_manual_build.checks.c07_plausibility import PlausibilityCheck
from fdp_manual_build.checks.c08_ambiguity import AmbiguityCheck
from fdp_manual_build.checks.c09_reproducibility import MANIFEST_NAME, ReproducibilityCheck
from fdp_manual_build.checks.c10_reuse import REUSE_REQUIREMENT, ReuseCheck
from fdp_manual_build.checks.c11_metropt import MetroptFitCheck
from fdp_manual_build.checks.pdftext import PdfText
from fdp_manual_build.checks.report import (
    EXIT_ERROR,
    RunResult,
    summarise,
    write_json,
    write_markdown,
)
from fdp_manual_build.config import BuildConfig, load_build_config
from fdp_manual_build.errors import BuildError
from fdp_manual_build.load import load_manual
from fdp_manual_build.manual_tools import find_repo_root
from fdp_manual_build.model import Manual
from fdp_manual_build.numbering import SectionMap, generated_sections, read_chapters, scan

__all__ = ["CHECK_ORDER", "checks", "main", "run"]

#: Check order: the source-level rows first, the PDF-level rows after.
CHECK_ORDER: Final = (1, 2, 11, 7, 8, 6, 3, 4, 5, 9, 10)
#: Rows that need the mapped model; skipped when #1 could not build it.
NEEDS_MODEL: Final = frozenset({2, 3, 4, 5, 7, 8, 11})
#: Rows that read the built PDFs, so the extraction only runs when one is due.
#: Check #6 hands its own PDF paths to the blocklist scanner and needs no extraction.
NEEDS_PDF: Final = frozenset({3, 4, 5, 9, 11})

_BUILD_MARKER: Final = Path("manual") / "build.yaml"
_STATS_RELATIVE: Final = Path("data") / "metropt3-first-month-stats.json"
_BLOCKLIST_RELATIVE: Final = Path("scripts") / "blocklist.sh"
_REPORT_STEM: Final = "manual-check"


def checks() -> tuple[Check, ...]:
    """Every acceptance check, in the order the runner evaluates them."""
    registry: dict[int, Check] = {
        1: SchemaCheck(),
        2: IntegrityCheck(),
        3: CoverageCleanCheck(),
        4: TableRecoveryCheck(),
        5: CoverageRealisticCheck(),
        6: BlocklistCheck(),
        7: PlausibilityCheck(),
        8: AmbiguityCheck(),
        9: ReproducibilityCheck(),
        10: ReuseCheck(),
        11: MetroptFitCheck(),
    }
    return tuple(registry[number] for number in CHECK_ORDER)


def run(
    ctx: CheckContext,
    only: frozenset[int] = frozenset(),
    skip: frozenset[int] = frozenset(),
) -> tuple[CheckResult, ...]:
    """Run every selected check against ``ctx``, in :data:`CHECK_ORDER`."""
    results: list[CheckResult] = []
    for check in checks():
        if (only and check.number not in only) or check.number in skip:
            results.append(_deselected(check))
            continue
        if check.number in NEEDS_MODEL and not ctx.model_available:
            results.append(_blocked(check))
            continue
        results.append(check.run(ctx))
    return tuple(results)


def main(argv: Sequence[str] | None = None, repo_root: Path | None = None) -> int:
    """Entry point of ``fdp-manual-check`` and of ``fdp-manual-build check``."""
    parser = _parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        only, skip = _numbers(args.only), _numbers(args.skip)
        ctx, fail_on_report = _context(args, repo_root, _selected(only, skip))
    except _RunnerError as error:
        print(f"fdp-manual-check: {error}", file=sys.stderr)
        return EXIT_ERROR

    results = run(ctx, only, skip)
    summary = summarise(results, fail_on_report=fail_on_report)
    result = RunResult(
        generated_at=datetime.now(tz=UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        repo_root=ctx.repo_root,
        manual_root=ctx.manual_root,
        profile=str(ctx.profile),
        inputs=_inputs(ctx),
        checks=results,
        summary=summary,
    )
    json_path = write_json(ctx.reports_dir / f"{_REPORT_STEM}.json", result)
    markdown_path = write_markdown(ctx.reports_dir / f"{_REPORT_STEM}.md", result)
    _print(result, json_path, markdown_path)
    return summary.exit_code


# --- context --------------------------------------------------------------


class _RunnerError(RuntimeError):
    """A bad argument or an unreadable input; the runner exits 2."""


def _context(
    args: argparse.Namespace, repo_root: Path | None, selected: frozenset[int]
) -> tuple[CheckContext, bool]:
    root, manual_root, profile = _roots(args, repo_root)
    stats_path = Path(args.stats) if args.stats else root / _STATS_RELATIVE
    stats, stats_sha256 = _stats(stats_path)
    cfg, manual, sections, load_errors = _sources(root, manual_root)
    blocklist = Path(args.blocklist_cmd) if args.blocklist_cmd else root / _BLOCKLIST_RELATIVE
    variant_dir = _variant_dir(args, root)
    rebuilt_dir = None if args.rebuilt_dir is None else Path(args.rebuilt_dir).resolve()
    extract = bool(selected & NEEDS_PDF)
    pdfs = _extract(cfg, variant_dir) if extract else {}
    ctx = CheckContext(
        repo_root=root,
        manual_root=manual_root,
        profile=profile,
        cfg=cfg,
        manual=manual,
        sections=sections,
        load_errors=load_errors,
        stats=stats,
        stats_path=stats_path,
        stats_sha256=stats_sha256,
        reports_dir=Path(args.report_dir).resolve(),
        variant_dir=variant_dir,
        blocklist_cmd=blocklist,
        require_pdf=args.require_pdf,
        rebuilt_dir=rebuilt_dir,
        pdfs=pdfs,
        rebuilt=(
            _extract(cfg, rebuilt_dir, only=frozenset(pdfs))
            if extract and rebuilt_dir is not None
            else None
        ),
    )
    return ctx, bool(args.fail_on_report)


def _selected(only: frozenset[int], skip: frozenset[int]) -> frozenset[int]:
    """The check numbers this run will evaluate, after ``--only``/``--skip``."""
    chosen = only or frozenset(CHECK_ORDER)
    return frozenset(chosen) - skip


def _extract(
    cfg: BuildConfig | None, directory: Path, only: frozenset[str] | None = None
) -> dict[str, PdfText]:
    """Open every enabled variant that is present under ``directory``.

    One :class:`~fdp_manual_build.checks.pdftext.PdfText` per PDF per run; a
    file that cannot be read is simply absent, and the check that
    needed it reports the gap with its own finding code.
    """
    if cfg is None:
        return {}
    extracted: dict[str, PdfText] = {}
    for name in sorted(cfg.variants):
        if only is not None and name not in only:
            continue
        if not cfg.variants[name].enabled:
            continue
        path = directory / cfg.outputs.pdf_name(name)
        if not path.is_file():
            continue
        try:
            extracted[name] = PdfText.open(path)
        except BuildError:
            continue
    return extracted


def _roots(args: argparse.Namespace, given: Path | None) -> tuple[Path, Path, Profile]:
    """Resolve the tool checkout, the manual tree under check and the profile.

    ``--repo-root`` is normally a checkout holding ``manual/build.yaml``. It may
    also point straight at a manual tree — the mini fixture is one — in which
    case the tools and schemas come from the checkout above it, or, for a copy
    outside the repository, from the checkout this package is installed from,
    and the default profile becomes ``fixture``.
    """
    root = (Path(args.repo_root) if args.repo_root is not None else given) or Path.cwd()
    root = root.resolve()
    if (root / _BUILD_MARKER).is_file():
        manual_root, default = root / "manual", Profile.FULL
    elif (root / "build.yaml").is_file():
        checkout = find_repo_root(root) or find_repo_root(Path(__file__).resolve())
        if checkout is None:
            raise _RunnerError(f"{root}: no manual/tools/load.py in any directory above it")
        manual_root, root, default = root, checkout, Profile.FIXTURE
    else:
        raise _RunnerError(
            f"{root}: neither {_BUILD_MARKER.as_posix()} nor build.yaml; pass --repo-root"
        )
    profile = default if args.profile == "auto" else Profile(args.profile)
    return root, manual_root, profile


def _variant_dir(args: argparse.Namespace, root: Path) -> Path:
    given = Path(args.variant_dir)
    return given if given.is_absolute() else root / given


def _stats(path: Path) -> tuple[Mapping[str, Any], str]:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise _RunnerError(f"--stats {path}: {error}") from error
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise _RunnerError(f"--stats {path}: {error}") from error
    if not isinstance(parsed, dict):
        raise _RunnerError(f"--stats {path}: not a JSON object")
    return parsed, hashlib.sha256(raw).hexdigest()


def _sources(
    root: Path, manual_root: Path
) -> tuple[BuildConfig | None, Manual | None, SectionMap | None, tuple[Finding, ...]]:
    """Load ``build.yaml``, the model and the outline, collecting every error."""
    errors: list[Finding] = []
    try:
        cfg = load_build_config(root, manual_root)
    except BuildError as error:
        return None, None, None, tuple(_findings(error, "schema.build_config"))
    try:
        manual = load_manual(root, cfg)
    except BuildError as error:
        return cfg, None, None, tuple(_findings(error, "schema.invalid"))
    sections = _sections(cfg, manual, errors)
    return cfg, manual, sections, tuple(errors)


def _sections(cfg: BuildConfig, manual: Manual, errors: list[Finding]) -> SectionMap | None:
    """Number the outline, or return ``None`` while the manual's chapters are open."""
    missing = [chapter for chapter in cfg.chapters if not cfg.chapter_path(chapter).is_file()]
    if missing:
        errors.append(
            Finding(
                code="schema.partials_absent",
                message=(
                    f"{len(missing)} of {len(cfg.chapters)} chapter partial(s) are not written "
                    "yet, so the section outline was not numbered"
                ),
                location=str(cfg.manual_root / "content"),
                level=Level.REPORT,
            )
        )
        return None
    try:
        return scan(read_chapters(cfg), generated_sections(manual))
    except BuildError as error:
        errors.extend(_findings(error, "schema.section_outline"))
        return None


def _findings(error: BuildError, code: str) -> list[Finding]:
    if not error.errors:
        return [Finding(code=code, message=str(error), level=Level.MUST)]
    return [
        Finding(
            code="schema.duplicate_id" if "duplicate" in item.message else code,
            message=item.message,
            location=f"{item.file}#{item.json_pointer}" if item.json_pointer else item.file,
            level=Level.MUST,
        )
        for item in error.errors
    ]


def _inputs(ctx: CheckContext) -> dict[str, Any]:
    manual = ctx.manual
    return {
        "sources_tree_sha256": _tree_sha256(manual),
        "pdfs": _pdf_inputs(ctx),
        "manifest": str(ctx.variant_dir / MANIFEST_NAME),
        "stats_sha256": ctx.stats_sha256,
        "tool_versions": {
            "fdp-manual-build": __version__,
            "pdfplumber": _version("pdfplumber"),
            "reuse": REUSE_REQUIREMENT.rpartition("==")[2],
            "python": sys.version.split()[0],
        },
    }


def _pdf_inputs(ctx: CheckContext) -> dict[str, Any]:
    """Every built variant this run saw, with the hashes the report quotes."""
    entries: dict[str, Any] = {}
    for name, path in _pdf_paths(ctx).items():
        entry: dict[str, Any] = {"path": str(path)}
        extracted = ctx.pdfs.get(name)
        if isinstance(extracted, PdfText):
            entry |= {
                "sha256": extracted.pdf_sha256,
                "text_sha256": extracted.text_sha256,
                "pages": extracted.page_count,
            }
        entries[name] = entry
    return entries


def _pdf_paths(ctx: CheckContext) -> dict[str, Path]:
    cfg = ctx.cfg
    if cfg is None:
        return {}
    return {
        name: ctx.variant_dir / cfg.outputs.pdf_name(name)
        for name in sorted(cfg.variants)
        if (ctx.variant_dir / cfg.outputs.pdf_name(name)).is_file()
    }


def _tree_sha256(manual: Manual | None) -> str | None:
    """One hash over every source file the loader read, in path order."""
    if manual is None:
        return None
    digest = hashlib.sha256()
    for path, file_hash in sorted(manual.source_hashes.items()):
        digest.update(f"{path}:{file_hash}\n".encode())
    return digest.hexdigest()


def _version(package: str) -> str:
    try:
        return metadata.version(package)
    except metadata.PackageNotFoundError:  # pragma: no cover - always installed
        return "unknown"


# --- results and output ---------------------------------------------------


def _deselected(check: Check) -> CheckResult:
    return _skip(check, "not selected by --only/--skip", "check.deselected")


def _blocked(check: Check) -> CheckResult:
    return _skip(
        check,
        "the sources did not load, so check #1 has to pass first",
        "check.blocked_by_schema",
    )


def _skip(check: Check, reason: str, code: str) -> CheckResult:
    if isinstance(check, BaseCheck):
        return check.skipped(reason, code=code)
    raise TypeError(f"{check.id}: not a BaseCheck")  # pragma: no cover - registry is ours


def _numbers(text: str | None) -> frozenset[int]:
    if not text:
        return frozenset()
    try:
        return frozenset(int(part) for part in text.split(",") if part.strip())
    except ValueError as error:
        raise _RunnerError(f"expected comma-separated check numbers, got {text!r}") from error


def _print(result: RunResult, json_path: Path, markdown_path: Path) -> None:
    for check in result.checks:
        print(f"#{check.number:<2} {check.id:<20} {check.status}")
    summary = result.summary
    print(
        f"fdp-manual-check: {summary.status} — {summary.must_passed}/{summary.must_total} MUST, "
        f"{summary.report_total} report-only"
    )
    print(f"  {json_path}")
    print(f"  {markdown_path}")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fdp-manual-check",
        description="Run the eleven manual acceptance checks on the manual.",
    )
    parser.add_argument("--version", action="version", version=f"fdp-manual-check {__version__}")
    parser.add_argument(
        "--repo-root",
        default=None,
        metavar="DIR",
        help="checkout holding manual/build.yaml, or a manual tree such as a fixture",
    )
    parser.add_argument("--report-dir", default="reports", metavar="DIR", help="where to write")
    parser.add_argument(
        "--variant-dir", default="data/manual", metavar="DIR", help="where the built PDFs are"
    )
    parser.add_argument(
        "--rebuilt-dir", default=None, metavar="DIR", help="a fresh build to compare with (#9)"
    )
    parser.add_argument("--only", default=None, metavar="N,…", help="run only these check numbers")
    parser.add_argument("--skip", default=None, metavar="N,…", help="skip these check numbers")
    parser.add_argument(
        "--require-pdf",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="fail #3/#4/#5/#9 when the built PDFs are missing",
    )
    parser.add_argument(
        "--stats",
        default=None,
        metavar="FILE",
        help=f"MetroPT-3 statistics (default: {_STATS_RELATIVE.as_posix()})",
    )
    parser.add_argument(
        "--fail-on-report",
        action="store_true",
        help="turn REPORT checks and informative findings into failures (never in CI)",
    )
    parser.add_argument(
        "--profile",
        choices=("auto", "full", "fixture"),
        default="auto",
        help="how strictly to judge the tree (auto: fixture for a bare manual tree)",
    )
    parser.add_argument(
        "--blocklist-cmd",
        default=None,
        metavar="FILE",
        help=f"the blocklist scanner used by check #6 (default: {_BLOCKLIST_RELATIVE.as_posix()})",
    )
    return parser


if __name__ == "__main__":  # pragma: no cover - module entry point
    sys.exit(main())
