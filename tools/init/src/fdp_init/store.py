# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Writing one ingest into the app tables, atomically.

Three entry points, in the order :mod:`fdp_init.pipeline` calls them:

* :func:`ingested_already` answers the idempotency question — this
  PDF, this embedding pin, this catalog mode and this ``INGEST_VERSION`` have
  already been stored by a run that succeeded — so a second ``make up`` writes
  nothing at all.
* :func:`begin_ingest` is transaction A: it drops the row that carries the same
  SHA-256, inserts the document and opens a ``running`` run. It is short on
  purpose, so a crash between A and B leaves a diagnosable pair rather than a
  half-written catalog.
* :func:`store_ingest` is transaction B: the catalog, the chunks, the report
  and the deletion of the previous document, all or nothing. Any failure rolls
  it back, marks the run ``failed`` in autocommit and raises
  :class:`~fdp_init.errors.InitError` with
  :attr:`~fdp_init.errors.ExitCode.DB_WRITE`; the manual that was active before
  the attempt is untouched.

The tables are those of migrations ``0003``/``0004`` plus ``0008``. ``0004``
stores a cause once per document and reaches it from its conditions through
``app.catalog_condition_causes``, so the occurrences the builder yields — one
per (condition, cause) pair, since a cause may explain several conditions —
are folded here the way :func:`fdp_init.catalog.model.entries` folds them: one
cause row from the occurrence printed first, one link row per occurrence.

Every statement is parameterised — ``pg8000`` native binds ``:name`` — and no
value of the manual ever reaches the SQL text. Vectors go in through the
``pgvector`` adapter :func:`fdp_init.db.connect` registers, in batches of
:data:`CHUNK_BATCH_SIZE` rows.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import asdict
from typing import TYPE_CHECKING, Any, Protocol

import numpy as np
import pg8000.native
from numpy.typing import NDArray

from fdp_init import INGEST_VERSION
from fdp_init.catalog.model import (
    DEFAULT_LIKELIHOOD,
    Alarm,
    Catalog,
    Cause,
    Condition,
    Section,
    Signal,
    SignalMove,
)
from fdp_init.chunk.chunker import Chunk
from fdp_init.db import transaction
from fdp_init.embed.spec import EmbeddingSpec
from fdp_init.errors import ExitCode, InitError
from fdp_init.manual.model import ManualDoc

if TYPE_CHECKING:  # pragma: no cover - imported for the annotations only
    from fdp_init.catalog.validate import ValidationReport

Vectors = NDArray[np.float32]
"""``(len(chunks), spec.dimension)``: row ``i`` is the vector of chunk ``i``."""

__all__ = [
    "CHUNK_BATCH_SIZE",
    "CHUNK_COLUMNS",
    "ERROR_TEXT_LIMIT",
    "STEP",
    "ReportDocument",
    "begin_ingest",
    "chunk_statement",
    "ingested_already",
    "store_ingest",
    "unresolved_alarm_codes",
]

STEP = "store"

CHUNK_BATCH_SIZE = 200
"""Chunk rows per ``INSERT``."""

ERROR_TEXT_LIMIT = 2000
"""Characters of a failure kept in ``ingest_runs.error``; a driver traceback is
longer than anything a reader needs."""

_SIGNAL_GROUPS = frozenset({"analog", "digital"})
_EXTRA_GROUP = "extra"
"""``catalog_signals."group"`` accepts ``analog``, ``digital`` and ``extra``."""

logger = logging.getLogger(__name__)


class ReportDocument(Protocol):
    """What :func:`store_ingest` needs of the report: its JSON form.

    :class:`fdp_init.report.IngestReport` is the one implementation; storage
    depends on the shape, not on the module, so the report can grow a section
    without this file noticing.
    """

    def to_dict(self) -> dict[str, Any]:
        """The document ``ingest_runs.stats`` stores."""
        ...


