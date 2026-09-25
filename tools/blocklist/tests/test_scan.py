# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Hashed n-gram matching, file enumeration and the allow list."""

import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

from fdp_blocklist.scan import Matcher, Scanner, collect_paths, compile_glob, is_binary
from fdp_blocklist.terms import TermListError

MakeMatcher = Callable[..., Matcher]
MakeScanner = Callable[..., Scanner]


def _terms(matcher: Matcher, text: str) -> list[str]:
    return [hit.term for hit in matcher.scan_text("f.txt", text)]


def test_a_plain_phrase_matches_whatever_separates_its_words(make_matcher: MakeMatcher) -> None:
    matcher = make_matcher()
    for spelling in ("Zorblax Kompressoren", "Zorblax-Kompressoren", "ZORBLAX_KOMPRESSOREN"):
        assert _terms(matcher, f"a {spelling} b") == [spelling]


def test_a_phrase_also_matches_its_concatenated_spelling(make_matcher: MakeMatcher) -> None:
    assert _terms(make_matcher(), "the zorblaxkompressoren spare") == ["zorblaxkompressoren"]


def test_a_one_word_term_never_matches_inside_another_word(make_matcher: MakeMatcher) -> None:
    matcher = make_matcher()
    assert _terms(matcher, "absorb the zorbaline and zorbalised drums") == []
    assert _terms(matcher, "one zorbal drum") == ["zorbal"]


def test_a_phrase_split_across_a_line_break_still_matches(make_matcher: MakeMatcher) -> None:
    hits = make_matcher().scan_text("f.txt", "reads Zorblax\nKompressoren, 2026\n")
    assert [(hit.line, hit.col, hit.term) for hit in hits] == [(1, 7, "zorblax kompressoren")]


def test_a_hyphenated_word_is_joined_before_matching(make_matcher: MakeMatcher) -> None:
    hits = make_matcher().scan_text("f.txt", "the zor-\nbal drum\n")
    assert [(hit.line, hit.term) for hit in hits] == [(1, "zorbal")]


def test_the_context_and_position_locate_the_hit(make_matcher: MakeMatcher) -> None:
    hits = make_matcher().scan_text("f.txt", "line one\nplate: Zorbal drum\n")
    assert len(hits) == 1
    hit = hits[0]
    assert (hit.line, hit.col, hit.section) == (2, 8, "lubricants")
    assert hit.location == "f.txt:2:8"
    assert hit.context == "plate: Zorbal drum"


def test_a_regex_term_matches_a_model_code(make_matcher: MakeMatcher) -> None:
    hits = make_matcher().scan_text("f.txt", "model zx9000 and ZX-9001 on the plate")
    assert [hit.term for hit in hits] == ["zx9000", "ZX-9001"]
    assert {hit.section for hit in hits} == {"product-lines"}


def test_regex_terms_are_dropped_when_the_private_list_is_absent(
    make_matcher: MakeMatcher,
) -> None:
    matcher = make_matcher(with_regex=False)
    assert matcher.regex_count == 0
    assert _terms(matcher, "model ZX-9000") == []


def test_a_page_number_is_carried_into_the_hit(make_matcher: MakeMatcher) -> None:
    hits = make_matcher().scan_text("m.pdf", "the Zorbal drum", page=4)
    assert hits[0].location == "m.pdf:p4:1:5"
    assert hits[0].as_dict()["page"] == 4


def test_the_allow_list_exempts_one_term_in_one_path(
    tmp_path: Path, make_scanner: MakeScanner
) -> None:
    (tmp_path / "keep.txt").write_text("a Zorbal drum\n", encoding="utf-8")
    (tmp_path / "other.txt").write_text("a Zorbal drum\n", encoding="utf-8")
    allow = "keep.txt :: zorbal  # reviewed: the sample name of the test rig\n"
    scanner = make_scanner(tmp_path, allow_text=allow)
    assert scanner.scan_file("keep.txt") == []
    assert len(scanner.scan_file("other.txt")) == 1


def test_an_allow_line_without_a_reason_is_rejected(
    tmp_path: Path, make_scanner: MakeScanner
) -> None:
    with pytest.raises(TermListError, match="reason"):
        make_scanner(tmp_path, allow_text="*.txt :: zorbal\n")


def test_a_binary_file_is_skipped(tmp_path: Path, make_scanner: MakeScanner) -> None:
    (tmp_path / "blob.bin").write_bytes(b"Zorbal\x00 drum")
    assert make_scanner(tmp_path).scan_file("blob.bin") == []


def test_is_binary_only_probes_the_first_kibibytes() -> None:
    assert is_binary(b"text\x00")
    assert not is_binary(b"a" * 9000 + b"\x00")


