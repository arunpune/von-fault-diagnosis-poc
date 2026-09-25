# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""PDF text extraction for the scanner.

The manual is checked as it is *read*, not as it is written: the realistic
variant is two-column and hyphenated, so the check has to run over the text
``pdfplumber`` extracts from each page. Hits then carry a page number.

The CLI imports this module only when a PDF is in the scan set, so a text-only
run never pays for loading ``pdfplumber``.
"""

from pathlib import Path

import pdfplumber

from fdp_blocklist.scan import Hit, ScanError, Scanner

__all__ = ["extract_pages", "scan_pdf"]


def extract_pages(path: Path) -> list[str]:
    """The extracted text of every page, in order; an empty page gives ``""``."""
    try:
        with pdfplumber.open(path) as document:
            return [page.extract_text() or "" for page in document.pages]
    except Exception as error:  # pdfplumber raises assorted pdfminer errors
        raise ScanError(f"{path}: cannot read the PDF ({error})") from error


def scan_pdf(scanner: Scanner, path: Path, label: str) -> list[Hit]:
    """Scan every page of ``path``, reporting hits as ``label:p<page>:line:col``."""
    return scanner.scan_pages(label, extract_pages(path))
