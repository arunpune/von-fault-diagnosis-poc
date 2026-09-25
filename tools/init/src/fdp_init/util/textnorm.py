# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Text normalisation shared by the extractor, the profiles and the catalog.

Small and deterministic on purpose: the same PDF bytes must give the same
catalog JSON, so every string that reaches an
identifier or a header match goes through the same few functions.
"""

from __future__ import annotations

import re
import unicodedata

_WHITESPACE = re.compile(r"\s+")
_PUNCTUATION = re.compile(r"[^\w\s]+", re.UNICODE)
_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_HYPHEN_BREAK = re.compile("(?<=[^\\W\\d_])[-\\u2010\\u2011]\\r?\\n(?=[^\\W\\d_])")
_SOFT_HYPHEN = "\u00ad"

SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9(])")
"""Where one sentence ends and the next begins.

The single definition in this tool, because two consumers must agree on it: the
chunker splits an over-long paragraph here and the catalog builder splits
a cell of move sentences here, so a cell and the chunk that carries it
can never disagree about where a sentence ended. A stop counts only when what
follows opens a sentence — a capital, a digit or a bracket — which leaves
``7.0 bar`` and ``Rev. A`` whole.
"""


def norm_ws(text: str) -> str:
    """Collapse every run of whitespace to one space and strip the ends.

    Non-breaking spaces and soft hyphens come out of PDF text extraction and
    are invisible in a diff, so they are removed here rather than later.
    """
    cleaned = text.replace(_SOFT_HYPHEN, "").replace("\u00a0", " ")
    return _WHITESPACE.sub(" ", cleaned).strip()


def norm_header_cell(text: str) -> str:
    """Normalise a table header cell for the synonym match.

    Lower-cased, punctuation removed, whitespace collapsed — so ``"Fault id"``,
    ``"fault-id"`` and ``"FAULT ID."`` all become ``fault id``.
    """
    return norm_ws(_PUNCTUATION.sub(" ", norm_ws(text).lower()))


def dehyphenate(text: str) -> str:
    """Join a word a line break split with a hyphen.

    The hyphen must sit between two letters and be followed by the line break
    itself, so ``"tempera-\nture"`` becomes ``"temperature"`` while a real
    hyphen inside a line (``"cut-out"``) and a dangling one before a whole
    word (``"start- and stop"``) are left alone. Callers therefore run this
    *before* :func:`norm_ws` collapses the line breaks.
    """
    return _HYPHEN_BREAK.sub("", text)


def slug(text: str) -> str:
    """Lower-case identifier: non-alphanumerics become ``_``, runs collapse.

    ``"Oil temperature high"`` gives ``oil_temperature_high``. Accents are
    folded first so a stray ``é`` does not turn into a separator. This is the
    *fallback* for a condition id when the manual prints none; the manual of
    this repo prints the id, so slugging never has to guess.
    """
    folded = unicodedata.normalize("NFKD", text)
    ascii_only = folded.encode("ascii", "ignore").decode("ascii")
    return _NON_ALNUM.sub("_", ascii_only.lower()).strip("_")


def split_sentences(text: str) -> list[str]:
    """Split ``text`` on :data:`SENTENCE_BOUNDARY`; empty pieces are dropped."""
    return [part for part in (norm_ws(piece) for piece in SENTENCE_BOUNDARY.split(text)) if part]
