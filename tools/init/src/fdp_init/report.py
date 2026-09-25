# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""What one ingest did, in one JSON object.

The same document goes to three places: the log, as a single ``ingest.report``
event; ``app.ingest_runs.stats``, which is what ``fdp-init report`` reads back
and what the idempotency check matches on; and, when
``INIT_REPORT_DIR`` exists and is writable, a file beside the run.

Nothing here reads a secret. The optional structurer contributes a model name
and two token counts and nothing else, so a report is safe to print, to commit
to a CI artefact and to paste into an issue — which is exactly why the settings
object is never rendered into it.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from statistics import median
from typing import Any

import pg8000.native

from fdp_init import INGEST_VERSION, __version__
from fdp_init.catalog.model import Catalog
from fdp_init.catalog.provider import StructureResult
from fdp_init.catalog.validate import ValidationReport
from fdp_init.chunk.chunker import Chunk
from fdp_init.config import Settings
from fdp_init.dataset.metropt import DatasetResult
from fdp_init.embed.spec import EmbeddingSpec
from fdp_init.manual.extract import variant_of
from fdp_init.manual.model import ExtractStats, ManualDoc

__all__ = [
    "EVENT",
    "FILE_PREFIX",
    "STEP",
    "IngestReport",
    "StoredRun",
    "catalog_facts",
    "chunk_facts",
    "dataset_facts",
    "embedding_facts",
    "extraction_facts",
    "latest_report",
    "manual_facts",
    "report_filename",
    "skipped_manual_facts",
    "write_report",
]

STEP = "report"

EVENT = "ingest.report"
"""The log event of the report; one record carries the whole document."""

FILE_PREFIX = "init-ingest-"

SELECT_LATEST = """
SELECT id, document_id, status, started_wall_ts, finished_wall_ts, error, stats
  FROM app.ingest_runs
 ORDER BY started_wall_ts DESC, id DESC
 LIMIT 1
"""

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class IngestReport:
    """The ingest report.

    The nested sections are plain dictionaries because they are a serialisation
    format first: they are written to ``jsonb``, read back by ``fdp-init
    report`` and diffed between runs. The builders below
    (:func:`manual_facts` and friends) are what fills them, so a caller never
    has to remember a key.
    """

    started_at: str
    finished_at: str
    elapsed_s: float
    catalog_mode: str
    skipped: bool
    manual: dict[str, Any]
    init_version: str = __version__
    ingest_version: int = INGEST_VERSION
    extraction: dict[str, Any] | None = None
    catalog: dict[str, Any] | None = None
    chunks: dict[str, Any] | None = None
    embedding: dict[str, Any] | None = None
    dataset: dict[str, Any] | None = None
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """The document, in its fixed key order.

        A skipped run leaves ``extraction``, ``catalog`` and ``chunks`` null
        rather than zero-filled: nothing was extracted, and a reader must be
        able to tell that from "extracted nothing".
        """
        return {
            "init_version": self.init_version,
            "ingest_version": self.ingest_version,
            "catalog_mode": self.catalog_mode,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed_s": self.elapsed_s,
            "skipped": self.skipped,
            "manual": dict(self.manual),
            "extraction": None if self.extraction is None else dict(self.extraction),
            "catalog": None if self.catalog is None else dict(self.catalog),
            "chunks": None if self.chunks is None else dict(self.chunks),
            "embedding": None if self.embedding is None else dict(self.embedding),
            "dataset": None if self.dataset is None else dict(self.dataset),
            "warnings": list(self.warnings),
        }


def manual_facts(doc: ManualDoc) -> dict[str, Any]:
    """The ``manual`` section of a report that ingested something."""
    return {
        "path": str(doc.path),
        "sha256": doc.sha256,
        "bytes": doc.bytes,
        "pages": doc.page_count,
        "variant": doc.variant,
        "title": doc.title,
    }


