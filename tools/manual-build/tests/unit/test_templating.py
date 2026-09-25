# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The Jinja adapter over the manual's authoring contract."""

from __future__ import annotations

import dataclasses
from collections.abc import Iterator
from pathlib import Path

import pytest

from fdp_manual_build import build as build_module
from fdp_manual_build import numbering
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.errors import BuildError
from fdp_manual_build.model import Manual
from fdp_manual_build.numbering import ChapterSource, SectionMap
from fdp_manual_build.templating import (
    FactTracker,
    Sources,
    Templating,
    inline_svg,
    make_templating,
    manual_context,
    number_headings,
    resolve_manual,
)

SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
    "<title>t</title><rect x='0' y='0' width='10' height='10'/></svg>\n"
)


@pytest.fixture
def mini_sections(mini_config: BuildConfig, mini_manual: Manual) -> SectionMap:
    chapters = numbering.read_chapters(mini_config)
    return numbering.scan(chapters, numbering.generated_sections(mini_manual))


@pytest.fixture
def mini_sources(mini_config: BuildConfig, repo_root: Path) -> Sources:
    return build_module.read_sources(mini_config, repo_root)


def _bound(
    cfg: BuildConfig,
    name: str,
    manual: Manual,
    sections: SectionMap,
    sources: Sources,
) -> Templating:
    """One variant, resolved: the generated tables read the resolved model."""
    rendering = make_templating(cfg, cfg.variant(name), manual, sections, sources)
    rendering.resolve(manual)
    return rendering


@pytest.fixture
def clean(
    mini_config: BuildConfig,
    mini_manual: Manual,
    mini_sections: SectionMap,
    mini_sources: Sources,
) -> Templating:
    return _bound(mini_config, "clean", mini_manual, mini_sections, mini_sources)


@pytest.fixture
def realistic(
    mini_config: BuildConfig,
    mini_manual: Manual,
    mini_sections: SectionMap,
    mini_sources: Sources,
) -> Templating:
    return _bound(mini_config, "realistic", mini_manual, mini_sections, mini_sources)


def _partial(sources: Sources, number: int, text: str) -> ChapterSource:
    original = next(item for item in sources.chapters if item.number == number)
    return dataclasses.replace(original, text=text)


# --- the authoring contract is the manual's --------------------------------------


def test_the_namespace_is_the_contract_of_plan_section_8_2(clean: Templating) -> None:
    for name in ("machine", "signals", "settings", "alarms", "faults", "maintenance", "build"):
        assert name in clean.env.globals, name
    for name in ("num", "q", "val", "thr", "delay", "sig", "ref", "move_text", "tables"):
        assert name in clean.env.globals, name


def test_the_pdf_adds_only_its_own_names(clean: Templating) -> None:
    assert clean.env.globals["sections"] is clean.sections
    assert "fmt" in clean.env.filters
    assert "md" in clean.env.filters


def test_the_outline_agrees_with_the_numbering_scan(clean: Templating) -> None:
    """context.build_outline and numbering.scan must never diverge."""
    for anchor, section in clean.sections.items():
        assert clean.outline.has(anchor), anchor
        assert clean.outline.number_of(anchor) == section.number, anchor
    assert {heading.anchor for heading in clean.outline.headings} == set(clean.sections)


def test_the_same_outline_serves_every_variant(clean: Templating, realistic: Templating) -> None:
    numbers = {anchor: clean.outline.number_of(anchor) for anchor in clean.sections}
    assert {anchor: realistic.outline.number_of(anchor) for anchor in realistic.sections} == numbers


# --- strict undefined, bare numbers, unknown ids --------------------------


def test_an_undefined_name_fails_the_build_naming_the_file(
    clean: Templating, mini_sources: Sources
) -> None:
    chapter = _partial(mini_sources, 1, "## Safety {#sec:safety-general}\n\n{{ nonesuch }}\n")
    with pytest.raises(BuildError, match=r"content/01-safety\.md"):
        clean.chapter_body(chapter)


