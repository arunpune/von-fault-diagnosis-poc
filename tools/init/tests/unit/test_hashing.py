# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``sha256sum`` parsing and the sidecar cache."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from fdp_init.errors import ExitCode, InitError
from fdp_init.util.hashing import Sidecar, cached_sha256, read_sha256sums, sha256_file

CSV_NAME = "MetroPT3(AirCompressor).csv"

SUMS = f"""\
# data/SHA256SUMS — committed digests (no large files in Git)
db30ccb4ea402e3c8bf2c99db06e288d4f2a772f6928f9dbe26a920d69793e24  {CSV_NAME}

aab991a970e58210de853bb8078ce0e63abb4d9412fdc5c79792dae3d8e1721a *metropt+3+dataset.zip
"""


def write(path: Path, payload: bytes = b"a few bytes") -> Path:
    path.write_bytes(payload)
    return path


def test_sha256_file(tmp_path: Path) -> None:
    target = write(tmp_path / "f.bin", b"x" * (1024 * 1024 + 7))

    assert sha256_file(target) == hashlib.sha256(b"x" * (1024 * 1024 + 7)).hexdigest()


def test_read_sha256sums(tmp_path: Path) -> None:
    sums_file = tmp_path / "SHA256SUMS"
    sums_file.write_text(SUMS, encoding="utf-8")

    sums = read_sha256sums(sums_file)

    assert set(sums) == {CSV_NAME, "metropt+3+dataset.zip"}
    assert sums[CSV_NAME].startswith("db30ccb4")
    assert sums["metropt+3+dataset.zip"].startswith("aab991a9")


def test_missing_sums_file_exits_two(tmp_path: Path) -> None:
    with pytest.raises(InitError) as caught:
        read_sha256sums(tmp_path / "absent")

    assert caught.value.exit_code is ExitCode.CONFIG


def test_malformed_line_exits_two(tmp_path: Path) -> None:
    sums_file = tmp_path / "SHA256SUMS"
    sums_file.write_text("not a digest  file.csv\n", encoding="utf-8")

    with pytest.raises(InitError) as caught:
        read_sha256sums(sums_file)

    assert caught.value.exit_code is ExitCode.CONFIG
    assert "sha256sum format" in caught.value.message


def test_sidecar_round_trip(tmp_path: Path) -> None:
    target = write(tmp_path / "f.bin")
    digest = sha256_file(target)

    written = Sidecar.write(target, digest)
    loaded = Sidecar.load(target)

    assert loaded == written
    assert loaded is not None
    assert loaded.matches(target)
    assert Sidecar.path_for(target).name == "f.bin.sha256.json"


def test_sidecar_is_distrusted_after_a_change(tmp_path: Path) -> None:
    target = write(tmp_path / "f.bin")
    sidecar = Sidecar.write(target, sha256_file(target))

    write(target, b"different bytes entirely")

    assert not sidecar.matches(target)


def test_sidecar_ignores_a_broken_file(tmp_path: Path) -> None:
    target = write(tmp_path / "f.bin")
    Sidecar.path_for(target).write_text("{not json", encoding="utf-8")

    assert Sidecar.load(target) is None


def test_sidecar_ignores_missing_fields(tmp_path: Path) -> None:
    target = write(tmp_path / "f.bin")
    Sidecar.path_for(target).write_text(json.dumps({"sha256": "abc"}), encoding="utf-8")

    assert Sidecar.load(target) is None


def test_cached_sha256_reuses_a_trusted_sidecar(tmp_path: Path) -> None:
    target = write(tmp_path / "f.bin")
    cached_sha256(target)
    Sidecar.path_for(target).write_text(
        json.dumps(
            {
                "sha256": "cafe" * 16,
                "size": target.stat().st_size,
                "mtime_ns": target.stat().st_mtime_ns,
            }
        ),
        encoding="utf-8",
    )

    assert cached_sha256(target) == "cafe" * 16
    assert cached_sha256(target, rehash=True) == sha256_file(target)
