# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Text normalisation shared by the term list, the digests and the scanner.

The normal form is: Unicode NFKC, casefold, every run of non-alphanumeric
characters collapsed to one space. Both the terms and the scanned text go
through it, so ``Zorblax-Kompressoren``,
``ZORBLAX  KOMPRESSOREN`` and ``zorblax_kompressoren`` are the same phrase.

Casefolding happens per character *after* the whole string is NFKC-normalised,
which keeps every token's column in the NFKC form of the line: the scanner
needs those columns to report ``path:line:col``.
"""

import re
import unicodedata
from dataclasses import dataclass
from typing import Final

__all__ = [
    "Token",
    "canonical",
    "concatenated",
    "logical_lines",
    "nfkc",
    "normalize",
    "tokenize",
    "tokens",
]

#: A run of characters for which ``str.isalnum()`` holds; ``_`` separates.
_WORD_RE: Final = re.compile(r"[^\W_]+")


@dataclass(frozen=True, slots=True)
class Token:
    """One alphanumeric run, with its half-open column range in the NFKC text."""

    text: str
    start: int
    end: int


def nfkc(text: str) -> str:
    """The NFKC form of ``text``; columns reported by the scanner refer to it."""
    return unicodedata.normalize("NFKC", text)


def tokenize(text: str) -> list[Token]:
    """Split ``text`` into normalised tokens with their columns in ``nfkc(text)``."""
    folded = nfkc(text)
    return [
        Token(match.group(0).casefold(), match.start(), match.end())
        for match in _WORD_RE.finditer(folded)
    ]


def tokens(text: str) -> list[str]:
    """The normalised tokens of ``text`` without their positions."""
    return [token.text for token in tokenize(text)]


def canonical(text: str) -> str:
    """The normal form of ``text``: tokens joined by exactly one space."""
    return " ".join(tokens(text))


def concatenated(text: str) -> str:
    """The normal form of ``text`` with the token separators removed."""
    return "".join(tokens(text))


def normalize(text: str) -> str:
    """The canonical form padded with one space, for whole-word phrase tests."""
    return f" {canonical(text)} "


def logical_lines(text: str) -> list[tuple[int, str]]:
    """Physical lines with ``-\\n`` hyphenation joined (PDF text runs into it).

    Each entry is ``(physical line number of the first segment, joined text)``,
    so a hit keeps a line number that points into the file as it is on disk.
    """
    joined: list[tuple[int, str]] = []
    pending: list[str] = []
    number = 0
    start = 1
    for raw in text.splitlines():
        number += 1
        if not pending:
            start = number
        if len(raw) > 1 and raw.endswith("-") and raw[-2].isalnum():
            pending.append(raw[:-1])
            continue
        pending.append(raw)
        joined.append((start, "".join(pending)))
        pending.clear()
    if pending:
        joined.append((start, "".join(pending)))
    return joined