@pytest.mark.parametrize("expression", ["{{ 7 }}", "{{ 3 + 4 }}", "{{ 0.5 }}"])
def test_a_bare_number_in_prose_fails_the_build(
    clean: Templating, mini_sources: Sources, expression: str
) -> None:
    text = f"## Safety {{#sec:safety-general}}\n\nThe unit runs at {expression} bar.\n"
    with pytest.raises(BuildError, match=r"content/01-safety\.md") as raised:
        clean.chapter_body(_partial(mini_sources, 1, text))
    assert "bare number" in str(raised.value)


def test_a_bare_quantity_mapping_in_prose_fails_the_build(
    clean: Templating, mini_sources: Sources
) -> None:
    text = (
        "## Safety {#sec:safety-general}\n\nThe sump holds {{ machine.ratings.oil_fill_volume }}.\n"
    )
    with pytest.raises(BuildError, match="use q\\(\\)"):
        clean.chapter_body(_partial(mini_sources, 1, text))


def test_a_boolean_is_not_a_bare_number(clean: Templating, mini_sources: Sources) -> None:
    text = "## Safety {#sec:safety-general}\n\nShown: {{ true }}.\n"
    assert "Shown: True." in clean.chapter_body(_partial(mini_sources, 1, text))


@pytest.mark.parametrize(
    ("call", "message"),
    [
        ("{{ ref('sec:nowhere') }}", "unknown cross-reference anchor"),
        ("{{ alarm('W999') }}", "no controller message"),
        ("{{ sig('nonesuch') }}", "no signal"),
        ("{{ val('nonesuch') }}", "no setting"),
    ],
)
def test_an_unknown_id_fails_the_build(
    clean: Templating, mini_sources: Sources, call: str, message: str
) -> None:
    text = f"## Safety {{#sec:safety-general}}\n\nSee {call}.\n"
    with pytest.raises(BuildError, match=r"content/01-safety\.md") as raised:
        clean.chapter_body(_partial(mini_sources, 1, text))
    assert message in str(raised.value)


# --- cross-references and units per variant -------------------------------


def test_the_clean_variant_spells_a_cross_reference_out(clean: Templating) -> None:
    body = clean.chapter_body(next(c for c in clean_chapters(clean) if c.number == 6))
    assert '<a class="xref" href="#sec-settings-table">section 4.1</a>' in body
    assert "fn" not in body


def test_the_realistic_variant_shortens_it_and_adds_a_footnote(realistic: Templating) -> None:
    body = realistic.chapter_body(next(c for c in clean_chapters(realistic) if c.number == 6))
    assert '<a class="xref" href="#sec-settings-table">4.1</a>' in body
    assert '<span class="fn">Section 4.1, Setting table</span>' in body


def clean_chapters(rendering: Templating) -> Iterator[ChapterSource]:
    """The mini fixture's partials, read through the build's own reader."""
    return iter(numbering.read_chapters(rendering.cfg))


def test_the_realistic_variant_prints_imperial_units(realistic: Templating) -> None:
    body = realistic.chapter_body(next(c for c in clean_chapters(realistic) if c.number == 4))
    assert "8.0 bar (116 psi)" in body


# --- fact placement --------------------------------------------------------


def test_a_prose_only_fact_is_recorded_while_a_partial_renders(realistic: Templating) -> None:
    for chapter in clean_chapters(realistic):
        realistic.chapter_body(chapter)
    assert "setting:cut_in_pressure" in realistic.facts.stated
    realistic.check_fact_placement()


def test_a_prose_only_fact_that_never_reaches_the_prose_fails(realistic: Templating) -> None:
    with pytest.raises(BuildError, match="setting:cut_in_pressure"):
        realistic.check_fact_placement()


def test_the_clean_variant_has_no_prose_only_promise(clean: Templating) -> None:
    clean.check_fact_placement()


def test_the_tracker_ignores_a_call_outside_a_partial() -> None:
    tracker = FactTracker()
    tracked = tracker.track(lambda anchor: anchor != "setting:hidden")
    assert tracked("setting:shown") is True
    assert tracker.stated == set()
    tracker.in_prose = True
    assert tracked("setting:shown") is True
    assert tracked("setting:hidden") is False
    assert tracker.stated == {"setting:shown"}


