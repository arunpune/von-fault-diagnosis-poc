# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The init image, built from the repository and run the way Compose runs it.

This is the init service's end-to-end test. It
builds ``tools/init/Dockerfile`` from the repository root under a tag of its
own, starts pgvector and Mosquitto on a private Docker network under the
service names Compose gives them (``postgres`` and ``mqtt``), bind-mounts a
temporary ``data/`` laid out like the repository's — the clean mini-manual, a
header-only CSV under the canonical MetroPT-3 name, generated here and never
cut from the dataset, and a ``SHA256SUMS`` that lists it — and runs
the image four times against the same database:

1. the first run exits 0, writes its report to ``/reports`` and fills the
   ``app`` tables with what the fixture records;
2. the second run exits 0 and reports ``skipped`` without writing a row;
3. a run with a dummy ``LLM_API_KEY`` re-ingests in ``llm`` mode and falls
   back to the tables, because the structurer's endpoint refuses the
   connection;
4. a run whose ``SHA256SUMS`` lists the wrong digest exits 5 and leaves the
   stored manual alone.

Neither keyed run lets the key into a log line, a report or a stored run. The
image is checked as well: ``--help``, the baked migrations and contracts, the
environment contract, no ``.env`` anywhere in its filesystem,
no key in its configuration or build history, and the 700 MB budget.

Nothing leaves the machine except the embedding model download of a cold
cache (about 91 MB): the dataset URLs and the structurer's endpoint point at a
closed loopback port. Set ``INIT_TEST_MODEL_CACHE`` to a warm cache directory
(``data/models`` after any model test) to skip the download; it is mounted
read-write, as the ``model-cache`` volume is.

Run with ``uv run --package fdp-init pytest -m e2e tools/init/tests/e2e -q``
(``make test-init-e2e``). Without ``-m e2e`` the module skips, so ``make
test-py`` never builds an image; without Docker it skips as well, unless
``FDP_REQUIRE_DOCKER=1`` turns that into a failure.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import uuid
from collections.abc import Iterator, Sequence
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pg8000.native
import pytest
from testcontainers.core.container import DockerContainer
from testcontainers.core.network import Network

from fdp_init.dataset.metropt import CANONICAL_NAME, METROPT_HEADER
from fdp_init.errors import ExitCode

pytestmark = pytest.mark.e2e

ROOT = Path(__file__).resolve().parents[4]
"""The repository root: ``tools/init/tests/e2e`` is four levels down."""

DOCKERFILE = "tools/init/Dockerfile"
TAG = f"fdp-init:test-{os.getpid()}"
"""A tag per process, so parallel worktrees never remove each other's image."""

LABELS = {"fdp.worktree": ROOT.name, "fdp.suite": "ini-e2e"}
"""Which working copy started a container or network, as the integration
suite labels its own."""

BUILD_TIMEOUT_S = 900.0
RUN_TIMEOUT_S = 300.0
"""Every run exits within five minutes, the model download of a cold cache
included."""
DOCKER_TIMEOUT_S = 60.0
"""Every other docker command: an inspect, a one-line run, a removal."""

IMAGE_SIZE_BUDGET = 700_000_000
"""The image stays under 700 MB."""

PG_IMAGE = os.environ.get("FDP_PG_IMAGE") or "pgvector/pgvector:0.8.6-pg18-trixie"
MQTT_IMAGE = os.environ.get("FDP_MQTT_IMAGE") or "eclipse-mosquitto:2.0.22"
PG_ALIAS = "postgres"
MQTT_ALIAS = "mqtt"
PG_PORT = 5432
MQTT_PORT = 1883

ADMIN_USER = "fdp_admin"
ADMIN_PASSWORD = "fdp_admin"
ADMIN_DB = "fdp"
ROLE_PASSWORDS = {
    "PG_APP_PASSWORD": "app_rw",
    "PG_GT_PASSWORD": "gt_rw",
    "PG_EVAL_PASSWORD": "eval",
}
"""PoC defaults, not secrets."""

ROLES_SCRIPT = ROOT / "infra" / "postgres" / "initdb" / "00-roles.sh"
ROLES_SCRIPT_IN_CONTAINER = "docker-entrypoint-initdb.d/00-roles.sh"
"""Relative to ``/``: the tar archive is unpacked there, so no leading slash."""
MOSQUITTO_CONFIG = ROOT / "infra" / "mosquitto"
MOSQUITTO_FILES = ("mosquitto.conf", "passwd", "acl")
"""The broker configuration of the real stack, which admits the anonymous
CONNECT of init's readiness wait."""

