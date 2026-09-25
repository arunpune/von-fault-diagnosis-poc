# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The ingest report: its shape, its file, its secrets.

The report is written to three places — the log, ``app.ingest_runs.stats`` and
``INIT_REPORT_DIR`` — and read back by ``fdp-init report``. These tests pin the
key order and the section builders, the rules for when a file is written, and
that no key material reaches any of the three even with an LLM configured
(secrets via the environment only).
"""

from __future__ import annotations

import json
import logging
import os
import stat
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from fdp_init import INGEST_VERSION, __version__
from fdp_init.catalog.model import Alarm, Catalog, Cause, Condition, Section
from fdp_init.catalog.provider import StructureResult
from fdp_init.catalog.validate import ValidationReport
from fdp_init.chunk.chunker import Chunk
from fdp_init.config import Settings
from fdp_init.dataset.metropt import DatasetResult
from fdp_init.embed.spec import EmbeddingSpec, load_spec
from fdp_init.logging import configure_logging
from fdp_init.manual.model import ExtractStats, ManualDoc
from fdp_init.report import (
    EVENT,
    IngestReport,
    StoredRun,
    catalog_facts,
    chunk_facts,
    dataset_facts,
    embedding_facts,
    extraction_facts,
    latest_report,
    manual_facts,
    report_filename,
    skipped_manual_facts,
    write_report,
)

pytestmark = pytest.mark.unit

Env = Callable[..., dict[str, str]]

VENDORED_CONTRACTS = Path(__file__).resolve().parents[1] / "fixtures" / "contracts"

FAKE_KEY = "sk-ant-test-0123456789abcdefREPORT"
"""Shaped like a real key so the redaction patterns would recognise it."""

FAKE_PASSWORD = "report-test-password-42"

SECTION_ORDER = [
    "init_version",
    "ingest_version",
    "catalog_mode",
    "started_at",
    "finished_at",
    "elapsed_s",
    "skipped",
    "manual",
    "extraction",
    "catalog",
    "chunks",
    "embedding",
    "dataset",
    "warnings",
]
"""The key order of the report document."""


@pytest.fixture(scope="module")
def spec() -> EmbeddingSpec:
    return load_spec(VENDORED_CONTRACTS)


@pytest.fixture(autouse=True)
def _restore_logging() -> Iterator[None]:
    """``configure_logging`` installs handlers; hand the root logger back."""
    root = logging.getLogger()
    handlers, level = list(root.handlers), root.level
    yield
    root.handlers = handlers
    root.setLevel(level)


def make_doc() -> ManualDoc:
    return ManualDoc(
        path=Path("/data/manual/cau-7-realistic.pdf"),
        sha256="cd" * 32,
        bytes=4_096,
        page_count=6,
        title="CAU-7 operator manual",
        variant="realistic",
        headings=[],
        blocks=[],
        tables=[],
        furniture=[],
        full_text="",
        stats=make_stats(),
    )


def make_stats() -> ExtractStats:
    return ExtractStats(
        pages=6,
        headings_by_level={1: 5, 2: 2},
        rows_without_fault_id=1,
        fault_ids_in_text=8,
        fault_ids_in_tables=7,
    )


def make_cause(fault_id: str, codes: list[str]) -> Cause:
    return Cause(
        fault_id=fault_id,
        title=fault_id,
        description="",
        subsystem="oil",
        benign=False,
        checks=[],
        remedy="",
        remedy_steps=[],
        signal_moves=[],
        alarm_codes=codes,
        manual_section="8.2.3",
        page_start=4,
        page_end=4,
        ordinal=0,
    )


def make_catalog() -> Catalog:
    shared = make_cause("oil_cooler_fouled", ["W104"])
    return Catalog(
        conditions=[
            Condition(
                "oil_temperature_high",
                "Oil temperature high",
                "",
                [],
                "8.2.3",
                4,
                4,
                [shared, make_cause("oil_filter_clogged", ["W104", "W999"])],
            ),
            Condition("frequent_cycling", "Starts too often", "", [], "8.2.2", 3, 3, [shared]),
        ],
        alarms=[Alarm("W104", "warning", "Oil hot", "", 95.0, "°C", 30, None, None, "3")],
        sections=[Section("8", "Problem solving", 1, None, 3, 5)],
    )


def make_chunks() -> list[Chunk]:
    def chunk(ordinal: int, kind: str, tokens: int, *, truncated: bool = False) -> Chunk:
        return Chunk(
            ordinal, kind, "8", "Problem solving", 3, 3, "body", tokens, truncated=truncated
        )

    return [
        chunk(0, "text", 120),
        chunk(1, "list", 40),
        chunk(2, "table", 60),
        chunk(3, "table", 248, truncated=True),
    ]


def make_dataset() -> DatasetResult:
    return DatasetResult(
        path=Path("/data/metropt3/header.csv"),
        sha256="ef" * 32,
        status="verified",
        source="existing",
        bytes=120,
        elapsed_s=0.01234,
    )


def full_report(spec: EmbeddingSpec, result: StructureResult | None = None) -> IngestReport:
    catalog = make_catalog()
    chosen = result or StructureResult(catalog=catalog, source="tables")
    return IngestReport(
        started_at="2026-09-22T10:15:30.123Z",
        finished_at="2026-09-22T10:16:02.456Z",
        elapsed_s=32.333,
        catalog_mode="tables",
        skipped=False,
        manual=manual_facts(make_doc()),
        extraction=extraction_facts(make_stats()),
        catalog=catalog_facts(
            catalog,
            chosen,
            ValidationReport(entry_count=2, id_pattern_warnings=["fault_id X"]),
            make_stats(),
            ["W999"],
        ),
        chunks=chunk_facts(make_chunks()),
        embedding=embedding_facts(spec, 1.23456),
        dataset=dataset_facts(make_dataset()),
        warnings=["one thing to look at"],
    )


# shape -----------------------------------------------------------------------


def test_to_dict_carries_the_sections_of_13_in_order(spec: EmbeddingSpec) -> None:
    document = full_report(spec).to_dict()

    assert list(document) == SECTION_ORDER
    assert document["init_version"] == __version__
    assert document["ingest_version"] == INGEST_VERSION
    assert document["manual"] == {
        "path": "/data/manual/cau-7-realistic.pdf",
        "sha256": "cd" * 32,
        "bytes": 4_096,
        "pages": 6,
        "variant": "realistic",
        "title": "CAU-7 operator manual",
    }
    assert document["warnings"] == ["one thing to look at"]
    json.dumps(document)  # every value is JSON as it stands


def test_a_skipped_report_leaves_what_was_never_computed_null() -> None:
    report = IngestReport(
        started_at="2026-09-22T10:15:30.123Z",
        finished_at="2026-09-22T10:15:30.456Z",
        elapsed_s=0.333,
        catalog_mode="tables",
        skipped=True,
        manual=skipped_manual_facts(Path("/data/manual/cau-7-clean.pdf"), "ab" * 32, 99),
    )

    document = report.to_dict()

    assert list(document) == SECTION_ORDER
    assert document["skipped"] is True
    assert {key: document[key] for key in ("extraction", "catalog", "chunks", "embedding")} == {
        "extraction": None,
        "catalog": None,
        "chunks": None,
        "embedding": None,
    }
    assert document["manual"] == {
        "path": "/data/manual/cau-7-clean.pdf",
        "sha256": "ab" * 32,
        "bytes": 99,
        "pages": None,
        "variant": "clean",
        "title": None,
    }


def test_the_catalog_section_counts_causes_once_and_occurrences_separately(
    spec: EmbeddingSpec,
) -> None:
    catalog = full_report(spec).to_dict()["catalog"]

    assert catalog == {
        "source": "tables",
        "fallback_reason": None,
        "conditions": 2,
        "causes": 2,
        "cause_rows": 3,
        "alarms": 1,
        "signals": 0,
        "sections": 1,
        "fault_ids": ["oil_cooler_fouled", "oil_filter_clogged"],
        "rows_without_fault_id": 1,
        "invalid_entries": [],
        "id_pattern_warnings": ["fault_id X"],
        "unresolved_alarm_codes": ["W999"],
        "llm": None,
    }


def test_the_llm_section_keeps_only_the_model_and_the_token_counts(spec: EmbeddingSpec) -> None:
    result = StructureResult(
        catalog=make_catalog(),
        source="llm",
        usage={
            "model": "claude-opus-5",
            "input_tokens": 1_200,
            "output_tokens": 800,
            "request_id": "req_should_not_travel",
        },
    )

    catalog = full_report(spec, result).to_dict()["catalog"]

    assert catalog["llm"] == {"model": "claude-opus-5", "input_tokens": 1_200, "output_tokens": 800}


def test_the_chunk_section_counts_kinds_truncations_and_token_spread() -> None:
    assert chunk_facts(make_chunks()) == {
        "total": 4,
        "text": 1,
        "list": 1,
        "table": 2,
        "truncated_rows": 1,
        "tokens_p50": 90,
        "tokens_max": 248,
    }
    assert chunk_facts([]) == {
        "total": 0,
        "text": 0,
        "list": 0,
        "table": 0,
        "truncated_rows": 0,
        "tokens_p50": 0,
        "tokens_max": 0,
    }


def test_the_embedding_section_names_the_whole_pin(spec: EmbeddingSpec) -> None:
    assert embedding_facts(spec, 1.23456) == {
        "model_id": spec.model_id,
        "revision": spec.revision,
        "dimension": spec.dimension,
        "pooling": spec.pooling,
        "max_tokens": spec.max_tokens,
        "key": spec.key,
        "elapsed_s": 1.235,
    }


def test_the_extraction_section_is_json_with_the_recall_estimate() -> None:
    facts = extraction_facts(make_stats())

    assert facts["headings_by_level"] == {"1": 5, "2": 2}
    assert facts["table_recall_estimate"] == 0.875
    assert facts["rows_without_fault_id"] == 1


def test_the_dataset_section_is_null_when_the_step_did_not_run() -> None:
    assert dataset_facts(None) is None
    assert dataset_facts(make_dataset()) == {
        "path": "/data/metropt3/header.csv",
        "sha256": "ef" * 32,
        "status": "verified",
        "source": "existing",
        "bytes": 120,
        "elapsed_s": 0.012,
    }


def test_the_file_name_is_the_start_instant_without_separators(spec: EmbeddingSpec) -> None:
    assert report_filename(full_report(spec)) == "init-ingest-20260922T101530123Z.json"


# write_report ----------------------------------------------------------------


def settings_with_report_dir(env: Env, directory: Path, **extra: str) -> Settings:
    return Settings.from_env(env(INIT_REPORT_DIR=str(directory), **extra))


def test_the_report_is_written_when_the_directory_exists(
    env: Env, tmp_path: Path, spec: EmbeddingSpec
) -> None:
    directory = tmp_path / "reports"
    directory.mkdir()
    report = full_report(spec)

    written = write_report(report, settings_with_report_dir(env, directory))

    assert written == directory / "init-ingest-20260922T101530123Z.json"
    assert json.loads(written.read_text(encoding="utf-8")) == report.to_dict()


def test_no_file_and_no_directory_when_it_does_not_exist(
    env: Env, tmp_path: Path, spec: EmbeddingSpec
) -> None:
    directory = tmp_path / "absent"

    assert write_report(full_report(spec), settings_with_report_dir(env, directory)) is None
    assert not directory.exists()


@pytest.mark.skipif(os.name != "posix" or os.geteuid() == 0, reason="root ignores the mode bits")
def test_no_file_when_the_directory_is_read_only(
    env: Env, tmp_path: Path, spec: EmbeddingSpec
) -> None:
    directory = tmp_path / "readonly"
    directory.mkdir()
    directory.chmod(stat.S_IRUSR | stat.S_IXUSR)
    try:
        assert write_report(full_report(spec), settings_with_report_dir(env, directory)) is None
        assert list(directory.iterdir()) == []
    finally:
        directory.chmod(stat.S_IRWXU)


def test_a_write_error_is_a_warning_not_a_failure(
    env: Env,
    tmp_path: Path,
    spec: EmbeddingSpec,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    directory = tmp_path / "reports"
    directory.mkdir()

    def refuse(self: Path, *args: Any, **kwargs: Any) -> int:
        raise OSError("disk full")

    monkeypatch.setattr(Path, "write_text", refuse)

    with caplog.at_level(logging.WARNING, logger="fdp_init.report"):
        assert write_report(full_report(spec), settings_with_report_dir(env, directory)) is None

    assert "disk full" in caplog.text


def test_the_report_is_logged_as_one_ingest_report_event(
    env: Env,
    tmp_path: Path,
    spec: EmbeddingSpec,
    caplog: pytest.LogCaptureFixture,
) -> None:
    report = full_report(spec)

    with caplog.at_level(logging.INFO, logger="fdp_init.report"):
        write_report(report, settings_with_report_dir(env, tmp_path / "absent"))

    (record,) = [one for one in caplog.records if getattr(one, "event", None) == EVENT]
    assert json.loads(record.__dict__["report"]) == report.to_dict()
    assert record.__dict__["step"] == "report"


def test_no_key_material_reaches_the_report_its_file_or_its_log(
    env: Env,
    tmp_path: Path,
    spec: EmbeddingSpec,
    capsys: pytest.CaptureFixture[str],
) -> None:
    directory = tmp_path / "reports"
    directory.mkdir()
    settings = settings_with_report_dir(
        env,
        directory,
        LLM_PROVIDER="anthropic",
        LLM_API_KEY=FAKE_KEY,
        POSTGRES_PASSWORD=FAKE_PASSWORD,
        LOG_FORMAT="json",
    )
    configure_logging(settings)
    assert settings.catalog_mode == "llm"
    result = StructureResult(
        catalog=make_catalog(),
        source="tables",
        fallback_reason="auth",
        usage={"model": "claude-opus-5", "input_tokens": 1, "output_tokens": 0},
    )
    report = full_report(spec, result)

    written = write_report(report, settings)

    assert written is not None
    stored = json.dumps(report.to_dict())
    printed = capsys.readouterr().out
    assert EVENT in printed
    for secret in (FAKE_KEY, FAKE_PASSWORD):
        assert secret not in stored
        assert secret not in written.read_text(encoding="utf-8")
        assert secret not in printed


# latest_report ---------------------------------------------------------------


class RowsConnection:
    """Answers the one ``SELECT`` of :func:`latest_report` with fixed rows."""

    def __init__(self, rows: list[list[Any]]) -> None:
        self.rows = rows
        self.sql: list[str] = []

    def run(self, sql: str, **params: Any) -> list[list[Any]]:
        assert not params
        self.sql.append(sql)
        return self.rows


def test_latest_report_reads_the_newest_run() -> None:
    started = datetime(2026, 9, 22, 10, 15, 30, tzinfo=UTC)
    finished = datetime(2026, 9, 22, 10, 16, 2, tzinfo=UTC)
    conn = RowsConnection([[4, 2, "succeeded", started, finished, None, {"skipped": False}]])

    stored = latest_report(conn)

    assert stored == StoredRun(
        run_id=4,
        document_id=2,
        status="succeeded",
        started_at="2026-09-22T10:15:30+00:00",
        finished_at="2026-09-22T10:16:02+00:00",
        error=None,
        report={"skipped": False},
    )
    assert "ORDER BY started_wall_ts DESC, id DESC" in conn.sql[0]
    assert list(stored.to_dict()) == [
        "run_id",
        "document_id",
        "status",
        "started_at",
        "finished_at",
        "error",
        "report",
    ]


def test_latest_report_keeps_the_error_of_a_failed_run() -> None:
    started = datetime(2026, 9, 22, 10, 15, 30, tzinfo=UTC)
    seed = json.dumps({"catalog_mode": "tables", "ingest_version": INGEST_VERSION})
    conn = RowsConnection([[5, 3, "failed", started, None, "storing the ingest failed", seed]])

    stored = latest_report(conn)

    assert stored is not None
    assert (stored.status, stored.finished_at) == ("failed", None)
    assert stored.error == "storing the ingest failed"
    assert stored.report == {"catalog_mode": "tables", "ingest_version": INGEST_VERSION}


def test_latest_report_is_none_before_the_first_ingest() -> None:
    assert latest_report(RowsConnection([])) is None