SELECT_INGESTED = """
SELECT 1
  FROM app.manual_documents AS document
  JOIN LATERAL (
         SELECT run.status,
                run.embedding_model_id,
                run.embedding_revision,
                run.embedding_dimension,
                run.stats
           FROM app.ingest_runs AS run
          WHERE run.document_id = document.id
          ORDER BY run.started_wall_ts DESC, run.id DESC
          LIMIT 1
       ) AS latest ON true
 WHERE document.sha256 = :sha256
   AND latest.status = 'succeeded'
   AND latest.embedding_model_id = :model_id
   AND latest.embedding_revision = :revision
   AND latest.embedding_dimension = :dimension
   AND latest.stats->'embedding'->>'key' = :embedding_key
   AND latest.stats->>'catalog_mode' = :catalog_mode
   AND latest.stats->>'ingest_version' = :ingest_version
"""

DELETE_DOCUMENT_BY_SHA = "DELETE FROM app.manual_documents WHERE sha256 = :sha256"

DELETE_OTHER_DOCUMENTS = "DELETE FROM app.manual_documents WHERE id <> :document_id"

INSERT_DOCUMENT = """
INSERT INTO app.manual_documents (name, path, variant, sha256, bytes, pages, meta)
VALUES (:name, :path, :variant, :sha256, :bytes, :pages, CAST(:meta AS jsonb))
RETURNING id
"""

INSERT_RUN = """
INSERT INTO app.ingest_runs (document_id, status, embedding_model_id, embedding_revision,
                             embedding_dimension, catalog_source, stats)
VALUES (:document_id, 'running', :model_id, :revision, :dimension, :catalog_source,
        CAST(:stats AS jsonb))
RETURNING id
"""

UPDATE_RUN_SUCCEEDED = """
UPDATE app.ingest_runs
   SET status = 'succeeded', finished_wall_ts = now(), stats = CAST(:stats AS jsonb)
 WHERE id = :run_id
"""

UPDATE_RUN_FAILED = """
UPDATE app.ingest_runs
   SET status = 'failed', finished_wall_ts = now(), error = :error
 WHERE id = :run_id
"""

INSERT_SECTION = """
INSERT INTO app.catalog_sections (document_id, section_ref, title, level, parent_ref,
                                  page_start, page_end)
VALUES (:document_id, :section_ref, :title, :level, :parent_ref, :page_start, :page_end)
"""

INSERT_CONDITION = """
INSERT INTO app.catalog_conditions (document_id, condition_id, title, symptom, symptoms,
                                    alarm_codes, signals, manual_section, page_start, page_end,
                                    source)
VALUES (:document_id, :condition_id, :title, :symptom, CAST(:symptoms AS text[]),
        CAST(:alarm_codes AS text[]), CAST(:signals AS text[]), :manual_section, :page_start,
        :page_end, :source)
RETURNING id
"""

INSERT_CAUSE = """
INSERT INTO app.catalog_causes (document_id, fault_id, name, summary, subsystem, benign, remedy,
                                related_alarms, manual_section, page, page_start, page_end, source)
VALUES (:document_id, :fault_id, :name, :summary, :subsystem, :benign, :remedy,
        CAST(:related_alarms AS text[]), :manual_section, :page, :page_start, :page_end, :source)
RETURNING id
"""

INSERT_CONDITION_CAUSE = """
INSERT INTO app.catalog_condition_causes (condition_pk, cause_pk, ordinal, likelihood, note)
VALUES (:condition_pk, :cause_pk, :ordinal, :likelihood, :note)
"""

INSERT_CHECK = """
INSERT INTO app.catalog_checks (cause_pk, ordinal, instruction, expected)
VALUES (:cause_pk, :ordinal, :instruction, NULL)
"""

INSERT_REMEDY = """
INSERT INTO app.catalog_remedies (cause_pk, ordinal, action, post_check)
VALUES (:cause_pk, :ordinal, :action, NULL)
"""

INSERT_SIGNAL_MOVE = """
INSERT INTO app.catalog_signal_moves (cause_pk, ordinal, signal_id, behaviour, direction, phase,
                                      onset, note, text)
VALUES (:cause_pk, :ordinal, :signal_id, :behaviour, :direction, :phase, :onset, :note, :text)
"""

