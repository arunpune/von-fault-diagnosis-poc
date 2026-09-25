# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The downloader against an in-process HTTP server.

``http.server`` on an ephemeral port in a thread: no network, no Docker, and
no collision with another worktree. Each test scripts the answers the server
gives, one per request, so a resume or a retry is exercised exactly once.
"""

from __future__ import annotations

import hashlib
import http.server
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from fdp_init.util import fetch as fetchmod
from fdp_init.util.fetch import (
    FetchError,
    FetchTimeoutError,
    HashMismatch,
    fetch_to_file,
)

Behaviour = Callable[["_Handler"], None]

BODY = bytes(range(256)) * 40  # 10 240 bytes, no compression surprises
BODY_SHA256 = hashlib.sha256(BODY).hexdigest()

BIG_BODY = b"x" * (2 * 1024 * 1024)

SHUTDOWN_TIMEOUT_S = 5.0


@pytest.fixture(autouse=True)
def _fast_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shrink the 2 s → 60 s retry backoff; the schedule is tenacity's."""
    monkeypatch.setattr(fetchmod, "RETRY_MIN_WAIT_S", 0.01)
    monkeypatch.setattr(fetchmod, "RETRY_MAX_WAIT_S", 0.02)
    monkeypatch.setattr(fetchmod, "RETRY_JITTER_S", 0.0)


@dataclass
class Plan:
    """The answers the server gives, in order; the last one repeats."""

    behaviours: list[Behaviour]
    requests: list[tuple[str, str | None]] = field(default_factory=list)
    served: int = 0

    def next_behaviour(self) -> Behaviour:
        behaviour = self.behaviours[min(self.served, len(self.behaviours) - 1)]
        self.served += 1
        return behaviour


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        # The name is BaseHTTPRequestHandler's contract, not a style choice.
        plan: Plan = self.server.plan  # type: ignore[attr-defined]
        plan.requests.append((self.path, self.headers.get("Range")))
        plan.next_behaviour()(self)

    def log_message(self, format: str, *args: object) -> None:
        """Keep the test output clean."""


def serve_full(body: bytes = BODY) -> Behaviour:
    """A plain 200 with the whole body."""

    def behave(handler: _Handler) -> None:
        handler.send_response(200)
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    return behave


def serve_range(body: bytes = BODY) -> Behaviour:
    """206 for a ``Range`` request, 200 otherwise."""

    def behave(handler: _Handler) -> None:
        header = handler.headers.get("Range")
        if header is None:
            serve_full(body)(handler)
            return
        start = int(header.removeprefix("bytes=").split("-")[0])
        rest = body[start:]
        handler.send_response(206)
        handler.send_header("Content-Length", str(len(rest)))
        handler.send_header("Content-Range", f"bytes {start}-{len(body) - 1}/{len(body)}")
        handler.end_headers()
        handler.wfile.write(rest)

    return behave


def cut(body: bytes = BODY, *, at: int = 4096) -> Behaviour:
    """Promise the whole body, deliver ``at`` bytes, drop the connection."""

    def behave(handler: _Handler) -> None:
        handler.send_response(200)
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body[:at])
        handler.wfile.flush()
        handler.close_connection = True

    return behave


def status(code: int) -> Behaviour:
    """An error answer with no body."""

    def behave(handler: _Handler) -> None:
        handler.send_response(code)
        handler.send_header("Content-Length", "0")
        handler.end_headers()

    return behave


def redirect(location: str) -> Behaviour:
    """A 302 to another path on the same server."""

    def behave(handler: _Handler) -> None:
        handler.send_response(302)
        handler.send_header("Location", location)
        handler.send_header("Content-Length", "0")
        handler.end_headers()

    return behave


def stall(body: bytes, *, after: int, delay: float) -> Behaviour:
    """Send ``after`` bytes, sleep, then the rest: a slow mirror."""

    def behave(handler: _Handler) -> None:
        handler.send_response(200)
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body[:after])
        handler.wfile.flush()
        time.sleep(delay)
        handler.wfile.write(body[after:])

    return behave


@pytest.fixture
def serve() -> Iterator[Callable[..., tuple[str, Plan]]]:
    """Start a scripted HTTP server; returns its base URL and the plan."""
    servers: list[http.server.ThreadingHTTPServer] = []

    def start(*behaviours: Behaviour) -> tuple[str, Plan]:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        plan = Plan(list(behaviours))
        server.plan = plan  # type: ignore[attr-defined]
        servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{server.server_address[1]}", plan

    yield start
    for server in servers:
        server.shutdown()
        server.server_close()