# --- figures ---------------------------------------------------------------


def test_a_figure_is_inlined_and_numbered_per_chapter(clean: Templating) -> None:
    body = clean.chapter_body(next(c for c in clean_chapters(clean) if c.number == 2))
    assert '<figure class="figure" id="figure-system-schematic">' in body
    assert "<svg" in body
    assert "<img" not in body
    assert "Figure 2.1" in body


def test_inline_svg_accepts_a_plain_drawing(tmp_path: Path) -> None:
    path = tmp_path / "ok.svg"
    path.write_text(SVG, encoding="utf-8")
    assert inline_svg(path).startswith("<svg")


@pytest.mark.parametrize(
    ("markup", "message"),
    [
        ('<svg xmlns="http://www.w3.org/2000/svg"><image href="a.png"/></svg>', "<image>"),
        ('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>', "<script>"),
        (
            '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.test">x</a></svg>',
            "external reference",
        ),
        ('<svg xmlns="http://www.w3.org/2000/svg"><rect>', "not well-formed"),
        ('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>', "no DOCTYPE"),
    ],
)
def test_inline_svg_rejects_what_section_9_forbids(
    tmp_path: Path, markup: str, message: str
) -> None:
    path = tmp_path / "bad.svg"
    path.write_text(markup, encoding="utf-8")
    with pytest.raises(BuildError, match=message):
        inline_svg(path)


def test_a_missing_figure_is_reported(tmp_path: Path) -> None:
    with pytest.raises(BuildError, match="no such figure"):
        inline_svg(tmp_path / "absent.svg")


# --- heading numbers -------------------------------------------------------


def test_heading_numbers_come_from_the_outline(clean: Templating) -> None:
    numbered = number_headings("## Overview {#sec:overview}\n", clean.outline)
    assert numbered == '## <span class="num">2.1</span> Overview {#sec:overview}\n'


def test_an_unknown_anchor_keeps_its_heading_unchanged(clean: Templating) -> None:
    line = "## Nowhere {#sec:nowhere}\n"
    assert number_headings(line, clean.outline) == line


# --- model resolution ------------------------------------------------------


def test_resolve_manual_fills_every_html_field(clean: Templating, mini_manual: Manual) -> None:
    assert mini_manual.signals[0].description_html is None
    resolved = clean.resolve(mini_manual)
    for signal in resolved.signals:
        assert signal.description_html
        assert "<p>" not in signal.description_html
    for cause in resolved.causes.values():
        assert cause.summary_html
        assert cause.remedy_html
        assert cause.checks_html is not None
        assert len(cause.checks_html) == len(cause.checks_md)
    for task in resolved.maintenance:
        assert task.steps_html is not None
        assert len(task.steps_html) == len(task.steps_md)


def test_resolve_manual_leaves_the_original_untouched(
    clean: Templating, mini_manual: Manual
) -> None:
    resolved = clean.resolve(mini_manual)
    assert resolved is not mini_manual
    assert mini_manual.signals[0].description_html is None


def test_resolve_manual_runs_the_jinja_pass_over_yaml_text(
    clean: Templating, mini_manual: Manual, repo_root: Path
) -> None:
    context = manual_context(repo_root)
    templated = dataclasses.replace(
        mini_manual,
        signals=(
            dataclasses.replace(
                mini_manual.signals[0],
                description_md="Measured at {{ val('cut_in_pressure') }}.",
            ),
            *mini_manual.signals[1:],
        ),
    )
    resolved = resolve_manual(templated, clean.env, context=context)
    assert resolved.signals[0].description_md == "Measured at 8.0 bar."
    assert resolved.signals[0].description_html == "Measured at 8.0 bar."


def test_a_broken_yaml_text_field_is_reported(clean: Templating, mini_manual: Manual) -> None:
    broken = dataclasses.replace(
        mini_manual,
        signals=(
            dataclasses.replace(mini_manual.signals[0], description_md="{{ nonesuch }}"),
            *mini_manual.signals[1:],
        ),
    )
    with pytest.raises(BuildError, match="does not render"):
        resolve_manual(broken, clean.env, context=clean.context)
