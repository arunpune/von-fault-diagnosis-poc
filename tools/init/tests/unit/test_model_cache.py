# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The model cache against an in-process HTTP server.

No network and no 91 MB: the pin under test names two tiny bodies and carries
their real SHA-256, and ``spec.HUGGINGFACE_RESOLVE`` is pointed at an
``http.server`` on an ephemeral port, so :func:`ensure_model` runs through the
real :func:`~fdp_init.util.fetch.fetch_to_file` exactly as it does in
production. The server counts requests, which is how "a warm cache downloads
nothing" is proven rather than assumed.
"""

from __future__ import annotations

import hashlib
import http.server
import json
import os
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from fdp_init.embed import spec as specmod
from fdp_init.embed.model_cache import ensure_model, file_path, model_dir
from fdp_init.embed.spec import EmbeddingSpec
from fdp_init.errors import ExitCode, InitError
from fdp_init.util.fetch import FetchResult
from fdp_init.util.hashing import SIDECAR_SUFFIX, Sidecar

MODEL_ID = "fdp-test/tiny-embedder"
REVISION = "0123456789abcdef0123456789abcdef01234567"

GRAPH_PATH = "onnx/model.onnx"
TOKENIZER_PATH = "tokenizer.json"

GRAPH_BODY = b"onnx-graph-bytes\n" * 64
TOKENIZER_BODY = b'{"model": "tiny"}\n' * 16

BODIES = {GRAPH_PATH: GRAPH_BODY, TOKENIZER_PATH: TOKENIZER_BODY}

SHUTDOWN_TIMEOUT_S = 5.0

TIMEOUT_S = 10.0
RETRIES = 2


def digest(body: bytes) -> str:
    """The hex SHA-256 the pin has to carry for ``body``."""
    return hashlib.sha256(body).hexdigest()


def pin_document(*, sha256: dict[str, str] | None = None) -> dict[str, object]:
    """A complete ``embedding.json`` for the two fake files."""
    digests = sha256 or {path: digest(body) for path, body in BODIES.items()}
    return {
        "model_id": MODEL_ID,
        "revision": REVISION,
        "license": "Apache-2.0",
        "dimension": 8,
        "pooling": "mean",
        "normalize": True,
        "max_tokens": 32,
        "query_prefix": "",
        "passage_prefix": "",
        "onnx": {"inputs": ["input_ids", "attention_mask"], "output": "last_hidden_state"},
        "files": [
            {"path": path, "sha256": digests[path], "bytes": len(body)}
            for path, body in BODIES.items()
        ],
        "fixture": "fixtures/embeddings/tiny.json",
    }


class _Handler(http.server.BaseHTTPRequestHandler):
    """Serves ``/<model_id>/resolve/<revision>/<path>`` from :data:`BODIES`."""

    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        # The name is BaseHTTPRequestHandler's contract, not a style choice.
        requests: list[str] = self.server.requests  # type: ignore[attr-defined]
        requests.append(self.path)
        name = next((path for path in BODIES if self.path.endswith(path)), None)
        if name is None:
            self.send_error(404, "no such file")
            return
        body = BODIES[name]
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        """Keep the test output clean."""


@pytest.fixture
def requests(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    """Serve the fake model files locally and point the pin at the server.

    Yields the list of paths the server was asked for, newest last.
    """
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    log: list[str] = []
    server.requests = log  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[0], server.server_address[1]
    monkeypatch.setattr(
        specmod,
        "HUGGINGFACE_RESOLVE",
        f"http://{host}:{port}/{{model_id}}/resolve/{{revision}}/{{path}}",
    )
    try:
        yield log
    finally:
        server.shutdown()
        thread.join(timeout=SHUTDOWN_TIMEOUT_S)
        server.server_close()


@pytest.fixture
def spec(tmp_path: Path) -> EmbeddingSpec:
    """The pin for the two fake files, loaded the production way."""
    path = tmp_path / "embedding.json"
    path.write_text(json.dumps(pin_document()), encoding="utf-8")
    return EmbeddingSpec.load(path)


@pytest.fixture
def cache(tmp_path: Path) -> Path:
    """An empty ``MODEL_CACHE_DIR``."""
    return tmp_path / "models"


def fill(spec: EmbeddingSpec, cache: Path) -> None:
    """Download both files into ``cache``."""
    ensure_model(spec, cache, timeout_s=TIMEOUT_S, retries=RETRIES)


def test_a_cold_cache_downloads_both_files_with_sidecars(
    spec: EmbeddingSpec, cache: Path, requests: list[str]
) -> None:
    files = ensure_model(spec, cache, timeout_s=TIMEOUT_S, retries=RETRIES)

    directory = cache / "fdp-test--tiny-embedder" / REVISION
    assert model_dir(spec, cache) == directory
    assert files.model_path == directory / GRAPH_PATH
    assert files.tokenizer_path == directory / TOKENIZER_PATH
    assert files.revision == REVISION
    assert files.model_path.read_bytes() == GRAPH_BODY
    assert files.tokenizer_path.read_bytes() == TOKENIZER_BODY

    for path, body in ((files.model_path, GRAPH_BODY), (files.tokenizer_path, TOKENIZER_BODY)):
        sidecar = Sidecar.load(path)
        assert sidecar is not None
        assert sidecar.sha256 == digest(body)
        assert sidecar.matches(path)
    assert len(requests) == 2


def test_the_cache_layout_is_the_one_the_backend_reads(spec: EmbeddingSpec, cache: Path) -> None:
    assert file_path(spec, cache, spec.onnx_file()).relative_to(cache) == Path(
        "fdp-test--tiny-embedder", REVISION, GRAPH_PATH
    )


def test_a_warm_cache_makes_no_request(
    spec: EmbeddingSpec, cache: Path, requests: list[str]
) -> None:
    fill(spec, cache)
    requests.clear()

    files = ensure_model(spec, cache, timeout_s=TIMEOUT_S, retries=RETRIES)

    assert requests == []
    assert files.model_path.read_bytes() == GRAPH_BODY


def test_a_warm_cache_never_calls_the_downloader(
    spec: EmbeddingSpec, cache: Path, requests: list[str]
) -> None:
    fill(spec, cache)
    requests.clear()

    def refuse(url: str, dest: Path, **kwargs: object) -> FetchResult:
        raise AssertionError(f"a warm cache asked for {url}")

    ensure_model(spec, cache, refuse, timeout_s=TIMEOUT_S, retries=RETRIES)
    assert requests == []


def test_a_truncated_file_is_downloaded_again(
    spec: EmbeddingSpec, cache: Path, requests: list[str]
) -> None:
    fill(spec, cache)
    target = file_path(spec, cache, spec.onnx_file())
    target.write_bytes(GRAPH_BODY[:10])
    requests.clear()

    ensure_model(spec, cache, timeout_s=TIMEOUT_S, retries=RETRIES)

    assert len(requests) == 1
    assert target.read_bytes() == GRAPH_BODY


def test_a_corrupt_file_of_the_right_size_is_downloaded_again(
    spec: EmbeddingSpec, cache: Path, requests: list[str]
) -> None:
    """Same size, different bytes: only re-hashing can catch this one.

    The mtime is moved by a whole second so the run does not depend on how
    fine-grained the filesystem's timestamps are: the sidecar is then
    certainly stale, the file is hashed again and the mismatch is found.
    """
    fill(spec, cache)
    target = file_path(spec, cache, spec.onnx_file())
    stamped = Sidecar.load(target)
    assert stamped is not None
    target.write_bytes(b"\x00" * len(GRAPH_BODY))
    moved = stamped.mtime_ns + 1_000_000_000
    os.utime(target, ns=(moved, moved))
    requests.clear()

    ensure_model(spec, cache, timeout_s=TIMEOUT_S, retries=RETRIES)

    assert len(requests) == 1
    assert target.read_bytes() == GRAPH_BODY
    sidecar = Sidecar.load(target)
    assert sidecar is not None
    assert sidecar.sha256 == digest(GRAPH_BODY)
    assert sidecar.matches(target)


def test_a_missing_file_next_to_a_good_one_is_downloaded_alone(
    spec: EmbeddingSpec, cache: Path, requests: list[str]
) -> None:
    fill(spec, cache)
    tokenizer = file_path(spec, cache, spec.tokenizer_file())
    tokenizer.unlink()
    Sidecar.path_for(tokenizer).unlink()
    requests.clear()

    ensure_model(spec, cache, timeout_s=TIMEOUT_S, retries=RETRIES)

    assert len(requests) == 1
    assert requests[0].endswith(TOKENIZER_PATH)


def test_a_wrong_hash_fails_with_the_model_exit_code_and_leaves_nothing(
    tmp_path: Path, cache: Path, requests: list[str]
) -> None:
    wrong = {path: digest(body + b"drift") for path, body in BODIES.items()}
    path = tmp_path / "embedding.json"
    path.write_text(json.dumps(pin_document(sha256=wrong)), encoding="utf-8")
    spec = EmbeddingSpec.load(path)

    with pytest.raises(InitError) as caught:
        ensure_model(spec, cache, timeout_s=TIMEOUT_S, retries=RETRIES)

    assert caught.value.exit_code is ExitCode.MODEL
    assert caught.value.step == "model"
    target = file_path(spec, cache, spec.onnx_file())
    assert not target.exists()
    assert not Sidecar.path_for(target).exists()
    assert not target.with_name(target.name + ".part").exists()
    assert requests != []


def test_an_unreachable_file_fails_with_the_model_exit_code(
    spec: EmbeddingSpec, cache: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        specmod, "HUGGINGFACE_RESOLVE", "http://127.0.0.1:1/{model_id}/{revision}/{path}"
    )
    with pytest.raises(InitError) as caught:
        ensure_model(spec, cache, timeout_s=1.0, retries=1)
    assert caught.value.exit_code is ExitCode.MODEL


def test_an_unknown_file_gives_the_model_exit_code(
    spec: EmbeddingSpec, cache: Path, requests: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        specmod,
        "HUGGINGFACE_RESOLVE",
        specmod.HUGGINGFACE_RESOLVE.replace("{path}", "{path}.gone"),
    )
    with pytest.raises(InitError) as caught:
        ensure_model(spec, cache, timeout_s=TIMEOUT_S, retries=1)
    assert caught.value.exit_code is ExitCode.MODEL
    assert "404" in caught.value.message
    assert requests != []


def test_the_sidecar_suffix_is_the_one_the_dataset_step_uses(
    spec: EmbeddingSpec, cache: Path, requests: list[str]
) -> None:
    fill(spec, cache)
    assert len(requests) == 2
    target = file_path(spec, cache, spec.onnx_file())
    assert (target.parent / (target.name + SIDECAR_SUFFIX)).is_file()
