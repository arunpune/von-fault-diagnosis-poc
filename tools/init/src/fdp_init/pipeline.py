# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The run sequence, in one place.

:func:`run` is what the ``init`` container executes: wait, migrate, dataset,
embedding pin, model cache, then — unless this exact manual is already stored —
extract, build the catalog, validate it, chunk, embed and store, and finally
write the report. It is fail-fast in that order and the exit code of the step
that failed is the exit code of the process.

:func:`ingest` is the same ingestion without the dependencies around it, for
``fdp-init ingest`` during development and for the integration tests.

Every step logs ``{"step": ..., "event": "start|done|failed",
"elapsed_ms": ...}``, so a run that takes four minutes says where they went;
a skipped ingestion logs ``"event": "skipped"`` with its reason.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pg8000.native
from numpy.typing import NDArray

from fdp_init import INGEST_VERSION
from fdp_init.catalog.deterministic import build_catalog
from fdp_init.catalog.provider import StructureResult, select_structurer
from fdp_init.catalog.validate import ValidationReport, is_fatal, validate_catalog
from fdp_init.chunk.chunker import Chunk, chunk_manual
from fdp_init.config import Settings
from fdp_init.dataset.metropt import DatasetResult, ensure_dataset
from fdp_init.db import connect, register_vectors
from fdp_init.embed import (
    Embedder,
    EmbeddingSpec,
    ModelFiles,
    assert_dimension,
    ensure_model,
    load_spec,
)
from fdp_init.errors import ExitCode, InitError
from fdp_init.manual.extract import TABLE_RECALL_FLOOR, extract_manual
from fdp_init.manual.model import ManualDoc
from fdp_init.migrate import migrate
from fdp_init.report import (
    IngestReport,
    catalog_facts,
    chunk_facts,
    dataset_facts,
    embedding_facts,
    extraction_facts,
    manual_facts,
    skipped_manual_facts,
    write_report,
)
from fdp_init.store import begin_ingest, ingested_already, store_ingest, unresolved_alarm_codes
from fdp_init.util.hashing import sha256_file
from fdp_init.wait import wait_for_mqtt, wait_for_postgres

__all__ = ["ingest", "run"]

STEP = "ingest"

ALREADY_INGESTED = "this manual is already ingested with this embedding pin and ingest version"
SKIP_MANUAL_SET = "INIT_SKIP_MANUAL is set"

logger = logging.getLogger(__name__)


def _timestamp() -> str:
    """ISO 8601 in UTC with milliseconds, the shape the log lines use."""
    return datetime.now(tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True, slots=True)
class _Clock:
    """When something started, on the clock each purpose needs.

    ``wall`` is what goes into ``started_at`` and names the report file;
    ``monotonic`` is what durations are measured against, so a clock
    correction in the middle of a four-minute ingest cannot make one negative.
    """

    wall: str = field(default_factory=_timestamp)
    monotonic: float = field(default_factory=time.monotonic)

    def elapsed_s(self) -> float:
        return round(time.monotonic() - self.monotonic, 3)

    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self.monotonic) * 1000)


@contextmanager
def _step(name: str) -> Iterator[_Clock]:
    """Log ``start``/``done``/``failed`` around one step, with its duration."""
    clock = _Clock()
    logger.info("%s started", name, extra={"step": name, "event": "start"})
    try:
        yield clock
    except Exception:
        logger.error(
            "%s failed",
            name,
            extra={"step": name, "event": "failed", "elapsed_ms": clock.elapsed_ms()},
        )
        raise
    logger.info(
        "%s done", name, extra={"step": name, "event": "done", "elapsed_ms": clock.elapsed_ms()}
    )


@dataclass(frozen=True, slots=True)
class _Run:
    """What every step after the embedding pin needs to know."""

    settings: Settings
    spec: EmbeddingSpec
    dataset: DatasetResult | None
    clock: _Clock


