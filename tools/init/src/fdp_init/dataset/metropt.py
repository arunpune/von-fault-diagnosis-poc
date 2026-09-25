# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Make ``METROPT_CSV`` exist and be the file it claims to be.

The decision order, in one sentence: a file that is already there is
verified against ``data/SHA256SUMS`` (or, when it is an unlisted fixture,
against the MetroPT-3 header line); a corrupt copy under the canonical name is
moved aside and fetched again; a missing file is downloaded from
``METROPT_URL`` and then ``METROPT_FALLBACK_URL``, unzipped when the payload
is an archive, and only renamed into place once its SHA-256 matches.

Nothing here parses the CSV: the header is the deepest this module ever
reads, and the 1 516 948 rows are the simulator's business.
"""

from __future__ import annotations

import logging
import shutil
import time
import zipfile
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fdp_init.config import CANONICAL_METROPT_CSV, Settings
from fdp_init.errors import ExitCode, InitError
from fdp_init.util.fetch import FetchError, fetch_to_file
from fdp_init.util.hashing import BLOCK_SIZE, Sidecar, cached_sha256, read_sha256sums, sha256_file

STEP = "dataset"

CANONICAL_NAME = Path(CANONICAL_METROPT_CSV).name
"""``MetroPT3(AirCompressor).csv``: the only name that is ever downloaded."""

METROPT_HEADER = (
    ",timestamp,TP2,TP3,H1,DV_pressure,Reservoirs,Oil_temperature,Motor_current,"
    "COMP,DV_eletric,Towers,MPG,LPS,Pressure_switch,Oil_level,Caudal_impulses"
)
"""The first line of the published CSV, misspelling included: the authors
wrote ``DV_eletric`` and every column name is kept verbatim.
"""

HEADER_READ_LIMIT = 4096
"""Characters of the first line to read; the header is about 150 of them, and
the bound keeps a file without newlines from being pulled into memory."""

PART_SUFFIX = ".part"
"""``<stem>.part`` beside the target: the payload is staged there and only
renamed once it has been unzipped and verified."""

EXTRACT_SUFFIX = ".csv"
"""Appended to the staging name while a zip member is copied out of it."""

ZIP_MAGIC = b"PK\x03\x04"

Status = Literal["verified", "unverified", "skipped"]
"""``verified`` matched a committed digest, ``unverified`` only the header,
``skipped`` means ``INIT_SKIP_DATASET=1``."""

Source = Literal["existing", "download", "override"]
"""Where the file came from: it was already on disk, it was fetched, or the
environment took the step out of the run."""

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class DatasetResult:
    """What the dataset step settled on.

    Attributes:
        path: ``METROPT_CSV``, whether or not anything was downloaded.
        sha256: The digest of the file, or ``None`` when the step was skipped.
        status: See :data:`Status`.
        source: See :data:`Source`.
        bytes: Size of the file on disk; ``0`` when the step was skipped.
        elapsed_s: Wall-clock seconds the step took.
    """

    path: Path
    sha256: str | None
    status: Status
    source: Source
    bytes: int
    elapsed_s: float


def ensure_dataset(settings: Settings, *, rehash: bool = False) -> DatasetResult:
    """Guarantee that ``settings.metropt_csv`` holds the dataset, or fail.

    Args:
        settings: The environment contract; ``METROPT_CSV``, ``METROPT_URL``,
            ``METROPT_FALLBACK_URL``, ``SHA256SUMS_PATH``, the download budget
            and ``INIT_SKIP_DATASET`` are the ones that matter here.
        rehash: ``fdp-init dataset --rehash``: ignore the sidecar cache and
            read the whole file again.

    Returns:
        The path, digest, status and provenance of the dataset.

    Raises:
        InitError: :attr:`~fdp_init.errors.ExitCode.CONFIG` when
            ``SHA256SUMS`` is unreadable or has no entry for a file that would
            have to be downloaded, and
            :attr:`~fdp_init.errors.ExitCode.DATASET` for everything else —
            a corrupt fixture, a missing non-canonical path, a download that
            failed on every URL, a payload whose digest does not match.
    """
    started = time.monotonic()
    target = settings.metropt_csv
    if settings.skip_dataset:
        logger.warning(
            "dataset step skipped by INIT_SKIP_DATASET",
            extra=_event("skipped", path=str(target), elapsed_ms=_elapsed_ms(started)),
        )
        return DatasetResult(
            path=target,
            sha256=None,
            status="skipped",
            source="override",
            bytes=0,
            elapsed_s=_elapsed_s(started),
        )

    logger.info("dataset step started", extra=_event("start", path=str(target)))
    expected = read_sha256sums(settings.sha256sums_path).get(target.name)
    if target.exists():
        existing = _use_existing(target, expected, rehash=rehash, started=started)
        if existing is not None:
            return existing
    elif target.name != CANONICAL_NAME:
        raise InitError(
            ExitCode.DATASET,
            f"METROPT_CSV points at a missing file ({target}); "
            f"only the canonical name {CANONICAL_NAME} is downloaded",
            STEP,
        )
    return _download(settings, target, expected, started)


def _use_existing(
    target: Path, expected: str | None, *, rehash: bool, started: float
) -> DatasetResult | None:
    """Judge the file that is already at ``target``.

    Returns:
        The result, or ``None`` when the copy was corrupt but carries the
        canonical name, in which case it has been moved aside and the caller
        downloads a fresh one.
    """
    if expected is None:
        _check_header(target)
        digest = cached_sha256(target, rehash=rehash)
        logger.warning(
            "dataset is not listed in SHA256SUMS; only its header was checked",
            extra=_event(
                "done",
                path=str(target),
                sha256=digest,
                status="unverified",
                source="existing",
                elapsed_ms=_elapsed_ms(started),
            ),
        )
        return _result(target, digest, "unverified", "existing", started)

    digest = cached_sha256(target, rehash=rehash)
    if digest == expected:
        logger.info(
            "dataset verified",
            extra=_event(
                "done",
                path=str(target),
                sha256=digest,
                status="verified",
                source="existing",
                elapsed_ms=_elapsed_ms(started),
            ),
        )
        return _result(target, digest, "verified", "existing", started)

    if target.name != CANONICAL_NAME:
        raise InitError(
            ExitCode.DATASET,
            f"{target} hashes to {digest} but SHA256SUMS lists {expected}; "
            "a listed fixture with the wrong hash is a repository error, not a download",
            STEP,
        )
    moved = _move_aside(target)
    logger.warning(
        "dataset was corrupt and has been moved aside",
        extra=_event("start", path=str(moved), sha256=digest, expected_sha256=expected),
    )
    return None


def _download(
    settings: Settings, target: Path, expected: str | None, started: float
) -> DatasetResult:
    """Fetch the dataset from the primary URL, then the mirror."""
    if expected is None:
        raise InitError(
            ExitCode.CONFIG,
            f"{settings.sha256sums_path} has no entry for {target.name}, "
            "so a downloaded copy could not be verified",
            STEP,
        )

    staging = target.with_suffix(PART_SUFFIX)
    urls = [settings.metropt_url]
    if settings.metropt_fallback_url != settings.metropt_url:
        urls.append(settings.metropt_fallback_url)

    failures: list[str] = []
    for index, url in enumerate(urls):
        if index:
            # A partial body from the previous URL must not be resumed against
            # a different server: the two need not serve the same bytes.
            _clear_staging(staging)
        try:
            fetch_to_file(
                url,
                staging,
                timeout_s=settings.download_timeout_s,
                retries=settings.download_retries,
                resume=True,
            )
        except FetchError as exc:
            failures.append(f"{url}: {exc}")
            logger.warning("dataset download failed", extra=_event("start", url=url))
            continue
        if _is_zip(staging, url):
            _extract_csv(staging)
        return _verify_download(target, staging, expected, url, started)

    raise InitError(
        ExitCode.DATASET,
        "could not download the MetroPT-3 dataset from any URL (" + "; ".join(failures) + ")",
        STEP,
    )


def _verify_download(
    target: Path, staging: Path, expected: str, url: str, started: float
) -> DatasetResult:
    """Hash the staged payload and, when it matches, move it into place."""
    digest = sha256_file(staging)
    if digest != expected:
        staging.unlink(missing_ok=True)
        raise InitError(
            ExitCode.DATASET,
            f"{url} delivered a file that hashes to {digest}, but SHA256SUMS lists "
            f"{expected}; point METROPT_URL at a trusted mirror or place the CSV at "
            f"{target} by hand (README, Troubleshooting)",
            STEP,
        )
    staging.replace(target)
    # A read-only mount cannot take the sidecar; the dataset is still good.
    with suppress(OSError):
        Sidecar.write(target, digest)
    logger.info(
        "dataset downloaded",
        extra=_event(
            "done",
            path=str(target),
            url=url,
            sha256=digest,
            status="verified",
            source="download",
            elapsed_ms=_elapsed_ms(started),
        ),
    )
    return _result(target, digest, "verified", "download", started)


def _check_header(target: Path) -> None:
    """Fail unless the first line of ``target`` is the MetroPT-3 header.

    The only check available for a fixture nobody listed in ``SHA256SUMS``:
    it catches a wrong file at the right path, which is the mistake that
    otherwise surfaces much later as an unreadable replay.
    """
    try:
        with target.open("r", encoding="utf-8", errors="replace") as handle:
            first = handle.readline(HEADER_READ_LIMIT)
    except OSError as exc:
        raise InitError(ExitCode.DATASET, f"cannot read {target}: {exc}", STEP) from exc
    if first.rstrip("\r\n") != METROPT_HEADER:
        raise InitError(
            ExitCode.DATASET,
            f"{target} is not listed in SHA256SUMS and does not start with the "
            f"MetroPT-3 header; its first line is {first.rstrip()[:80]!r}",
            STEP,
        )


def _move_aside(target: Path) -> Path:
    """Rename a corrupt canonical copy to ``<name>.corrupt-<utc timestamp>``."""
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    moved = target.with_name(f"{target.name}.corrupt-{stamp}")
    target.replace(moved)
    Sidecar.path_for(target).unlink(missing_ok=True)
    return moved


def _clear_staging(staging: Path) -> None:
    """Remove the staged payload and the downloader's own partial file."""
    staging.unlink(missing_ok=True)
    staging.with_name(staging.name + PART_SUFFIX).unlink(missing_ok=True)