def test_happy_path(serve: Callable[..., tuple[str, Plan]], tmp_path: Path) -> None:
    base, plan = serve(serve_full())
    dest = tmp_path / "nested" / "data.csv"

    result = fetch_to_file(f"{base}/data.csv", dest, timeout_s=10, retries=3)

    assert dest.read_bytes() == BODY
    assert result.sha256 == BODY_SHA256
    assert result.bytes == len(BODY)
    assert result.resumed is False
    assert result.attempts == 1
    assert not dest.with_name(dest.name + ".part").exists()
    assert plan.requests == [("/data.csv", None)]


def test_expected_hash_accepted(serve: Callable[..., tuple[str, Plan]], tmp_path: Path) -> None:
    base, _ = serve(serve_full())
    dest = tmp_path / "data.csv"

    result = fetch_to_file(
        f"{base}/data.csv", dest, expected_sha256=BODY_SHA256, timeout_s=10, retries=3
    )

    assert result.sha256 == BODY_SHA256


def test_redirect_is_followed(serve: Callable[..., tuple[str, Plan]], tmp_path: Path) -> None:
    base, plan = serve(redirect("/real.csv"), serve_full())
    dest = tmp_path / "data.csv"

    result = fetch_to_file(f"{base}/start.csv", dest, timeout_s=10, retries=3)

    assert result.sha256 == BODY_SHA256
    assert [path for path, _ in plan.requests] == ["/start.csv", "/real.csv"]


def test_resume_after_a_cut_connection(
    serve: Callable[..., tuple[str, Plan]], tmp_path: Path
) -> None:
    """The second request carries ``Range`` and the server answers 206."""
    base, plan = serve(cut(), serve_range())
    dest = tmp_path / "data.csv"

    result = fetch_to_file(
        f"{base}/data.csv", dest, expected_sha256=BODY_SHA256, timeout_s=10, retries=3
    )

    assert dest.read_bytes() == BODY
    assert result.resumed is True
    assert result.attempts == 2
    assert plan.requests[1][1] == "bytes=4096-"


def test_server_without_range_restarts(
    serve: Callable[..., tuple[str, Plan]], tmp_path: Path
) -> None:
    """A 200 answer to a ``Range`` request truncates the part file."""
    base, plan = serve(serve_full())
    dest = tmp_path / "data.csv"
    part = dest.with_name(dest.name + ".part")
    part.write_bytes(b"stale bytes from an older mirror")

    result = fetch_to_file(
        f"{base}/data.csv", dest, expected_sha256=BODY_SHA256, timeout_s=10, retries=3
    )

    assert dest.read_bytes() == BODY
    assert result.resumed is False
    assert plan.requests[0][1] is not None  # the client did ask to resume


def test_hash_mismatch_deletes_the_file(
    serve: Callable[..., tuple[str, Plan]], tmp_path: Path
) -> None:
    base, _ = serve(serve_full())
    dest = tmp_path / "data.csv"

    with pytest.raises(HashMismatch) as caught:
        fetch_to_file(f"{base}/data.csv", dest, expected_sha256="0" * 64, timeout_s=10, retries=3)

    assert caught.value.actual == BODY_SHA256
    assert not dest.exists()
    assert not dest.with_name(dest.name + ".part").exists()


def test_five_hundred_then_two_hundred(
    serve: Callable[..., tuple[str, Plan]], tmp_path: Path
) -> None:
    base, plan = serve(status(500), status(503), serve_full())
    dest = tmp_path / "data.csv"

    result = fetch_to_file(f"{base}/data.csv", dest, timeout_s=10, retries=5)

    assert result.sha256 == BODY_SHA256
    assert result.attempts == 3
    assert plan.served == 3


def test_four_oh_four_is_not_retried(
    serve: Callable[..., tuple[str, Plan]], tmp_path: Path
) -> None:
    base, plan = serve(status(404))
    dest = tmp_path / "data.csv"

    with pytest.raises(FetchError) as caught:
        fetch_to_file(f"{base}/data.csv", dest, timeout_s=10, retries=5)

    assert "404" in str(caught.value)
    assert plan.served == 1


def test_retries_are_bounded(serve: Callable[..., tuple[str, Plan]], tmp_path: Path) -> None:
    base, plan = serve(status(500))
    dest = tmp_path / "data.csv"

    with pytest.raises(FetchError):
        fetch_to_file(f"{base}/data.csv", dest, timeout_s=10, retries=2)

    assert plan.served == 2


def test_timeout_budget(serve: Callable[..., tuple[str, Plan]], tmp_path: Path) -> None:
    base, _ = serve(stall(BIG_BODY, after=1024 * 1024, delay=0.4))
    dest = tmp_path / "data.csv"

    with pytest.raises(FetchTimeoutError):
        fetch_to_file(f"{base}/data.csv", dest, timeout_s=0.1, retries=3)

    assert not dest.exists()


def test_only_http_urls(tmp_path: Path) -> None:
    with pytest.raises(FetchError):
        fetch_to_file("file:///etc/passwd", tmp_path / "x", timeout_s=1, retries=1)
