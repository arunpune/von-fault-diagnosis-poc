# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Storage without a database: what ``store.py`` sends, and in which order.

A fake connection records every ``run(sql, **params)`` call and answers
``RETURNING id`` with increasing ids, so the tests read the transaction
boundaries, the parameter shapes, the chunk batches and the failure path of
the store straight off the recording. The same statements against
a real pgvector server are the integration suite's job
(``tests/integration/test_ingest_pipeline.py``).
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass, field, replace
from itertools import count
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from numpy.typing import NDArray

from fdp_init import INGEST_VERSION
from fdp_init.catalog.model import (
    SOURCE_TABLES,
    Alarm,
    Catalog,
    Cause,
    Condition,
    Section,
    Signal,
    SignalMove,
)
from fdp_init.catalog.validate import ValidationReport
from fdp_init.chunk.chunker import Chunk
from fdp_init.embed.spec import EmbeddingSpec, load_spec, spec_path
from fdp_init.errors import ExitCode, InitError
from fdp_init.manual.model import ExtractStats, ManualDoc
from fdp_init.store import (
    CHUNK_BATCH_SIZE,
    CHUNK_COLUMNS,
    begin_ingest,
    chunk_statement,
    ingested_already,
    store_ingest,
    unresolved_alarm_codes,
)

pytestmark = pytest.mark.unit

ROOT = Path(__file__).resolve().parents[4]
CONTRACTS = ROOT / "packages" / "contracts"
VENDORED_CONTRACTS = Path(__file__).resolve().parents[1] / "fixtures" / "contracts"

SHA = "ab" * 32

_TARGET = re.compile(r"^\s*(?:INSERT INTO|DELETE FROM|UPDATE|SELECT 1\s+FROM)\s+(app\.\w+)")


class InjectedError(Exception):
    """What the fake raises when a test asks a statement to fail."""


@dataclass(frozen=True, slots=True)
class Call:
    sql: str
    params: dict[str, Any]

    @property
    def target(self) -> str:
        """``BEGIN``/``COMMIT``/``ROLLBACK``, or the verb and table written."""
        stripped = self.sql.strip()
        if stripped in {"BEGIN", "COMMIT", "ROLLBACK"}:
            return stripped
        match = _TARGET.match(self.sql)
        assert match is not None, f"unrecognised statement: {self.sql!r}"
        verb = stripped.split()[0]
        return f"{verb} {match.group(1)}"


@dataclass
class FakeConnection:
    """Records statements; fails the ones that contain ``fail_on``."""

    fail_on: tuple[str, ...] = ()
    rows: list[list[Any]] = field(default_factory=list)
    calls: list[Call] = field(default_factory=list)
    _ids: Iterator[int] = field(default_factory=lambda: count(1))

    def run(self, sql: str, **params: Any) -> list[list[Any]]:
        self.calls.append(Call(sql, params))
        if any(fragment in sql for fragment in self.fail_on):
            raise InjectedError(f"injected failure on {sql.split(maxsplit=1)[0]}")
        if "RETURNING id" in sql:
            return [[next(self._ids)]]
        if sql.lstrip().startswith("SELECT"):
            return self.rows
        return []

    @property
    def targets(self) -> list[str]:
        return [call.target for call in self.calls]

    def of(self, target: str) -> list[Call]:
        return [call for call in self.calls if call.target == target]


@dataclass(frozen=True, slots=True)
class StubReport:
    """The one method storage needs of an ingest report."""

    document: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return dict(self.document)


@pytest.fixture(scope="module")
def spec() -> EmbeddingSpec:
    directory = CONTRACTS if spec_path(CONTRACTS).is_file() else VENDORED_CONTRACTS
    return load_spec(directory)


def make_doc() -> ManualDoc:
    return ManualDoc(
        path=Path("/data/manual/cau-7-clean.pdf"),
        sha256=SHA,
        bytes=12_345,
        page_count=6,
        title="CAU-7 operator manual",
        variant="clean",
        headings=[],
        blocks=[],
        tables=[],
        furniture=["page # of #"],
        full_text="",
        stats=ExtractStats(pages=6, headings_by_level={1: 2, 2: 3}, rows_recovered=8),
    )