def _is_zip(payload: Path, url: str) -> bool:
    """True when the payload should be opened as an archive.

    The magic bytes settle it for anything that was actually delivered; the
    ``.zip`` suffix of the URL is the second signal, and is
    what a server that sends no usable body would be judged on.
    """
    with payload.open("rb") as handle:
        if handle.read(len(ZIP_MAGIC)) == ZIP_MAGIC:
            return True
    return urlsplit(url).path.lower().endswith(".zip")


def _extract_csv(archive: Path) -> None:
    """Replace ``archive`` in place with the single ``.csv`` member it holds.

    The member is stream-copied in :data:`~fdp_init.util.hashing.BLOCK_SIZE`
    blocks, so a 218 MB table never becomes a 218 MB string. Everything else
    in the archive — UCI ships a description PDF — is left behind with it.
    """
    extracted = archive.with_name(archive.name + EXTRACT_SUFFIX)
    try:
        with zipfile.ZipFile(archive) as bundle:
            member = _csv_member(bundle, archive)
            with bundle.open(member) as source, extracted.open("wb") as handle:
                shutil.copyfileobj(source, handle, BLOCK_SIZE)
    except zipfile.BadZipFile as exc:
        extracted.unlink(missing_ok=True)
        raise InitError(
            ExitCode.DATASET,
            f"the download looked like a zip archive but could not be opened: {exc}",
            STEP,
        ) from exc
    archive.unlink()
    extracted.replace(archive)
    logger.info(
        "dataset archive extracted",
        extra=_event("start", member=member.filename, bytes=archive.stat().st_size),
    )


