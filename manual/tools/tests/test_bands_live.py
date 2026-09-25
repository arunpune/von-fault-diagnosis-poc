# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Opt-in reproducibility test against the real MetroPT-3 CSV.

Skipped unless $METROPT_CSV points at the dataset (so CI, which has no CSV,
stays green). When it runs it re-derives the bands into tmp_path and asserts
byte equality with the committed manual/spec/derived/normal-bands.json, which
is the point of deriving the bands: anyone with the dataset reproduces the file.

Run with:

    METROPT_CSV="data/metropt3/MetroPT3(AirCompressor).csv" \
    uv run --no-project --with pytest==9.1.1 --with pyyaml==6.0.3 \
        --with pandas==3.0.6 --with pyarrow==25.0.1 \
        pytest manual/tools/tests/test_bands_live.py -q
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1]
SCRIPT = TOOLS / "derive_bands.py"
COMMITTED = TOOLS.parent / "spec" / "derived" / "normal-bands.json"

EXPECTED_SHA256 = "db30ccb4ea402e3c8bf2c99db06e288d4f2a772f6928f9dbe26a920d69793e24"
EXPECTED_ROWS_TOTAL = 1516948
EXPECTED_RANGE = ["2020-02-01T00:00:00", "2020-03-01T00:00:00"]


def dataset() -> Path | None:
    raw = os.environ.get("METROPT_CSV")
    if not raw:
        return None
    path = Path(raw)
    return path if path.exists() else None


pytestmark = pytest.mark.skipif(
    dataset() is None, reason="set METROPT_CSV to the MetroPT-3 CSV to run the live derivation"
)


@pytest.fixture(scope="module")
def rederived(tmp_path_factory: pytest.TempPathFactory) -> Path:
    csv = dataset()
    assert csv is not None
    out = tmp_path_factory.mktemp("bands-live") / "normal-bands.json"
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), "--csv", str(csv), "--out", str(out)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    return out


def test_committed_file_exists() -> None:
    assert COMMITTED.exists(), f"{COMMITTED} is not committed yet"


def test_rederivation_is_byte_identical(rederived: Path) -> None:
    assert rederived.read_bytes() == COMMITTED.read_bytes()


def test_provenance_of_the_committed_file() -> None:
    prov = json.loads(COMMITTED.read_text(encoding="utf-8"))["provenance"]
    assert prov["source_sha256"] == EXPECTED_SHA256
    assert prov["source_file"] == "MetroPT3(AirCompressor).csv"
    assert prov["rows_total"] == EXPECTED_ROWS_TOTAL
    assert prov["range"] == EXPECTED_RANGE
    assert prov["range_override"] is False
    assert (
        prov["rows_used"]
        + prov["rows_dropped_gap"]
        + prov["rows_dropped_frozen"]
        + prov["rows_dropped_settle"]
        == 214850
    )