def skipped_manual_facts(path: Path, sha256: str | None, size: int | None) -> dict[str, Any]:
    """The ``manual`` section when the PDF was never opened.

    A skipped run knows the file and its digest — that is what it compared —
    but not the page count or the title, which only extraction produces.
    """
    return {
        "path": str(path),
        "sha256": sha256,
        "bytes": size,
        "pages": None,
        "variant": variant_of(path),
        "title": None,
    }


def extraction_facts(stats: ExtractStats) -> dict[str, Any]:
    """The ``extraction`` section: the self-check counters."""
    facts = asdict(stats)
    facts["headings_by_level"] = {
        str(level): count for level, count in stats.headings_by_level.items()
    }
    facts["table_recall_estimate"] = round(stats.table_recall_estimate, 4)
    return facts


def _llm_facts(result: StructureResult) -> dict[str, Any] | None:
    """The ``catalog.llm`` object: the model and its token use, or null.

    Only what the provider reports back. The key, the base URL and the prompt
    are not part of a report: secrets stay in the environment.
    """
    if result.usage is None:
        return None
    return {
        "model": result.usage.get("model"),
        "input_tokens": result.usage.get("input_tokens"),
        "output_tokens": result.usage.get("output_tokens"),
    }


def catalog_facts(
    catalog: Catalog,
    result: StructureResult,
    vreport: ValidationReport,
    stats: ExtractStats,
    unresolved_alarm_codes: Sequence[str],
) -> dict[str, Any]:
    """The ``catalog`` section: what was built, and what the contracts said."""
    return {
        "source": catalog.source,
        "fallback_reason": result.fallback_reason,
        "conditions": len(catalog.conditions),
        "causes": len(catalog.fault_ids),
        "cause_rows": len(catalog.causes),
        "alarms": len(catalog.alarms),
        "signals": len(catalog.signals),
        "sections": len(catalog.sections),
        "fault_ids": list(catalog.fault_ids),
        "rows_without_fault_id": stats.rows_without_fault_id,
        "invalid_entries": [list(entry) for entry in vreport.invalid_entries],
        "id_pattern_warnings": list(vreport.id_pattern_warnings),
        "unresolved_alarm_codes": list(unresolved_alarm_codes),
        "llm": _llm_facts(result),
    }


def chunk_facts(chunks: Sequence[Chunk]) -> dict[str, Any]:
    """The ``chunks`` section: how many of each kind, and how long they are."""
    tokens = sorted(chunk.tokens for chunk in chunks)
    return {
        "total": len(chunks),
        "text": sum(1 for chunk in chunks if chunk.kind == "text"),
        "list": sum(1 for chunk in chunks if chunk.kind == "list"),
        "table": sum(1 for chunk in chunks if chunk.kind == "table"),
        "truncated_rows": sum(1 for chunk in chunks if chunk.truncated),
        "tokens_p50": int(median(tokens)) if tokens else 0,
        "tokens_max": tokens[-1] if tokens else 0,
    }


def embedding_facts(spec: EmbeddingSpec, elapsed_s: float) -> dict[str, Any]:
    """The ``embedding`` section: the pin, and what running it cost.

    ``key`` is :attr:`EmbeddingSpec.key`; :func:`fdp_init.store.ingested_already`
    compares it, so a change of pooling or token ceiling re-ingests even when
    the model id and revision stay the same.
    """
    return {
        "model_id": spec.model_id,
        "revision": spec.revision,
        "dimension": spec.dimension,
        "pooling": spec.pooling,
        "max_tokens": spec.max_tokens,
        "key": spec.key,
        "elapsed_s": round(elapsed_s, 3),
    }


def dataset_facts(result: DatasetResult | None) -> dict[str, Any] | None:
    """The ``dataset`` section, or null when the step was not part of the run."""
    if result is None:
        return None
    facts = asdict(result)
    facts["path"] = str(result.path)
    facts["elapsed_s"] = round(result.elapsed_s, 3)
    return facts


