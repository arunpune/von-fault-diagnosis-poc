# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Readiness waits against fake servers in threads.

Both servers are real sockets on an ephemeral loopback port, so the tests run
beside other worktrees without colliding and need neither Docker nor network.
The Postgres one speaks just enough of the v3 protocol for ``pg8000`` to
finish its handshake and run ``SELECT 1``.
"""

from __future__ import annotations

import socket
import threading
import time
from collections.abc import Callable, Iterator

import pytest

from fdp_init import wait as waitmod
from fdp_init.config import Settings
from fdp_init.errors import ExitCode, InitError

Env = Callable[..., dict[str, str]]
Handler = Callable[[socket.socket], None]

ACCEPT_TIMEOUT_S = 0.2
JOIN_TIMEOUT_S = 2.0


@pytest.fixture(autouse=True)
def _fast_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shrink the 1 s → 5 s backoff so the retry paths stay quick.

    The schedule itself is tenacity's; what these tests check is which
    failures are retried and which are not.
    """
    monkeypatch.setattr(waitmod, "RETRY_MIN_WAIT_S", 0.02)
    monkeypatch.setattr(waitmod, "RETRY_MAX_WAIT_S", 0.05)
    monkeypatch.setattr(waitmod, "RETRY_JITTER_S", 0.01)