INSERT_ALARM = """
INSERT INTO app.catalog_alarms (document_id, code, type, title, trigger_text, threshold,
                                threshold_unit, delay_s, reset_rule, bit, manual_section)
VALUES (:document_id, :code, :type, :title, :trigger_text, :threshold, :threshold_unit, :delay_s,
        :reset_rule, :bit, :manual_section)
"""

INSERT_SIGNAL = """
INSERT INTO app.catalog_signals (document_id, signal_id, panel_label, name, description, unit,
                                 "group", kind, subsystem, metropt_column, range_min, range_max,
                                 normal_bands, manual_section)
VALUES (:document_id, :signal_id, :panel_label, :name, :description, :unit, :group, :kind,
        :subsystem, :metropt_column, :range_min, :range_max, CAST(:normal_bands AS jsonb),
        :manual_section)
"""

CHUNK_COLUMNS = (
    "ordinal",
    "section_ref",
    "section_title",
    "page_start",
    "page_end",
    "kind",
    "content",
    "tokens",
    "embedding",
    "fault_id",
    "alarm_code",
    "table_kind",
)
"""The columns of one ``app.chunks`` row, ``document_id`` excluded."""


def _unique(values: Iterable[str]) -> list[str]:
    """The values in first-seen order, duplicates removed."""
    seen: dict[str, None] = {}
    for value in values:
        seen.setdefault(value, None)
    return list(seen)


def _occurrences(catalog: Catalog) -> dict[str, list[tuple[Condition, Cause]]]:
    """Group the cause occurrences by fault id, in document order.

    The same grouping :func:`fdp_init.catalog.model.entries` uses, because
    ``app.v_catalog_entries`` has to return what the export writes: one row per
    fault id, built from the occurrence the manual prints first, with every
    condition it explains hanging off the link table.
    """
    grouped: dict[str, list[tuple[Condition, Cause]]] = {}
    for condition in catalog.conditions:
        for cause in condition.causes:
            grouped.setdefault(cause.fault_id, []).append((condition, cause))
    return grouped


def unresolved_alarm_codes(catalog: Catalog) -> list[str]:
    """Alarm codes a cause names that no ``ALARMS`` table declares.

    They are reported rather than stored: a code with no alarm row behind it
    would send retrieval looking for a message the manual never prints. The
    ingest report carries them under ``catalog.unresolved_alarm_codes``.
    """
    known = {alarm.code for alarm in catalog.alarms}
    return _unique(
        code for cause in catalog.causes for code in cause.alarm_codes if code not in known
    )


def _known_codes(catalog: Catalog, codes: Iterable[str]) -> list[str]:
    """``codes`` narrowed to the alarms this catalog declares, order kept."""
    known = {alarm.code for alarm in catalog.alarms}
    return [code for code in _unique(codes) if code in known]


def ingested_already(
    conn: pg8000.native.Connection,
    manual_sha: str,
    spec: EmbeddingSpec,
    catalog_mode: str,
    ingest_version: int = INGEST_VERSION,
) -> bool:
    """Whether this exact ingest is already stored.

    Args:
        conn: An open admin connection.
        manual_sha: SHA-256 of ``MANUAL_PATH``.
        spec: The embedding pin. The model id, revision and dimension have to
            match the run's columns, and :attr:`EmbeddingSpec.key` — which adds
            the pooling and the token ceiling —
            the ``embedding.key`` of its stored report.
        catalog_mode: ``tables`` or ``llm``, the mode this run *asks* for.
        ingest_version: :data:`fdp_init.INGEST_VERSION`, bumped whenever
            extraction, chunking, catalog or storage semantics change.

    Returns:
        ``True`` only when a document with this SHA-256 has a latest run that
        succeeded with every one of those values equal. Anything else — no
        document, a failed or running latest run, a different model or a
        bumped version — is ``False`` and the caller re-ingests.
    """
    rows = conn.run(
        SELECT_INGESTED,
        sha256=manual_sha,
        model_id=spec.model_id,
        revision=spec.revision,
        dimension=spec.dimension,
        embedding_key=spec.key,
        catalog_mode=catalog_mode,
        ingest_version=str(ingest_version),
    )
    return bool(rows)


