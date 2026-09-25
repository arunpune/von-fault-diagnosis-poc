# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The dataset step against the real artefacts.

Two opt-in checks that the in-process server of ``tests/unit/test_dataset.py``
cannot give: that the published URL still serves the bytes ``data/SHA256SUMS``
was written from, and that the copy already in the checkout passes the same
gate. Both are skipped by default — the first downloads about 218 MB, the
second needs the gitignored CSV — so an ordinary ``make test`` runs neither.

    INIT_TEST_REAL_DOWNLOAD=1 uv run --package fdp-init pytest -m network \\
        tools/init/tests/integration/test_dataset_real_download.py -q
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from fdp_init.config import Settings, find_root
from fdp_init.dataset.metropt import CANONICAL_NAME, METROPT_HEADER, ensure_dataset
from fdp_init.util.hashing import read_sha256sums

pytestmark = pytest.mark.network

REAL_DOWNLOAD_FLAG = "INIT_TEST_REAL_DOWNLOAD"

DOWNLOAD_BUDGET_S = "3600"


def _sha256sums() -> Path:
    """The committed ``data/SHA256SUMS`` of this checkout."""
    return find_root() / "data" / "SHA256SUMS"


def _local_csv() -> Path:
    """Where the full dataset lives when somebody has already fetched it."""
    return find_root() / "data" / "metropt3" / CANONICAL_NAME


def _settings(csv: Path) -> Settings:
    """Settings for one dataset run, with every other path left at default."""
    return Settings.from_env(
        {
            "INIT_ROOT_DIR": str(find_root()),
            "METROPT_CSV": str(csv),
            "SHA256SUMS_PATH": str(_sha256sums()),
            "INIT_DOWNLOAD_TIMEOUT_S": DOWNLOAD_BUDGET_S,
        }
    )


@pytest.mark.skipif(
    os.environ.get(REAL_DOWNLOAD_FLAG) != "1",
    reason=f"set {REAL_DOWNLOAD_FLAG}=1 to download about 218 MB from the published URL",
)
def test_the_published_url_still_serves_the_committed_bytes(tmp_path: Path) -> None:
    """Download into a temporary directory and check the committed digest."""
    expected = read_sha256sums(_sha256sums())[CANONICAL_NAME]
    target = tmp_path / "metropt3" / CANONICAL_NAME

    result = ensure_dataset(_settings(target))

    assert result.status == "verified"
    assert result.source == "download"
    assert result.sha256 == expected
    assert target.is_file()


def test_the_checkout_copy_passes_the_same_gate(tmp_path: Path) -> None:
    """Verify the local dataset without writing anything next to it.

    The run happens through a symlink in ``tmp_path``, so the sidecar and any
    file the step would move aside land in the temporary directory and the
    gitignored original is only ever read.
    """
    original = _local_csv()
    if not original.is_file():
        pytest.skip(f"{original} is not in this checkout")

    link = tmp_path / CANONICAL_NAME
    link.symlink_to(original.resolve())
    expected = read_sha256sums(_sha256sums())[CANONICAL_NAME]

    result = ensure_dataset(_settings(link))

    assert result.status == "verified"
    assert result.source == "existing"
    assert result.sha256 == expected
    assert not (original.parent / f"{CANONICAL_NAME}.sha256.json").exists()


def test_the_header_constant_matches_the_checkout_copy() -> None:
    """The constant every unlisted fixture is judged against, against reality."""
    original = _local_csv()
    if not original.is_file():
        pytest.skip(f"{original} is not in this checkout")

    with original.open("r", encoding="utf-8") as handle:
        assert handle.readline(4096).rstrip("\r\n") == METROPT_HEADER