@dataclass(frozen=True, slots=True)
class _Built:
    """Everything extraction produced, ready for transaction B."""

    doc: ManualDoc
    result: StructureResult
    vreport: ValidationReport
    chunks: list[Chunk]
    vectors: NDArray[np.float32]
    embed_elapsed_s: float


def run(settings: Settings) -> int:
    """The whole sequence.

    Args:
        settings: The validated environment contract.

    Returns:
        :attr:`~fdp_init.errors.ExitCode.OK`, including when there was nothing
        to do.

    Raises:
        InitError: with the exit code of the step that failed — 3 for a
            dependency, 4 for a migration, 5 for the dataset, 6 for the manual
            or the catalog, 7 for the model, 8 for a database write, 2 for a
            configuration mistake found on the way. :func:`fdp_init.cli.main`
            logs it and turns it into the process exit code.
    """
    clock = _Clock()
    with _step("wait"):
        wait_for_postgres(settings)
        wait_for_mqtt(settings)

    with closing(connect(settings)) as conn:
        with _step("migrate"):
            migrate(conn, settings.migrations_dir)
        with _step("dataset"):
            dataset = ensure_dataset(settings)
        report = _ingest(conn, _Run(settings, _pin(conn, settings), dataset, clock))

    write_report(report, settings)
    return int(ExitCode.OK)


def ingest(settings: Settings) -> int:
    """Extract, embed and store the manual, and nothing else (``fdp-init ingest``).

    The dependencies are assumed to be up and the schema current, which is what
    makes this useful while developing: the ingest of a re-rendered PDF costs
    the ingest, not the whole sequence.

    Returns:
        :attr:`~fdp_init.errors.ExitCode.OK`.

    Raises:
        InitError: as :func:`run`, minus the codes of the steps it skips.
    """
    clock = _Clock()
    with closing(connect(settings)) as conn:
        report = _ingest(conn, _Run(settings, _pin(conn, settings), None, clock))
    write_report(report, settings)
    return int(ExitCode.OK)


def _pin(conn: pg8000.native.Connection, settings: Settings) -> EmbeddingSpec:
    """Load ``embedding.json`` and prove the schema was built for it.

    The vector adapter is registered here rather than trusted from
    :func:`fdp_init.db.connect`: on a first run the connection was opened before
    ``0001`` created the extension.

    Raises:
        InitError: exit code 2, when the database has no ``vector`` type or
            ``app.chunks.embedding`` has another width than the pin.
    """
    spec = load_spec(settings.contracts_dir)
    if not register_vectors(conn):
        raise InitError(
            ExitCode.CONFIG,
            "the database has no vector type, so app.chunks cannot hold embeddings; "
            "run the migrations first",
            "embed",
        )
    assert_dimension(conn, spec)
    return spec


def _fingerprint(path: Path) -> tuple[str, int]:
    """The SHA-256 and size of ``MANUAL_PATH``, the key of the skip check.

    Raises:
        InitError: exit code 2, when the file is missing or unreadable — a
            configuration mistake, not an extraction failure.
    """
    try:
        return sha256_file(path), path.stat().st_size
    except OSError as error:
        raise InitError(
            ExitCode.CONFIG, f"MANUAL_PATH {path} cannot be read: {error}", "config"
        ) from error


def _ingest(conn: pg8000.native.Connection, context: _Run) -> IngestReport:
    """The ingestion half, from the model cache to the stored report."""
    settings = context.settings
    with _step("model"):
        files = ensure_model(
            context.spec,
            settings.model_cache_dir,
            timeout_s=settings.download_timeout_s,
            retries=settings.download_retries,
        )

    if settings.skip_manual:
        manual = skipped_manual_facts(settings.manual_path, None, None)
        return _skipped(context, manual, SKIP_MANUAL_SET)

    manual_sha, size = _fingerprint(settings.manual_path)
    if not settings.force_ingest and ingested_already(
        conn, manual_sha, context.spec, settings.catalog_mode, INGEST_VERSION
    ):
        manual = skipped_manual_facts(settings.manual_path, manual_sha, size)
        return _skipped(context, manual, ALREADY_INGESTED)

    built = _build(context, files)
    with _step("store"):
        document_id, run_id = begin_ingest(
            conn,
            built.doc,
            context.spec,
            settings.catalog_mode,
            source=built.result.catalog.source,
        )
        # The report is finished before transaction B, because the transaction
        # writes it: `finished_at` is the moment the ingest stopped working,
        # not the moment the commit returned.
        report = _report(context, built)
        store_ingest(
            conn,
            document_id,
            run_id,
            built.result.catalog,
            built.vreport,
            built.chunks,
            built.vectors,
            report,
        )
    return report


