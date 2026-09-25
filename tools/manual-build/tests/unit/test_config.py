# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``manual/build.yaml`` → ``BuildConfig``."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from fdp_manual_build.config import BuildConfig, load_build_config
from fdp_manual_build.errors import BuildError

#: The signature of the ``mutate`` fixture in ``tests/conftest.py``.
MutateFn = Callable[[Path, str, str, Any], Path]

BUILD_YAML = "build.yaml"


def test_chapters_are_one_to_ten_in_order(mini_config: BuildConfig) -> None:
    assert [chapter.number for chapter in mini_config.chapters] == list(range(1, 11))
    assert mini_config.chapters[0].filename == "01-safety.md"
    assert mini_config.chapters[-1].filename == "10-appendix.md"
    assert mini_config.chapter_path(mini_config.chapters[0]).name == "01-safety.md"


def test_document_and_outputs(mini_config: BuildConfig) -> None:
    assert mini_config.document.number == "CAU7-IOM-EN"
    assert mini_config.document.revisions[0].revision == "1.0"
    assert mini_config.outputs.pdf_name("clean") == "mini-clean.pdf"
    assert mini_config.source_date_iso == "2026-01-15T00:00:00+00:00"
    assert len(mini_config.source_hash) == 64


def test_variants_carry_mans_knob_names(mini_config: BuildConfig) -> None:
    clean = mini_config.variant("clean")
    realistic = mini_config.variant("realistic")
    assert clean.layout == "single_column"
    assert clean.units == "si"
    assert clean.footnotes is False
    assert realistic.two_column_chapters == (2, 6, 7)
    assert realistic.xref_style == "short_with_footnotes"
    assert realistic.is_two_column(6) is True
    assert clean.is_two_column(6) is False


def test_scanned_extends_realistic(mini_config: BuildConfig) -> None:
    scanned = mini_config.variant("scanned")
    realistic = mini_config.variant("realistic")
    assert scanned.enabled is False
    assert scanned.raster_dpi == 200
    assert scanned.layout == realistic.layout
    assert scanned.two_column_chapters == realistic.two_column_chapters
    assert scanned.prose_only == realistic.prose_only


def test_fact_placement_semantics(mini_config: BuildConfig) -> None:
    clean = mini_config.variant("clean")
    realistic = mini_config.variant("realistic")
    # tables_only never hides a fact from either place.
    assert clean.fact_in_prose("setting:cut_in_pressure") is True
    assert clean.fact_in_table("setting:cut_in_pressure") is True
    # mixed hides prose_only anchors from the tables and vice versa.
    assert realistic.fact_in_prose("setting:cut_in_pressure") is True
    assert realistic.fact_in_table("setting:cut_in_pressure") is False
    assert realistic.fact_in_prose("machine.ratings.oil_fill_volume") is False
    assert realistic.fact_in_table("machine.ratings.oil_fill_volume") is True


def test_pdf_block_is_read(mini_config: BuildConfig) -> None:
    assert mini_config.pdf.pdf_identifier == "fdp-mini-manual"
    assert mini_config.pdf.page_budget.min == 4
    assert mini_config.pdf.page_budget.max == 24
    assert mini_config.pdf.catalog.endswith("catalog.json")


def test_pdf_block_defaults_when_absent(
    repo_root: Path,
    tmp_path: Path,
    mutate: MutateFn,
    delete: object,
) -> None:
    root = mutate(tmp_path, BUILD_YAML, "/pdf", delete)
    cfg = load_build_config(repo_root, root)
    assert cfg.pdf.pdf_identifier == "fdp-mini-manual"
    assert (cfg.pdf.page_budget.min, cfg.pdf.page_budget.max) == (28, 56)
    assert cfg.pdf.manifest == ".build/mini-spec/build-manifest.json"
    assert cfg.pdf.catalog == "tools/eval/fixtures/catalog.json"


def test_unknown_variant_is_an_error(mini_config: BuildConfig) -> None:
    with pytest.raises(BuildError, match="unknown variant 'glossy'"):
        mini_config.variant("glossy")


def test_missing_build_yaml_is_an_error(repo_root: Path, tmp_path: Path) -> None:
    with pytest.raises(BuildError, match=r"no build\.yaml in this manual tree"):
        load_build_config(repo_root, tmp_path)


def test_schema_violation_carries_file_and_pointer(
    repo_root: Path,
    tmp_path: Path,
    mutate: MutateFn,
) -> None:
    root = mutate(tmp_path, BUILD_YAML, "/document/language", "english")
    with pytest.raises(BuildError) as raised:
        load_build_config(repo_root, root)
    assert [(error.file, error.json_pointer) for error in raised.value.errors] == [
        (BUILD_YAML, "/document/language")
    ]


def test_chapter_numbers_must_be_consecutive(
    repo_root: Path,
    tmp_path: Path,
    mutate: MutateFn,
) -> None:
    root = mutate(tmp_path, BUILD_YAML, "/chapters/3/number", 9)
    with pytest.raises(BuildError) as raised:
        load_build_config(repo_root, root)
    assert any(error.json_pointer == "/chapters/3/number" for error in raised.value.errors)


def test_both_spec_variants_must_exist(
    repo_root: Path,
    tmp_path: Path,
    mutate: MutateFn,
    delete: object,
) -> None:
    root = mutate(tmp_path, BUILD_YAML, "/variants/clean", delete)
    with pytest.raises(BuildError) as raised:
        load_build_config(repo_root, root)
    assert any("variant 'clean' is missing" in error.message for error in raised.value.errors)


def test_page_budget_must_be_ordered(
    repo_root: Path,
    tmp_path: Path,
    mutate: MutateFn,
) -> None:
    root = mutate(tmp_path, BUILD_YAML, "/pdf/page_budget/min", 99)
    with pytest.raises(BuildError) as raised:
        load_build_config(repo_root, root)
    assert any(error.json_pointer == "/pdf/page_budget" for error in raised.value.errors)


def test_extends_cycle_is_reported(
    repo_root: Path,
    tmp_path: Path,
    mutate: MutateFn,
) -> None:
    root = mutate(tmp_path, BUILD_YAML, "/variants/realistic/extends", "scanned")
    with pytest.raises(BuildError) as raised:
        load_build_config(repo_root, root)
    assert any("`extends` cycle" in error.message for error in raised.value.errors)


def test_the_real_build_yaml_parses(repo_root: Path) -> None:
    cfg = load_build_config(repo_root)
    assert cfg.pdf.pdf_identifier == "fdp-cau-7-manual"
    assert (cfg.pdf.page_budget.min, cfg.pdf.page_budget.max) == (28, 56)
    assert cfg.pdf.manifest == "data/manual/build-manifest.json"
    assert cfg.pdf.catalog == "tools/eval/fixtures/catalog.json"
    assert cfg.default_variant == "realistic"
