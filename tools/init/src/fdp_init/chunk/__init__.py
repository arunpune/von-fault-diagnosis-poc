# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Chunking: the retrieval units.

One module, re-exported here so the pipeline and the store import ``Chunk`` and
:func:`chunk_manual` from the package rather than from the file they happen to
live in.
"""

from fdp_init.chunk.chunker import (
    HARD_MAX_MARGIN,
    OVERLAP_SENTENCES,
    TARGET_TOKENS,
    Chunk,
    CountTokens,
    chunk_manual,
    hard_max,
)

__all__ = [
    "HARD_MAX_MARGIN",
    "OVERLAP_SENTENCES",
    "TARGET_TOKENS",
    "Chunk",
    "CountTokens",
    "chunk_manual",
    "hard_max",
]
