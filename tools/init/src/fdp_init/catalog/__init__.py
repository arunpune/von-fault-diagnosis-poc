# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The fault catalog: value model, deterministic builder, validation, provider.

The public surface is re-exported here so the pipeline, the ``export-catalog``
command and the store import from the package instead of from the module a
name happens to live in.

``catalog.provider`` never imports the Anthropic SDK; the optional LLM
structurer plugs into the extension point of
:func:`~fdp_init.catalog.provider.select_structurer`.
"""

from fdp_init.catalog.deterministic import build_catalog, split_steps
from fdp_init.catalog.model import (
    CATALOG_SCHEMA_ID,
    SOURCE_LLM,
    SOURCE_TABLES,
    Alarm,
    Catalog,
    Cause,
    Condition,
    Section,
    Signal,
    SignalMove,
    entries,
    to_catalog_document,
)
from fdp_init.catalog.provider import (
    CatalogStructurer,
    DeterministicStructurer,
    StructureResult,
    select_structurer,
)
from fdp_init.catalog.validate import ValidationReport, is_fatal, validate_catalog

__all__ = [
    "CATALOG_SCHEMA_ID",
    "SOURCE_LLM",
    "SOURCE_TABLES",
    "Alarm",
    "Catalog",
    "CatalogStructurer",
    "Cause",
    "Condition",
    "DeterministicStructurer",
    "Section",
    "Signal",
    "SignalMove",
    "StructureResult",
    "ValidationReport",
    "build_catalog",
    "entries",
    "is_fatal",
    "select_structurer",
    "split_steps",
    "to_catalog_document",
    "validate_catalog",
]