def _returned_id(rows: Sequence[Sequence[Any]]) -> int:
    """The ``RETURNING id`` of a single-row ``INSERT``."""
    return int(rows[0][0])


def begin_ingest(
    conn: pg8000.native.Connection,
    doc: ManualDoc,
    spec: EmbeddingSpec,
    catalog_mode: str,
    *,
    source: str | None = None,
) -> tuple[int, int]:
    """Transaction A: replace the document row, open a run.

    ``DELETE ... WHERE sha256 = :sha256`` first, because ``sha256`` is UNIQUE:
    a forced re-ingest of the same PDF — or a retry after a failed run — has to
    make room for its own row, and the cascade takes the old catalog, chunks
    and runs with it.

    Args:
        conn: An open admin connection.
        doc: The extracted manual.
        spec: The embedding pin stored on the run.
        catalog_mode: The mode this run asked for; it goes into ``stats`` and
            is part of the idempotency key of :func:`ingested_already`.
        source: Where the catalog actually came from, ``tables`` or ``llm``.
            Defaults to ``catalog_mode``; they differ when the structurer was
            configured but fell back.

    Returns:
        ``(document_id, run_id)``.

    Raises:
        InitError: exit code 8, when the transaction cannot be committed.
    """
    meta = {
        "title": doc.title,
        "furniture": list(doc.furniture),
        "extract_stats": asdict(doc.stats),
    }
    seed = {"catalog_mode": catalog_mode, "ingest_version": INGEST_VERSION}
    try:
        with transaction(conn):
            conn.run(DELETE_DOCUMENT_BY_SHA, sha256=doc.sha256)
            document_id = _returned_id(
                conn.run(
                    INSERT_DOCUMENT,
                    name=doc.path.name,
                    path=str(doc.path),
                    variant=doc.variant,
                    sha256=doc.sha256,
                    bytes=doc.bytes,
                    pages=doc.page_count,
                    meta=json.dumps(meta, sort_keys=True),
                )
            )
            run_id = _returned_id(
                conn.run(
                    INSERT_RUN,
                    document_id=document_id,
                    model_id=spec.model_id,
                    revision=spec.revision,
                    dimension=spec.dimension,
                    catalog_source=source or catalog_mode,
                    stats=json.dumps(seed, sort_keys=True),
                )
            )
    except Exception as error:
        raise InitError(
            ExitCode.DB_WRITE, f"the manual document could not be opened for ingest: {error}", STEP
        ) from error

    logger.info(
        "ingest run opened",
        extra={
            "step": STEP,
            "event": "start",
            "document_id": document_id,
            "run_id": run_id,
            "sha256": doc.sha256,
            "catalog_mode": catalog_mode,
        },
    )
    return document_id, run_id


