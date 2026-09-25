# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The whole init pipeline, in-process, against pgvector and Mosquitto.

Every test gets its own database on the session's pgvector server, the real
``db/migrations`` (``0001`` to ``0008``), the session's
Mosquitto for the readiness wait, a header-only MetroPT-3 CSV listed in a
temporary ``SHA256SUMS``, one of the mini-manual PDFs and the real embedding
model from the shared cache — and drives it through :func:`fdp_init.cli.main`,
so what is asserted is what ``fdp-init run``, ``ingest`` and ``report`` do,
exit codes included:

* a first run fills every ``app`` table with the counts ``expected.json`` and
  the golden chunk list give, and ``app.v_catalog_entries`` validates against
  the ``catalog-entry`` contract;
* a second run is skipped and changes no row; ``INIT_FORCE_INGEST=1`` and a
  different manual replace the document atomically; a failure inside
  transaction B leaves the previous manual active and a failed run behind;
* a domain query finds the oil-temperature condition by vector search;
* a vector column of another width than the pin exits 2.

Run with ``uv run --package fdp-init pytest -m integration
tools/init/tests/integration/test_ingest_pipeline.py``. A cold model cache
skips unless ``FDP_REQUIRE_MODEL=1`` (or ``EMBEDDER_ALLOW_DOWNLOAD=1``) allows
the 91 MB download, exactly as the unit tests of the embedder do.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

from fdp_init import INGEST_VERSION, cli, store
from fdp_init.catalog.validate import load_registry
from fdp_init.dataset.metropt import METROPT_HEADER
from fdp_init.db import register_vectors
from fdp_init.embed import Embedder, EmbeddingSpec, ensure_model, load_spec
from fdp_init.embed.model_cache import file_path
from fdp_init.embed.spec import spec_path
from fdp_init.errors import ExitCode
from fdp_init.migrate import migrate

from .conftest import ADMIN_PASSWORD, ADMIN_USER, ROOT, FreshDatabase, PostgresStack

pytestmark = pytest.mark.integration

MIGRATIONS = ROOT / "db" / "migrations"
FIXTURES = ROOT / "tools" / "init" / "tests" / "fixtures"
MINI_MANUAL = FIXTURES / "mini-manual"
CONTRACTS = ROOT / "packages" / "contracts"
VENDORED_CONTRACTS = FIXTURES / "contracts"
DEFAULT_CACHE_DIR = ROOT / "data" / "models"

EXPECTED: dict[str, Any] = json.loads((MINI_MANUAL / "expected.json").read_text(encoding="utf-8"))

CSV_NAME = "metropt3-header-only.csv"
"""Not the canonical name, so the dataset step verifies it and never downloads."""

QUERY = "oil temperature rises during load"
OIL_CONDITION = "oil_temperature_high"

TABLES = (
    "manual_documents",
    "ingest_runs",
    "catalog_sections",
    "catalog_conditions",
    "catalog_causes",
    "catalog_condition_causes",
    "catalog_checks",
    "catalog_remedies",
    "catalog_signal_moves",
    "catalog_alarms",
    "catalog_signals",
    "chunks",
)
"""Every table init writes."""

CONTENT_TABLES = TABLES[2:]
"""The tables transaction B fills: the catalog and the chunks."""

CHUNK_FIELDS = (
    "ordinal",
    "kind",
    "section_ref",
    "section_title",
    "page_start",
    "page_end",
    "content",
    "tokens",
    "fault_id",
    "alarm_code",
    "table_kind",
)

SETTINGS_VARIABLES = (
    "INIT_ROOT_DIR",
    "POSTGRES_HOST",
    "POSTGRES_PORT",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "MQTT_URL",
    "METROPT_CSV",
    "METROPT_URL",
    "METROPT_FALLBACK_URL",
    "SHA256SUMS_PATH",
    "MANUAL_PATH",
    "MODEL_CACHE_DIR",
    "CONTRACTS_DIR",
    "MIGRATIONS_DIR",
    "LLM_PROVIDER",
    "LLM_API_KEY",
    "LLM_MODEL",
    "INIT_WAIT_TIMEOUT_S",
    "INIT_DOWNLOAD_TIMEOUT_S",
    "INIT_DOWNLOAD_RETRIES",
    "INIT_FORCE_INGEST",
    "INIT_SKIP_DATASET",
    "INIT_SKIP_MANUAL",
    "INIT_REPORT_DIR",
    "INIT_EMBED_BATCH_SIZE",
    "INIT_ORT_THREADS",
    "INIT_LLM_TIMEOUT_S",
    "CATALOG_FAULT_ID_PATTERN",
    "CATALOG_CONDITION_ID_PATTERN",
    "CATALOG_ALARM_CODE_PATTERN",
    "LOG_LEVEL",
    "LOG_FORMAT",
)
"""Everything :meth:`Settings.from_env` reads; cleared so the host shell cannot
leak an ``LLM_API_KEY`` or an ``INIT_FORCE_INGEST`` into a test."""