MINI_MANUAL = ROOT / "tools" / "init" / "tests" / "fixtures" / "mini-manual"
MANUAL = MINI_MANUAL / "mini-manual-clean.pdf"
EXPECTED: dict[str, Any] = json.loads((MINI_MANUAL / "expected.json").read_text(encoding="utf-8"))
GOLDEN_CHUNKS: list[dict[str, Any]] = json.loads(
    (MINI_MANUAL / "golden" / "chunks-clean.json").read_text(encoding="utf-8")
)

CLOSED_URL = "http://127.0.0.1:9/"
"""Port 9 on the init container's own loopback: nothing listens there, so a
download or a structuring request is refused at once and nothing is sent."""

WRONG_DIGEST = hashlib.sha256(b"not the header-only dataset").hexdigest()

DUMMY_KEY_TAIL = "e2e-sentinel-4f1c9a7d2b6e8035"
DUMMY_KEY = f"sk-ant-api03-{DUMMY_KEY_TAIL}"
"""Shaped like an Anthropic key so every rule of the redaction filter applies;
it opens nothing."""
KEY_PATTERNS = (re.compile(r"sk-ant-[A-Za-z0-9._\-]+"), re.compile(re.escape(DUMMY_KEY_TAIL)))
"""Any key-shaped token, and the dummy's own tail in case only its prefix were
masked."""

REPORT_GLOB = "init-ingest-*.json"
COUNTED_TABLES = (
    "catalog_conditions",
    "catalog_causes",
    "catalog_alarms",
    "catalog_signals",
    "chunks",
)

ENVIRONMENT = {
    "POSTGRES_HOST": PG_ALIAS,
    "POSTGRES_PORT": str(PG_PORT),
    "POSTGRES_USER": ADMIN_USER,
    "POSTGRES_PASSWORD": ADMIN_PASSWORD,
    "POSTGRES_DB": ADMIN_DB,
    "MQTT_URL": f"mqtt://{MQTT_ALIAS}:{MQTT_PORT}",
    # Relative on purpose: resolved against the image's INIT_ROOT_DIR=/, the
    # rule that makes the README's MANUAL_PATH=data/byo-manual/x.pdf work.
    "MANUAL_PATH": f"data/manual/{MANUAL.name}",
    "INIT_REPORT_DIR": "/reports",
    "METROPT_URL": CLOSED_URL,
    "METROPT_FALLBACK_URL": CLOSED_URL,
    "LOG_LEVEL": "info",
}
"""What the ``init`` service of compose.yaml passes, pointed at this test's
containers. The image's own ENV supplies the rest (INIT_ROOT_DIR, the
migrations, the contracts, the model cache, METROPT_CSV, SHA256SUMS_PATH), so
the image contract is what gets exercised."""

_TRUE = frozenset({"1", "true", "yes", "on"})


