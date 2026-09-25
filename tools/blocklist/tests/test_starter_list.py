# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The committed starter list, checked without ever naming one of its terms.

Everything that can be checked from the digests alone runs everywhere. The
tests that need the plain terms read them from the gitignored private file at
runtime and skip when it is absent (a fresh clone, CI).
"""

import re
from collections.abc import Callable, Sequence
from pathlib import Path

import pytest

from fdp_blocklist import normalize, terms
from fdp_blocklist.config import Config, load_config
from fdp_blocklist.pdf import scan_pdf
from fdp_blocklist.scan import Matcher, Scanner
from fdp_blocklist.terms import MINIMUM_TERMS, SECTIONS, HashedList, TermList

WritePdf = Callable[[Path, Sequence[Sequence[str]]], Path]

_DIGEST_RE = re.compile(r"\A[0-9a-f]{64}\Z")


@pytest.fixture(scope="module")
def config() -> Config:
    return load_config()


@pytest.fixture(scope="module")
def hashed(config: Config) -> HashedList:
    return terms.read_hash_file(config.hash_file)


@pytest.fixture(scope="module")
def private(config: Config) -> TermList:
    if not config.private_list.is_file():
        pytest.skip(f"{config.private_list} is gitignored and absent in this checkout")
    return terms.read_term_list(config.private_list)


def test_every_section_of_the_plan_is_present(hashed: HashedList) -> None:
    assert {entry.section for entry in hashed.entries} == set(SECTIONS)


@pytest.mark.parametrize("section", SECTIONS)
def test_a_section_meets_its_minimum(hashed: HashedList, section: str) -> None:
    assert terms.section_counts(hashed)[section] >= MINIMUM_TERMS[section]


def test_every_line_is_a_lowercase_sha256(hashed: HashedList) -> None:
    assert all(_DIGEST_RE.match(entry.digest) for entry in hashed.entries)


def test_no_digest_appears_twice(hashed: HashedList) -> None:
    digests = [entry.digest for entry in hashed.entries]
    assert len(set(digests)) == len(digests)


def test_variants_are_marked_and_terms_are_not(hashed: HashedList) -> None:
    assert any(entry.is_variant for entry in hashed.entries)
    assert all(entry.n_tokens >= 1 for entry in hashed.entries if not entry.is_variant)


def test_no_term_is_longer_than_three_tokens(hashed: HashedList) -> None:
    assert max(entry.n_tokens for entry in hashed.entries) <= 3


def test_the_digest_file_holds_no_plain_text(config: Config) -> None:
    body = config.hash_file.read_text(encoding="utf-8")
    payload = [line for line in body.splitlines() if line and not line.startswith("#")]
    assert payload
    assert all(len(line.split("\t")) == 3 for line in payload)


def test_rehashing_the_private_list_reproduces_the_committed_file(
    config: Config, private: TermList
) -> None:
    rendered = terms.render_hash_file(terms.hash_terms(private, config.salt))
    assert rendered == config.hash_file.read_text(encoding="utf-8")


def test_a_one_token_term_is_at_least_four_characters(private: TermList) -> None:
    for entry in private.plain:
        canonical = normalize.canonical(entry.term)
        if len(canonical.split()) == 1:
            assert len(canonical) >= terms.MIN_SINGLE_TOKEN_LENGTH


def test_no_term_repeats_after_normalisation(private: TermList) -> None:
    canonical = [normalize.canonical(entry.term) for entry in private.plain]
    assert len(set(canonical)) == len(canonical)


def _first_per_section(private: TermList) -> dict[str, str]:
    first: dict[str, str] = {}
    for entry in private.plain:
        first.setdefault(entry.section, entry.term)
    return first


def _real_scanner(root: Path, config: Config, hashed: HashedList) -> Scanner:
    return Scanner(root, Matcher(hashed, config.salt), terms.read_allow_list(config.allow_file))


def test_the_first_term_of_each_section_is_found_in_a_text_file(
    tmp_path: Path, config: Config, hashed: HashedList, private: TermList
) -> None:
    first = _first_per_section(private)
    assert set(first) == set(SECTIONS)
    lines = [f"plate {term} unit" for term in first.values()]
    (tmp_path / "sample.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    hits = _real_scanner(tmp_path, config, hashed).scan_file("sample.txt")
    assert [hit.section for hit in hits] == list(first)
    assert [hit.line for hit in hits] == list(range(1, len(first) + 1))
    assert all(hit.col == 7 for hit in hits)


def test_the_first_term_of_each_section_is_found_in_a_pdf(
    tmp_path: Path,
    config: Config,
    hashed: HashedList,
    private: TermList,
    pdf_writer: WritePdf,
) -> None:
    first = _first_per_section(private)
    path = pdf_writer(tmp_path / "sample.pdf", [[f"plate {term} unit"] for term in first.values()])
    hits = scan_pdf(_real_scanner(tmp_path, config, hashed), path, "sample.pdf")
    assert [hit.section for hit in hits] == list(first)
    assert [hit.page for hit in hits] == list(range(1, len(first) + 1))
