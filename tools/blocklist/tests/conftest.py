# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Fixtures for the blocklist tests.

Every term used here is invented. The real list is hashed and gitignored, so
the tests build their own list at runtime and hash it with a test salt; the
only test that touches the real terms reads them from the gitignored private
file and skips when it is absent.
"""

import subprocess
from collections.abc import Callable, Sequence
from pathlib import Path

import pytest

from fdp_blocklist import terms
from fdp_blocklist.scan import Matcher, Scanner

#: Salt of the test digests; unrelated to the committed one.
TEST_SALT = "test-salt-v1"

#: A list of invented terms exercising every matching rule.
SYNTHETIC_LIST = """\
# invented names only
[makers]
Zorblax Kompressoren  # two words: also matches the concatenated spelling
Quibberton Airworks

[controllers]
Vexonic Control Unit

[lubricants]
Zorbal

[product-lines]
re:\\bZX-?9[0-9]{3}\\b  # invented model-code pattern
"""


@pytest.fixture
def salt() -> str:
    """The salt every test digest is built with."""
    return TEST_SALT


@pytest.fixture
def synthetic_list() -> str:
    """The invented term list, for tests that write it to disk."""
    return SYNTHETIC_LIST


@pytest.fixture
def make_matcher() -> Callable[..., Matcher]:
    """Build a matcher from plain-text list source, hashed at call time."""

    def build(list_text: str = SYNTHETIC_LIST, *, with_regex: bool = True) -> Matcher:
        parsed = terms.parse_term_list(list_text, "<test>")
        hashed = terms.HashedList(terms.hash_terms(parsed, TEST_SALT), "<test>")
        return Matcher(hashed, TEST_SALT, parsed.regex if with_regex else ())

    return build


@pytest.fixture
def make_scanner(make_matcher: Callable[..., Matcher]) -> Callable[..., Scanner]:
    """Build a scanner rooted at a directory, with an optional allow list."""

    def build(root: Path, list_text: str = SYNTHETIC_LIST, allow_text: str = "") -> Scanner:
        allow = terms.parse_allow_list(allow_text, "<test-allow>")
        return Scanner(root, make_matcher(list_text), allow)

    return build


def _escape(text: str) -> bytes:
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return escaped.encode("latin-1", errors="replace")


def _page_content(lines: Sequence[str]) -> bytes:
    body = bytearray(b"BT\n/F1 12 Tf\n16 TL\n72 720 Td\n")
    for index, line in enumerate(lines):
        if index:
            body += b"T*\n"
        body += b"(" + _escape(line) + b") Tj\n"
    body += b"ET\n"
    return bytes(body)


def _assemble(objects: list[bytes]) -> bytes:
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode("latin-1") + body + b"\nendobj\n"
    xref_at = len(out)
    size = len(objects) + 1
    out += f"xref\n0 {size}\n".encode("latin-1")
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode("latin-1")
    out += f"trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n".encode(
        "latin-1"
    )
    return bytes(out)


def write_pdf(path: Path, pages: Sequence[Sequence[str]]) -> Path:
    """Write a minimal PDF with one text block per page, built-in Helvetica.

    Raw PDF syntax on purpose: a few hundred bytes, no generator dependency and
    no binary fixture in Git, yet ``pdfplumber`` extracts the text.
    """
    page_count = len(pages)
    kids = " ".join(f"{3 + index * 2} 0 R" for index in range(page_count))
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {page_count} >>".encode("latin-1"),
    ]
    font = 3 + page_count * 2
    for index, lines in enumerate(pages):
        content = _page_content(lines)
        contents = 4 + index * 2
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]"
                f" /Resources << /Font << /F1 {font} 0 R >> >>"
                f" /Contents {contents} 0 R >>"
            ).encode("latin-1")
        )
        header = f"<< /Length {len(content)} >>\nstream\n".encode("latin-1")
        objects.append(header + content + b"endstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    path.write_bytes(_assemble(objects))
    return path


@pytest.fixture
def pdf_writer() -> Callable[[Path, Sequence[Sequence[str]]], Path]:
    """A helper writing a minimal multi-page PDF from raw PDF syntax."""
    return write_pdf


@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    """An empty git repository; ``git ls-files`` and ``--staged`` work in it."""
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    return tmp_path
