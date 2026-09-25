# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The shared model cache init fills and the backend reads.

Layout — published here because the backend mounts the same volume read-only
and must find the files by the same rule::

    MODEL_CACHE_DIR/<model_id with "/" → "--">/<revision>/<file.path>
    MODEL_CACHE_DIR/<model_id with "/" → "--">/<revision>/<file.path>.sha256.json

:func:`ensure_model` is idempotent: a warm cache is verified by its sidecar and
touches the network not at all, a missing or corrupt entry is
downloaded again through :func:`~fdp_init.util.fetch.fetch_to_file` with the
digest from the pin, and every failure becomes exit code 7.
"""

from __future__ import annotations

import logging
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from fdp_init.embed.spec import EmbeddingSpec, ModelFile
from fdp_init.errors import ExitCode, InitError
from fdp_init.util.fetch import FetchError, FetchResult, fetch_to_file
from fdp_init.util.hashing import Sidecar, cached_sha256

STEP = "model"

DEFAULT_TIMEOUT_S = 3600.0
"""``INIT_DOWNLOAD_TIMEOUT_S``'s default, for callers without settings."""

DEFAULT_RETRIES = 5
"""``INIT_DOWNLOAD_RETRIES``'s default, for callers without settings."""

logger = logging.getLogger(__name__)


class Fetch(Protocol):
    """The downloader :func:`ensure_model` calls; the tests substitute it."""

    def __call__(
        self,
        url: str,
        dest: Path,
        *,
        expected_sha256: str | None = None,
        timeout_s: float,
        retries: int,
    ) -> FetchResult: ...


@dataclass(frozen=True, slots=True)
class ModelFiles:
    """Where the verified artefacts of one revision are on disk.

    Attributes:
        model_path: The ONNX graph.
        tokenizer_path: The ``tokenizer.json`` that goes with it.
        revision: The commit both files come from, carried so the ingest
            report and ``app.ingest_runs`` can record it without the spec.
    """

    model_path: Path
    tokenizer_path: Path
    revision: str


def model_dir(spec: EmbeddingSpec, cache_dir: Path) -> Path:
    """The directory holding one revision of one model."""
    return cache_dir / spec.cache_subdir


def file_path(spec: EmbeddingSpec, cache_dir: Path, file: ModelFile) -> Path:
    """Where one pinned file lives in the cache."""
    return model_dir(spec, cache_dir) / file.path


def _fail(message: str) -> InitError:
    """Exit code 7: the model could not be cached."""
    return InitError(ExitCode.MODEL, message, STEP)


def _discard(target: Path) -> None:
    """Remove a cache entry and its sidecar, ignoring what is not there."""
    with suppress(OSError):
        target.unlink(missing_ok=True)
    with suppress(OSError):
        Sidecar.path_for(target).unlink(missing_ok=True)


def _cached(target: Path, expected: ModelFile) -> bool:
    """True when ``target`` is already the pinned file.

    The size is checked first because a truncated 90 MB download is the common
    corruption and costs nothing to spot; the digest comes from the sidecar
    when it still matches the file's size and mtime.
    """
    try:
        size = target.stat().st_size
    except OSError:
        return False
    if size != expected.bytes:
        logger.warning(
            "cached model file has the wrong size",
            extra={
                "step": STEP,
                "path": str(target),
                "bytes": size,
                "expected_bytes": expected.bytes,
            },
        )
        return False
    try:
        digest = cached_sha256(target)
    except OSError as exc:
        raise _fail(f"cannot read the cached model file {target}: {exc}") from exc
    if digest == expected.sha256:
        return True
    logger.warning(
        "cached model file has the wrong digest",
        extra={
            "step": STEP,
            "path": str(target),
            "sha256": digest,
            "expected_sha256": expected.sha256,
        },
    )
    return False


@dataclass(frozen=True, slots=True)
class _Budget:
    """How long one file may take and how often it may be tried again."""

    timeout_s: float
    retries: int


def _download(
    spec: EmbeddingSpec, file: ModelFile, target: Path, fetch: Fetch, budget: _Budget
) -> None:
    """Fetch one pinned file into the cache, verified, and record its digest."""
    url = spec.file_url(file.path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        fetch(
            url,
            target,
            expected_sha256=file.sha256,
            timeout_s=budget.timeout_s,
            retries=budget.retries,
        )
    except (FetchError, OSError) as exc:
        # fetch_to_file already removed the file on a digest mismatch; the
        # sidecar of an earlier, corrupt entry must go with it.
        _discard(target)
        raise _fail(f"cannot download {url}: {exc}") from exc
    with suppress(OSError):  # a read-only cache still has the right bytes
        Sidecar.write(target, file.sha256)


def ensure_model(
    spec: EmbeddingSpec,
    cache_dir: Path,
    fetch: Fetch = fetch_to_file,
    *,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    retries: int = DEFAULT_RETRIES,
) -> ModelFiles:
    """Make sure every file of ``spec`` is in ``cache_dir``, hash-verified.

    Args:
        spec: The pin from ``embedding.json``.
        cache_dir: ``MODEL_CACHE_DIR``; created when missing.
        fetch: The downloader, replaced in tests by an in-process server.
        timeout_s: Budget for one file, retries included.
        retries: Attempts per file before giving up.

    Returns:
        The two paths the embedder loads, plus the revision they came from.

    Raises:
        InitError: exit code 7, when a file cannot be downloaded, cannot be
            read back or does not hash to the pinned digest.
    """
    budget = _Budget(timeout_s=timeout_s, retries=retries)
    downloaded: list[str] = []
    for file in spec.files:
        target = file_path(spec, cache_dir, file)
        if _cached(target, file):
            continue
        _discard(target)
        _download(spec, file, target, fetch, budget)
        downloaded.append(file.path)

    files = ModelFiles(
        model_path=file_path(spec, cache_dir, spec.onnx_file()),
        tokenizer_path=file_path(spec, cache_dir, spec.tokenizer_file()),
        revision=spec.revision,
    )
    logger.info(
        "model cache ready",
        extra={
            "step": STEP,
            "event": "done",
            "model_id": spec.model_id,
            "revision": spec.revision,
            "cache_dir": str(model_dir(spec, cache_dir)),
            "downloaded": downloaded,
        },
    )
    return files