def free_port() -> int:
    """An ephemeral loopback port nothing is listening on."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class FakeServer:
    """A loopback listener that hands each connection to ``handler``."""

    def __init__(self, handler: Handler, *, drop_first: int = 0) -> None:
        self._handler = handler
        self._drop_first = drop_first
        self.connections = 0
        self._socket = socket.socket()
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._socket.bind(("127.0.0.1", 0))
        self._socket.listen(8)
        self._socket.settimeout(ACCEPT_TIMEOUT_S)
        self.port = int(self._socket.getsockname()[1])
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                connection, _ = self._socket.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            self.connections += 1
            with connection:
                if self.connections <= self._drop_first:
                    continue
                try:
                    self._handler(connection)
                except OSError:
                    continue

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=JOIN_TIMEOUT_S)
        self._socket.close()


def recv_exactly(connection: socket.socket, count: int) -> bytes:
    """Read ``count`` bytes from a fake-server connection."""
    chunks = bytearray()
    while len(chunks) < count:
        block = connection.recv(count - len(chunks))
        if not block:
            raise OSError("client closed")
        chunks += block
    return bytes(chunks)


def pg_message(code: bytes, body: bytes) -> bytes:
    """A backend message: type byte, length including itself, body."""
    return code + (len(body) + 4).to_bytes(4, "big") + body


def pg_error(sqlstate: str, message: str) -> bytes:
    """An ``ErrorResponse`` carrying one SQLSTATE."""
    fields = b"".join(
        code + text.encode() + b"\x00"
        for code, text in ((b"S", "FATAL"), (b"V", "FATAL"), (b"C", sqlstate), (b"M", message))
    )
    return pg_message(b"E", fields + b"\x00")


_READY = pg_message(b"Z", b"I")
"""ReadyForQuery, idle."""

_ROW_DESCRIPTION = pg_message(
    b"T",
    (1).to_bytes(2, "big")
    + b"?column?\x00"
    + (0).to_bytes(4, "big")  # table oid
    + (0).to_bytes(2, "big")  # column attnum
    + (23).to_bytes(4, "big")  # int4
    + (4).to_bytes(2, "big")  # type length
    + (-1).to_bytes(4, "big", signed=True)  # type modifier
    + (0).to_bytes(2, "big"),  # text format
)

_QUERY_REPLY = (
    _ROW_DESCRIPTION
    + pg_message(b"D", (1).to_bytes(2, "big") + (1).to_bytes(4, "big") + b"1")
    + pg_message(b"C", b"SELECT 1\x00")
    + _READY
)
"""The simple-query answer to ``SELECT 1``: ``pg8000.native.run`` with no
parameters sends one ``Q`` message rather than Parse/Bind/Execute."""


def postgres_handler(*, sqlstate: str | None = None) -> Handler:
    """A backend that completes the handshake, or refuses with ``sqlstate``."""

    def handle(connection: socket.socket) -> None:
        recv_exactly(connection, 8)  # SSLRequest
        connection.sendall(b"N")
        length = int.from_bytes(recv_exactly(connection, 4), "big")
        recv_exactly(connection, length - 4)  # StartupMessage
        if sqlstate is not None:
            connection.sendall(pg_error(sqlstate, "authentication failed"))
            return
        connection.sendall(pg_message(b"R", (0).to_bytes(4, "big")))
        connection.sendall(pg_message(b"K", (1).to_bytes(4, "big") + (2).to_bytes(4, "big")))
        connection.sendall(_READY)
        while True:
            code = connection.recv(1)
            if not code or code == b"X":
                return
            size = int.from_bytes(recv_exactly(connection, 4), "big")
            recv_exactly(connection, size - 4)
            if code == b"Q":
                connection.sendall(_QUERY_REPLY)

    return handle


def mqtt_handler(return_code: int) -> Handler:
    """A broker that reads CONNECT and answers CONNACK ``return_code``."""

    def handle(connection: socket.socket) -> None:
        assert recv_exactly(connection, 1) == b"\x10"
        remaining = 0
        shift = 0
        while True:
            byte = recv_exactly(connection, 1)[0]
            remaining += (byte & 0x7F) << shift
            if not byte & 0x80:
                break
            shift += 7
        recv_exactly(connection, remaining)
        connection.sendall(bytes([0x20, 0x02, 0x00, return_code]))
        connection.recv(2)  # DISCONNECT, when the client sends one

    return handle


@pytest.fixture
def server() -> Iterator[Callable[..., FakeServer]]:
    """Start fake servers and close them all at the end of the test."""
    started: list[FakeServer] = []

    def start(handler: Handler, *, drop_first: int = 0) -> FakeServer:
        instance = FakeServer(handler, drop_first=drop_first)
        started.append(instance)
        return instance

    yield start
    for instance in started:
        instance.close()


def pg_settings(env: Env, port: int, *, budget: str = "10") -> Settings:
    return Settings.from_env(
        env(POSTGRES_HOST="127.0.0.1", POSTGRES_PORT=str(port), INIT_WAIT_TIMEOUT_S=budget)
    )


def mqtt_settings(env: Env, port: int, *, budget: str = "10") -> Settings:
    return Settings.from_env(env(MQTT_URL=f"mqtt://127.0.0.1:{port}", INIT_WAIT_TIMEOUT_S=budget))


def test_postgres_refused_then_ready(env: Env, server: Callable[..., FakeServer]) -> None:
    """The first two connections are dropped before the handshake."""
    fake = server(postgres_handler(), drop_first=2)

    waitmod.wait_for_postgres(pg_settings(env, fake.port))

    assert fake.connections == 3


def test_postgres_auth_failure_fails_fast(env: Env, server: Callable[..., FakeServer]) -> None:
    fake = server(postgres_handler(sqlstate="28P01"))
    started = time.monotonic()

    with pytest.raises(InitError) as caught:
        waitmod.wait_for_postgres(pg_settings(env, fake.port, budget="30"))

    assert caught.value.exit_code is ExitCode.WAIT_TIMEOUT
    assert "28P01" in caught.value.message
    assert fake.connections == 1
    assert time.monotonic() - started < 5


def test_postgres_other_database_error_is_retried(
    env: Env, server: Callable[..., FakeServer]
) -> None:
    """``57P03`` (the server is starting up) keeps the wait waiting."""
    fake = server(postgres_handler(sqlstate="57P03"))

    with pytest.raises(InitError) as caught:
        waitmod.wait_for_postgres(pg_settings(env, fake.port, budget="0.3"))

    assert caught.value.exit_code is ExitCode.WAIT_TIMEOUT
    assert fake.connections > 1


def test_postgres_timeout_exits_three(env: Env) -> None:
    settings = pg_settings(env, free_port(), budget="0.3")

    with pytest.raises(InitError) as caught:
        waitmod.wait_for_postgres(settings)

    assert caught.value.exit_code is ExitCode.WAIT_TIMEOUT
    assert caught.value.step == "wait"
    assert "postgres at 127.0.0.1" in caught.value.message


def test_mqtt_connack_zero(env: Env, server: Callable[..., FakeServer]) -> None:
    fake = server(mqtt_handler(0), drop_first=1)

    waitmod.wait_for_mqtt(mqtt_settings(env, fake.port))

    assert fake.connections == 2


def test_mqtt_connack_five_fails_fast(env: Env, server: Callable[..., FakeServer]) -> None:
    fake = server(mqtt_handler(5))

    with pytest.raises(InitError) as caught:
        waitmod.wait_for_mqtt(mqtt_settings(env, fake.port, budget="30"))

    assert caught.value.exit_code is ExitCode.WAIT_TIMEOUT
    assert "CONNACK 5" in caught.value.message
    assert fake.connections == 1


def test_mqtt_server_unavailable_is_retried(env: Env, server: Callable[..., FakeServer]) -> None:
    fake = server(mqtt_handler(3))

    with pytest.raises(InitError) as caught:
        waitmod.wait_for_mqtt(mqtt_settings(env, fake.port, budget="0.3"))

    assert "CONNACK 3" in caught.value.message
    assert fake.connections > 1


def test_mqtt_timeout_exits_three(env: Env) -> None:
    with pytest.raises(InitError) as caught:
        waitmod.wait_for_mqtt(mqtt_settings(env, free_port(), budget="0.3"))

    assert caught.value.exit_code is ExitCode.WAIT_TIMEOUT


def test_connect_packet_is_mqtt_311() -> None:
    packet = waitmod.connect_packet("init-host")

    assert packet[0] == 0x10
    assert packet[2:8] == b"\x00\x04MQTT"
    assert packet[8] == 0x04  # protocol level 3.1.1
    assert packet[9] == 0x02  # clean session, no credentials
    assert packet[10:12] == (10).to_bytes(2, "big")  # keep-alive
    assert packet.endswith(b"\x00\tinit-host")
    assert packet[1] == len(packet) - 2


def test_client_id_is_host_derived() -> None:
    assert waitmod.client_id().startswith("init-")
    assert len(waitmod.client_id()) <= 64
