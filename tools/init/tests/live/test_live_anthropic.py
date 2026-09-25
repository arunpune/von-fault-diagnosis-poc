# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""One real structuring request on the clean fixture.

Run by hand only, with the key exported from your own ``.env``:

    set -a; source .env; set +a
    uv run --package fdp-init pytest -m live tools/init/tests/live -q -s

The key is read through :class:`Settings` and nowhere else, and nothing but
the counts of the result is printed.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from fdp_init.catalog.anthropic_structurer import MIN_ID_RECALL, AnthropicStructurer
from fdp_init.catalog.deterministic import build_catalog
from fdp_init.catalog.model import SOURCE_LLM
from fdp_init.catalog.validate import validate_catalog
from fdp_init.config import Settings
from fdp_init.manual.extract import extract_manual

pytestmark = pytest.mark.live

CLEAN_PDF = (
    Path(__file__).resolve().parents[1] / "fixtures" / "mini-manual" / "mini-manual-clean.pdf"
)


@pytest.fixture
def settings(request: pytest.FixtureRequest) -> Settings:
    """The environment's settings, or a skip unless the run asked for this test.

    A key exported in a developer's shell must not turn ``make test-py`` into
    a paid call, so the marker has to be selected explicitly as well.
    """
    if "live" not in str(request.config.getoption("markexpr") or ""):
        pytest.skip("the live structuring smoke runs only with -m live")
    settings = Settings.from_env()
    if not settings.llm_api_key:
        pytest.skip("LLM_API_KEY is not set; the live structuring smoke is opt-in")
    return settings


def test_the_structurer_reconciles_the_clean_fixture(settings: Settings) -> None:
    doc = extract_manual(CLEAN_PDF)
    draft = build_catalog(doc)

    result = AnthropicStructurer(settings).structure(doc, draft)

    kept = set(draft.fault_ids) & set(result.catalog.fault_ids)
    recall = len(kept) / len(set(draft.fault_ids))
    report = validate_catalog(result.catalog, settings.contracts_dir, doc)
    usage = result.usage or {}
    # The counts are the smoke's whole report; nothing else is printed.
    print(
        f"source={result.source} fallback_reason={result.fallback_reason} "
        f"model={usage.get('model')} input_tokens={usage.get('input_tokens')} "
        f"output_tokens={usage.get('output_tokens')} conditions={len(result.catalog.conditions)} "
        f"causes={len(result.catalog.causes)} fault_ids={len(result.catalog.fault_ids)} "
        f"recall={recall:.2f} invalid_entries={len(report.invalid_entries)}"
    )
    assert result.source == SOURCE_LLM, result.fallback_reason
    assert recall >= MIN_ID_RECALL
    assert report.structural_errors == []
    assert report.invalid_entries == []
