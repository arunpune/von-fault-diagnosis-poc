# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Readiness waits for Postgres and the MQTT broker.

Belt and braces beside the Compose healthchecks: both waits retry with a
bounded budget so ``fdp-init`` never hangs, and both fail fast on an answer
that waiting cannot change — a rejected password, a refused protocol version.
``fdp-init wait`` exposes them for ``scripts/smoke.sh``.
"""

from __future__ import annotations

import logging
import socket
import time
from collections.abc import Callable

import pg8000.native
from tenacity import (
    Retrying,
    retry_if_exception_type,
    stop_after_delay,
    wait_exponential,
    wait_random,
)

from fdp_init.config import Settings
from fdp_init.errors import ExitCode, InitError

STEP = "wait"

PROBE_TIMEOUT_S = 5.0
"""Per-attempt socket timeout; the budget is ``INIT_WAIT_TIMEOUT_S``."""

RETRY_MIN_WAIT_S = 1.0
RETRY_MAX_WAIT_S = 5.0
RETRY_JITTER_S = 0.5

FATAL_SQLSTATES = frozenset({"28000", "28P01"})
"""``invalid_authorization_specification`` and ``invalid_password``: a wrong
password is not a timing problem."""

MQTT_PROTOCOL_LEVEL = 4
"""MQTT 3.1.1."""

MQTT_KEEPALIVE_S = 10

MQTT_CONNACK_MESSAGES = {
    0: "accepted",
    1: "unacceptable protocol version",
    2: "identifier rejected",
    3: "server unavailable",
    4: "bad user name or password",
    5: "not authorized",
}

MQTT_FATAL_CONNACK = frozenset({1, 4, 5})
"""Return codes a retry cannot change; 2 and 3 are transient."""

_CONNECT = 0x10
_CONNACK = 0x20
_DISCONNECT = 0xE0

logger = logging.getLogger(__name__)


class _TransientError(Exception):
    """The dependency is not up yet; retry until the budget is spent."""


def _wait(name: str, target: str, probe: Callable[[], None], settings: Settings) -> None:
    """Retry ``probe`` until it returns, or raise ``InitError`` on timeout.

    A :class:`InitError` raised by the probe itself (a fatal answer) is not
    retried and propagates unchanged.
    """
    budget = settings.wait_timeout_s
    started = time.monotonic()
    attempts = 0
    retrying = Retrying(
        stop=stop_after_delay(budget),
        wait=wait_exponential(multiplier=1, min=RETRY_MIN_WAIT_S, max=RETRY_MAX_WAIT_S)
        + wait_random(0, RETRY_JITTER_S),
        retry=retry_if_exception_type(_TransientError),
        reraise=True,
    )
    try:
        for attempt in retrying:
            with attempt:
                attempts += 1
                probe()
    except _TransientError as exc:
        raise InitError(
            ExitCode.WAIT_TIMEOUT,
            f"{name} at {target} was not ready within {budget:g} s "
            f"after {attempts} attempt(s): {exc}",
            STEP,
        ) from exc
    logger.info(
        "dependency ready",
        extra={
            "step": STEP,
            "dependency": name,
            "target": target,
            "attempts": attempts,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        },
    )


def _sqlstate(error: Exception) -> str | None:
    """The SQLSTATE of a pg8000 ``DatabaseError``, when it carries one."""
    if error.args and isinstance(error.args[0], dict):
        code = error.args[0].get("C")
        if isinstance(code, str):
            return code
    return None


def _probe_postgres(settings: Settings) -> None:
    """Open one connection and run ``SELECT 1``.

    Raises:
        _TransientError: the server is not accepting connections yet.
        InitError: the server answered with an authentication failure.
    """
    try:
        connection = pg8000.native.Connection(
            settings.postgres_user,
            host=settings.postgres_host,
            port=settings.postgres_port,
            database=settings.postgres_db,
            password=settings.postgres_password,
            timeout=PROBE_TIMEOUT_S,
        )
    except pg8000.native.DatabaseError as exc:
        state = _sqlstate(exc)
        if state in FATAL_SQLSTATES:
            raise InitError(
                ExitCode.WAIT_TIMEOUT,
                f"postgres at {settings.postgres_host}:{settings.postgres_port} rejected user "
                f"{settings.postgres_user!r} (SQLSTATE {state}); waiting cannot fix a credential",
                STEP,
            ) from exc
        raise _TransientError(f"database error {state or 'unknown'}") from exc
    except (pg8000.native.InterfaceError, OSError) as exc:
        raise _TransientError(str(exc)) from exc

    try:
        connection.run("SELECT 1")
    except (pg8000.native.DatabaseError, pg8000.native.InterfaceError, OSError) as exc:
        raise _TransientError(str(exc)) from exc
    finally:
        try:
            connection.close()
        except Exception:
            logger.debug("closing the probe connection failed", extra={"step": STEP})


def wait_for_postgres(settings: Settings) -> None:
    """Block until Postgres answers ``SELECT 1`` or the budget is spent.

    Raises:
        InitError: exit code 3, on timeout or on an authentication failure.
    """
    _wait(
        "postgres",
        f"{settings.postgres_host}:{settings.postgres_port}",
        lambda: _probe_postgres(settings),
        settings,
    )


def _remaining_length(value: int) -> bytes:
    """Encode an MQTT variable-length integer."""
    out = bytearray()
    while True:
        byte = value % 128
        value //= 128
        if value:
            byte |= 0x80
        out.append(byte)
        if not value:
            return bytes(out)


def _mqtt_string(value: str) -> bytes:
    """Encode a length-prefixed UTF-8 MQTT string."""
    raw = value.encode("utf-8")
    return len(raw).to_bytes(2, "big") + raw


def connect_packet(client_id: str) -> bytes:
    """Build the MQTT 3.1.1 CONNECT packet the wait sends.

    Clean session, no credentials: the broker ACL allows an anonymous connect
    and init never subscribes or publishes.
    """
    payload = _mqtt_string(client_id)
    variable = (
        _mqtt_string("MQTT")
        + bytes([MQTT_PROTOCOL_LEVEL, 0x02])
        + MQTT_KEEPALIVE_S.to_bytes(2, "big")
    )
    body = variable + payload
    return bytes([_CONNECT]) + _remaining_length(len(body)) + body


def client_id() -> str:
    """``init-<hostname>``, trimmed to a length every broker accepts."""
    host = socket.gethostname().split(".")[0] or "unknown"
    return f"init-{host}"[:64]


def _read_exactly(connection: socket.socket, count: int) -> bytes:
    """Read ``count`` bytes or raise ``_TransientError`` on a short read."""
    chunks = bytearray()
    while len(chunks) < count:
        block = connection.recv(count - len(chunks))
        if not block:
            raise _TransientError("broker closed the connection during CONNACK")
        chunks += block
    return bytes(chunks)


def _probe_mqtt(settings: Settings) -> None:
    """Open a socket, CONNECT, read CONNACK, DISCONNECT.

    Raises:
        _TransientError: the broker is not listening yet, or answered a code a
            retry can clear.
        InitError: the broker refused the connection for good.
    """
    try:
        connection = socket.create_connection(
            (settings.mqtt_host, settings.mqtt_port), timeout=PROBE_TIMEOUT_S
        )
    except OSError as exc:
        raise _TransientError(str(exc)) from exc

    with connection:
        try:
            connection.sendall(connect_packet(client_id()))
            header = _read_exactly(connection, 2)
            if header[0] != _CONNACK or header[1] != 2:
                raise _TransientError(f"unexpected answer to CONNECT: {header.hex()}")
            flags_and_code = _read_exactly(connection, 2)
        except OSError as exc:
            raise _TransientError(str(exc)) from exc
        code = flags_and_code[1]
        if code in MQTT_FATAL_CONNACK:
            raise InitError(
                ExitCode.WAIT_TIMEOUT,
                f"broker at {settings.mqtt_url} refused the connection: "
                f"CONNACK {code} ({MQTT_CONNACK_MESSAGES.get(code, 'unknown')})",
                STEP,
            )
        if code != 0:
            raise _TransientError(f"CONNACK {code} ({MQTT_CONNACK_MESSAGES.get(code, 'unknown')})")
        try:
            connection.sendall(bytes([_DISCONNECT, 0x00]))
        except OSError:
            logger.debug("broker closed before DISCONNECT", extra={"step": STEP})


def wait_for_mqtt(settings: Settings) -> None:
    """Block until the broker answers CONNACK 0 or the budget is spent.

    Raises:
        InitError: exit code 3, on timeout or on a refusal.
    """
    _wait(
        "mqtt",
        f"{settings.mqtt_host}:{settings.mqtt_port}",
        lambda: _probe_mqtt(settings),
        settings,
    )
