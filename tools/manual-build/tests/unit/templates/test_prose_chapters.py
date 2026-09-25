# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""One assertion set per chapter template.

Chapters 1, 2, 5, 6 and 10 are prose; 3, 4, 7, 8 and 9 carry the generated
tables, which ``tests/unit/templates/test_data_chapters.py`` covers.
Every one of the ten must render its partial inside the ``.body`` wrapper the
two-column rule selects on, and none of them may still hold a
``<!-- generated: … -->`` marker: the tables reach the page through the manual's
``tables.*`` macros now, not through a marker the chapter
template substitutes.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from fdp_manual_build import numbering
from fdp_manual_build.build import CHAPTER_TEMPLATES, RenderedChapter, read_sources
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.model import Manual
from fdp_manual_build.templating import Sources, Templating, make_templating

#: Chapters whose tables come from the manual's macros; test_data_chapters.py covers them.
DATA_CHAPTERS = (3, 4, 7, 8, 9)


@pytest.fixture(scope="module")
def rendering(request: pytest.FixtureRequest) -> Templating:
    repo_root: Path = request.getfixturevalue("repo_root")
    cfg: BuildConfig = request.getfixturevalue("mini_config")
    manual: Manual = request.getfixturevalue("mini_manual")
    sources = read_sources(cfg, repo_root)
    sections = numbering.scan(sources.chapters, numbering.generated_sections(manual))
    rendering = make_templating(cfg, cfg.variant("clean"), manual, sections, sources)
    rendering.resolve(manual)
    return rendering


@pytest.fixture(scope="module")
def sources(request: pytest.FixtureRequest) -> Sources:
    repo_root: Path = request.getfixturevalue("repo_root")
    cfg: BuildConfig = request.getfixturevalue("mini_config")
    return read_sources(cfg, repo_root)


def render(rendering: Templating, sources: Sources, number: int) -> str:
    """Render one chapter template exactly as ``base.html.j2`` includes it."""
    chapter = next(item for item in sources.chapters if item.number == number)
    rendered = RenderedChapter(
        number=chapter.number,
        slug=chapter.slug,
        title=chapter.title,
        template=CHAPTER_TEMPLATES[number],
        body=rendering.chapter_body(chapter),
        columns=1,
        sections=(),
    )
    template = rendering.pages.get_template(f"chapters/{CHAPTER_TEMPLATES[number]}")
    return template.render(ch=rendered)


@pytest.mark.parametrize("number", sorted(CHAPTER_TEMPLATES))
def test_every_chapter_template_wraps_the_partial_in_a_body(
    rendering: Templating, sources: Sources, number: int
) -> None:
    html = render(rendering, sources, number)
    assert html.lstrip().startswith('<div class="body">')
    assert html.rstrip().endswith("</div>")
    assert "{{" not in html


@pytest.mark.parametrize("number", sorted(CHAPTER_TEMPLATES))
def test_every_chapter_template_renders_its_own_partial(
    rendering: Templating, sources: Sources, number: int
) -> None:
    chapter = next(item for item in sources.chapters if item.number == number)
    body = rendering.chapter_body(chapter)
    assert body.strip()
    assert body.strip() in render(rendering, sources, number)


@pytest.mark.parametrize("number", sorted(CHAPTER_TEMPLATES))
def test_no_chapter_template_carries_a_generated_marker(
    rendering: Templating, sources: Sources, number: int
) -> None:
    assert "<!-- generated:" not in render(rendering, sources, number)


@pytest.mark.parametrize("number", DATA_CHAPTERS)
def test_a_data_chapter_prints_at_least_one_generated_table(
    rendering: Templating, sources: Sources, number: int
) -> None:
    assert "<table" in render(rendering, sources, number)


def test_chapter_1_renders_the_safety_prose(rendering: Templating, sources: Sources) -> None:
    html = render(rendering, sources, 1)
    assert '<h2 id="sec-safety-general">' in html
    assert "1.1" in html
    assert "venting the pressure" in html


def test_chapter_2_inlines_the_schematic(rendering: Templating, sources: Sources) -> None:
    html = render(rendering, sources, 2)
    assert '<figure class="figure" id="figure-system-schematic">' in html
    assert "<svg" in html
    assert "<img" not in html
    assert "Figure 2.1" in html


def test_chapter_5_is_prose_only(rendering: Templating, sources: Sources) -> None:
    html = render(rendering, sources, 5)
    assert '<h2 id="sec-reference-conditions">' in html
    assert "<table" not in html


def test_chapter_6_carries_the_cross_reference(rendering: Templating, sources: Sources) -> None:
    html = render(rendering, sources, 6)
    assert 'class="xref" href="#sec-settings-table"' in html


def test_chapter_10_adds_the_glossary_and_the_colophon(
    rendering: Templating, sources: Sources
) -> None:
    html = render(rendering, sources, 10)
    assert '<dl class="glossary">' in html
    assert 'id="glossary-oil_cooler"' in html
    assert '<section class="colophon">' in html
    assert "10.24432/C5VW3R" in html
    assert "CC BY 4.0" in html


def test_chapter_10_does_not_repeat_the_revision_table(
    rendering: Templating, sources: Sources
) -> None:
    """The partial's tables.revision_history() macro is the only one."""
    assert render(rendering, sources, 10).count('class="revision-history"') == 1