def report_filename(report: IngestReport) -> str:
    """``init-ingest-<started_at>.json``, with the separators taken out.

    The file is named after ``started_at``. The timestamp is ISO 8601, and a
    colon is legal on POSIX but not on every filesystem a bind mount may come
    from, so the punctuation is dropped and the instant is still readable:
    ``init-ingest-20260922T101530123Z.json``.
    """
    stamp = report.started_at
    for character in "-:.+":
        stamp = stamp.replace(character, "")
    return f"{FILE_PREFIX}{stamp}.json"


def _writable(directory: Path) -> bool:
    """Whether ``INIT_REPORT_DIR`` exists as a directory and accepts writes."""
    return directory.is_dir() and os.access(directory, os.W_OK)


def write_report(report: IngestReport, settings: Settings) -> Path | None:
    """Log the report, and write it to ``INIT_REPORT_DIR`` when that is possible.

    Args:
        report: The finished report.
        settings: The environment contract; only ``report_dir`` is read.

    Returns:
        The file that was written, or ``None`` when the directory does not
        exist or is read-only — which is the normal case in the container
        unless a volume is mounted, and never a failure of the run.
    """
    document = report.to_dict()
    logger.info(
        "ingest report",
        extra={
            "step": STEP,
            "event": EVENT,
            "skipped": report.skipped,
            "elapsed_s": report.elapsed_s,
            "catalog_mode": report.catalog_mode,
            # One JSON string, not a nested object: the redaction filter
            # rewrites every non-scalar extra through ``str()``, which
            # would put a Python repr on the log line instead of JSON.
            "report": json.dumps(document, sort_keys=True),
        },
    )
    directory = settings.report_dir
    if not _writable(directory):
        logger.debug(
            "no report file written",
            extra={"step": STEP, "event": "skipped", "dir": str(directory)},
        )
        return None

    target = directory / report_filename(report)
    try:
        target.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except OSError as error:
        logger.warning(
            "the ingest report could not be written to %s: %s",
            target,
            error,
            extra={"step": STEP, "event": "skipped", "path": str(target)},
        )
        return None
    logger.info(
        "ingest report written",
        extra={"step": STEP, "event": "done", "path": str(target)},
    )
    return target


def _iso(value: object) -> str | None:
    """A ``timestamptz`` as ISO 8601, or ``None`` when the column is null."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _as_document(value: object) -> dict[str, Any]:
    """``ingest_runs.stats`` as a dictionary, whatever the driver handed back."""
    if isinstance(value, str):  # a connection without the jsonb adapter
        value = json.loads(value)
    return dict(value) if isinstance(value, Mapping) else {}


@dataclass(frozen=True, slots=True)
class StoredRun:
    """The newest ``app.ingest_runs`` row, as ``fdp-init report`` prints it.

    ``report`` is the run's ``stats``: the full :class:`IngestReport` of a run
    that succeeded, or the seed :func:`fdp_init.store.begin_ingest` wrote for
    one that is still running or failed — in which case ``error`` says why.
    """

    run_id: int
    document_id: int
    status: str
    started_at: str | None
    finished_at: str | None
    error: str | None
    report: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        """The printed document."""
        return {
            "run_id": self.run_id,
            "document_id": self.document_id,
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
            "report": dict(self.report),
        }


def latest_report(conn: pg8000.native.Connection) -> StoredRun | None:
    """The newest ingest run and its report, for ``fdp-init report``.

    Returns:
        The run, or ``None`` when no ingest has ever been recorded.
    """
    rows = conn.run(SELECT_LATEST)
    if not rows:
        return None
    run_id, document_id, status, started, finished, error, stats = rows[0]
    return StoredRun(
        run_id=int(run_id),
        document_id=int(document_id),
        status=str(status),
        started_at=_iso(started),
        finished_at=_iso(finished),
        error=error,
        report=_as_document(stats),
    )
