# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The normal form of the term list and the hyphenation join."""

import pytest

from fdp_blocklist import normalize


@pytest.mark.parametrize(
    "spelling",
    [
        "Zorblax Kompressoren",
        "Zorblax-Kompressoren",
        "ZORBLAX  KOMPRESSOREN",
        "zorblax_kompressoren",
        "  zorblax\t/ kompressoren ",
    ],
)
def test_every_spelling_shares_one_canonical_form(spelling: str) -> None:
    assert normalize.canonical(spelling) == "zorblax kompressoren"


def test_nfkc_folds_compatibility_characters_before_matching() -> None:
    # U+2116 NUMERO SIGN decomposes to "No" and U+00B2 to "2", so a term
    # typeset with them still normalises onto its plain spelling.
    assert normalize.canonical("№ 5, ZX²") == "no 5 zx2"


def test_normalize_pads_so_a_phrase_test_is_whole_word() -> None:
    assert normalize.normalize("Zorbal!") == " zorbal "


def test_concatenated_drops_the_separators() -> None:
    assert normalize.concatenated("Zorblax-Kompressoren") == "zorblaxkompressoren"


def test_tokens_keep_their_columns_in_the_nfkc_text() -> None:
    found = normalize.tokenize("a Zorbal-9 b")
    assert [token.text for token in found] == ["a", "zorbal", "9", "b"]
    assert (found[1].start, found[1].end) == (2, 8)


def test_an_underscore_separates_tokens() -> None:
    assert normalize.tokens("zorbal_drum") == ["zorbal", "drum"]


def test_digits_are_tokens_of_their_own_run() -> None:
    assert normalize.tokens("ZX-9000") == ["zx", "9000"]


def test_logical_lines_join_a_hyphenated_word_onto_its_first_line() -> None:
    text = "the zorb-\nal drum\nnext line\n"
    assert normalize.logical_lines(text) == [(1, "the zorbal drum"), (3, "next line")]


def test_logical_lines_leave_a_dash_only_line_alone() -> None:
    assert normalize.logical_lines("---\nnext\n") == [(1, "---"), (2, "next")]


def test_logical_lines_flush_a_trailing_hyphen_at_end_of_file() -> None:
    assert normalize.logical_lines("zorb-") == [(1, "zorb")]