_TRUE = frozenset({"1", "true", "yes", "on"})

needs_con_03 = pytest.mark.skipif(
    not (MIGRATIONS / "0003_manual_chunks.sql").is_file()
    or not (MIGRATIONS / "0004_catalog.sql").is_file(),
    reason="db/migrations/0003_manual_chunks.sql and 0004_catalog.sql are absent",
)


def _switch(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in _TRUE


def contracts_dir() -> Path:
    """The real contracts package, or the vendored copy when it is absent."""
    return CONTRACTS if spec_path(CONTRACTS).is_file() else VENDORED_CONTRACTS


def cache_dir() -> Path:
    """``MODEL_CACHE_DIR``, or the gitignored development default."""
    configured = os.environ.get("MODEL_CACHE_DIR", "").strip()
    return Path(configured) if configured else DEFAULT_CACHE_DIR


def manual(variant: str) -> Path:
    return MINI_MANUAL / f"mini-manual-{variant}.pdf"


def golden(variant: str) -> list[dict[str, Any]]:
    document: list[dict[str, Any]] = json.loads(
        (MINI_MANUAL / "golden" / f"chunks-{variant}.json").read_text(encoding="utf-8")
    )
    return document


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def quiet(_line: str) -> None:
    """Swallow the runner's log lines; the migration suites check them."""


# fixtures ---------------------------------------------------------------------


@pytest.fixture(scope="module")
def spec() -> EmbeddingSpec:
    return load_spec(contracts_dir())


@pytest.fixture(scope="module")
def model_cache(spec: EmbeddingSpec) -> Path:
    """The shared cache, warm; a cold one skips unless downloading is allowed."""
    cache = cache_dir()
    cached = all(file_path(spec, cache, entry).is_file() for entry in spec.files)
    if not cached and not (_switch("FDP_REQUIRE_MODEL") or _switch("EMBEDDER_ALLOW_DOWNLOAD")):
        pytest.skip(
            f"the embedding model is not cached in {cache}; set FDP_REQUIRE_MODEL=1 to download it"
        )
    ensure_model(spec, cache)
    return cache


@pytest.fixture(scope="module")
def embedder(spec: EmbeddingSpec, model_cache: Path) -> Embedder:
    return Embedder(ensure_model(spec, model_cache), spec, threads=1)


@pytest.fixture(autouse=True)
def _restore_logging() -> Iterator[None]:
    """``cli.main`` configures logging; hand the root logger back untouched."""
    root = logging.getLogger()
    handlers, level = list(root.handlers), root.level
    yield
    root.handlers = handlers
    root.setLevel(level)


@dataclass(frozen=True, slots=True)
class Init:
    """One database, one data directory, and the CLI pointed at both."""

    db: FreshDatabase
    root: Path
    report_dir: Path

    @property
    def conn(self) -> Any:
        return self.db.admin

    def main(self, command: str = "run", **overrides: str) -> int:
        """Run ``fdp-init <command>`` in-process with ``overrides`` on top."""
        with pytest.MonkeyPatch.context() as patch:
            for name, value in overrides.items():
                patch.setenv(name, value)
            return cli.main([command])

    def reports(self) -> list[dict[str, Any]]:
        """The report files, oldest first."""
        return [
            json.loads(path.read_text(encoding="utf-8"))
            for path in sorted(self.report_dir.glob("init-ingest-*.json"))
        ]


def _write_dataset(root: Path) -> tuple[Path, Path]:
    """A header-only CSV and a ``SHA256SUMS`` that lists it."""
    csv = root / "data" / "metropt3" / CSV_NAME
    csv.parent.mkdir(parents=True)
    csv.write_text(METROPT_HEADER + "\n", encoding="utf-8")
    sums = root / "data" / "SHA256SUMS"
    sums.write_text(f"{sha256_of(csv)}  {CSV_NAME}\n", encoding="utf-8")
    return csv, sums


@pytest.fixture
def init(
    fresh_db: FreshDatabase,
    postgres: PostgresStack,
    mosquitto: tuple[str, int],
    model_cache: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Init:
    """The environment, pointed at this test's world."""
    csv, sums = _write_dataset(tmp_path)
    report_dir = tmp_path / "reports"
    report_dir.mkdir()
    for name in SETTINGS_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    host, port = mosquitto
    environment = {
        "INIT_ROOT_DIR": str(tmp_path),
        "POSTGRES_HOST": postgres.host,
        "POSTGRES_PORT": str(postgres.port),
        "POSTGRES_USER": ADMIN_USER,
        "POSTGRES_PASSWORD": ADMIN_PASSWORD,
        "POSTGRES_DB": fresh_db.name,
        "MQTT_URL": f"mqtt://{host}:{port}",
        "METROPT_CSV": str(csv),
        "SHA256SUMS_PATH": str(sums),
        "MANUAL_PATH": str(manual("clean")),
        "MODEL_CACHE_DIR": str(model_cache),
        "CONTRACTS_DIR": str(contracts_dir()),
        "MIGRATIONS_DIR": str(MIGRATIONS),
        "INIT_REPORT_DIR": str(report_dir),
        "INIT_WAIT_TIMEOUT_S": "30",
        "INIT_ORT_THREADS": "2",
        "LOG_FORMAT": "json",
    }
    for name, value in environment.items():
        monkeypatch.setenv(name, value)
    return Init(db=fresh_db, root=tmp_path, report_dir=report_dir)


# reading the database back ---------------------------------------------------


def scalar(conn: Any, sql: str, **params: object) -> Any:
    return conn.run(sql, **params)[0][0]


def counts(conn: Any) -> dict[str, int]:
    return {table: int(scalar(conn, f"SELECT count(*) FROM app.{table}")) for table in TABLES}


def snapshot(conn: Any) -> dict[str, list[list[Any]]]:
    """Every primary key init wrote, plus the run rows' status and finish time."""
    rows: dict[str, list[list[Any]]] = {}
    for table in TABLES:
        key = "condition_pk, cause_pk" if table == "catalog_condition_causes" else "id"
        rows[table] = [
            list(row) for row in conn.run(f"SELECT {key} FROM app.{table} ORDER BY {key}")
        ]
    rows["runs"] = [
        list(row)
        for row in conn.run("SELECT id, status, finished_wall_ts FROM app.ingest_runs ORDER BY id")
    ]
    return rows


def _first_occurrences() -> dict[str, dict[str, Any]]:
    """The expected causes, one per fault id, from the condition printed first."""
    first: dict[str, dict[str, Any]] = {}
    for condition in EXPECTED["catalog"]["conditions"]:
        for cause in condition["causes"]:
            first.setdefault(cause["fault_id"], cause)
    return first


def expected_counts(variant: str) -> dict[str, int]:
    """What one stored manual puts in each table, from the fixture's own record."""
    totals = EXPECTED["counts"]
    first = _first_occurrences()
    return {
        "manual_documents": 1,
        "ingest_runs": 1,
        "catalog_sections": len(EXPECTED["variants"][variant]["headings"]),
        "catalog_conditions": totals["conditions"],
        "catalog_causes": totals["causes"],
        "catalog_condition_causes": totals["cause_rows"],
        "catalog_checks": sum(cause["checks_count"] for cause in first.values()),
        "catalog_signal_moves": sum(len(cause["signal_moves"]) for cause in first.values()),
        "catalog_alarms": totals["alarms"],
        "catalog_signals": totals["signals"],
        "chunks": len(golden(variant)),
    }


def assert_stored(conn: Any, variant: str) -> None:
    """One active document holding exactly what the fixture records for ``variant``."""
    found = counts(conn)
    remedies = found.pop("catalog_remedies")
    assert found == expected_counts(variant)
    assert remedies >= EXPECTED["counts"]["causes"], "every cause prints at least one remedy step"
    (document,) = conn.run("SELECT sha256, variant, name FROM app.manual_documents")
    assert document == [sha256_of(manual(variant)), variant, manual(variant).name]


def stored_stats(conn: Any) -> dict[str, Any]:
    """The report of the single succeeded run."""
    ((status, stats),) = conn.run("SELECT status, stats FROM app.ingest_runs")
    assert status == "succeeded"
    assert isinstance(stats, dict)
    return stats


# the first run ---------------------------------------------------------------


@needs_con_03
def test_a_first_run_fills_every_app_table_with_the_fixture_counts(init: Init) -> None:
    assert init.main("run") == ExitCode.OK

    assert_stored(init.conn, "clean")
    kinds = dict(init.conn.run("SELECT kind, count(*) FROM app.chunks GROUP BY kind"))
    assert kinds == EXPECTED["variants"]["clean"]["chunks"]
    fault_ids = {row[0] for row in init.conn.run("SELECT fault_id FROM app.catalog_causes")}
    assert fault_ids == set(_first_occurrences())
    ((status, source, finished, error),) = init.conn.run(
        "SELECT status, catalog_source, finished_wall_ts, error FROM app.ingest_runs"
    )
    assert (status, source, error) == ("succeeded", "tables", None)
    assert finished is not None


@needs_con_03
def test_the_stored_chunks_are_the_golden_chunks_with_a_vector_each(
    init: Init, spec: EmbeddingSpec
) -> None:
    assert init.main("run") == ExitCode.OK

    columns = ", ".join(CHUNK_FIELDS)
    rows = init.conn.run(f"SELECT {columns} FROM app.chunks ORDER BY ordinal")
    stored = [dict(zip(CHUNK_FIELDS, row, strict=True)) for row in rows]
    expected = [{name: chunk[name] for name in CHUNK_FIELDS} for chunk in golden("clean")]
    assert stored == expected
    dimensions = init.conn.run(
        "SELECT DISTINCT vector_dims(embedding) FROM app.chunks WHERE embedding IS NOT NULL"
    )
    assert dimensions == [[spec.dimension]]
    assert scalar(init.conn, "SELECT count(*) FROM app.chunks WHERE embedding IS NULL") == 0


@needs_con_03
def test_every_catalog_entry_row_validates_against_the_contract(init: Init) -> None:
    assert init.main("run") == ExitCode.OK

    directory = contracts_dir()
    schema = json.loads(
        (directory / "schemas" / "v1" / "catalog-entry.schema.json").read_text(encoding="utf-8")
    )
    validator = Draft202012Validator(schema, registry=load_registry(directory))
    entries = dict(
        init.conn.run("SELECT fault_id, entry FROM app.v_catalog_entries ORDER BY fault_id")
    )
    assert set(entries) == set(_first_occurrences())
    for fault_id, entry in entries.items():
        problems = [error.message for error in validator.iter_errors(entry)]
        assert problems == [], f"{fault_id}: {problems}"
    shared = entries["downstream_air_leak"]
    assert [condition["condition_id"] for condition in shared["conditions"]] == [
        "low_line_pressure",
        "frequent_cycling",
    ]
    assert shared["source"] == "tables"
    assert shared["manual_ref"]["section"] == "8.2.1"


@needs_con_03
def test_the_report_is_stored_on_the_run_and_written_to_the_report_dir(
    init: Init, spec: EmbeddingSpec
) -> None:
    assert init.main("run") == ExitCode.OK

    stats = stored_stats(init.conn)
    (written,) = init.reports()
    assert written == stats
    assert stats["skipped"] is False
    assert (stats["catalog_mode"], stats["ingest_version"]) == ("tables", INGEST_VERSION)
    assert stats["manual"]["sha256"] == sha256_of(manual("clean"))
    assert stats["catalog"]["causes"] == EXPECTED["counts"]["causes"]
    assert stats["catalog"]["cause_rows"] == EXPECTED["counts"]["cause_rows"]
    assert stats["chunks"]["total"] == len(golden("clean"))
    assert stats["embedding"]["key"] == spec.key
    assert (stats["dataset"]["status"], stats["dataset"]["source"]) == ("verified", "existing")


@needs_con_03
def test_the_report_subcommand_prints_the_latest_run(
    init: Init, capsys: pytest.CaptureFixture[str]
) -> None:
    assert init.main("run") == ExitCode.OK
    capsys.readouterr()

    assert init.main("report") == ExitCode.OK

    printed = json.loads(capsys.readouterr().out)
    assert printed["status"] == "succeeded"
    assert printed["error"] is None
    assert printed["report"] == stored_stats(init.conn)
    assert printed["document_id"] == scalar(init.conn, "SELECT id FROM app.manual_documents")


# vector search ---------------------------------------------------------------


@needs_con_03
def test_a_domain_query_finds_the_oil_temperature_condition(
    init: Init, embedder: Embedder, spec: EmbeddingSpec
) -> None:
    assert init.main("run") == ExitCode.OK

    ((section,),) = init.conn.run(
        "SELECT manual_section FROM app.catalog_conditions WHERE condition_id = :condition",
        condition=OIL_CONDITION,
    )
    causes = {
        row[0]
        for row in init.conn.run(
            """
            SELECT ca.fault_id
              FROM app.catalog_condition_causes AS link
              JOIN app.catalog_conditions AS co ON co.id = link.condition_pk
              JOIN app.catalog_causes AS ca ON ca.id = link.cause_pk
             WHERE co.condition_id = :condition
            """,
            condition=OIL_CONDITION,
        )
    }
    vectors, _ = embedder.embed([spec.query_prefix + QUERY])
    assert register_vectors(init.conn)

    top = init.conn.run(
        """
        SELECT fault_id, section_ref
          FROM app.chunks
         ORDER BY embedding <=> CAST(:query AS vector), ordinal
         LIMIT 3
        """,
        query=vectors[0],
    )

    assert any(fault_id in causes or ref == section for fault_id, ref in top), (
        f"none of {top} belongs to {OIL_CONDITION} (section {section}, causes {sorted(causes)})"
    )


# idempotency and replacement -------------------------------------------------


@needs_con_03
def test_a_second_run_is_skipped_and_changes_no_row(init: Init) -> None:
    assert init.main("run") == ExitCode.OK
    before = snapshot(init.conn)

    assert init.main("run") == ExitCode.OK

    assert snapshot(init.conn) == before
    first, second = init.reports()
    assert (first["skipped"], second["skipped"]) == (False, True)
    assert second["manual"]["sha256"] == sha256_of(manual("clean"))
    assert second["catalog"] is None


@needs_con_03
def test_force_ingest_replaces_the_document_with_the_same_counts(init: Init) -> None:
    assert init.main("run") == ExitCode.OK
    before = scalar(init.conn, "SELECT id FROM app.manual_documents")

    assert init.main("run", INIT_FORCE_INGEST="1") == ExitCode.OK

    assert_stored(init.conn, "clean")
    assert scalar(init.conn, "SELECT id FROM app.manual_documents") > before
    assert init.reports()[-1]["skipped"] is False


@needs_con_03
def test_a_different_manual_replaces_the_previous_one(init: Init) -> None:
    assert init.main("run") == ExitCode.OK

    assert init.main("run", MANUAL_PATH=str(manual("realistic"))) == ExitCode.OK

    assert_stored(init.conn, "realistic")
    assert sha256_of(manual("realistic")) != sha256_of(manual("clean"))


@needs_con_03
def test_a_failure_while_storing_keeps_the_previous_manual_active(init: Init) -> None:
    assert init.main("run") == ExitCode.OK
    active = snapshot(init.conn)

    def fail(*args: object, **kwargs: object) -> None:
        raise RuntimeError("injected failure while storing the chunks")

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(store, "_store_chunks", fail)
        exit_code = init.main("run", MANUAL_PATH=str(manual("realistic")))

    assert exit_code == ExitCode.DB_WRITE
    documents = init.conn.run(
        """
        SELECT document.sha256, run.status, run.error, run.finished_wall_ts IS NOT NULL
          FROM app.manual_documents AS document
          JOIN app.ingest_runs AS run ON run.document_id = document.id
         ORDER BY document.id
        """
    )
    assert documents[0][:3] == [sha256_of(manual("clean")), "succeeded", None]
    failed_sha, failed_status, failed_error, finished = documents[1]
    assert (failed_sha, failed_status, finished) == (sha256_of(manual("realistic")), "failed", True)
    assert "injected failure while storing the chunks" in failed_error
    assert len(documents) == 2
    # The failed document is an empty shell: transaction B left nothing behind,
    # and the catalog and chunks of the active manual are the rows they were.
    after = snapshot(init.conn)
    assert {table: after[table] for table in CONTENT_TABLES} == {
        table: active[table] for table in CONTENT_TABLES
    }
    for table in ("catalog_sections", "catalog_conditions", "catalog_causes", "chunks"):
        owners = init.conn.run(f"SELECT DISTINCT document_id FROM app.{table}")
        assert owners == active["manual_documents"]

    # The next attempt without the fault replaces both rows.
    assert init.main("run", MANUAL_PATH=str(manual("realistic"))) == ExitCode.OK
    assert_stored(init.conn, "realistic")


# the embedding pin and the single-step sub-command ---------------------------


@needs_con_03
def test_a_vector_column_of_another_width_exits_2(init: Init) -> None:
    migrate(init.conn, MIGRATIONS, log=quiet)
    init.conn.run("ALTER TABLE app.chunks ALTER COLUMN embedding TYPE vector(3)")

    assert init.main("run") == ExitCode.CONFIG

    assert counts(init.conn)["manual_documents"] == 0


@needs_con_03
def test_the_ingest_subcommand_stores_the_manual_on_a_migrated_database(init: Init) -> None:
    migrate(init.conn, MIGRATIONS, log=quiet)

    assert init.main("ingest") == ExitCode.OK

    assert_stored(init.conn, "clean")
    assert stored_stats(init.conn)["dataset"] is None


@needs_con_03
def test_the_ingest_subcommand_on_an_unmigrated_database_exits_2(init: Init) -> None:
    assert init.main("ingest") == ExitCode.CONFIG
