# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""One built PDF as the acceptance checks read it.

:class:`PdfText` wraps pdfplumber 0.11.10 so the PDF-level checks (#3, #4, #5
and #9) all see the same extraction: one instance per PDF per run, every
derived view computed once.

Three details are load-bearing and spelled out here rather than in each check.

* ``pages`` uses ``page.extract_text()`` with the library defaults and
  ``joined`` glues them with a form feed, because that is the definition of
  ``manifest.text_sha256`` which check #9 compares.
* ``tables_by_page`` uses the ruled-line strategy of check #4. A narrow table
  cell wraps a range such as the measuring span of a tag over two lines, so the
  needle is never one line of ``pages`` but always one *cell*: ``cells_by_page``
  is what check #3 falls back to, and the number and its unit are still in the
  same cell of the same row.
* ``page_halves`` re-extracts a page from its left and right halves. Two
  columns interleave when a page is read line by line, so check #5 classifies a
  miss as ``two_column_interleave`` when the needle comes back from a half.

The document is opened over an in-memory buffer, so an instance holds no
operating-system handle and the raw bytes stay available for
:meth:`PdfText.raw_contains`.
"""

from __future__ import annotations

import hashlib
import io
import re
from collections.abc import Iterator, Mapping, Sequence
from functools import cached_property
from pathlib import Path
from types import TracebackType
from typing import Any, Final

import pdfplumber

from fdp_manual_build.errors import BuildError
from fdp_manual_build.render import PAGE_SEPARATOR

__all__ = ["LINES_STRATEGY", "PDF_HEADER", "PdfText", "normalize"]

#: The ``extract_tables`` settings every table check uses.
LINES_STRATEGY: Final[Mapping[str, Any]] = {
    "vertical_strategy": "lines",
    "horizontal_strategy": "lines",
    "snap_tolerance": 3,
    "intersection_tolerance": 5,
}

#: How many bytes of the header carry ``%PDF-1.7``.
PDF_HEADER: Final = 8

#: U+2011 (non-breaking hyphen) reads as an ordinary hyphen in a needle. It is
#: written as a code point so the source file carries no confusable character.
_NON_BREAKING_HYPHEN: Final = chr(0x2011)
_WHITESPACE: Final = re.compile(r"\s+")


def normalize(text: str) -> str:
    """Collapse whitespace runs and fold the dashes the templates may emit.

    Every comparison in checks #3 and #5 runs through this, on both sides, so a
    line break inside a table cell cannot turn a present value into a miss. The
    en dash is kept: ``qty_range`` prints it and the checks search for both it
    and a hyphen-minus by generating two spellings, not by erasing the
    difference here.
    """
    return _WHITESPACE.sub(" ", text.replace(_NON_BREAKING_HYPHEN, "-")).strip()


class PdfText:
    """The extracted views of one built PDF, computed once and cached."""

    def __init__(self, path: Path, data: bytes) -> None:
        self.path = path
        self._data = data
        try:
            self._document = pdfplumber.open(io.BytesIO(data))
        except Exception as error:  # pdfminer raises its own hierarchy
            raise BuildError(f"{path}: cannot be read as a PDF ({error})") from error

    @classmethod
    def open(cls, path: Path) -> PdfText:
        """Read ``path`` and extract it.

        Raises:
            BuildError: when the file cannot be read or is not a PDF.
        """
        try:
            data = path.read_bytes()
        except OSError as error:
            raise BuildError(f"{path}: cannot be read ({error})") from error
        return cls(path, data)

    def __enter__(self) -> PdfText:
        """Allow ``with PdfText.open(path) as pdf:`` in a short-lived scope."""
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Close the underlying document."""
        self.close()

    def close(self) -> None:
        """Release the pdfplumber document."""
        self._document.close()

    # --- text ------------------------------------------------------------

    @cached_property
    def pages(self) -> tuple[str, ...]:
        """Every page's text, pdfplumber defaults, in page order."""
        return tuple(page.extract_text() or "" for page in self._document.pages)

    @cached_property
    def joined(self) -> str:
        """The pages glued with a form feed, as the manifest hashes them."""
        return PAGE_SEPARATOR.join(self.pages)

    @cached_property
    def text_sha256(self) -> str:
        """SHA-256 of :attr:`joined`, the value check #9 compares."""
        return hashlib.sha256(self.joined.encode("utf-8")).hexdigest()

    @cached_property
    def normalized_pages(self) -> tuple[str, ...]:
        """Every page's text run through :func:`normalize`."""
        return tuple(normalize(text) for text in self.pages)

    @property
    def page_count(self) -> int:
        """How many pages the document has."""
        return len(self.pages)

    def blank_pages(self) -> tuple[int, ...]:
        """1-based numbers of the pages with no extracted character."""
        return tuple(number for number, text in enumerate(self.pages, start=1) if not text.strip())

    def page_of(self, needle: str) -> int | None:
        """The 1-based number of the first page whose text holds ``needle``.

        The page text is compared normalized, so the caller passes a needle
        that is already normalized.
        """
        for number, text in enumerate(self.normalized_pages, start=1):
            if needle in text:
                return number
        return None

    def page_opening(self, title: str) -> int | None:
        """The 1-based number of the page that opens the chapter ``title``.

        A line equal to the title, not merely containing it: the table of
        contents lists ``8 Problem solving 37`` and the running header of the
        realistic variant ends with the title, and neither opens the chapter.
        """
        for number, text in enumerate(self.pages, start=1):
            if any(line.strip() == title for line in text.splitlines()):
                return number
        return None

    # --- tables ----------------------------------------------------------

    @cached_property
    def tables_by_page(self) -> tuple[tuple[tuple[tuple[str, ...], ...], ...], ...]:
        """Per page, the ruled tables, each a tuple of rows of cell strings.

        Every cell is normalized; a cell pdfplumber could not read comes back
        as an empty string rather than ``None``, so a caller never has to guard.
        """
        return tuple(
            tuple(
                tuple(tuple(normalize(cell or "") for cell in row) for row in table)
                for table in page.extract_tables(dict(LINES_STRATEGY))
            )
            for page in self._document.pages
        )

    @cached_property
    def cells_by_page(self) -> tuple[frozenset[str], ...]:
        """Per page, every normalized table cell that carries text."""
        return tuple(
            frozenset(cell for table in tables for row in table for cell in row if cell)
            for tables in self.tables_by_page
        )

    def cell_page_of(self, needle: str) -> int | None:
        """The 1-based page of the first table cell containing ``needle``."""
        for number, cells in enumerate(self.cells_by_page, start=1):
            if any(needle in cell for cell in cells):
                return number
        return None

    def rows_on(self, pages: Sequence[int]) -> Iterator[tuple[tuple[str, ...], ...]]:
        """Every ruled table on the 1-based ``pages``, in reading order."""
        for number in pages:
            if 1 <= number <= len(self.tables_by_page):
                yield from self.tables_by_page[number - 1]

    # --- column-aware re-extraction --------------------------------------

    def page_halves(self, page_index: int) -> tuple[str, str]:
        """The text of the left and the right half of a 0-based page.

        A two-column page read line by line interleaves the columns; cropping
        the page in two reads each column on its own, which is how check #5
        tells ``two_column_interleave`` from a real miss.
        """
        page = self._document.pages[page_index]
        left = page.crop((page.bbox[0], page.bbox[1], page.bbox[0] + page.width / 2, page.bbox[3]))
        right = page.crop((page.bbox[0] + page.width / 2, page.bbox[1], page.bbox[2], page.bbox[3]))
        return normalize(left.extract_text() or ""), normalize(right.extract_text() or "")

    def in_any_half(self, needle: str) -> int | None:
        """The 1-based page whose left or right half holds ``needle``."""
        for index in range(self.page_count):
            if any(needle in half for half in self.page_halves(index)):
                return index + 1
        return None

    # --- hygiene ---------------------------------------------------------

    @cached_property
    def fontnames(self) -> frozenset[str]:
        """Every font name pdfplumber reports for a character of the document."""
        return frozenset(
            str(char["fontname"]) for page in self._document.pages for char in page.chars
        )

    @cached_property
    def metadata(self) -> Mapping[str, Any]:
        """The document information dictionary, as pdfplumber decodes it."""
        return dict(self._document.metadata)

    @cached_property
    def pdf_version(self) -> str:
        """The version of the ``%PDF-x.y`` header, ``""`` when it is absent."""
        header = self._data[:PDF_HEADER].decode("ascii", errors="replace")
        return header.removeprefix("%PDF-") if header.startswith("%PDF-") else ""

    @property
    def size(self) -> int:
        """How many bytes the file has."""
        return len(self._data)

    @cached_property
    def pdf_sha256(self) -> str:
        """SHA-256 of the file itself, the manifest's ``pdf_sha256``."""
        return hashlib.sha256(self._data).hexdigest()

    def raw_contains(self, marker: bytes) -> bool:
        """Whether the raw bytes hold ``marker`` (``b"/JavaScript"`` and kin)."""
        return marker in self._data
