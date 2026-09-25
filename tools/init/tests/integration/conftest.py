# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Containers the init integration tests run against.

One PostgreSQL server per session on a host port Docker chooses, with the
three login roles created by the same ``00-roles.sh`` the real stack uses, and
one database per test created from it. Several worktrees run this suite at the
same time, so nothing is named after a fixed port or a fixed container name and
every container carries an ``fdp.worktree`` label naming the working copy that
started it.

``FDP_PG_IMAGE`` and ``FDP_MQTT_IMAGE`` override the pinned images for a local
experiment; the defaults are what CI runs.
"""

from __future__ import annotations

import os
import socket
import time
from collections.abc import Iterator
from contextlib import suppress
from dataclasses import dataclass
from itertools import count
from pathlib import Path
from typing import Any

import pg8000.native
import pytest
from testcontainers.core.container import DockerContainer

from fdp_init.wait import client_id, connect_packet

ROOT = Path(__file__).resolve().parents[4]
"""The repository root: ``tools/init/tests/integration`` is four levels down."""

FIXTURES = ROOT / "tools" / "init" / "tests" / "fixtures"

PG_IMAGE = os.environ.get("FDP_PG_IMAGE") or "pgvector/pgvector:0.8.6-pg18-trixie"
MQTT_IMAGE = os.environ.get("FDP_MQTT_IMAGE") or "eclipse-mosquitto:2.0.22"

PG_PORT = 5432
MQTT_PORT = 1883

ADMIN_USER = "fdp_admin"
ADMIN_PASSWORD = "fdp_admin"
ADMIN_DB = "fdp"

ROLE_PASSWORDS = {"app_rw": "app_rw", "gt_rw": "gt_rw", "eval": "eval"}
"""PoC defaults, not secrets; the
roles script reads them from ``PG_APP_PASSWORD`` and friends."""

ROLES_SCRIPT_IN_CONTAINER = "docker-entrypoint-initdb.d/00-roles.sh"
"""Relative to ``/``: the tar archive is unpacked there, so no leading slash."""

PG_ISREADY = (
    f"pg_isready --host 127.0.0.1 --port {PG_PORT} --username {ADMIN_USER} --dbname {ADMIN_DB}"
)
"""Run inside the container: over TCP, so the socket-only initdb server does not
count as ready."""

READY_TIMEOUT_S = 120.0
READY_POLL_S = 0.25
CONNECT_TIMEOUT_S = 5.0

MQTT_CONNACK = 0x20
"""First byte of the answer the readiness handshake expects."""

MOSQUITTO_CONFIG_DIR = "mosquitto/config"
MOSQUITTO_FILES = ("mosquitto.conf", "passwd", "acl")
"""``mosquitto.conf`` of the real stack names the other two; the fallback
configuration is a single file and the loop simply finds nothing to copy."""


def _labels(suite: str) -> dict[str, str]:
    """Labels that say which working copy and which suite started a container."""
    return {"fdp.worktree": ROOT.name, "fdp.suite": suite}


@dataclass(frozen=True, slots=True)
class PostgresStack:
    """A running server and the connections it hands out."""

    host: str
    port: int

    def connect(
        self,
        database: str = ADMIN_DB,
        *,
        user: str = ADMIN_USER,
        password: str = ADMIN_PASSWORD,
    ) -> Any:
        """An open ``pg8000.native.Connection``; the caller closes it."""
        return pg8000.native.Connection(
            user,
            host=self.host,
            port=self.port,
            database=database,
            password=password,
            timeout=CONNECT_TIMEOUT_S,
        )


@dataclass(frozen=True, slots=True)
class FreshDatabase:
    """One empty database, with the admin connection a test migrates through."""

    name: str
    admin: Any
    stack: PostgresStack
    opened: list[Any]
    """Every connection handed out, closed by the fixture that built this."""

    def connect_as(self, role: str) -> Any:
        """A connection to this database as one of the three login roles.

        The returned connection is closed by the ``fresh_db`` fixture, so a
        test that only wants to assert a privilege need not track it.
        """
        connection = self.stack.connect(self.name, user=role, password=ROLE_PASSWORDS[role])
        self.opened.append(connection)
        return connection


def _close(connection: Any) -> None:
    """Close a pg8000 connection and the buffer its own ``close`` leaves open.

    ``pg8000`` drops the buffered wrapper around the socket without closing it,
    so the interpreter flushes it later onto a closed file descriptor and
    pytest reports an unraisable ``OSError`` that has nothing to do with the
    test. Closing the wrapper here keeps the suite's output about the suite.
    """
    buffered = getattr(connection, "_sock", None)
    with suppress(Exception):
        connection.close()
    if buffered is not None:
        with suppress(Exception):
            buffered.close()


def _roles_script() -> Path:
    """The real roles script, or the vendored copy when it is absent."""
    real = ROOT / "infra" / "postgres" / "initdb" / "00-roles.sh"
    return real if real.is_file() else FIXTURES / "initdb" / "00-roles.sh"


def _wait_until_ready(container: DockerContainer, stack: PostgresStack) -> None:
    """Wait for ``pg_isready`` over TCP, then prove the driver can connect.

    The readiness check runs inside the container, as the TypeScript helper's
    does (db/README.md), because the entrypoint serves
    ``/docker-entrypoint-initdb.d`` from a temporary server that listens on a
    unix socket only: a TCP answer means the roles script has finished. Probing
    with ``pg8000`` instead would mean connecting into a half-open server and
    leaving a half-built connection behind on every attempt.
    """
    deadline = time.monotonic() + READY_TIMEOUT_S
    last = ""
    while time.monotonic() < deadline:
        result = container.exec(PG_ISREADY)
        if result.exit_code == 0:
            connection = stack.connect()
            try:
                connection.run("SELECT 1")
            finally:
                _close(connection)
            return
        last = result.output.decode(errors="replace").strip()
        time.sleep(READY_POLL_S)
    raise TimeoutError(
        f"postgres at {stack.host}:{stack.port} was not ready within {READY_TIMEOUT_S:.0f}s: {last}"
    )


def _wait_until_broker_ready(host: str, port: int) -> None:
    """Poll until the broker answers a CONNECT with a CONNACK.

    Docker publishes the port as soon as the container is created, so a plain
    TCP connect succeeds while mosquitto is still reading its configuration and
    the first CONNECT is met with a reset. The readiness handshake of init is
    the only honest readiness signal, so the fixture speaks it — through the
    production packet builder, which keeps the two in step.
    """
    packet = connect_packet(client_id())
    deadline = time.monotonic() + READY_TIMEOUT_S
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=CONNECT_TIMEOUT_S) as probe:
                probe.sendall(packet)
                answer = probe.recv(4)
            if len(answer) == 4 and answer[0] == MQTT_CONNACK and answer[3] == 0:
                return
            last = OSError(f"unexpected answer to CONNECT: {answer.hex()}")
        except OSError as exc:
            last = exc
        time.sleep(READY_POLL_S)
    raise TimeoutError(
        f"broker at {host}:{port} was not ready within {READY_TIMEOUT_S:.0f}s: {last}"
    )


@pytest.fixture(scope="session")
def postgres() -> Iterator[PostgresStack]:
    """A PostgreSQL server with pgvector and the three login roles.

    Session-scoped because starting it costs seconds and no test changes the
    server itself: each one works in its own database (see ``fresh_db``).
    """
    container = (
        DockerContainer(PG_IMAGE)
        .with_env("POSTGRES_USER", ADMIN_USER)
        .with_env("POSTGRES_PASSWORD", ADMIN_PASSWORD)
        .with_env("POSTGRES_DB", ADMIN_DB)
        .with_env("PG_APP_PASSWORD", ROLE_PASSWORDS["app_rw"])
        .with_env("PG_GT_PASSWORD", ROLE_PASSWORDS["gt_rw"])
        .with_env("PG_EVAL_PASSWORD", ROLE_PASSWORDS["eval"])
        .with_exposed_ports(PG_PORT)
        .with_kwargs(labels=_labels("ini-integration-postgres"))
        .with_copy_into_container(_roles_script(), ROLES_SCRIPT_IN_CONTAINER, mode=0o755)
    )
    container.start()
    try:
        stack = PostgresStack(
            host=container.get_container_host_ip(),
            port=int(container.get_exposed_port(PG_PORT)),
        )
        _wait_until_ready(container, stack)
        yield stack
    finally:
        container.stop()


@pytest.fixture(scope="session")
def database_names() -> Iterator[str]:
    """``test_1``, ``test_2``, … — one per ``fresh_db``, unique in the session."""
    return (f"test_{index}" for index in count(1))


@pytest.fixture
def fresh_db(postgres: PostgresStack, database_names: Iterator[str]) -> Iterator[FreshDatabase]:
    """An empty database, so a test starts from nothing the previous one left.

    ``CREATE DATABASE`` cannot run inside a transaction, which is why it goes
    through its own connection: pg8000 leaves a parameterless ``run`` in
    autocommit.
    """
    name = next(database_names)
    maintenance = postgres.connect()
    try:
        maintenance.run(f'CREATE DATABASE "{name}"')
    finally:
        _close(maintenance)

    admin = postgres.connect(name)
    database = FreshDatabase(name=name, admin=admin, stack=postgres, opened=[admin])
    try:
        yield database
    finally:
        for connection in database.opened:
            _close(connection)
        cleanup = postgres.connect()
        try:
            with suppress(Exception):
                cleanup.run(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        finally:
            _close(cleanup)


@pytest.fixture(scope="session")
def mosquitto() -> Iterator[tuple[str, int]]:
    """An MQTT broker on a random host port, as ``(host, port)``.

    The real stack's configuration is used when ``infra/mosquitto`` is in the
    worktree; otherwise the anonymous-only fallback of
    ``tests/fixtures/mosquitto.conf``. Anonymous connects are allowed either
    way, because init's readiness wait sends a CONNECT with no
    credentials and never subscribes or publishes.
    """
    container = (
        DockerContainer(MQTT_IMAGE)
        .with_exposed_ports(MQTT_PORT)
        .with_kwargs(labels=_labels("ini-integration-mqtt"))
    )
    infra = ROOT / "infra" / "mosquitto"
    if (infra / "mosquitto.conf").is_file():
        for name in MOSQUITTO_FILES:
            source = infra / name
            if source.is_file():
                container.with_copy_into_container(
                    source, f"{MOSQUITTO_CONFIG_DIR}/{name}", mode=0o644
                )
    else:
        container.with_copy_into_container(
            FIXTURES / "mosquitto.conf", f"{MOSQUITTO_CONFIG_DIR}/mosquitto.conf", mode=0o644
        )
    container.start()
    try:
        host = container.get_container_host_ip()
        port = int(container.get_exposed_port(MQTT_PORT))
        _wait_until_broker_ready(host, port)
        yield host, port
    finally:
        container.stop()
