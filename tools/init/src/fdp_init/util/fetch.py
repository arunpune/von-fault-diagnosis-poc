# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The streaming downloader shared by the dataset and the model cache.

Built on the standard library alone (no ``httpx``, no ``huggingface_hub``): a
``.part`` file that survives a cut connection, a ``Range`` resume that restarts
cleanly when the server ignores it, a streaming SHA-256 over the whole file
including the part already on disk, and retries on the failures that are worth
retrying. A digest mismatch deletes the file so a later run cannot mistake it
for a good one.
"""

from __future__ import annotations

import hashlib
import http.client
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path

from tenacity import (
    Retrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
    wait_random,
)

from fdp_init import __version__

STEP = "fetch"

BLOCK_SIZE = 1024 * 1024
"""1 MiB reads: large enough to keep the loop cheap on a 218 MB file."""

READ_TIMEOUT_S = 60.0
"""Per-read socket timeout; the whole download has its own budget."""

PROGRESS_FRACTION = 0.05
PROGRESS_INTERVAL_S = 30.0

RETRY_MIN_WAIT_S = 2.0
RETRY_MAX_WAIT_S = 60.0
RETRY_JITTER_S = 1.0

RETRYABLE_STATUS = frozenset({408, 429, *range(500, 600)})
"""408, 429 and every 5xx; any other 4xx is a permanent answer."""

PART_SUFFIX = ".part"

ALLOWED_SCHEMES = frozenset({"http", "https"})

DEFAULT_USER_AGENT = f"fdp-init/{__version__}"

logger = logging.getLogger(__name__)


class FetchError(Exception):
    """A download that will not succeed by trying again."""


class FetchTimeoutError(FetchError):
    """The whole-download budget ``timeout_s`` ran out."""


class HashMismatch(FetchError):  # noqa: N818 - a published name, kept as it is
    """The download completed but its SHA-256 is not the expected one."""

    def __init__(self, url: str, expected: str, actual: str) -> None:
        super().__init__(f"{url} hashed to {actual}, expected {expected}")
        self.url = url
        self.expected = expected
        self.actual = actual


class _TransientError(Exception):
    """A network hiccup: retry within the attempt budget."""


@dataclass(frozen=True, slots=True)
class _Download:
    """The per-download state every attempt of one URL shares."""

    url: str
    part: Path
    user_agent: str
    resume: bool
    deadline: float
    started: float


@dataclass(frozen=True, slots=True)
class FetchResult:
    """What one successful :func:`fetch_to_file` produced."""

    path: Path
    sha256: str
    bytes: int
    resumed: bool
    attempts: int


def _check_scheme(url: str) -> None:
    """Refuse anything that is not plain HTTP(S)."""
    scheme = url.split(":", 1)[0].lower()
    if scheme not in ALLOWED_SCHEMES:
        raise FetchError(f"only http and https URLs are downloaded, got {url!r}")


def _open(url: str, *, offset: int, user_agent: str) -> http.client.HTTPResponse:
    """Open ``url``, asking to continue at ``offset`` when it is non-zero."""
    request = urllib.request.Request(  # noqa: S310 - the scheme is checked above
        url,
        headers={"User-Agent": user_agent, "Accept-Encoding": "identity"},
    )
    if offset:
        request.add_header("Range", f"bytes={offset}-")
    # urlopen is typed as returning Any for non-HTTP handlers; _check_scheme
    # has already refused everything but http and https.
    opened: http.client.HTTPResponse = urllib.request.urlopen(  # noqa: S310
        request, timeout=READ_TIMEOUT_S
    )
    return opened


def _total_bytes(response: http.client.HTTPResponse, offset: int) -> int | None:
    """The expected final size, from ``Content-Length`` and the offset."""
    raw = response.headers.get("Content-Length")
    if raw is None:
        return None
    try:
        return int(raw) + offset
    except ValueError:
        return None


def _prefix_digest(part: Path, size: int) -> hashlib._Hash:
    """Re-hash the bytes already on disk so the digest covers the whole file."""
    digest = hashlib.sha256()
    with part.open("rb") as handle:
        remaining = size
        while remaining > 0 and (block := handle.read(min(BLOCK_SIZE, remaining))):
            digest.update(block)
            remaining -= len(block)
    return digest


def _log_progress(url: str, done: int, total: int | None, started: float) -> None:
    """One progress line, at most every 5 % or 30 s."""
    logger.info(
        "download progress",
        extra={
            "step": STEP,
            "url": url,
            "bytes": done,
            "total_bytes": total,
            "percent": round(100 * done / total, 1) if total else None,
            "elapsed_s": round(time.monotonic() - started, 1),
        },
    )


def _stream(
    response: http.client.HTTPResponse,
    job: _Download,
    mode: str,
    digest: hashlib._Hash,
    done: int,
) -> int:
    """Copy the response body into the part file, hashing as it goes.

    Returns:
        The number of bytes in the part file afterwards.

    Raises:
        _TransientError: the connection dropped mid-body.
        FetchTimeoutError: the whole-download budget ran out.
    """
    total = _total_bytes(response, done if mode == "ab" else 0)
    step_bytes = int(total * PROGRESS_FRACTION) if total else 0
    next_mark = done + step_bytes
    last_log = time.monotonic()
    with job.part.open(mode) as handle:
        while True:
            if time.monotonic() > job.deadline:
                raise FetchTimeoutError(f"{job.url} did not finish within the download budget")
            try:
                block = response.read(BLOCK_SIZE)
            except (TimeoutError, http.client.IncompleteRead, OSError) as exc:
                raise _TransientError(f"read failed after {done} bytes: {exc}") from exc
            if not block:
                break
            handle.write(block)
            digest.update(block)
            done += len(block)
            now = time.monotonic()
            by_size = bool(step_bytes) and done >= next_mark
            if by_size or now - last_log >= PROGRESS_INTERVAL_S:
                _log_progress(job.url, done, total, job.started)
                next_mark = done + step_bytes
                last_log = now
    if total is not None and done != total:
        raise _TransientError(f"truncated body: {done} of {total} bytes")
    return done


def _attempt(job: _Download) -> tuple[str, int, bool]:
    """One download attempt; returns ``(sha256, bytes, resumed)``."""
    offset = job.part.stat().st_size if job.resume and job.part.exists() else 0
    try:
        response = _open(job.url, offset=offset, user_agent=job.user_agent)
    except urllib.error.HTTPError as exc:
        if exc.code == HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE and offset:
            job.part.unlink(missing_ok=True)
            raise _TransientError("server rejected the resume range; restarting") from exc
        if exc.code in RETRYABLE_STATUS:
            raise _TransientError(f"HTTP {exc.code}") from exc
        raise FetchError(f"{job.url} answered HTTP {exc.code} {exc.reason}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise _TransientError(str(exc)) from exc

    with response:
        resumed = offset > 0 and response.status == HTTPStatus.PARTIAL_CONTENT
        if resumed:
            digest = _prefix_digest(job.part, offset)
            done = offset
            mode = "ab"
        else:
            # Either a fresh download or a server that ignored Range and
            # answered 200: start the file and the digest from zero.
            digest = hashlib.sha256()
            done = 0
            mode = "wb"
        done = _stream(response, job, mode, digest, done)
    return digest.hexdigest(), done, resumed


def fetch_to_file(  # noqa: PLR0913 - the published signature
    url: str,
    dest: Path,
    *,
    expected_sha256: str | None = None,
    timeout_s: float,
    retries: int,
    resume: bool = True,
    user_agent: str = DEFAULT_USER_AGENT,
) -> FetchResult:
    """Download ``url`` to ``dest``, verified and resumable.

    The body is streamed into ``<dest>.part``; the file only appears under its
    real name once the digest is known and, when ``expected_sha256`` is given,
    matches. That makes an interrupted ``make up`` safe to repeat.

    Args:
        url: An ``http://`` or ``https://`` URL. Redirects are followed.
        dest: The final path. Its parent is created.
        expected_sha256: The committed digest, from ``data/SHA256SUMS`` or
            ``embedding.json``.
        timeout_s: Budget for the whole download, retries included.
        retries: Attempts per URL before giving up.
        resume: Send ``Range`` when a ``.part`` file is already there.
        user_agent: Sent on every request.

    Returns:
        The path, digest, size, whether a resume happened and how many
        attempts it took.

    Raises:
        HashMismatch: the digest differs; ``dest`` and the ``.part`` file are
            removed first.
        FetchTimeoutError: ``timeout_s`` ran out.
        FetchError: a permanent HTTP answer, or a non-HTTP URL.
    """
    _check_scheme(url)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + PART_SUFFIX)
    started = time.monotonic()
    deadline = started + timeout_s
    attempts = 0

    job = _Download(
        url=url,
        part=part,
        user_agent=user_agent,
        resume=resume,
        deadline=deadline,
        started=started,
    )
    retrying = Retrying(
        stop=stop_after_attempt(retries),
        wait=wait_exponential(multiplier=1, min=RETRY_MIN_WAIT_S, max=RETRY_MAX_WAIT_S)
        + wait_random(0, RETRY_JITTER_S),
        retry=retry_if_exception_type(_TransientError),
        reraise=True,
    )
    digest = ""
    size = 0
    resumed = False
    try:
        for attempt in retrying:
            with attempt:
                attempts += 1
                if time.monotonic() > deadline:
                    raise FetchTimeoutError(f"{url} did not finish within {timeout_s:g} s")
                digest, size, resumed = _attempt(job)
    except _TransientError as exc:
        raise FetchError(f"{url} failed after {attempts} attempt(s): {exc}") from exc

    if expected_sha256 is not None and digest != expected_sha256:
        part.unlink(missing_ok=True)
        dest.unlink(missing_ok=True)
        raise HashMismatch(url, expected_sha256, digest)

    part.replace(dest)
    logger.info(
        "download complete",
        extra={
            "step": STEP,
            "url": url,
            "path": str(dest),
            "bytes": size,
            "sha256": digest,
            "resumed": resumed,
            "attempts": attempts,
            "elapsed_s": round(time.monotonic() - started, 1),
        },
    )
    return FetchResult(path=dest, sha256=digest, bytes=size, resumed=resumed, attempts=attempts)
