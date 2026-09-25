# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Which structurer builds the catalog.

The deterministic builder is the default and the fallback: it needs no key, no
network and no model, and its output is the draft any other structurer has to
improve on. :func:`select_structurer` is the one place that decides, so the
pipeline never asks whether a key is set.

This module deliberately does not import the ``anthropic`` SDK at module level.
The optional Claude structurer lives in
:mod:`fdp_init.catalog.anthropic_structurer` and is imported inside the one
branch of :func:`select_structurer` that needs it, so a base install without the
``llm`` extra still runs the whole pipeline; a missing SDK degrades to the
deterministic catalog with :data:`FALLBACK_SDK_MISSING` recorded.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Protocol

from fdp_init.catalog.model import SOURCE_TABLES, Catalog
from fdp_init.config import Settings
from fdp_init.manual.model import ManualDoc

__all__ = [
    "CATALOG_MODE_LLM",
    "FALLBACK_AUTH",
    "FALLBACK_CONNECTION",
    "FALLBACK_INVALID_OUTPUT",
    "FALLBACK_MISSING_IDS",
    "FALLBACK_RATE_LIMIT",
    "FALLBACK_REFUSAL",
    "FALLBACK_SDK_ERROR",
    "FALLBACK_SDK_MISSING",
    "FALLBACK_TIMEOUT",
    "FALLBACK_TRUNCATED",
    "FALLBACK_UNKNOWN_IDS",
    "CatalogStructurer",
    "DeterministicStructurer",
    "StructureResult",
    "select_structurer",
    "status_reason",
    "stop_reason_fallback",
]

log = logging.getLogger(__name__)

STEP = "ingest"

CATALOG_MODE_LLM = "llm"
"""``Settings.catalog_mode`` when a provider and a key are both configured."""

SDK_MODULE = "anthropic"
"""The optional ``llm`` extra (tools/init/pyproject.toml); absent in a base install."""

FALLBACK_AUTH = "auth"
FALLBACK_RATE_LIMIT = "rate_limit"
FALLBACK_TIMEOUT = "timeout"
FALLBACK_CONNECTION = "connection"
FALLBACK_INVALID_OUTPUT = "invalid_output"
FALLBACK_REFUSAL = "refusal"
"""The fallback reasons of the optional LLM structurer.

``invalid_output`` covers every answer that cannot be read or does not
validate: no text block, text that is not JSON, a schema violation, a cause
declared twice or under no condition, and a section reference that neither the
answer nor the draft resolves (rule (e) failing is rule (b) failing).
"""

FALLBACK_TRUNCATED = "truncated"
"""``stop_reason`` was ``max_tokens``: the document stopped mid-way."""

FALLBACK_MISSING_IDS = "missing_ids"
"""Rule (d): the answer kept less than 90 % of the draft's distinct fault ids."""

FALLBACK_UNKNOWN_IDS = "unknown_ids"
"""Rule (c): a fault id breaks the id grammar or is not printed in the manual."""

FALLBACK_SDK_MISSING = "sdk_missing"
"""A key is configured but the optional ``llm`` extra is not installed."""

FALLBACK_SDK_ERROR = "sdk_error"
"""The SDK failed for a reason none of the HTTP classes above describes."""


def status_reason(status_code: int) -> str:
    """The reason for an HTTP status the SDK has no narrower class for."""
    return f"status_{status_code}"


def stop_reason_fallback(stop_reason: str) -> str:
    """The reason for a ``stop_reason`` other than ``end_turn``, ``refusal`` and ``max_tokens``.

    A single request with no tools and no stop sequences should never see one,
    but ``pause_turn`` or a new value of the API must still name itself in the
    report rather than read as a generic failure.
    """
    return f"stop_{stop_reason or 'missing'}"


@dataclass(frozen=True, slots=True)
class StructureResult:
    """What a structurer returned, and why, if it fell back."""

    catalog: Catalog
    source: str
    fallback_reason: str | None = None
    usage: dict[str, Any] | None = None


class CatalogStructurer(Protocol):
    """Turns the deterministic draft into the catalog the run stores."""

    @property
    def name(self) -> str:
        """How the run names this structurer in its log and its report."""
        ...

    def structure(self, doc: ManualDoc, draft: Catalog) -> StructureResult:
        """Return the catalog to store, never raising for a provider reason."""
        ...


@dataclass(frozen=True, slots=True)
class DeterministicStructurer:
    """The default: the draft *is* the catalog.

    ``fallback_reason`` is set only when this structurer stands in for a
    configured one — today that is the missing ``llm`` extra — so the ingest
    report can say why the model did not run.
    """

    name: str = "deterministic"
    fallback_reason: str | None = None

    def structure(self, doc: ManualDoc, draft: Catalog) -> StructureResult:
        """Return the draft unchanged, tagged ``tables``."""
        del doc
        return StructureResult(
            catalog=draft, source=SOURCE_TABLES, fallback_reason=self.fallback_reason
        )


def select_structurer(settings: Settings) -> CatalogStructurer:
    """Pick the structurer for this run.

    Args:
        settings: The validated configuration; ``catalog_mode`` already folds
            ``LLM_PROVIDER`` and ``LLM_API_KEY`` into the one decision.

    Returns:
        The Anthropic structurer when a provider and a key are configured and
        the optional ``llm`` extra is installed, the deterministic one in every
        other case. It is a branch of this function and not a plug-in registry
        because there are exactly two structurers and the second one is
        optional.
    """
    if settings.catalog_mode != CATALOG_MODE_LLM:
        return DeterministicStructurer()
    try:
        # Imported here and not at module level so that a base install without
        # the `llm` extra never pays for — or fails on — the SDK.
        from fdp_init.catalog.anthropic_structurer import AnthropicStructurer  # noqa: PLC0415
    except ModuleNotFoundError as error:
        if (error.name or "").partition(".")[0] != SDK_MODULE:
            raise  # a broken import of our own is a bug, not a missing extra
        log.warning(
            "a catalog model is configured but the optional anthropic SDK is not installed; "
            "the catalog is read from the fault tables",
            extra={
                "step": STEP,
                "llm_provider": settings.llm_provider,
                "fallback_reason": FALLBACK_SDK_MISSING,
            },
        )
        return DeterministicStructurer(fallback_reason=FALLBACK_SDK_MISSING)
    return AnthropicStructurer(settings)