def _csv_member(bundle: zipfile.ZipFile, archive: Path) -> zipfile.ZipInfo:
    """The one member whose name ends in ``.csv``."""
    members = [
        info
        for info in bundle.infolist()
        if not info.is_dir() and info.filename.lower().endswith(".csv")
    ]
    if not members:
        raise InitError(
            ExitCode.DATASET,
            f"the archive downloaded to {archive} holds no .csv member",
            STEP,
        )
    if len(members) > 1:
        names = ", ".join(sorted(info.filename for info in members))
        raise InitError(
            ExitCode.DATASET,
            f"the archive downloaded to {archive} holds several .csv members ({names}); "
            "one was expected",
            STEP,
        )
    return members[0]


def _result(
    target: Path, digest: str, status: Status, source: Source, started: float
) -> DatasetResult:
    """Build the result for a file that is now at ``target``."""
    return DatasetResult(
        path=target,
        sha256=digest,
        status=status,
        source=source,
        bytes=target.stat().st_size,
        elapsed_s=_elapsed_s(started),
    )


def _event(event: str, **fields: object) -> dict[str, object]:
    """The ``extra`` every log line of this step carries."""
    return {"step": STEP, "event": event, **fields}


def _elapsed_s(started: float) -> float:
    return round(time.monotonic() - started, 3)


def _elapsed_ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)
