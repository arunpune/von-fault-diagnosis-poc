# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Every branch of the decision order.

The dataset is 218 MB and lives behind two URLs, so the whole suite runs
against an in-process ``http.server`` on an ephemeral port serving a synthetic
50-row CSV and a zip of it: no network, no Docker, and nothing that another
worktree could collide with. The server counts its requests, which is how the
"a verified file downloads nothing" case is proved rather than assumed.
"""

from __future__ import annotations

import hashlib
import http.server
import io
import json
import logging
import threading
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from fdp_init import cli
from fdp_init.config import Settings
from fdp_init.dataset.metropt import METROPT_HEADER, ensure_dataset
from fdp_init.errors import ExitCode, InitError
from fdp_init.util import fetch as fetchmod
from fdp_init.util import hashing
from fdp_init.util.hashing import Sidecar

CANONICAL = "MetroPT3(AirCompressor).csv"

ZIP_MEMBER = "MetroPT3(AirCompressor).csv"

DECOY_MEMBER = "Data Description_Metro.pdf"
"""UCI ships a description PDF beside the table; it is never extracted."""

ROWS = 50


def _csv_bytes(header: str = METROPT_HEADER) -> bytes:
    """A synthetic table with the real column names and 50 constant rows."""
    lines = [header]
    for index in range(ROWS):
        values = [str(index), f"2020-02-01 00:{index // 60:02d}:{index % 60:02d}"]
        values += [f"{index / 10:.3f}"] * 8
        values += ["1"] * 7
        lines.append(",".join(values))
    return ("\n".join(lines) + "\n").encode("utf-8")


CSV = _csv_bytes()
CSV_SHA256 = hashlib.sha256(CSV).hexdigest()

WRONG_HEADER_CSV = _csv_bytes("a,b,c")


def _zip_bytes(payload: bytes = CSV) -> bytes:
    """The table plus a decoy member, the way UCI packages it."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(ZIP_MEMBER, payload)
        bundle.writestr(DECOY_MEMBER, b"%PDF-1.7\nnot extracted\n")
    return buffer.getvalue()


ZIP = _zip_bytes()


@dataclass
class Route:
    """One canned answer."""

    status: int
    body: bytes
    content_type: str = "text/csv"


@dataclass
class Site:
    """The routes the server knows and every path it was asked for."""

    routes: dict[str, Route]
    hits: list[str] = field(default_factory=list)


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        # The name is BaseHTTPRequestHandler's contract, not a style choice.
        site: Site = self.server.site  # type: ignore[attr-defined]
        site.hits.append(self.path)
        route = site.routes.get(self.path)
        if route is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(route.status)
        self.send_header("Content-Type", route.content_type)
        self.send_header("Content-Length", str(len(route.body)))
        self.end_headers()
        self.wfile.write(route.body)

    def log_message(self, format: str, *args: object) -> None:
        """Keep the test output clean."""


@pytest.fixture(autouse=True)
def _restore_logging() -> Iterator[None]:
    """Give the sub-command tests a clean root logger and hand it back."""
    root = logging.getLogger()
    handlers = list(root.handlers)
    level = root.level
    package_level = logging.getLogger("fdp_init").level
    yield
    root.handlers = handlers
    root.setLevel(level)
    logging.getLogger("fdp_init").setLevel(package_level)


