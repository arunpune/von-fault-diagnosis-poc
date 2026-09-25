# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Inputs, caches and the report writer of the extraction-quality suite.

The suite needs three committed files: the two CAU-7 manuals under
``data/manual/`` and the reference catalog ``make manual`` writes. A missing
one skips the tests that need it, with the reason, rather than failing them —
a worktree without the manual build is not an extraction regression.

Each PDF is extracted once per session: the deterministic path is the same
work whichever test asks, and it is most of the suite's run time.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pdfplumber
import pytest

from fdp_init.catalog.deterministic import build_catalog
from fdp_init.catalog.model import Catalog
from fdp_init.manual.extract import extract_manual
from fdp_init.manual.model import ManualDoc

from .reference import ReferenceCatalog, load_reference_catalog

REPO_ROOT = Path(__file__).resolve().parents[4]
MANUALS = REPO_ROOT / "data" / "manual"
REFERENCE_CATALOG = REPO_ROOT / "tools" / "eval" / "fixtures" / "catalog.json"
REPORT_PATH = REPO_ROOT / "reports" / "init-extraction-quality.json"
VENDORED_CONTRACTS = REPO_ROOT / "tools" / "init" / "tests" / "fixtures" / "contracts"
CONTRACTS = REPO_ROOT / "packages" / "contracts"
VARIANTS = ("clean", "realistic")

REPORT_SCHEMA = "urn:fdp:init:extraction-quality:v1"
"""The ``schema`` field of the report, so a reader can tell it from other reports."""


def contracts_dir() -> Path:
    """The contracts package, or init's vendored byte copy of its schemas."""
    return CONTRACTS if (CONTRACTS / "schemas").is_dir() else VENDORED_CONTRACTS


def _display(path: Path) -> str:
    """``path`` relative to the repository when it lies inside it."""
    return str(path.relative_to(REPO_ROOT)) if path.is_relative_to(REPO_ROOT) else str(path)


def require_reference(path: Path = REFERENCE_CATALOG) -> ReferenceCatalog:
    """The reference catalog at ``path``; skips the calling test when it is absent."""
    if not path.is_file():
        pytest.skip(f"{_display(path)} is absent: `make manual` writes it")
    return load_reference_catalog(path)


@dataclass(frozen=True, slots=True)
class Extraction:
    """One committed manual, run through ``extract_manual`` and ``build_catalog``."""

    variant: str
    path: Path
    doc: ManualDoc
    catalog: Catalog


class Extractions:
    """Extract each committed manual the first time a test asks for it."""

    def __init__(self, manuals: Path = MANUALS) -> None:
        self._manuals = manuals
        self._done: dict[str, Extraction] = {}

    def get(self, variant: str) -> Extraction:
        """The extraction of ``variant``; skips the calling test when the PDF is absent."""
        if variant not in self._done:
            path = self._manuals / f"cau-7-{variant}.pdf"
            if not path.is_file():
                pytest.skip(f"{_display(path)} is absent: `make manual` builds it")
            doc = extract_manual(path)
            self._done[variant] = Extraction(variant, path, doc, build_catalog(doc))
        return self._done[variant]


class QualityReport:
    """``reports/init-extraction-quality.json``, rewritten after every variant.

    Each variant's metrics are recorded as its test measures them, so the file
    holds whatever was measured even when a later assertion fails. Keys are
    sorted and nothing time-dependent is written: the same PDFs and the same
    reference give the same report.
    """

    def __init__(self, path: Path, reference: dict[str, Any]) -> None:
        self.path = path
        self._document: dict[str, Any] = {
            "schema": REPORT_SCHEMA,
            "reference": reference,
            "variants": {},
        }

    def record(self, variant: str, metrics: dict[str, Any]) -> None:
        """Store one variant's metrics and rewrite the file."""
        self._document["variants"][variant] = metrics
        self.path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(self._document, indent=2, sort_keys=True, ensure_ascii=False)
        self.path.write_text(text + "\n", encoding="utf-8")


@pytest.fixture(scope="session")
def reference() -> ReferenceCatalog:
    """The reference catalog; skips the suite when it has not been built."""
    return require_reference()


@pytest.fixture(scope="session")
def extractions() -> Extractions:
    """The per-session cache of extracted manuals."""
    return Extractions()


@pytest.fixture(scope="session")
def quality_report(reference: ReferenceCatalog) -> QualityReport:
    """The report every measuring test records into."""
    return QualityReport(
        REPORT_PATH,
        {
            "path": _display(REFERENCE_CATALOG),
            "shape": reference.shape,
            "fault_ids": len(reference.fault_ids),
            "conditions": len(reference.condition_ids),
            "rows": len(reference.pairs),
        },
    )


def _token_pattern(token: str) -> re.Pattern[str]:
    """``token`` as a whole identifier: no letter, digit or underscore on either side."""
    return re.compile(rf"(?<![A-Za-z0-9_]){re.escape(token)}(?![A-Za-z0-9_])")


def prints_token(text: str, token: str) -> bool:
    """True when ``text`` prints ``token`` as a whole identifier."""
    return _token_pattern(token).search(text) is not None


def pages_printing(path: Path, tokens: Iterable[str]) -> dict[str, list[int]]:
    """The pages of ``path`` whose text prints each token, for the misses of the report.

    The PDF is opened only when there is something to look up, so a clean run
    costs nothing here.
    """
    wanted = sorted(set(tokens))
    if not wanted:
        return {}
    patterns = {token: _token_pattern(token) for token in wanted}
    found: dict[str, list[int]] = {token: [] for token in wanted}
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            for token, pattern in patterns.items():
                if pattern.search(text):
                    found[token].append(int(page.page_number))
    return found