def store_ingest(  # noqa: PLR0913, PLR0917 - one argument per stored part of the ingest
    conn: pg8000.native.Connection,
    document_id: int,
    run_id: int,
    catalog: Catalog,
    vreport: ValidationReport,
    chunks: Sequence[Chunk],
    vectors: Vectors,
    report: ReportDocument,
) -> None:
    """Transaction B: the catalog, the chunks and the report.

    The order is chosen so every foreign key is satisfied as it is written:
    sections, conditions, causes with their checks, remedies and signal moves,
    the condition/cause links, the alarms, the signals, then the chunks in
    batches of :data:`CHUNK_BATCH_SIZE`. The run is marked ``succeeded`` with
    the report as its ``stats`` and every other document is deleted, so exactly
    one manual is active when the transaction commits.

    Args:
        conn: An open admin connection.
        document_id: From :func:`begin_ingest`.
        run_id: From :func:`begin_ingest`.
        catalog: What the structurer returned.
        vreport: The contracts verdict; its findings are already in ``report``
            and it is passed so the stored entry count can be logged.
        chunks: The retrieval units, in ordinal order.
        vectors: ``(len(chunks), spec.dimension)`` float32, row ``i`` belonging
            to ``chunks[i]``.
        report: The finished report, stored as the run's ``stats``.

    Raises:
        InitError: exit code 8. The transaction is rolled back first and the
            run is marked ``failed`` with the message, in autocommit, so the
            previous manual stays active and the failure stays diagnosable.
    """
    try:
        if len(vectors) != len(chunks):
            raise ValueError(f"{len(chunks)} chunks but {len(vectors)} vectors")
        with transaction(conn):
            _store_sections(conn, document_id, catalog.sections)
            condition_pks = _store_conditions(conn, document_id, catalog)
            cause_pks = _store_causes(conn, document_id, catalog)
            _store_links(conn, catalog, condition_pks, cause_pks)
            _store_alarms(conn, document_id, catalog.alarms)
            _store_signals(conn, document_id, catalog.signals)
            _store_chunks(conn, document_id, chunks, vectors)
            conn.run(
                UPDATE_RUN_SUCCEEDED,
                run_id=run_id,
                stats=json.dumps(report.to_dict(), sort_keys=True),
            )
            conn.run(DELETE_OTHER_DOCUMENTS, document_id=document_id)
    except Exception as error:
        message = _mark_failed(conn, run_id, error)
        raise InitError(ExitCode.DB_WRITE, f"storing the ingest failed: {message}", STEP) from error

    logger.info(
        "ingest stored",
        extra={
            "step": STEP,
            "event": "done",
            "document_id": document_id,
            "run_id": run_id,
            "conditions": len(catalog.conditions),
            "causes": len(catalog.fault_ids),
            "cause_rows": len(catalog.causes),
            "alarms": len(catalog.alarms),
            "signals": len(catalog.signals),
            "sections": len(catalog.sections),
            "chunks": len(chunks),
            "entries_validated": vreport.entry_count,
        },
    )


def _mark_failed(conn: pg8000.native.Connection, run_id: int, error: Exception) -> str:
    """Record the failure on the run, outside the rolled-back transaction.

    Returns the message that was stored. A connection that is itself broken
    cannot record anything, and that must not replace the original error, so
    a failure here is logged and the caller raises the first one.
    """
    message = str(error).strip()[:ERROR_TEXT_LIMIT] or error.__class__.__name__
    try:
        conn.run(UPDATE_RUN_FAILED, run_id=run_id, error=message)
    except Exception as secondary:
        logger.warning(
            "the failed run could not be marked failed: %s",
            secondary,
            extra={"step": STEP, "event": "failed", "run_id": run_id},
        )
    return message


def _store_sections(
    conn: pg8000.native.Connection, document_id: int, sections: Sequence[Section]
) -> None:
    """One ``app.catalog_sections`` row per heading."""
    for section in sections:
        conn.run(
            INSERT_SECTION,
            document_id=document_id,
            section_ref=section.section_ref,
            title=section.title,
            level=section.level,
            parent_ref=section.parent_ref,
            page_start=section.page_start,
            page_end=section.page_end,
        )


def _condition_signals(condition: Condition) -> list[str]:
    """The signal tags the causes of this condition move, first-seen order.

    Behaviours are left out: ``catalog_conditions.signals`` names tags of the
    ``SIGNALS`` table, and a behaviour is derived, not measured.
    """
    return _unique(
        move.signal_id
        for cause in condition.causes
        for move in cause.signal_moves
        if not move.is_behaviour
    )


def _store_conditions(
    conn: pg8000.native.Connection, document_id: int, catalog: Catalog
) -> dict[str, int]:
    """Insert the conditions and return ``condition_id -> primary key``."""
    primary_keys: dict[str, int] = {}
    for condition in catalog.conditions:
        primary_keys[condition.condition_id] = _returned_id(
            conn.run(
                INSERT_CONDITION,
                document_id=document_id,
                condition_id=condition.condition_id,
                title=condition.title,
                symptom=condition.description or None,
                symptoms=list(condition.symptoms),
                alarm_codes=_known_codes(catalog, condition.alarm_codes),
                signals=_condition_signals(condition),
                manual_section=condition.manual_section or None,
                page_start=condition.page_start,
                page_end=condition.page_end,
                source=catalog.source,
            )
        )
    return primary_keys