def _count_hashing(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    """Record every full read of a file that :func:`cached_sha256` makes."""
    calls: list[Path] = []
    real = hashing.sha256_file

    def counted(path: Path) -> str:
        calls.append(path)
        return real(path)

    monkeypatch.setattr(hashing, "sha256_file", counted)
    return calls


@pytest.fixture(autouse=True)
def _fast_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shrink the downloader's 2 s → 60 s backoff to keep the suite quick."""
    monkeypatch.setattr(fetchmod, "RETRY_MIN_WAIT_S", 0.01)
    monkeypatch.setattr(fetchmod, "RETRY_MAX_WAIT_S", 0.02)
    monkeypatch.setattr(fetchmod, "RETRY_JITTER_S", 0.0)


@pytest.fixture
def site() -> Iterator[Callable[..., tuple[str, Site]]]:
    """Start a server on port 0; returns its base URL and its request log."""
    servers: list[http.server.ThreadingHTTPServer] = []

    def start(**routes: Route) -> tuple[str, Site]:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        state = Site({f"/{name}": route for name, route in routes.items()})
        server.site = state  # type: ignore[attr-defined]
        servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{server.server_address[1]}", state

    yield start
    for server in servers:
        server.shutdown()
        server.server_close()


@pytest.fixture
def sums(tmp_path: Path) -> Callable[..., Path]:
    """Write a temporary ``SHA256SUMS`` and return its path."""

    def write(**entries: str) -> Path:
        path = tmp_path / "SHA256SUMS"
        path.write_text(
            "# synthetic fixtures, not the published dataset\n"
            + "".join(f"{digest}  {name}\n" for name, digest in entries.items()),
            encoding="utf-8",
        )
        return path

    return write


@pytest.fixture
def settings(env: Callable[..., dict[str, str]], tmp_path: Path) -> Callable[..., Settings]:
    """Build :class:`Settings` for a dataset run inside ``tmp_path``."""

    def build(*, csv: Path, sha256sums: Path, **overrides: str) -> Settings:
        base = {
            "METROPT_CSV": str(csv),
            "SHA256SUMS_PATH": str(sha256sums),
            "INIT_DOWNLOAD_TIMEOUT_S": "30",
            "INIT_DOWNLOAD_RETRIES": "2",
            "METROPT_URL": "http://127.0.0.1:1/unused.csv",
            "METROPT_FALLBACK_URL": "http://127.0.0.1:1/unused.csv",
        }
        base.update(overrides)
        return Settings.from_env(env(**base))

    return build


def _target(tmp_path: Path, name: str = CANONICAL) -> Path:
    directory = tmp_path / "metropt3"
    directory.mkdir(exist_ok=True)
    return directory / name


def test_downloads_a_plain_csv(
    site: Callable[..., tuple[str, Site]],
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    base, state = site(**{CANONICAL: Route(200, CSV)})
    target = _target(tmp_path)

    result = ensure_dataset(
        settings(
            csv=target,
            sha256sums=sums(**{CANONICAL: CSV_SHA256}),
            METROPT_URL=f"{base}/{CANONICAL}",
        )
    )

    assert target.read_bytes() == CSV
    assert result.status == "verified"
    assert result.source == "download"
    assert result.sha256 == CSV_SHA256
    assert result.bytes == len(CSV)
    assert state.hits == [f"/{CANONICAL}"]
    assert Sidecar.load(target) is not None


def test_downloads_and_extracts_a_zip(
    site: Callable[..., tuple[str, Site]],
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    """The ``.csv`` member lands at the target; the archive and the PDF do not."""
    base, _ = site(**{"metropt.zip": Route(200, ZIP, "application/zip")})
    target = _target(tmp_path)

    result = ensure_dataset(
        settings(
            csv=target,
            sha256sums=sums(**{CANONICAL: CSV_SHA256}),
            METROPT_URL=f"{base}/metropt.zip",
        )
    )

    assert target.read_bytes() == CSV
    assert result.status == "verified"
    leftovers = sorted(path.name for path in target.parent.iterdir())
    assert leftovers == [CANONICAL, CANONICAL + ".sha256.json"]


def test_falls_back_to_the_mirror(
    site: Callable[..., tuple[str, Site]],
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    """A 404 on the primary URL is permanent, so the fallback is tried once."""
    base, state = site(**{"mirror.csv": Route(200, CSV)})
    target = _target(tmp_path)

    result = ensure_dataset(
        settings(
            csv=target,
            sha256sums=sums(**{CANONICAL: CSV_SHA256}),
            METROPT_URL=f"{base}/missing.csv",
            METROPT_FALLBACK_URL=f"{base}/mirror.csv",
        )
    )

    assert result.status == "verified"
    assert state.hits == ["/missing.csv", "/mirror.csv"]


def test_every_url_failing_exits_five(
    site: Callable[..., tuple[str, Site]],
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    base, _ = site()
    target = _target(tmp_path)

    with pytest.raises(InitError) as caught:
        ensure_dataset(
            settings(
                csv=target,
                sha256sums=sums(**{CANONICAL: CSV_SHA256}),
                METROPT_URL=f"{base}/a.csv",
                METROPT_FALLBACK_URL=f"{base}/b.csv",
            )
        )

    assert caught.value.exit_code is ExitCode.DATASET
    assert "a.csv" in caught.value.message
    assert "b.csv" in caught.value.message
    assert not target.exists()


def test_hash_mismatch_exits_five_and_leaves_nothing(
    site: Callable[..., tuple[str, Site]],
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    wrong = "0" * 64
    base, _ = site(**{CANONICAL: Route(200, CSV)})
    target = _target(tmp_path)

    with pytest.raises(InitError) as caught:
        ensure_dataset(
            settings(
                csv=target,
                sha256sums=sums(**{CANONICAL: wrong}),
                METROPT_URL=f"{base}/{CANONICAL}",
            )
        )

    assert caught.value.exit_code is ExitCode.DATASET
    assert CSV_SHA256 in caught.value.message
    assert wrong in caught.value.message
    assert "METROPT_URL" in caught.value.message
    assert list(target.parent.iterdir()) == []


def test_a_verified_file_downloads_nothing(
    site: Callable[..., tuple[str, Site]],
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    base, state = site(**{CANONICAL: Route(200, CSV)})
    target = _target(tmp_path)
    target.write_bytes(CSV)

    result = ensure_dataset(
        settings(
            csv=target,
            sha256sums=sums(**{CANONICAL: CSV_SHA256}),
            METROPT_URL=f"{base}/{CANONICAL}",
        )
    )

    assert state.hits == []
    assert result.status == "verified"
    assert result.source == "existing"
    assert Sidecar.load(target) == Sidecar(
        sha256=CSV_SHA256, size=len(CSV), mtime_ns=target.stat().st_mtime_ns
    )


def test_the_sidecar_spares_the_second_hashing(
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The second run trusts ``<file>.sha256.json`` and reads no bytes."""
    target = _target(tmp_path)
    target.write_bytes(CSV)
    built = settings(csv=target, sha256sums=sums(**{CANONICAL: CSV_SHA256}))
    assert ensure_dataset(built).status == "verified"

    calls = _count_hashing(monkeypatch)

    assert ensure_dataset(built).status == "verified"
    assert calls == []


def test_the_sidecar_is_ignored_when_the_mtime_differs(
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    """A stale digest must not let a changed file pass as verified."""
    target = _target(tmp_path)
    target.write_bytes(CSV)
    built = settings(csv=target, sha256sums=sums(**{CANONICAL: CSV_SHA256}))
    assert ensure_dataset(built).status == "verified"

    stat = target.stat()
    Sidecar.path_for(target).write_text(
        json.dumps({"sha256": "1" * 64, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns - 1}),
        encoding="utf-8",
    )

    result = ensure_dataset(built)

    assert result.sha256 == CSV_SHA256
    assert Sidecar.load(target) == Sidecar(
        sha256=CSV_SHA256, size=stat.st_size, mtime_ns=stat.st_mtime_ns
    )


def test_rehash_ignores_the_sidecar(
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = _target(tmp_path)
    target.write_bytes(CSV)
    built = settings(csv=target, sha256sums=sums(**{CANONICAL: CSV_SHA256}))
    assert ensure_dataset(built).status == "verified"

    calls = _count_hashing(monkeypatch)

    assert ensure_dataset(built, rehash=True).status == "verified"
    assert calls == [target]


def test_a_corrupt_canonical_file_is_moved_aside_and_fetched_again(
    site: Callable[..., tuple[str, Site]],
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    base, state = site(**{CANONICAL: Route(200, CSV)})
    target = _target(tmp_path)
    target.write_bytes(b"truncated download\n")

    result = ensure_dataset(
        settings(
            csv=target,
            sha256sums=sums(**{CANONICAL: CSV_SHA256}),
            METROPT_URL=f"{base}/{CANONICAL}",
        )
    )

    assert target.read_bytes() == CSV
    assert result.source == "download"
    assert state.hits == [f"/{CANONICAL}"]
    moved = [path for path in target.parent.iterdir() if ".corrupt-" in path.name]
    assert len(moved) == 1
    assert moved[0].read_bytes() == b"truncated download\n"


def test_a_corrupt_fixture_exits_five(
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    """A listed fixture with the wrong hash is a repository error."""
    target = _target(tmp_path, "ci-slice.csv")
    target.write_bytes(b"not the fixture\n")

    with pytest.raises(InitError) as caught:
        ensure_dataset(settings(csv=target, sha256sums=sums(**{"ci-slice.csv": CSV_SHA256})))

    assert caught.value.exit_code is ExitCode.DATASET
    assert target.exists()


def test_an_unlisted_fixture_is_header_checked(
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    target = _target(tmp_path, "ci-slice.csv")
    target.write_bytes(CSV)

    result = ensure_dataset(settings(csv=target, sha256sums=sums()))

    assert result.status == "unverified"
    assert result.source == "existing"
    assert result.sha256 == CSV_SHA256


def test_an_unlisted_fixture_with_a_wrong_header_exits_five(
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    target = _target(tmp_path, "ci-slice.csv")
    target.write_bytes(WRONG_HEADER_CSV)

    with pytest.raises(InitError) as caught:
        ensure_dataset(settings(csv=target, sha256sums=sums()))

    assert caught.value.exit_code is ExitCode.DATASET
    assert "MetroPT-3 header" in caught.value.message


def test_a_missing_non_canonical_path_exits_five(
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    target = _target(tmp_path, "ci-slice.csv")

    with pytest.raises(InitError) as caught:
        ensure_dataset(settings(csv=target, sha256sums=sums()))

    assert caught.value.exit_code is ExitCode.DATASET
    assert CANONICAL in caught.value.message


def test_a_missing_canonical_file_without_an_entry_is_a_config_error(
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    """Nothing may be downloaded that no committed digest can vouch for."""
    target = _target(tmp_path)

    with pytest.raises(InitError) as caught:
        ensure_dataset(settings(csv=target, sha256sums=sums(**{"ci-slice.csv": CSV_SHA256})))

    assert caught.value.exit_code is ExitCode.CONFIG


def test_skip_dataset_does_nothing(
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    target = _target(tmp_path)

    result = ensure_dataset(settings(csv=target, sha256sums=sums(), INIT_SKIP_DATASET="1"))

    assert result.status == "skipped"
    assert result.source == "override"
    assert result.sha256 is None
    assert result.bytes == 0
    assert not target.exists()


def test_an_archive_without_a_csv_member_exits_five(
    site: Callable[..., tuple[str, Site]],
    sums: Callable[..., Path],
    settings: Callable[..., Settings],
    tmp_path: Path,
) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.writestr(DECOY_MEMBER, b"%PDF-1.7\n")
    base, _ = site(**{"metropt.zip": Route(200, buffer.getvalue(), "application/zip")})
    target = _target(tmp_path)

    with pytest.raises(InitError) as caught:
        ensure_dataset(
            settings(
                csv=target,
                sha256sums=sums(**{CANONICAL: CSV_SHA256}),
                METROPT_URL=f"{base}/metropt.zip",
            )
        )

    assert caught.value.exit_code is ExitCode.DATASET
    assert "no .csv member" in caught.value.message


def test_the_subcommand_reports_the_status_in_json(
    sums: Callable[..., Path],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """``fdp-init dataset`` exits 0 and logs one ``done`` event."""
    target = _target(tmp_path)
    target.write_bytes(CSV)
    for name, value in {
        "INIT_ROOT_DIR": str(tmp_path),
        "METROPT_CSV": str(target),
        "SHA256SUMS_PATH": str(sums(**{CANONICAL: CSV_SHA256})),
        "LOG_FORMAT": "json",
    }.items():
        monkeypatch.setenv(name, value)

    assert cli.main(["dataset"]) == int(ExitCode.OK)

    events = [
        json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")
    ]
    done = [event for event in events if event.get("step") == "dataset"]
    assert [event["event"] for event in done] == ["start", "done"]
    assert done[-1]["status"] == "verified"
    assert done[-1]["sha256"] == CSV_SHA256
    assert done[-1]["path"] == str(target)


def test_the_subcommand_maps_a_bad_dataset_to_exit_five(
    sums: Callable[..., Path],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = _target(tmp_path, "ci-slice.csv")
    target.write_bytes(WRONG_HEADER_CSV)
    for name, value in {
        "INIT_ROOT_DIR": str(tmp_path),
        "METROPT_CSV": str(target),
        "SHA256SUMS_PATH": str(sums()),
    }.items():
        monkeypatch.setenv(name, value)

    assert cli.main(["dataset", "--rehash"]) == int(ExitCode.DATASET)
