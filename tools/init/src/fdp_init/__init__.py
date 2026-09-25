# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""One-shot initialisation for the fault-diagnosis PoC.

The ``init`` service of the Compose stack: it waits for Postgres and the MQTT broker,
runs the migrations, downloads and verifies MetroPT-3, ingests the manual PDF
and exits 0. ``fdp_init.cli`` is the entry point; each sub-command lives in
``fdp_init.commands`` and is imported only when it runs.
"""

__version__ = "0.1.0"

INGEST_VERSION = 1
"""Bumped on any change to extraction, chunking, catalog or storage semantics.

It is part of the idempotency key, so a bump forces a re-ingest on upgrade
without touching the PDF.
"""

__all__ = ["INGEST_VERSION", "__version__"]