def make_cause(fault_id: str, **overrides: Any) -> Cause:
    values: dict[str, Any] = {
        "fault_id": fault_id,
        "title": fault_id.replace("_", " ").capitalize(),
        "description": f"What {fault_id} does.",
        "subsystem": "oil",
        "benign": False,
        "checks": ["Check one.", "Check two."],
        "remedy": "Do the thing.",
        "remedy_steps": ["Do the thing."],
        "signal_moves": [SignalMove("oil_temperature", "rises", onset="gradual", text="T1 rises.")],
        "alarm_codes": ["W104"],
        "manual_section": "8.2.3",
        "page_start": 4,
        "page_end": 4,
        "ordinal": 0,
    }
    values.update(overrides)
    return Cause(**values)


def make_catalog() -> Catalog:
    """Two conditions sharing one cause, one undeclared alarm code."""
    leak = make_cause("downstream_air_leak", alarm_codes=["W101", "W999"], subsystem="distribution")
    return Catalog(
        source=SOURCE_TABLES,
        conditions=[
            Condition(
                condition_id="low_line_pressure",
                title="Line pressure below setpoint",
                description="The line pressure stays low.",
                symptoms=["Tools run slowly."],
                manual_section="8.2.1",
                page_start=3,
                page_end=3,
                causes=[
                    leak,
                    make_cause(
                        "intake_filter_clogged",
                        ordinal=1,
                        signal_moves=[SignalMove("load_cycle_rate", "higher", is_behaviour=True)],
                    ),
                ],
            ),
            Condition(
                condition_id="frequent_cycling",
                title="Compressor starts and loads too often",
                description="",
                symptoms=[],
                manual_section="8.2.2",
                page_start=3,
                page_end=4,
                causes=[replace(leak, description="Seen here as short load cycles.", ordinal=0)],
            ),
        ],
        alarms=[
            Alarm(
                "W101",
                "warning",
                "Line pressure low",
                "P2 below 6 bar",
                6.0,
                "bar",
                10,
                None,
                None,
                "3",
            ),
            Alarm(
                "W104",
                "warning",
                "Oil temperature high",
                "T1 above 95 °C",
                95.0,
                "°C",
                30,
                "auto",
                3,
                "3",
            ),
        ],
        signals=[
            Signal(
                "oil_temperature",
                "Oil temperature",
                "°C",
                "analog",
                "Oil_temperature",
                0.0,
                120.0,
                {"loaded": [70.0, 85.0]},
                "9",
                panel_label="T1",
                subsystem="oil",
            ),
            Signal("compressor_state", "Compressor state", "", "state", None, None, None, {}, "9"),
        ],
        sections=[
            Section("8", "Problem solving", 1, None, 3, 5),
            Section("8.2", "Troubleshooting", 2, "8", 3, 5),
        ],
    )


def make_chunks(total: int) -> list[Chunk]:
    return [
        Chunk(
            ordinal=index,
            kind="table" if index % 2 else "text",
            section_ref="8.2.3",
            section_title="Oil temperature high",
            page_start=4,
            page_end=4,
            content=f"chunk body {index}",
            tokens=10 + index,
            fault_id="oil_cooler_fouled" if index % 2 else None,
            table_kind="troubleshooting" if index % 2 else None,
        )
        for index in range(total)
    ]


def make_vectors(total: int, dimension: int = 4) -> NDArray[np.float32]:
    return np.arange(total * dimension, dtype=np.float32).reshape(total, dimension)


def store(
    conn: FakeConnection,
    catalog: Catalog | None = None,
    chunks: list[Chunk] | None = None,
    vectors: NDArray[np.float32] | None = None,
    report: StubReport | None = None,
) -> None:
    chosen = make_chunks(3) if chunks is None else chunks
    store_ingest(
        conn,
        7,
        11,
        catalog or make_catalog(),
        ValidationReport(entry_count=2),
        chosen,
        make_vectors(len(chosen)) if vectors is None else vectors,
        report or StubReport({"skipped": False}),
    )


# ingested_already ------------------------------------------------------------


def test_ingested_already_binds_every_part_of_the_idempotency_key(spec: EmbeddingSpec) -> None:
    conn = FakeConnection(rows=[[1]])

    assert ingested_already(conn, SHA, spec, "tables", INGEST_VERSION)

    (call,) = conn.calls
    assert call.target == "SELECT app.manual_documents"
    assert call.params == {
        "sha256": SHA,
        "model_id": spec.model_id,
        "revision": spec.revision,
        "dimension": spec.dimension,
        "embedding_key": spec.key,
        "catalog_mode": "tables",
        # ->> yields text, so the version is compared as text.
        "ingest_version": str(INGEST_VERSION),
    }
    assert "latest.status = 'succeeded'" in call.sql
    assert "ORDER BY run.started_wall_ts DESC, run.id DESC" in call.sql


