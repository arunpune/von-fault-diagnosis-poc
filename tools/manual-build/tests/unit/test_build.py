# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""HTML assembly on the mini fixture.

The assertions parse the document with ``tinyhtml5`` — already a WeasyPrint
dependency — rather than matching strings, so a layout change that keeps the
structure does not break them and a structural regression does.
"""

from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path
from xml.etree.ElementTree import Element

import pytest
import tinyhtml5

from fdp_manual_build import numbering
from fdp_manual_build.build import (
    CHAPTER_TEMPLATES,
    EXIT_PAGE_BUDGET,
    Options,
    build_all,
    build_variant,
    main,
    read_sources,
)
from fdp_manual_build.config import BuildConfig, load_build_config
from fdp_manual_build.errors import BuildError
from fdp_manual_build.model import Manual

XHTML = "{http://www.w3.org/1999/xhtml}"
VARIANTS = ("clean", "realistic")


def parse(html: str) -> Element:
    """Parse a document the way WeasyPrint does."""
    root: Element = tinyhtml5.parse(html)
    return root


def find(root: Element, tag: str) -> Iterator[Element]:
    """Every element of one tag, in document order."""
    return root.iter(f"{XHTML}{tag}")


def by_id(root: Element, element_id: str) -> Element | None:
    for element in root.iter():
        if element.get("id") == element_id:
            return element
    return None


def text_of(element: Element) -> str:
    return "".join(element.itertext())


@pytest.fixture(scope="module")
def documents(
    request: pytest.FixtureRequest,
) -> dict[str, str]:
    """Both variants of the mini fixture, built once for the whole module."""
    repo_root: Path = request.getfixturevalue("repo_root")
    cfg: BuildConfig = request.getfixturevalue("mini_config")
    manual: Manual = request.getfixturevalue("mini_manual")
    sources = read_sources(cfg, repo_root)
    sections = numbering.scan(sources.chapters, numbering.generated_sections(manual))
    return {
        name: build_variant(cfg, cfg.variant(name), manual, sections, sources) for name in VARIANTS
    }


@pytest.mark.parametrize("variant", VARIANTS)
def test_the_document_is_one_well_formed_html_page(documents: dict[str, str], variant: str) -> None:
    root = parse(documents[variant])
    assert root.tag == f"{XHTML}html"
    assert root.get("lang") == "en"
    body = next(find(root, "body"))
    assert body.get("data-variant") == variant


@pytest.mark.parametrize("variant", VARIANTS)
def test_no_unresolved_jinja_marker_survives(documents: dict[str, str], variant: str) -> None:
    html = documents[variant]
    assert "{{" not in html
    assert "{%" not in html
    assert "{#sec:" not in html


@pytest.mark.parametrize("variant", VARIANTS)
def test_the_head_carries_the_fixed_creation_date(documents: dict[str, str], variant: str) -> None:
    root = parse(documents[variant])
    metas = {meta.get("name"): meta.get("content") for meta in find(root, "meta")}
    assert metas["dcterms.created"] == "2026-01-15T00:00:00+00:00"
    assert metas["author"] == "Meddle S.r.l."
    hrefs = [link.get("href") for link in find(root, "link")]
    assert hrefs == [
        "templates/css/fonts.css",
        "templates/css/base.css",
        f"templates/css/{variant}.css",
    ]


@pytest.mark.parametrize("variant", VARIANTS)
def test_the_cover_names_machine_controller_revision_and_licence(
    documents: dict[str, str], variant: str
) -> None:
    cover = by_id(parse(documents[variant]), "cover")
    assert cover is not None
    text = text_of(cover)
    for expected in ("CAU-7 Compressed-Air Unit", "CTRL-7", "CAU7-IOM-EN", "2026-01-15"):
        assert expected in text
    assert "CC BY 4.0" in text


@pytest.mark.parametrize("variant", VARIANTS)
def test_every_chapter_is_a_section_with_its_own_id(
    documents: dict[str, str], variant: str
) -> None:
    root = parse(documents[variant])
    chapters = [element for element in find(root, "section") if element.get("class") == "chapter"]
    assert [element.get("id") for element in chapters] == [f"ch-{n}" for n in range(1, 11)]
    assert [element.get("data-chapter") for element in chapters] == [str(n) for n in range(1, 11)]


@pytest.mark.parametrize("variant", VARIANTS)
def test_every_authored_heading_has_its_anchor_id(
    documents: dict[str, str],
    mini_config: BuildConfig,
    mini_manual: Manual,
    repo_root: Path,
    variant: str,
) -> None:
    sources = read_sources(mini_config, repo_root)
    sections = numbering.scan(sources.chapters, numbering.generated_sections(mini_manual))
    root = parse(documents[variant])
    spanning = mini_config.variant(variant).tables == "span_pages_repeat_header"
    for section in sections.values():
        heading = by_id(root, section.html_id)
        assert heading is not None, section.html_id
        # The spanning troubleshooting table of the realistic variant replaces
        # the per-condition headings with group rows carrying the same id.
        expected = (
            (f"{XHTML}tr",)
            if spanning and section.anchor.startswith("cond:")
            else (f"{XHTML}h2", f"{XHTML}h3")
        )
        assert heading.tag in expected, section.html_id
        assert section.number in text_of(heading), section.html_id


@pytest.mark.parametrize("variant", VARIANTS)
def test_the_toc_links_every_level_two_section(
    documents: dict[str, str],
    mini_config: BuildConfig,
    mini_manual: Manual,
    repo_root: Path,
    variant: str,
) -> None:
    sources = read_sources(mini_config, repo_root)
    sections = numbering.scan(sources.chapters, numbering.generated_sections(mini_manual))
    root = parse(documents[variant])
    toc = by_id(root, "toc")
    assert toc is not None
    hrefs = {anchor.get("href") for anchor in find(toc, "a")}
    assert {f"#ch-{n}" for n in range(1, 11)} <= hrefs
    expected = {
        f"#{section.html_id}" for section in sections.values() if section.number.count(".") == 1
    }
    assert expected <= hrefs
    for href in hrefs:
        assert by_id(root, str(href).removeprefix("#")) is not None, href


@pytest.mark.parametrize("variant", VARIANTS)
def test_the_appendix_carries_the_credit_and_the_licence(
    documents: dict[str, str], variant: str
) -> None:
    chapter = by_id(parse(documents[variant]), "ch-10")
    assert chapter is not None
    text = text_of(chapter)
    assert "CC BY 4.0" in text
    assert "10.24432/C5VW3R" in text
    assert "MetroPT-3" in text
    assert "Oil cooler" in text


def test_the_two_variants_differ_where_the_knobs_say_they_do(documents: dict[str, str]) -> None:
    clean, realistic = documents["clean"], documents["realistic"]
    assert 'data-columns="2"' in realistic
    assert 'data-columns="2"' not in clean
    assert '<span class="fn">' in realistic
    assert '<span class="fn">' not in clean
    assert "(116 psi)" in realistic
    assert "psi" not in clean
    assert ">section 4.1<" in clean
    assert ">section 4.1<" not in realistic


def test_a_bare_number_in_a_partial_fails_the_build_naming_the_file(
    repo_root: Path, tmp_path: Path
) -> None:
    root = _fixture_copy(tmp_path, repo_root)
    partial = root / "content" / "01-safety.md"
    partial.write_text(
        "## General safety {#sec:safety-general}\n\nThe unit runs at {{ 7 }} bar.\n",
        encoding="utf-8",
    )
    cfg = load_build_config(repo_root, root)
    with pytest.raises(BuildError, match=r"content/01-safety\.md") as raised:
        build_all(cfg, repo_root, Options(out_dir=tmp_path / "out", html_only=True))
    assert "bare number" in str(raised.value)


def test_a_prose_only_fact_left_out_of_the_prose_fails_the_build(
    repo_root: Path, tmp_path: Path
) -> None:
    root = _fixture_copy(tmp_path, repo_root)
    partial = root / "content" / "04-settings.md"
    partial.write_text(
        "## Setting table {#sec:settings-table}\n\n"
        "Only a service engineer may change a setting.\n\n"
        "{{ tables.settings() }}\n",
        encoding="utf-8",
    )
    cfg = load_build_config(repo_root, root)
    with pytest.raises(BuildError, match="setting:cut_in_pressure"):
        build_all(
            cfg,
            repo_root,
            Options(out_dir=tmp_path / "out", html_only=True, variants=("realistic",)),
        )


def test_build_all_writes_one_html_file_per_variant(
    mini_config: BuildConfig, repo_root: Path, tmp_path: Path
) -> None:
    result = build_all(
        mini_config,
        repo_root,
        Options(out_dir=tmp_path / "out", html_only=True, html_dir=tmp_path / "build"),
    )
    assert [variant.name for variant in result.variants] == list(VARIANTS)
    for variant in result.variants:
        assert variant.html_path == tmp_path / "build" / f"{variant.name}.html"
        assert variant.html_path.read_text(encoding="utf-8") == variant.html
        assert variant.pdf_path is None
        assert variant.pages is None
    assert result.variant("clean").html.startswith("<!DOCTYPE html>")


def test_the_disabled_scanned_variant_is_not_built(
    mini_config: BuildConfig, repo_root: Path, tmp_path: Path
) -> None:
    result = build_all(
        mini_config,
        repo_root,
        Options(out_dir=tmp_path / "out", html_only=True, html_dir=tmp_path / "build"),
    )
    assert "scanned" not in [variant.name for variant in result.variants]


def test_a_missing_renderer_forces_html_and_warns(
    mini_config: BuildConfig,
    repo_root: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # `fdp_manual_build.render` imports here. The fallback still has to hold for
    # an installation without WeasyPrint, so the resolver is the thing to
    # silence, not the module.
    monkeypatch.setattr("fdp_manual_build.build._renderer", lambda: None)
    result = build_all(
        mini_config,
        repo_root,
        Options(out_dir=tmp_path / "out", html_dir=tmp_path / "build"),
    )
    assert result.html_only
    assert any("is not available" in warning for warning in result.warnings)


def test_the_build_is_deterministic(
    mini_config: BuildConfig, mini_manual: Manual, repo_root: Path
) -> None:
    sources = read_sources(mini_config, repo_root)
    sections = numbering.scan(sources.chapters, numbering.generated_sections(mini_manual))
    variant = mini_config.variant("realistic")
    first = build_variant(mini_config, variant, mini_manual, sections, sources)
    second = build_variant(mini_config, variant, mini_manual, sections, sources)
    assert first == second


def test_every_chapter_has_a_template() -> None:
    assert sorted(CHAPTER_TEMPLATES) == list(range(1, 11))


def test_out_of_budget_reports_every_offending_variant(
    mini_config: BuildConfig, repo_root: Path, tmp_path: Path
) -> None:
    from dataclasses import replace  # noqa: PLC0415 - local to this one assertion

    result = build_all(
        mini_config,
        repo_root,
        Options(out_dir=tmp_path / "out", html_only=True, html_dir=tmp_path / "build"),
    )
    paged = replace(
        result,
        variants=tuple(replace(item, pages=999) for item in result.variants),
    )
    assert len(paged.out_of_budget()) == len(VARIANTS)
    assert "999 pages" in paged.out_of_budget()[0]


# --- the command line ------------------------------------------------------


def test_the_command_builds_the_fixture_through_repo_root(
    repo_root: Path, mini_spec_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["--repo-root", str(mini_spec_dir), "--html-only"], repo_root) == 0
    printed = capsys.readouterr().out
    for name in VARIANTS:
        assert f"build: {name} ->" in printed
        assert (repo_root / "tools" / "manual-build" / ".build" / f"{name}.html").is_file()


def test_the_command_accepts_a_checkout_as_repo_root(
    repo_root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    checkout = tmp_path / "checkout"
    (checkout / "manual").mkdir(parents=True)
    assert main(["--repo-root", str(checkout), "--html-only"], repo_root) == 2
    assert "holds neither build.yaml" in capsys.readouterr().err


def test_the_command_reports_an_unknown_variant(
    repo_root: Path, mini_spec_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    argv = ["--repo-root", str(mini_spec_dir), "--html-only", "--variant", "glossy"]
    assert main(argv, repo_root) == 2
    assert "unknown variant 'glossy'" in capsys.readouterr().err


def test_the_page_budget_exit_code_is_three() -> None:
    assert EXIT_PAGE_BUDGET == 3


def _fixture_copy(tmp_path: Path, repo_root: Path) -> Path:
    """A writable copy of the mini fixture, outside the checkout."""
    source = repo_root / "tools" / "manual-build" / "tests" / "fixtures" / "mini-spec"
    target = tmp_path / "mini-spec"
    shutil.copytree(source, target)
    return target
