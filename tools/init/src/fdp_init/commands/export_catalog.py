# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-init export-catalog``: write the catalog init extracts from a manual.

The evaluation scores the catalog the deterministic path reads off the realistic
PDF as its headline run (``fdp-eval run --catalog file:<path>``) and the
reference catalog the manual sources export as the ablation, so the number it
reports is the number of the catalog that ships. This command produces that
file: ``extract_manual`` and ``build_catalog`` — no database, no LLM — and the
contracts ``catalog`` document (``urn:fdp:schema:catalog:v1``) of
:func:`~fdp_init.catalog.model.to_catalog_document`, with sorted keys and a
trailing newline, so the same PDF gives the same bytes on every machine.

The document is checked against the contracts before it is written. The
evaluation harness validates every entry it loads and rejects the file on the
first one that fails, so a document with any schema error is refused here, with
the errors named, rather than written for the harness to refuse later.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
from pathlib import Path

from fdp_init.catalog.deterministic import build_catalog
from fdp_init.catalog.model import Catalog, to_catalog_document
from fdp_init.catalog.validate import ValidationReport, validate_catalog
from fdp_init.config import Settings
from fdp_init.errors import ExitCode, InitError
from fdp_init.manual.extract import extract_manual
from fdp_init.manual.model import ManualDoc

__all__ = ["STEP", "render_catalog", "run"]

STEP = "export-catalog"

LISTED_PROBLEMS = 5
"""How many schema problems the refusal quotes; the count is always complete."""

logger = logging.getLogger(__name__)


def render_catalog(catalog: Catalog, doc: ManualDoc) -> str:
    """The exported document as text: sorted keys, two-space indent, one final newline."""
    document = to_catalog_document(catalog, doc)
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def _problems(report: ValidationReport) -> list[str]:
    """Everything that keeps the document from being a valid ``catalog``.

    The whole-document validation covers every entry through the schema's own
    reference to ``catalog-entry``; the structural errors (a condition or a
    (condition, cause) pair declared twice) are the ones no schema can state.
    """
    return [*report.structural_errors, *report.warnings]


def _named(report: ValidationReport) -> list[str]:
    """The problems a reader can act on: entries named by fault id before JSON paths."""
    by_fault = [message for _, _, message in report.invalid_entries]
    return [*report.structural_errors, *by_fault, *report.id_pattern_warnings] or _problems(report)


def _write(path: Path, text: str) -> None:
    """Write ``text`` to ``path``, creating its directory, with ``\\n`` line ends everywhere."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
    except OSError as error:
        raise InitError(ExitCode.CONFIG, f"cannot write {path}: {error}", STEP) from error


def run(args: argparse.Namespace, settings: Settings) -> int:
    """Extract ``--manual`` (default ``MANUAL_PATH``) and write its catalog to ``--out``.

    Args:
        args: ``manual`` (optional path) and ``out`` (required path).
        settings: The environment contract; ``MANUAL_PATH`` is the default
            manual and ``CONTRACTS_DIR`` holds the schemas the document must
            satisfy.

    Returns:
        :attr:`~fdp_init.errors.ExitCode.OK` once the document is written.

    Raises:
        InitError: exit code 2 when the manual does not exist, the contracts
            hold no schema or ``--out`` cannot be written; exit code 6 when the
            manual cannot be read or its catalog is not a valid contracts
            ``catalog`` document, in which case nothing is written.
    """
    manual: Path = args.manual or settings.manual_path
    out: Path = args.out
    if not manual.is_file():
        raise InitError(ExitCode.CONFIG, f"the manual {manual} does not exist", STEP)
    logger.info(
        "exporting the catalog", extra={"step": STEP, "event": "start", "manual": str(manual)}
    )
    doc = extract_manual(manual)
    catalog = build_catalog(doc)
    report = validate_catalog(catalog, settings.contracts_dir, doc)
    problems = _problems(report)
    if problems:
        quoted = "; ".join(_named(report)[:LISTED_PROBLEMS])
        raise InitError(
            ExitCode.MANUAL,
            f"the catalog of {manual.name} is not a valid contracts catalog document "
            f"({len(problems)} schema problems, nothing written): {quoted}",
            STEP,
        )
    text = render_catalog(catalog, doc)
    _write(out, text)
    logger.info(
        "catalog exported",
        extra={
            "step": STEP,
            "event": "done",
            "out": str(out),
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "conditions": len(catalog.conditions),
            "causes": len(catalog.fault_ids),
            "rows": len(catalog.causes),
        },
    )
    return int(ExitCode.OK)