def test_ingested_already_is_false_without_a_matching_run(spec: EmbeddingSpec) -> None:
    assert not ingested_already(FakeConnection(), SHA, spec, "llm")


# begin_ingest ----------------------------------------------------------------


def test_begin_ingest_is_one_short_transaction(spec: EmbeddingSpec) -> None:
    conn = FakeConnection()

    ids = begin_ingest(conn, make_doc(), spec, "tables")

    assert ids == (1, 2)
    assert conn.targets == [
        "BEGIN",
        "DELETE app.manual_documents",
        "INSERT app.manual_documents",
        "INSERT app.ingest_runs",
        "COMMIT",
    ]
    delete, document, run = conn.calls[1:4]
    assert delete.params == {"sha256": SHA}
    assert {key: document.params[key] for key in document.params if key != "meta"} == {
        "name": "cau-7-clean.pdf",
        "path": "/data/manual/cau-7-clean.pdf",
        "variant": "clean",
        "sha256": SHA,
        "bytes": 12_345,
        "pages": 6,
    }
    meta = json.loads(document.params["meta"])
    assert meta["title"] == "CAU-7 operator manual"
    assert meta["furniture"] == ["page # of #"]
    assert meta["extract_stats"]["rows_recovered"] == 8
    assert meta["extract_stats"]["headings_by_level"] == {"1": 2, "2": 3}
    assert "'running'" in run.sql
    assert {key: run.params[key] for key in run.params if key != "stats"} == {
        "document_id": 1,
        "model_id": spec.model_id,
        "revision": spec.revision,
        "dimension": spec.dimension,
        "catalog_source": "tables",
    }
    assert json.loads(run.params["stats"]) == {
        "catalog_mode": "tables",
        "ingest_version": INGEST_VERSION,
    }


def test_begin_ingest_stores_the_source_the_structurer_used(spec: EmbeddingSpec) -> None:
    conn = FakeConnection()

    begin_ingest(conn, make_doc(), spec, "llm", source="tables")

    (run,) = conn.of("INSERT app.ingest_runs")
    assert run.params["catalog_source"] == "tables"
    assert json.loads(run.params["stats"])["catalog_mode"] == "llm"


def test_begin_ingest_rolls_back_and_exits_8_when_the_run_cannot_be_opened(
    spec: EmbeddingSpec,
) -> None:
    conn = FakeConnection(fail_on=("INSERT INTO app.ingest_runs",))

    with pytest.raises(InitError) as raised:
        begin_ingest(conn, make_doc(), spec, "tables")

    assert raised.value.exit_code is ExitCode.DB_WRITE
    assert conn.targets[-1] == "ROLLBACK"
    assert "COMMIT" not in conn.targets


# store_ingest: order and shapes ----------------------------------------------


def _phase(target: str) -> str:
    """Fold the per-cause child rows into the phase that writes them."""
    children = {
        "INSERT app.catalog_checks",
        "INSERT app.catalog_remedies",
        "INSERT app.catalog_signal_moves",
    }
    return "INSERT app.catalog_causes" if target in children else target


def test_store_ingest_writes_in_the_order_of_12_1_inside_one_transaction() -> None:
    conn = FakeConnection()

    store(conn)

    phases: list[str] = []
    for target in map(_phase, conn.targets):
        if not phases or phases[-1] != target:
            phases.append(target)
    assert phases == [
        "BEGIN",
        "INSERT app.catalog_sections",
        "INSERT app.catalog_conditions",
        "INSERT app.catalog_causes",
        "INSERT app.catalog_condition_causes",
        "INSERT app.catalog_alarms",
        "INSERT app.catalog_signals",
        "INSERT app.chunks",
        "UPDATE app.ingest_runs",
        "DELETE app.manual_documents",
        "COMMIT",
    ]
    (succeeded,) = conn.of("UPDATE app.ingest_runs")
    assert "status = 'succeeded'" in succeeded.sql
    assert "finished_wall_ts = now()" in succeeded.sql
    (delete,) = conn.of("DELETE app.manual_documents")
    assert "id <> :document_id" in delete.sql
    assert delete.params == {"document_id": 7}