@pytest.mark.parametrize(
    ("pattern", "path", "expected"),
    [
        ("tools/blocklist/data/**", "tools/blocklist/data/allow.txt", True),
        ("tools/blocklist/data/**", "tools/blocklist/blocklist.toml", False),
        ("**/*.png", "a.png", True),
        ("**/*.png", "apps/frontend/a.png", True),
        ("**/go.sum", "services/modbus/go.sum", True),
        ("*.md", "docs/api.md", False),
        ("docs/*.md", "docs/api.md", True),
        ("docs/*.md", "docs/img/notes.md", False),
    ],
)
def test_compile_glob_follows_the_segment_rules(pattern: str, path: str, expected: bool) -> None:
    assert (compile_glob(pattern).match(path) is not None) is expected


def test_collect_paths_lists_tracked_and_untracked_files(git_repo: Path) -> None:
    (git_repo / "kept.txt").write_text("a\n", encoding="utf-8")
    (git_repo / "skipped.log").write_text("b\n", encoding="utf-8")
    assert collect_paths(git_repo, [], excludes=["*.log"]) == ["kept.txt"]


def test_collect_paths_honours_gitignore(git_repo: Path) -> None:
    (git_repo / ".gitignore").write_text("secret.txt\n", encoding="utf-8")
    (git_repo / "secret.txt").write_text("a\n", encoding="utf-8")
    assert collect_paths(git_repo, [], excludes=[]) == [".gitignore"]


def test_collect_paths_adds_the_configured_pdf_globs(git_repo: Path) -> None:
    (git_repo / ".gitignore").write_text("build/\n", encoding="utf-8")
    (git_repo / "build").mkdir()
    (git_repo / "build" / "manual.pdf").write_bytes(b"%PDF-1.4\n")
    listed = collect_paths(git_repo, [], excludes=[], pdf_globs=["build/*.pdf"])
    assert "build/manual.pdf" in listed


def test_staged_scans_only_the_index(git_repo: Path) -> None:
    (git_repo / "staged.txt").write_text("a\n", encoding="utf-8")
    (git_repo / "loose.txt").write_text("b\n", encoding="utf-8")
    subprocess.run(["git", "add", "staged.txt"], cwd=git_repo, check=True)
    assert collect_paths(git_repo, [], excludes=[], staged=True) == ["staged.txt"]


def test_an_explicit_path_limits_the_scan(git_repo: Path) -> None:
    (git_repo / "a.txt").write_text("a\n", encoding="utf-8")
    (git_repo / "b.txt").write_text("b\n", encoding="utf-8")
    assert collect_paths(git_repo, ["a.txt"], excludes=[]) == ["a.txt"]


def test_a_directory_argument_is_walked(git_repo: Path) -> None:
    (git_repo / "pkg").mkdir()
    (git_repo / "pkg" / "a.txt").write_text("a\n", encoding="utf-8")
    (git_repo / "pkg" / "b.txt").write_text("b\n", encoding="utf-8")
    assert collect_paths(git_repo, ["pkg"], excludes=["**/b.txt"]) == ["pkg/a.txt"]


def test_a_walked_directory_keeps_its_prefix(git_repo: Path, make_scanner: MakeScanner) -> None:
    (git_repo / "pkg").mkdir()
    (git_repo / "pkg" / "one.txt").write_text("plate: Zorbal\n", encoding="utf-8")
    scanner = make_scanner(git_repo)
    listed = collect_paths(git_repo, ["pkg"], excludes=[])
    assert listed == ["pkg/one.txt"]
    assert [hit.path for path in listed for hit in scanner.scan_file(path)] == ["pkg/one.txt"]


def test_a_directory_outside_the_root_is_scanned_under_its_absolute_name(
    git_repo: Path, tmp_path_factory: pytest.TempPathFactory, make_scanner: MakeScanner
) -> None:
    # What `content_checks.py --content <dir>` does: the content directory
    # need not live in the checkout that holds the term list.
    outside = tmp_path_factory.mktemp("elsewhere")
    (outside / "one.txt").write_text("plate: Zorbal\n", encoding="utf-8")
    scanner = make_scanner(git_repo)
    listed = collect_paths(git_repo, [str(outside)], excludes=[])
    assert listed == [(outside / "one.txt").as_posix()]
    assert [hit.path for path in listed for hit in scanner.scan_file(path)] == listed


def test_the_scanner_reports_every_file_of_a_tree(
    git_repo: Path, make_scanner: MakeScanner
) -> None:
    (git_repo / "one.txt").write_text("plate: Zorbal\n", encoding="utf-8")
    (git_repo / "two.txt").write_text("nothing here\n", encoding="utf-8")
    scanner = make_scanner(git_repo)
    hits = [
        hit for path in collect_paths(git_repo, [], excludes=[]) for hit in scanner.scan_file(path)
    ]
    assert [(hit.path, hit.section) for hit in hits] == [("one.txt", "lubricants")]