def _build(context: _Run, files: ModelFiles) -> _Built:
    """Extract, structure, validate, chunk and embed (exit 6 or 7)."""
    settings, spec = context.settings, context.spec
    with _step("extract"):
        doc = extract_manual(settings.manual_path)

    with _step("catalog"):
        result = select_structurer(settings).structure(doc, build_catalog(doc))

    with _step("validate"):
        vreport = validate_catalog(result.catalog, settings.contracts_dir, doc)
        if is_fatal(vreport):
            raise InitError(ExitCode.MANUAL, _fatal_message(vreport), "catalog")

    with _step("chunk"):
        embedder = Embedder(
            files, spec, batch_size=settings.embed_batch_size, threads=settings.ort_threads
        )
        chunks = chunk_manual(doc, embedder.count_tokens, spec)

    with _step("embed") as clock:
        vectors, _counts = embedder.embed([spec.passage_prefix + chunk.content for chunk in chunks])
    return _Built(doc, result, vreport, chunks, vectors, clock.elapsed_s())


def _skipped(context: _Run, manual: dict[str, Any], reason: str) -> IngestReport:
    """The report of a run that wrote nothing, and why."""
    logger.info(
        "manual ingestion skipped: %s",
        reason,
        extra={"step": STEP, "event": "skipped", "reason": reason, "sha256": manual["sha256"]},
    )
    return IngestReport(
        started_at=context.clock.wall,
        finished_at=_timestamp(),
        elapsed_s=context.clock.elapsed_s(),
        catalog_mode=context.settings.catalog_mode,
        skipped=True,
        manual=manual,
        dataset=dataset_facts(context.dataset),
        warnings=[reason],
    )


def _report(context: _Run, built: _Built) -> IngestReport:
    """The report for an ingest that is about to be stored."""
    catalog = built.result.catalog
    return IngestReport(
        started_at=context.clock.wall,
        finished_at=_timestamp(),
        elapsed_s=context.clock.elapsed_s(),
        catalog_mode=context.settings.catalog_mode,
        skipped=False,
        manual=manual_facts(built.doc),
        extraction=extraction_facts(built.doc.stats),
        catalog=catalog_facts(
            catalog,
            built.result,
            built.vreport,
            built.doc.stats,
            unresolved_alarm_codes(catalog),
        ),
        chunks=chunk_facts(built.chunks),
        embedding=embedding_facts(context.spec, built.embed_elapsed_s),
        dataset=dataset_facts(context.dataset),
        warnings=_warnings(built),
    )


def _warnings(built: _Built) -> list[str]:
    """What a reader of the report should look at, one sentence each."""
    warnings = list(built.vreport.warnings)
    if built.result.fallback_reason:
        warnings.append(
            f"the catalog structurer fell back to the tables: {built.result.fallback_reason}"
        )
    recall = built.doc.stats.table_recall_estimate
    if recall < TABLE_RECALL_FLOOR:
        warnings.append(
            f"the troubleshooting tables recovered {recall:.0%} of the fault ids the text prints"
        )
    return warnings


def _fatal_message(vreport: ValidationReport) -> str:
    """One line naming why the catalog cannot be stored."""
    if vreport.structural_errors:
        return f"the catalog is structurally invalid: {'; '.join(vreport.structural_errors)}"
    return (
        f"{vreport.invalid_share:.0%} of the {vreport.entry_count} catalog entries "
        "do not validate against the contracts"
    )