def _switch(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in _TRUE


def _docker(
    argv: Sequence[str], *, timeout: float = DOCKER_TIMEOUT_S, cwd: Path | None = None
) -> subprocess.CompletedProcess[str]:
    """Run one docker command with a fixed argv and no shell."""
    return subprocess.run(
        ["docker", *argv], cwd=cwd, capture_output=True, text=True, check=False, timeout=timeout
    )


def _docker_problem() -> str | None:
    """Why this machine cannot run the test, or ``None`` when it can."""
    if shutil.which("docker") is None:
        return "docker is not on PATH"
    if _docker(["info"]).returncode != 0:
        return "no Docker daemon answers"
    return None


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# the host side of the mounts ---------------------------------------------------


@dataclass(frozen=True, slots=True)
class World:
    """The host directories and files one run of the image is given."""

    root: Path
    models: Path

    @property
    def metropt3(self) -> Path:
        return self.root / "data" / "metropt3"

    @property
    def manual(self) -> Path:
        return self.root / "data" / "manual"

    @property
    def sums(self) -> Path:
        return self.root / "data" / "SHA256SUMS"

    @property
    def wrong_sums(self) -> Path:
        return self.root / "data" / "SHA256SUMS.wrong"

    @property
    def reports(self) -> Path:
        return self.root / "reports"

    def writable(self) -> tuple[Path, ...]:
        """The mounts the container writes into as root."""
        return (self.metropt3, self.models, self.reports)


def _build_world(root: Path) -> World:
    """Lay out ``data/`` and ``reports/`` the way the repository has them."""
    world = World(root=root, models=_model_cache(root))
    world.metropt3.mkdir(parents=True)
    csv = world.metropt3 / CANONICAL_NAME
    csv.write_text(METROPT_HEADER + "\n", encoding="utf-8")
    world.manual.mkdir(parents=True)
    shutil.copyfile(MANUAL, world.manual / MANUAL.name)
    world.sums.write_text(f"{_sha256(csv)}  {CANONICAL_NAME}\n", encoding="utf-8")
    world.wrong_sums.write_text(f"{WRONG_DIGEST}  {CANONICAL_NAME}\n", encoding="utf-8")
    world.reports.mkdir()
    return world


def _model_cache(root: Path) -> Path:
    """``INIT_TEST_MODEL_CACHE`` when set, else an empty directory to fill."""
    configured = os.environ.get("INIT_TEST_MODEL_CACHE", "").strip()
    cache = Path(configured).resolve() if configured else root / "models"
    cache.mkdir(parents=True, exist_ok=True)
    return cache


def _hand_back(image: str, world: World) -> None:
    """Give the files the container wrote as root back to the user running the test.

    On a Linux host they would otherwise be root-owned, so pytest could not
    delete them and a developer's model cache would need sudo. Best effort:
    a failure here must not mask the result of the test.
    """
    mounts: list[str] = []
    for index, directory in enumerate(world.writable()):
        mounts += ["-v", f"{directory}:/hand-back/{index}"]
    owner = f"{os.getuid()}:{os.getgid()}"
    _docker(["run", "--rm", *mounts, "--entrypoint", "chown", image, "-R", owner, "/hand-back"])


# the database, read back from the host -----------------------------------------


@dataclass(frozen=True, slots=True)
class Database:
    """The pgvector container, as the host reaches it."""

    host: str
    port: int

    def connect(self) -> Any:
        """An open admin ``pg8000.native.Connection``; the caller closes it."""
        return pg8000.native.Connection(
            ADMIN_USER, host=self.host, port=self.port, database=ADMIN_DB, password=ADMIN_PASSWORD
        )


@dataclass(frozen=True, slots=True)
class Stored:
    """What the database holds after a run: the rows the idempotency rules touch."""

    documents: list[list[Any]]
    runs: list[list[Any]]
    counts: dict[str, int]
    chunks_without_embedding: int


def _stored(database: Database) -> Stored:
    with closing(database.connect()) as conn:
        documents = conn.run(
            "SELECT id, sha256, variant, name FROM app.manual_documents ORDER BY id"
        )
        runs = conn.run(
            "SELECT id, document_id, status, catalog_source, stats->>'catalog_mode'"
            " FROM app.ingest_runs ORDER BY id"
        )
        counts = {
            table: int(conn.run(f"SELECT count(*) FROM app.{table}")[0][0])
            for table in COUNTED_TABLES
        }
        missing = int(conn.run("SELECT count(*) FROM app.chunks WHERE embedding IS NULL")[0][0])
    return Stored(documents=documents, runs=runs, counts=counts, chunks_without_embedding=missing)


def _rows_holding(database: Database, needle: str) -> int:
    """Stored runs whose report or error contains ``needle`` anywhere."""
    with closing(database.connect()) as conn:
        rows = conn.run(
            "SELECT count(*) FROM app.ingest_runs"
            " WHERE strpos(stats::text, :needle) > 0 OR strpos(coalesce(error, ''), :needle) > 0",
            needle=needle,
        )
    return int(rows[0][0])


# one run of the image ------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Run:
    """One ``docker run`` of the image: its exit code, its output, its reports."""

    exit_code: int
    logs: str
    reports: tuple[dict[str, Any], ...]

    def events(self) -> list[dict[str, Any]]:
        """The JSON log lines, parsed; anything else on the output is skipped."""
        parsed: list[dict[str, Any]] = []
        for line in self.logs.splitlines():
            if line.startswith("{"):
                parsed.append(json.loads(line))
        return parsed

    def tail(self, lines: int = 60) -> str:
        """The end of the output, for an assertion message."""
        return "\n".join(self.logs.splitlines()[-lines:])


@dataclass(frozen=True, slots=True)
class Outcome:
    """A run and the database on both sides of it."""

    run: Run
    before: Stored | None
    after: Stored


@dataclass(frozen=True, slots=True)
class Init:
    """The image, the network it joins and the mounts it gets."""

    image: str
    network: Network
    world: World
    database: Database

    def run(self, *, sums: Path | None = None, **overrides: str) -> Run:
        """``docker run`` the image's default command with ``overrides`` on top."""
        before = set(self.world.reports.glob(REPORT_GLOB))
        name = f"fdp-init-e2e-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        argv = [
            "run",
            "--rm",
            "--name",
            name,
            "--network",
            self.network.name,
            *(flag for key, value in LABELS.items() for flag in ("--label", f"{key}={value}")),
            *self._mounts(sums or self.world.sums),
            *(
                flag
                for key, value in {**ENVIRONMENT, **overrides}.items()
                for flag in ("-e", f"{key}={value}")
            ),
            self.image,
        ]
        try:
            completed = _docker(argv, timeout=RUN_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            _docker(["rm", "-f", name])
            pytest.fail(f"the init container did not exit within {RUN_TIMEOUT_S:.0f} s")
        written = sorted(set(self.world.reports.glob(REPORT_GLOB)) - before)
        return Run(
            exit_code=completed.returncode,
            logs=completed.stdout + completed.stderr,
            reports=tuple(json.loads(path.read_text(encoding="utf-8")) for path in written),
        )

    def run_and_read(self, *, first: bool = False, **options: Any) -> Outcome:
        """A run, with the stored rows read before (unless ``first``) and after it."""
        before = None if first else _stored(self.database)
        run = self.run(**options)
        return Outcome(run=run, before=before, after=_stored(self.database))

    def _mounts(self, sums: Path) -> list[str]:
        """The bind mounts of the ``init`` service in compose.yaml."""
        world = self.world
        return [
            "-v",
            f"{world.metropt3}:/data/metropt3",
            "-v",
            f"{world.manual}:/data/manual:ro",
            "-v",
            f"{sums}:/data/SHA256SUMS:ro",
            "-v",
            f"{world.models}:/models",
            "-v",
            f"{world.reports}:/reports",
        ]


# fixtures --------------------------------------------------------------------------


@pytest.fixture(scope="module", autouse=True)
def _selected_and_docker(request: pytest.FixtureRequest) -> None:
    """Skip unless ``-m e2e`` asked for this module and Docker answers."""
    if "e2e" not in str(request.config.getoption("markexpr") or ""):
        pytest.skip("the container end-to-end test builds the init image; run it with -m e2e")
    problem = _docker_problem()
    if problem is None:
        return
    if _switch("FDP_REQUIRE_DOCKER"):
        pytest.fail(f"{problem}, and FDP_REQUIRE_DOCKER=1 requires Docker")
    pytest.skip(problem)


@pytest.fixture(scope="module")
def image() -> Iterator[str]:
    """``docker build -f tools/init/Dockerfile .`` from the root; removed after."""
    built = _docker(["build", "-f", DOCKERFILE, "-t", TAG, "."], cwd=ROOT, timeout=BUILD_TIMEOUT_S)
    assert built.returncode == 0, built.stderr[-4000:]
    try:
        yield TAG
    finally:
        _docker(["rmi", "-f", TAG])


@pytest.fixture(scope="module")
def network() -> Iterator[Network]:
    """A private network, so the containers answer to their Compose names."""
    with Network(docker_network_kw={"labels": LABELS}) as created:
        yield created


@pytest.fixture(scope="module")
def database(network: Network) -> Iterator[Database]:
    """pgvector with the three login roles, reachable as ``postgres`` and from the host.

    Nobody waits for it here: waiting for its dependencies is init's own first
    step, and the host reads the database only after a run has finished.
    """
    container = (
        DockerContainer(PG_IMAGE)
        .with_env("POSTGRES_USER", ADMIN_USER)
        .with_env("POSTGRES_PASSWORD", ADMIN_PASSWORD)
        .with_env("POSTGRES_DB", ADMIN_DB)
        .with_exposed_ports(PG_PORT)
        .with_network(network)
        .with_network_aliases(PG_ALIAS)
        .with_kwargs(labels=LABELS)
        .with_copy_into_container(ROLES_SCRIPT, ROLES_SCRIPT_IN_CONTAINER, mode=0o755)
    )
    for name, value in ROLE_PASSWORDS.items():
        container.with_env(name, value)
    container.start()
    try:
        yield Database(
            host=container.get_container_host_ip(),
            port=int(container.get_exposed_port(PG_PORT)),
        )
    finally:
        container.stop()


@pytest.fixture(scope="module")
def broker(network: Network) -> Iterator[None]:
    """Mosquitto with the stack's configuration, reachable as ``mqtt``."""
    container = (
        DockerContainer(MQTT_IMAGE)
        .with_network(network)
        .with_network_aliases(MQTT_ALIAS)
        .with_kwargs(labels=LABELS)
    )
    for name in MOSQUITTO_FILES:
        container.with_copy_into_container(
            MOSQUITTO_CONFIG / name, f"mosquitto/config/{name}", mode=0o644
        )
    container.start()
    try:
        yield
    finally:
        container.stop()


@pytest.fixture(scope="module")
def init(
    image: str,
    network: Network,
    database: Database,
    broker: None,
    tmp_path_factory: pytest.TempPathFactory,
) -> Iterator[Init]:
    world = _build_world(tmp_path_factory.mktemp("init-e2e"))
    try:
        yield Init(image=image, network=network, world=world, database=database)
    finally:
        _hand_back(image, world)


@pytest.fixture(scope="module")
def first_run(init: Init) -> Outcome:
    return init.run_and_read(first=True)


@pytest.fixture(scope="module")
def second_run(init: Init, first_run: Outcome) -> Outcome:
    return init.run_and_read()


@pytest.fixture(scope="module")
def keyed_run(init: Init, second_run: Outcome) -> Outcome:
    """A configured structurer whose endpoint refuses the connection."""
    return init.run_and_read(LLM_API_KEY=DUMMY_KEY, LLM_BASE_URL=CLOSED_URL)


@pytest.fixture(scope="module")
def wrong_hash_run(init: Init, keyed_run: Outcome) -> Outcome:
    """``SHA256SUMS`` lists another digest; the key is still in the environment.

    The canonical copy is moved aside and fetched again, from a
    closed port, once.
    """
    return init.run_and_read(
        sums=init.world.wrong_sums, INIT_DOWNLOAD_RETRIES="1", LLM_API_KEY=DUMMY_KEY
    )


# the image -------------------------------------------------------------------------


def _inspect(image: str) -> dict[str, Any]:
    inspected = _docker(["image", "inspect", image])
    assert inspected.returncode == 0, inspected.stderr
    (document,) = json.loads(inspected.stdout)
    assert isinstance(document, dict)
    return document


def _in_image(image: str, entrypoint: str, *args: str) -> subprocess.CompletedProcess[str]:
    return _docker(["run", "--rm", "--entrypoint", entrypoint, image, *args])


def test_the_image_answers_help_with_every_sub_command(image: str) -> None:
    shown = _docker(["run", "--rm", image, "--help"])

    assert shown.returncode == 0, shown.stderr
    for command in ("run", "wait", "migrate", "dataset", "model", "ingest", "report"):
        assert re.search(rf"^\s+{command}\s", shown.stdout, re.MULTILINE), command


def test_the_image_bakes_the_migrations_and_the_contracts(image: str) -> None:
    migrations = _in_image(image, "ls", "-1", "/db/migrations")
    schemas = _in_image(image, "ls", "-1", "/contracts/schemas/v1")
    pin = _in_image(image, "cat", "/contracts/embedding.json")

    repo_migrations = sorted(path.name for path in (ROOT / "db" / "migrations").glob("*.sql"))
    assert migrations.stdout.split() == repo_migrations
    repo_schemas = sorted(path.name for path in (ROOT / "packages/contracts/schemas/v1").iterdir())
    assert schemas.stdout.split() == repo_schemas
    assert pin.stdout == (ROOT / "packages" / "contracts" / "embedding.json").read_text("utf-8")


def test_the_image_declares_the_contract_compose_relies_on(image: str) -> None:
    config = _inspect(image)["Config"]
    env = dict(entry.split("=", 1) for entry in config["Env"])

    assert config["Entrypoint"] == ["fdp-init"]
    assert config["Cmd"] == ["run"]
    assert "/models" in config["Volumes"]
    assert config["User"] in ("", "root", "0")
    assert {
        name: env[name]
        for name in (
            "INIT_ROOT_DIR",
            "MIGRATIONS_DIR",
            "CONTRACTS_DIR",
            "MODEL_CACHE_DIR",
            "METROPT_CSV",
            "SHA256SUMS_PATH",
            "PYTHONUNBUFFERED",
        )
    } == {
        "INIT_ROOT_DIR": "/",
        "MIGRATIONS_DIR": "/db/migrations",
        "CONTRACTS_DIR": "/contracts",
        "MODEL_CACHE_DIR": "/models",
        "METROPT_CSV": f"/data/metropt3/{CANONICAL_NAME}",
        "SHA256SUMS_PATH": "/data/SHA256SUMS",
        "PYTHONUNBUFFERED": "1",
    }


def test_the_image_contains_no_env_file(image: str) -> None:
    # A plain `find` for `.env`, plus a sentinel so a shell that never ran cannot pass.
    search = "find / -name .env -not -path '/proc/*' 2>/dev/null; echo searched"
    found = _in_image(image, "sh", "-c", search)

    assert found.stdout.splitlines() == ["searched"]


def test_no_key_is_baked_into_the_image_configuration_or_history(image: str) -> None:
    config = _inspect(image)["Config"]
    history = _docker(["history", "--no-trunc", "--format", "{{.CreatedBy}}", image])

    names = [entry.split("=", 1)[0] for entry in config["Env"]]
    assert [name for name in names if name.endswith(("_API_KEY", "_TOKEN", "_SECRET"))] == []
    assert history.returncode == 0, history.stderr
    assert "API_KEY" not in history.stdout


def test_the_image_fits_its_size_budget(image: str) -> None:
    size = int(_inspect(image)["Size"])

    assert size < IMAGE_SIZE_BUDGET, f"{size / 1e6:.0f} MB"


# the runs --------------------------------------------------------------------------


def test_the_first_run_exits_0_with_a_report_and_the_fixture_rows(first_run: Outcome) -> None:
    run, stored = first_run.run, first_run.after

    assert run.exit_code == ExitCode.OK, run.tail()
    (report,) = run.reports
    assert report["skipped"] is False
    assert report["manual"]["sha256"] == _sha256(MANUAL)
    assert report["catalog"]["source"] == "tables"
    assert report["dataset"]["status"] == "verified"
    assert [row[1:] for row in stored.documents] == [[_sha256(MANUAL), "clean", MANUAL.name]]
    assert [row[2:] for row in stored.runs] == [["succeeded", "tables", "tables"]]
    counts = EXPECTED["counts"]
    assert stored.counts == {
        "catalog_conditions": counts["conditions"],
        "catalog_causes": counts["causes"],
        "catalog_alarms": counts["alarms"],
        "catalog_signals": counts["signals"],
        "chunks": len(GOLDEN_CHUNKS),
    }
    assert stored.chunks_without_embedding == 0


def test_a_second_run_is_skipped_and_writes_no_row(second_run: Outcome) -> None:
    run = second_run.run

    assert run.exit_code == ExitCode.OK, run.tail()
    (report,) = run.reports
    assert report["skipped"] is True
    assert second_run.after == second_run.before


def test_a_structurer_that_cannot_connect_falls_back_to_the_tables(keyed_run: Outcome) -> None:
    run, before, after = keyed_run.run, keyed_run.before, keyed_run.after

    assert run.exit_code == ExitCode.OK, run.tail()
    (report,) = run.reports
    assert report["skipped"] is False
    assert report["catalog_mode"] == "llm"
    assert report["catalog"]["source"] == "tables"
    # Not `sdk_missing`: the image carries the `llm` extra.
    assert report["catalog"]["fallback_reason"] == "connection"
    # Another catalog mode is another ingest: the same manual under a
    # new document row, with the same rows as the tables-mode ingest.
    assert before is not None
    assert [row[1:] for row in after.documents] == [row[1:] for row in before.documents]
    assert after.documents[0][0] != before.documents[0][0]
    assert [row[2:] for row in after.runs] == [["succeeded", "tables", "llm"]]
    assert after.counts == before.counts


def test_a_wrong_dataset_hash_exits_5_and_keeps_the_stored_manual(
    wrong_hash_run: Outcome,
) -> None:
    run = wrong_hash_run.run

    assert run.exit_code == ExitCode.DATASET, run.tail()
    failures = [event for event in run.events() if event.get("event") == "failed"]
    assert {"step": "dataset", "exit_code": int(ExitCode.DATASET)}.items() <= failures[-1].items()
    assert run.reports == ()
    assert wrong_hash_run.after == wrong_hash_run.before


def test_the_key_reaches_no_log_line_report_or_stored_run(
    keyed_run: Outcome, wrong_hash_run: Outcome, init: Init
) -> None:
    for outcome in (keyed_run, wrong_hash_run):
        assert outcome.run.events(), "the run logged nothing, so there is nothing to search"
        texts = [outcome.run.logs, *(json.dumps(report) for report in outcome.run.reports)]
        for pattern in KEY_PATTERNS:
            assert not any(pattern.search(text) for text in texts), pattern.pattern
    assert _rows_holding(init.database, DUMMY_KEY_TAIL) == 0