def _store_causes(
    conn: pg8000.native.Connection, document_id: int, catalog: Catalog
) -> dict[str, int]:
    """Insert one row per fault id and return ``fault_id -> primary key``.

    ``app.catalog_causes`` is unique on ``(document_id, fault_id)``, so a cause
    the manual lists under two conditions is stored once, from the occurrence
    it prints first; the wording of the other occurrences survives as the
    ``note`` of its link row. ``related_alarms`` is every declared code any
    occurrence names; the undeclared ones go to the report instead.
    """
    primary_keys: dict[str, int] = {}
    for fault_id, occurrences in _occurrences(catalog).items():
        first = occurrences[0][1]
        cause_pk = _returned_id(
            conn.run(
                INSERT_CAUSE,
                document_id=document_id,
                fault_id=fault_id,
                name=first.title,
                summary=first.description,
                subsystem=first.subsystem,
                benign=first.benign,
                remedy=first.remedy,
                related_alarms=_known_codes(
                    catalog, (code for _, cause in occurrences for code in cause.alarm_codes)
                ),
                manual_section=first.manual_section or None,
                page=first.page_start,
                page_start=first.page_start,
                page_end=first.page_end,
                source=catalog.source,
            )
        )
        primary_keys[fault_id] = cause_pk
        _store_checks(conn, cause_pk, first.checks)
        _store_remedies(conn, cause_pk, first.remedy_steps)
        _store_signal_moves(conn, cause_pk, first.signal_moves)
    return primary_keys


def _store_checks(conn: pg8000.native.Connection, cause_pk: int, checks: Sequence[str]) -> None:
    """The ordered checks of one cause; ``expected`` is not printed."""
    for ordinal, instruction in enumerate(checks, start=1):
        conn.run(INSERT_CHECK, cause_pk=cause_pk, ordinal=ordinal, instruction=instruction)


def _store_remedies(conn: pg8000.native.Connection, cause_pk: int, steps: Sequence[str]) -> None:
    """The ordered remedy steps; ``post_check`` is not printed."""
    for ordinal, action in enumerate(steps, start=1):
        conn.run(INSERT_REMEDY, cause_pk=cause_pk, ordinal=ordinal, action=action)


def _store_signal_moves(
    conn: pg8000.native.Connection, cause_pk: int, moves: Sequence[SignalMove]
) -> None:
    """The movements a cause is expected to produce (``signal_move``).

    The table requires ``phase`` and ``onset``; a move whose sentence names
    neither gets the defaults ``0004`` declares for them, ``any`` and
    ``sustained``.
    """
    for ordinal, move in enumerate(moves, start=1):
        conn.run(
            INSERT_SIGNAL_MOVE,
            cause_pk=cause_pk,
            ordinal=ordinal,
            signal_id=None if move.is_behaviour else move.signal_id,
            behaviour=move.signal_id if move.is_behaviour else None,
            direction=move.direction,
            phase=move.phase or "any",
            onset=move.onset or "sustained",
            note=move.note,
            text=move.text or None,
        )


def _store_links(
    conn: pg8000.native.Connection,
    catalog: Catalog,
    condition_pks: dict[str, int],
    cause_pks: dict[str, int],
) -> None:
    """One ``catalog_condition_causes`` row per occurrence of a cause.

    The note carries the wording of that occurrence when it differs from the
    summary stored on the cause, which is what
    :func:`fdp_init.catalog.model.entries` puts on ``conditions[].note``.
    """
    for fault_id, occurrences in _occurrences(catalog).items():
        summary = occurrences[0][1].description
        for condition, cause in occurrences:
            conn.run(
                INSERT_CONDITION_CAUSE,
                condition_pk=condition_pks[condition.condition_id],
                cause_pk=cause_pks[fault_id],
                ordinal=cause.ordinal,
                likelihood=DEFAULT_LIKELIHOOD,
                note=cause.description if cause.description != summary else None,
            )


