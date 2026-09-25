# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Check #9 — reproducibility — MUST (docs/manual.md#acceptance-checks).

Three questions, answered against ``data/manual/build-manifest.json`` and a
fresh build:

1. **Do two builds give the same document?** The extracted text of the
   committed PDF and of the rebuild must hash alike (the manifest's
   ``text_sha256``) and the two must have the same page count. The *bytes* are
   only a metric: outside the pinned container the text shaper differs, so the
   byte comparison is informative and this module records ``built_in`` so the
   report says which kind of build it was.
2. **Were the committed PDFs built from the committed sources?** The manifest
   lists every input file with its hash; recomputing
   :func:`~fdp_manual_build.manifest.inputs_tree_sha256` over the working tree
   catches a source edited without ``make manual``.
3. **Are the committed files clean?** Producer, creation date, PDF version,
   embedded fonts and the absence of ``/JavaScript``, ``/EmbeddedFiles`` and
   ``/AcroForm`` — hygiene a reader cannot see.

The rebuild comes from ``--rebuilt-dir`` (CI hands over a container build) or,
when that is absent, from an in-process :func:`~fdp_manual_build.build.build_all`
into a temporary directory. A rebuild that cannot be made is an ``error``, never
a pass: this check has nothing to compare without one.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

from fdp_manual_build.build import Options, build_all
from fdp_manual_build.checks.base import BaseCheck, Finding, Level, Status
from fdp_manual_build.checks.pdftext import PdfText
from fdp_manual_build.errors import BuildError
from fdp_manual_build.manifest import (
    CONTAINER_ENV,
    SYSTEM_PACKAGES_PATH,
    Manifest,
    hash_file,
    inputs_tree_sha256,
    read_manifest,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.checks.base import CheckContext, CheckResult
    from fdp_manual_build.config import BuildConfig

__all__ = [
    "BANNED_MARKERS",
    "EXPECTED_PRODUCER",
    "EXPECTED_VERSION",
    "FONT_FAMILY",
    "MANIFEST_NAME",
    "ReproducibilityCheck",
    "hygiene",
]

#: The build manifest, next to the PDFs.
MANIFEST_NAME: Final = "build-manifest.json"
#: The pinned ``weasyprint==70.0`` writes this Producer.
EXPECTED_PRODUCER: Final = "WeasyPrint 70.0"
#: The committed manuals are PDF 1.7.
EXPECTED_VERSION: Final = "1.7"
#: Every embedded face is a subset of one of the two IBM Plex families.
FONT_FAMILY: Final = "IBMPlex"
#: Markers no manual may carry (a PDF is a document, not a program).
BANNED_MARKERS: Final[tuple[bytes, ...]] = (b"/JavaScript", b"/EmbeddedFiles", b"/AcroForm")

#: Metadata keys that may carry a date, and the one value that is allowed.
_DATE_KEYS: Final[tuple[str, ...]] = ("CreationDate", "ModDate")


class ReproducibilityCheck(BaseCheck):
    """The committed PDFs come from the committed sources, and rebuild alike."""

    number = 9
    id = "reproducibility"
    title = "Reproducibility"
    level = Level.MUST

    def run(self, ctx: CheckContext) -> CheckResult:
        """Skip without PDFs when they are not required; error without a rebuild."""
        if not ctx.pdfs and not ctx.require_pdf:
            return self.skipped(
                f"no built PDF under {ctx.variant_dir} (--no-require-pdf)",
                code="check.pdf_absent",
            )
        result = super().run(ctx)
        if any(finding.code == "reproducibility.rebuild_failed" for finding in result.findings):
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
        """Compare the committed build with the manifest and with a rebuild."""
        cfg = ctx.cfg
        path = ctx.variant_dir / MANIFEST_NAME
        if cfg is None:
            return [_finding("manifest_unreadable", "build.yaml did not load", str(path))], {}
        findings: list[Finding] = []
        metrics: dict[str, float | int | str] = {}
        try:
            manifest = read_manifest(path)
        except BuildError as error:
            return [_finding("manifest_missing", str(error), str(path))], {"manifest": str(path)}
        metrics["built_in"] = str(manifest.get("built_in", "unknown"))
        findings += _inputs(ctx, manifest)
        rebuilt, source, failures = _rebuild(ctx, cfg)
        metrics["rebuild"] = source
        findings += failures
        if failures:
            return findings, metrics
        findings += _compare(ctx, manifest, rebuilt, metrics)
        findings += _system_packages(manifest)
        findings += [item for pdf in _committed(ctx) for item in hygiene(pdf, cfg)]
        return findings, metrics


# --- the manifest against the working tree ---------------------------------


def _inputs(ctx: CheckContext, manifest: Manifest) -> list[Finding]:
    """Recompute ``inputs_tree_sha256`` over the current sources (check #9)."""
    recorded = manifest.get("inputs")
    if not isinstance(recorded, dict) or not recorded:
        return [
            _finding(
                "manifest_unreadable",
                "the manifest lists no `inputs`, so the sources cannot be compared",
                str(ctx.variant_dir / MANIFEST_NAME),
            )
        ]
    current: dict[str, str] = {}
    missing: list[str] = []
    changed: list[str] = []
    for relative, digest in sorted(recorded.items()):
        path = ctx.repo_root / relative
        if not path.is_file():
            missing.append(relative)
            continue
        current[relative] = hash_file(path)
        if current[relative] != digest:
            changed.append(relative)
    if missing:
        return [
            _finding(
                "inputs_missing",
                f"{len(missing)} input file(s) of the committed build are gone: "
                f"{', '.join(missing[:5])}",
                str(ctx.repo_root),
                data={"missing": missing},
            )
        ]
    found = inputs_tree_sha256(current)
    if found == manifest.get("inputs_tree_sha256"):
        return []
    return [
        _finding(
            "inputs_changed",
            f"{len(changed)} source file(s) changed since the PDFs were built "
            f"({', '.join(changed[:5])}); run `make manual`",
            str(ctx.repo_root),
            data={
                "changed": changed,
                "expected": manifest.get("inputs_tree_sha256"),
                "found": found,
            },
        )
    ]


# --- the rebuild -----------------------------------------------------------


def _rebuild(ctx: CheckContext, cfg: BuildConfig) -> tuple[dict[str, PdfText], str, list[Finding]]:
    """The fresh build to compare with, from ``--rebuilt-dir`` or in process."""
    if ctx.rebuilt is not None:
        return dict(ctx.rebuilt), "rebuilt-dir", []
    if ctx.rebuilt_dir is not None:
        loaded, failures = _load(ctx, cfg, ctx.rebuilt_dir)
        return loaded, "rebuilt-dir", failures
    try:
        with tempfile.TemporaryDirectory(prefix="fdp-rebuild-") as scratch:
            out_dir = Path(scratch) / "pdf"
            build_all(
                cfg,
                ctx.repo_root,
                Options(out_dir=out_dir, strict_pages=False, html_dir=Path(scratch) / "html"),
            )
            loaded, failures = _load(ctx, cfg, out_dir)
            return loaded, "in-process", failures
    except BuildError as error:
        return {}, "in-process", [_finding("rebuild_failed", str(error), str(ctx.repo_root))]


def _load(
    ctx: CheckContext, cfg: BuildConfig, directory: Path
) -> tuple[dict[str, PdfText], list[Finding]]:
    """Extract every committed variant again out of ``directory``."""
    loaded: dict[str, PdfText] = {}
    failures: list[Finding] = []
    for name in sorted(ctx.pdfs):
        path = directory / cfg.outputs.pdf_name(name)
        try:
            loaded[name] = PdfText.open(path)
        except BuildError as error:
            failures.append(_finding("rebuild_failed", str(error), str(path)))
    return loaded, failures


def _compare(
    ctx: CheckContext,
    manifest: Manifest,
    rebuilt: Mapping[str, PdfText],
    metrics: dict[str, float | int | str],
) -> list[Finding]:
    """Text hash, page count and bytes, per variant."""
    findings: list[Finding] = []
    outputs = manifest.get("outputs")
    recorded: Mapping[str, Any] = outputs if isinstance(outputs, dict) else {}
    for name, committed in sorted(ctx.pdfs.items()):
        fresh = rebuilt.get(name)
        if fresh is None:
            findings.append(
                _finding("rebuild_failed", f"{name}: the rebuild produced no PDF", name)
            )
            continue
        metrics[f"{name}_text_sha256"] = committed.text_sha256
        metrics[f"{name}_bytes_identical"] = str(committed.pdf_sha256 == fresh.pdf_sha256).lower()
        findings += _variant(name, committed, fresh, recorded.get(name))
    return findings


def _variant(name: str, committed: PdfText, fresh: PdfText, recorded: Any) -> list[Finding]:
    findings: list[Finding] = []
    if committed.text_sha256 != fresh.text_sha256:
        findings.append(
            _finding(
                "text_hash",
                f"{name}: the rebuilt text hashes to {fresh.text_sha256[:12]}…, the committed "
                f"PDF to {committed.text_sha256[:12]}…",
                committed.path.name,
                data={"committed": committed.text_sha256, "rebuilt": fresh.text_sha256},
            )
        )
    if committed.page_count != fresh.page_count:
        findings.append(
            _finding(
                "page_count",
                f"{name}: the rebuild has {fresh.page_count} pages, the committed PDF "
                f"{committed.page_count}",
                committed.path.name,
                data={"committed": committed.page_count, "rebuilt": fresh.page_count},
            )
        )
    if committed.pdf_sha256 != fresh.pdf_sha256:
        findings.append(
            _finding(
                "bytes_differ",
                f"{name}: the rebuild is not byte-identical "
                f"({'in' if _in_container() else 'outside'} the pinned container)",
                committed.path.name,
                level=Level.REPORT,
            )
        )
    findings += _against_manifest(name, committed, recorded)
    return findings


def _against_manifest(name: str, committed: PdfText, recorded: Any) -> list[Finding]:
    """The committed file must still be the one the manifest recorded."""
    if not isinstance(recorded, dict):
        return [
            _finding(
                "manifest_stale",
                f"{name}: the manifest records no output for this variant",
                committed.path.name,
            )
        ]
    if recorded.get("pdf_sha256") == committed.pdf_sha256:
        return []
    return [
        _finding(
            "manifest_stale",
            f"{name}: {committed.path.name} is not the file the manifest records",
            committed.path.name,
            data={"expected": recorded.get("pdf_sha256"), "found": committed.pdf_sha256},
        )
    ]


def _system_packages(manifest: Manifest) -> list[Finding]:
    """Informative: the rebuild image's packages against the recorded ones."""
    image = manifest.get("image")
    recorded = image.get("system_packages") if isinstance(image, dict) else None
    if not isinstance(recorded, list) or not _in_container():
        return []
    current = (
        [
            line.strip()
            for line in SYSTEM_PACKAGES_PATH.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        if SYSTEM_PACKAGES_PATH.is_file()
        else []
    )
    if current == recorded:
        return []
    return [
        _finding(
            "system_packages",
            f"the rebuild image lists {len(current)} system package(s), the manifest "
            f"{len(recorded)}",
            str(SYSTEM_PACKAGES_PATH),
            level=Level.REPORT,
        )
    ]


# --- hygiene of the committed files ----------------------------------------


def hygiene(pdf: PdfText, cfg: BuildConfig) -> list[Finding]:
    """Producer, dates, version, fonts and banned markers of one built PDF."""
    return list(_hygiene(pdf, cfg))


def _hygiene(pdf: PdfText, cfg: BuildConfig) -> Iterator[Finding]:
    producer = str(pdf.metadata.get("Producer", ""))
    if producer != EXPECTED_PRODUCER:
        yield _finding(
            "producer",
            f"{pdf.path.name} was written by {producer or 'an unnamed tool'}, "
            f"not by {EXPECTED_PRODUCER}",
            pdf.path.name,
        )
    if pdf.pdf_version != EXPECTED_VERSION:
        yield _finding(
            "pdf_version",
            f"{pdf.path.name} is PDF {pdf.pdf_version or 'unknown'}, not {EXPECTED_VERSION}",
            pdf.path.name,
        )
    yield from _dates(pdf, cfg)
    for fontname in sorted(pdf.fontnames):
        if FONT_FAMILY not in fontname.replace("-", "").replace(" ", ""):
            yield _finding(
                "fallback_font",
                f"{pdf.path.name} embeds {fontname}, which is not an IBM Plex face",
                pdf.path.name,
                data={"fontname": fontname},
            )
    for marker in BANNED_MARKERS:
        if pdf.raw_contains(marker):
            yield _finding(
                "active_content",
                f"{pdf.path.name} carries {marker.decode()} in its raw bytes",
                pdf.path.name,
            )


def _dates(pdf: PdfText, cfg: BuildConfig) -> Iterator[Finding]:
    """Only the fixed ``dcterms.created`` of ``build.yaml`` may be in the file."""
    allowed = _pdf_date(cfg.source_date_epoch)
    for key in _DATE_KEYS:
        value = pdf.metadata.get(key)
        if value is None:
            continue
        if key == "ModDate" or str(value) != allowed:
            yield _finding(
                "metadata_date",
                f"{pdf.path.name} carries {key} {value!r}; only CreationDate {allowed!r}, "
                "the dcterms.created of build.yaml, is allowed",
                pdf.path.name,
                data={"key": key, "found": str(value), "allowed": allowed},
            )


def _pdf_date(epoch: int) -> str:
    """``source_date_epoch`` in the ``D:YYYYMMDDHHMMSS+00'00`` form PDFs use."""
    moment = datetime.fromtimestamp(epoch, tz=UTC)
    return f"D:{moment:%Y%m%d%H%M%S}+00'00"


# --- helpers ---------------------------------------------------------------


def _committed(ctx: CheckContext) -> list[PdfText]:
    return [pdf for _, pdf in sorted(ctx.pdfs.items())]


def _in_container() -> bool:
    return os.environ.get(CONTAINER_ENV) == "1"


def _finding(
    code: str,
    message: str,
    location: str,
    *,
    level: Level = Level.MUST,
    data: Mapping[str, Any] | None = None,
) -> Finding:
    return Finding(
        code=f"reproducibility.{code}",
        message=message,
        location=location,
        level=level,
        data=data or {},
    )