def test_the_report_becomes_the_stats_of_the_succeeded_run() -> None:
    conn = FakeConnection()
    report = StubReport({"skipped": False, "catalog_mode": "tables", "chunks": {"total": 3}})

    store(conn, report=report)

    (succeeded,) = conn.of("UPDATE app.ingest_runs")
    assert succeeded.params["run_id"] == 11
    assert json.loads(succeeded.params["stats"]) == report.to_dict()


def test_a_shared_cause_is_stored_once_and_linked_to_each_condition() -> None:
    conn = FakeConnection()

    store(conn)

    causes = conn.of("INSERT app.catalog_causes")
    assert [call.params["fault_id"] for call in causes] == [
        "downstream_air_leak",
        "intake_filter_clogged",
    ]
    leak = causes[0].params
    assert leak["summary"] == "What downstream_air_leak does."
    assert leak["subsystem"] == "distribution"
    assert leak["manual_section"] == "8.2.3"
    assert leak["source"] == "tables"
    links = conn.of("INSERT app.catalog_condition_causes")
    assert [(call.params["condition_pk"], call.params["cause_pk"]) for call in links] == [
        (1, 3),  # low_line_pressure -> downstream_air_leak
        (2, 3),  # frequent_cycling  -> downstream_air_leak, the same row
        (1, 4),  # low_line_pressure -> intake_filter_clogged
    ]
    assert [call.params["note"] for call in links] == [
        None,
        "Seen here as short load cycles.",
        None,
    ]
    assert {call.params["likelihood"] for call in links} == {"unknown"}
    # Checks, remedies and moves hang off the cause row, once per fault id.
    assert len(conn.of("INSERT app.catalog_checks")) == 4
    assert len(conn.of("INSERT app.catalog_remedies")) == 2
    assert [call.params["ordinal"] for call in conn.of("INSERT app.catalog_checks")] == [1, 2, 1, 2]


def test_undeclared_alarm_codes_stay_out_of_the_tables() -> None:
    conn = FakeConnection()
    catalog = make_catalog()

    store(conn, catalog=catalog)

    leak = conn.of("INSERT app.catalog_causes")[0].params
    assert leak["related_alarms"] == ["W101"]
    conditions = conn.of("INSERT app.catalog_conditions")
    assert conditions[0].params["alarm_codes"] == ["W101", "W104"]
    assert unresolved_alarm_codes(catalog) == ["W999"]


def test_conditions_carry_their_symptoms_and_the_tags_their_causes_move() -> None:
    conn = FakeConnection()

    store(conn)

    first, second = (call.params for call in conn.of("INSERT app.catalog_conditions"))
    assert first["symptoms"] == ["Tools run slowly."]
    assert first["symptom"] == "The line pressure stays low."
    # load_cycle_rate is a behaviour, not a tag of the SIGNALS table.
    assert first["signals"] == ["oil_temperature"]
    assert second["symptom"] is None
    assert second["symptoms"] == []


def test_a_signal_move_names_exactly_one_target_and_gets_the_schema_defaults() -> None:
    conn = FakeConnection()

    store(conn)

    tag, behaviour = (call.params for call in conn.of("INSERT app.catalog_signal_moves"))
    assert (tag["signal_id"], tag["behaviour"]) == ("oil_temperature", None)
    assert (tag["onset"], tag["phase"], tag["text"]) == ("gradual", "any", "T1 rises.")
    assert (behaviour["signal_id"], behaviour["behaviour"]) == (None, "load_cycle_rate")
    assert (behaviour["onset"], behaviour["phase"], behaviour["text"]) == ("sustained", "any", None)


def test_signals_are_grouped_by_their_printed_kind() -> None:
    conn = FakeConnection()

    store(conn)

    oil, state = (call.params for call in conn.of("INSERT app.catalog_signals"))
    assert (oil["group"], oil["kind"], oil["panel_label"]) == ("analog", "analog", "T1")
    assert (oil["name"], oil["description"]) == ("Oil temperature", "Oil temperature")
    assert json.loads(oil["normal_bands"]) == {"loaded": [70.0, 85.0]}
    assert (state["group"], state["unit"], state["panel_label"]) == ("extra", None, None)


def test_alarms_keep_their_code_and_type_verbatim() -> None:
    conn = FakeConnection()

    store(conn)

    codes = [
        (call.params["code"], call.params["type"]) for call in conn.of("INSERT app.catalog_alarms")
    ]
    assert codes == [("W101", "warning"), ("W104", "warning")]


# store_ingest: chunk batches -------------------------------------------------


def _rows_in(call: Call) -> int:
    return sum(1 for key in call.params if key.startswith("ordinal_"))