def _store_alarms(
    conn: pg8000.native.Connection, document_id: int, alarms: Sequence[Alarm]
) -> None:
    """One ``app.catalog_alarms`` row per controller message."""
    for alarm in alarms:
        conn.run(
            INSERT_ALARM,
            document_id=document_id,
            code=alarm.code,
            type=alarm.kind,
            title=alarm.title,
            trigger_text=alarm.trigger_text or None,
            threshold=alarm.threshold,
            threshold_unit=alarm.threshold_unit,
            delay_s=alarm.delay_s,
            reset_rule=alarm.reset_rule,
            bit=alarm.bit,
            manual_section=alarm.manual_section or None,
        )


def _signal_group(signal: Signal) -> str:
    """``catalog_signals."group"``: the printed kind, or ``extra``."""
    return signal.kind if signal.kind in _SIGNAL_GROUPS else _EXTRA_GROUP


def _store_signals(
    conn: pg8000.native.Connection, document_id: int, signals: Sequence[Signal]
) -> None:
    """One ``app.catalog_signals`` row per tag of the ``SIGNALS`` table.

    The printed description is both the row's ``description`` and its
    ``name``, the field the contracts ``catalog_signal`` calls it by (the
    export of :func:`fdp_init.catalog.model.to_catalog_document` does the same).
    """
    for signal in signals:
        conn.run(
            INSERT_SIGNAL,
            document_id=document_id,
            signal_id=signal.signal_id,
            panel_label=signal.panel_label or None,
            name=signal.description or None,
            description=signal.description or None,
            unit=signal.unit or None,
            group=_signal_group(signal),
            kind=signal.kind or None,
            subsystem=signal.subsystem,
            metropt_column=signal.metropt_column,
            range_min=signal.range_min,
            range_max=signal.range_max,
            normal_bands=json.dumps(signal.normal_bands, sort_keys=True),
            manual_section=signal.manual_section or None,
        )


def chunk_statement(count: int) -> str:
    """The multi-row ``INSERT`` for ``count`` chunks, one placeholder per cell.

    The row index is part of every placeholder name, so a batch is still a
    single parameterised statement: both halves of the text are this module's
    own constants and nothing of the manual is ever concatenated into SQL.
    """
    rows = ", ".join(
        "(:document_id, " + ", ".join(f":{column}_{index}" for column in CHUNK_COLUMNS) + ")"
        for index in range(count)
    )
    columns = ", ".join(("document_id", *CHUNK_COLUMNS))
    return f"INSERT INTO app.chunks ({columns})\nVALUES {rows}"


def _chunk_row(chunk: Chunk, vector: NDArray[np.float32], index: int) -> dict[str, Any]:
    """The parameters of one chunk row, named for its place in the batch."""
    values: dict[str, Any] = {
        "ordinal": chunk.ordinal,
        "section_ref": chunk.section_ref or None,
        "section_title": chunk.section_title or None,
        "page_start": chunk.page_start,
        "page_end": chunk.page_end,
        "kind": chunk.kind,
        "content": chunk.content,
        "tokens": chunk.tokens,
        "embedding": vector,
        "fault_id": chunk.fault_id,
        "alarm_code": chunk.alarm_code,
        "table_kind": chunk.table_kind,
    }
    return {f"{column}_{index}": values[column] for column in CHUNK_COLUMNS}


def _chunk_batches(
    chunks: Sequence[Chunk], vectors: Vectors
) -> Iterator[tuple[str, dict[str, Any]]]:
    """Yield ``(sql, params)`` per batch of :data:`CHUNK_BATCH_SIZE` rows."""
    for start in range(0, len(chunks), CHUNK_BATCH_SIZE):
        batch = chunks[start : start + CHUNK_BATCH_SIZE]
        params: dict[str, Any] = {}
        for index, chunk in enumerate(batch):
            params.update(_chunk_row(chunk, vectors[start + index], index))
        yield chunk_statement(len(batch)), params


def _store_chunks(
    conn: pg8000.native.Connection, document_id: int, chunks: Sequence[Chunk], vectors: Vectors
) -> None:
    """Insert the chunks in batches, vectors through the pgvector adapter."""
    for sql, params in _chunk_batches(chunks, vectors):
        conn.run(sql, document_id=document_id, **params)