def test_chunks_go_in_batches_of_200_with_one_vector_per_row() -> None:
    conn = FakeConnection()
    total = 2 * CHUNK_BATCH_SIZE + 50
    vectors = make_vectors(total)

    store(conn, chunks=make_chunks(total), vectors=vectors)

    batches = conn.of("INSERT app.chunks")
    assert [_rows_in(call) for call in batches] == [CHUNK_BATCH_SIZE, CHUNK_BATCH_SIZE, 50]
    last = batches[-1].params
    assert last["document_id"] == 7
    assert last["ordinal_0"] == 2 * CHUNK_BATCH_SIZE
    assert isinstance(last["embedding_49"], np.ndarray)
    np.testing.assert_array_equal(last["embedding_49"], vectors[total - 1])
    assert (last["fault_id_1"], last["table_kind_1"]) == ("oil_cooler_fouled", "troubleshooting")
    assert (last["fault_id_0"], last["alarm_code_0"], last["table_kind_0"]) == (None, None, None)
    assert len(last) == 1 + 50 * len(CHUNK_COLUMNS)


def test_chunk_statement_has_one_placeholder_per_cell() -> None:
    sql = chunk_statement(2)

    assert sql.startswith("INSERT INTO app.chunks (document_id, ordinal, section_ref,")
    placeholders = re.findall(r":(\w+)", sql)
    assert placeholders.count("document_id") == 2
    assert sorted(set(placeholders) - {"document_id"}) == sorted(
        f"{column}_{index}" for column in CHUNK_COLUMNS for index in range(2)
    )


def test_no_value_of_the_manual_is_ever_part_of_the_sql_text() -> None:
    conn = FakeConnection()
    chunks = make_chunks(3)

    store(conn, chunks=chunks)
    begin_ingest(conn, make_doc(), load_spec(VENDORED_CONTRACTS), "tables")

    values = [
        "downstream_air_leak",
        "Line pressure below setpoint",
        "Oil temperature high",
        "What downstream_air_leak does.",
        "CAU-7 operator manual",
        SHA,
        *(chunk.content for chunk in chunks),
    ]
    for call in conn.calls:
        for value in values:
            assert value not in call.sql


# store_ingest: the failure path ----------------------------------------------


def test_a_failure_rolls_back_and_marks_the_run_failed_in_autocommit() -> None:
    conn = FakeConnection(fail_on=("INSERT INTO app.chunks",))

    with pytest.raises(InitError) as raised:
        store(conn)

    assert raised.value.exit_code is ExitCode.DB_WRITE
    assert "injected failure" in raised.value.message
    targets = conn.targets
    assert targets[-2:] == ["ROLLBACK", "UPDATE app.ingest_runs"]
    assert "COMMIT" not in targets
    assert "DELETE app.manual_documents" not in targets
    failed = conn.calls[-1]
    assert "status = 'failed'" in failed.sql
    assert "finished_wall_ts = now()" in failed.sql
    assert failed.params["run_id"] == 11
    assert "injected failure" in failed.params["error"]


def test_mismatched_vectors_mark_the_run_failed_before_anything_is_written() -> None:
    conn = FakeConnection()

    with pytest.raises(InitError) as raised:
        store(conn, chunks=make_chunks(3), vectors=make_vectors(2))

    assert raised.value.exit_code is ExitCode.DB_WRITE
    assert conn.targets == ["UPDATE app.ingest_runs"]
    assert "3 chunks but 2 vectors" in conn.calls[0].params["error"]


def test_a_broken_connection_does_not_replace_the_original_error() -> None:
    conn = FakeConnection(fail_on=("INSERT INTO app.catalog_sections", "status = 'failed'"))

    with pytest.raises(InitError) as raised:
        store(conn)

    assert raised.value.exit_code is ExitCode.DB_WRITE
    assert "injected failure on INSERT" in raised.value.message
    assert conn.targets[-2:] == ["ROLLBACK", "UPDATE app.ingest_runs"]


def test_the_stored_error_text_is_bounded() -> None:
    class Loud(FakeConnection):
        def run(self, sql: str, **params: Any) -> list[list[Any]]:
            if "INSERT INTO app.catalog_signals" in sql:
                self.calls.append(Call(sql, params))
                raise InjectedError("x" * 10_000)
            return super().run(sql, **params)

    conn = Loud()

    with pytest.raises(InitError):
        store(conn)

    assert len(conn.calls[-1].params["error"]) == 2000
