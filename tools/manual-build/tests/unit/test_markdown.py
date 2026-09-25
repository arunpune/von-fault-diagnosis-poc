# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The Markdown pipeline: footnote pass, admonitions, tables, anchors."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from fdp_manual_build.config import BuildConfig
from fdp_manual_build.markdown import (
    ADMONITIONS,
    admonition_html,
    inline_footnotes,
    make_parser,
    render_inline,
    render_markdown,
)
from fdp_manual_build.templating import manual_context, page_env

FOOTNOTE_SOURCE = """Vent the pressure before every task.[^1]

[^1]: The maintenance chapter repeats this sequence.
"""


def test_a_footnote_is_folded_into_parentheses_for_clean() -> None:
    rendered = render_markdown(FOOTNOTE_SOURCE, "inline")
    assert "before every task. (The maintenance chapter repeats this sequence.)" in rendered
    assert "footnote" not in rendered


def test_a_footnote_becomes_a_floating_span_for_realistic() -> None:
    rendered = render_markdown(FOOTNOTE_SOURCE, "float")
    assert 'task.<span class="fn">The maintenance chapter repeats this sequence.</span>' in rendered
    assert "footnotes-list" not in rendered


def test_the_footnote_block_never_survives_the_pass() -> None:
    for mode in ("inline", "float"):
        rendered = render_markdown(FOOTNOTE_SOURCE, mode)  # type: ignore[arg-type]
        assert "footnotes-sep" not in rendered
        assert "footnote-backref" not in rendered


def test_the_footnote_body_keeps_its_inline_markup() -> None:
    source = 'See it[^a].\n\n[^a]: the *oil* filter and <span class="tag">T1</span>\n'
    rendered = render_markdown(source, "float")
    assert "<em>oil</em>" in rendered
    assert '<span class="tag">T1</span>' in rendered


def test_two_footnotes_keep_their_own_bodies() -> None:
    source = "First[^a] and second[^b].\n\n[^a]: one\n\n[^b]: two\n"
    rendered = render_markdown(source, "inline")
    assert "First (one) and second (two)." in rendered


def test_a_reference_without_a_definition_is_left_alone() -> None:
    assert "[^missing]" in render_markdown("Nothing here[^missing].\n", "inline")


def test_inline_footnotes_returns_the_tokens_it_kept() -> None:
    parser = make_parser()
    env: dict[str, Any] = {}
    tokens = parser.parse(FOOTNOTE_SOURCE, env)
    kept = inline_footnotes(tokens, env, "inline")
    assert [token.type for token in kept] == ["paragraph_open", "inline", "paragraph_close"]


@pytest.mark.parametrize("kind", sorted(ADMONITIONS))
def test_a_classed_paragraph_becomes_an_admonition(kind: str) -> None:
    rendered = render_markdown(f"Hot oil burns. {{.{kind}}}\n", "inline")
    assert rendered.strip() == admonition_html(kind, "Hot oil burns.")
    assert f'class="admonition {kind}"' in rendered
    assert f'<p class="label">{ADMONITIONS[kind]}</p>' in rendered


def test_an_unknown_paragraph_class_stays_literal_text() -> None:
    rendered = render_markdown("Plain enough. {.sidebar}\n", "inline")
    assert "{.sidebar}" in rendered
    assert "admonition" not in rendered


def test_the_admonition_template_matches_the_renderer(
    mini_config: BuildConfig,
    repo_root: Path,
) -> None:
    """partials/admonition.html.j2 and markdown.admonition_html must not drift."""
    env = page_env(mini_config, mini_config.variant("clean"), repo_root)
    template = env.get_template("partials/admonition.html.j2")
    for kind in ADMONITIONS:
        rendered = template.module.admonition(kind, "Hot oil burns.")  # type: ignore[attr-defined]
        assert str(rendered) == admonition_html(kind, "Hot oil burns.")


def test_a_heading_carries_its_anchor_as_an_id() -> None:
    rendered = render_markdown("## Overview {#sec:overview}\n", "inline")
    assert rendered.strip() == '<h2 id="sec-overview">Overview</h2>'


def test_headings_render_exactly_as_the_authoring_contract_does(repo_root: Path) -> None:
    """The PDF parser and context.md_to_html must agree."""
    context = manual_context(repo_root)
    source = "## Overview {#sec:overview}\n\n### Air flow {#sec:air-flow}\n\nPlain text.\n"
    assert render_markdown(source, "inline") == context.md_to_html(source, footnotes=True)


def test_a_table_survives_the_pipeline() -> None:
    source = "| Tag | Unit |\n| --- | --- |\n| P2 | bar |\n"
    rendered = render_markdown(source, "inline")
    assert "<thead>" in rendered
    assert "<th>Tag</th>" in rendered
    assert "<td>P2</td>" in rendered


def test_raw_html_from_the_authoring_helpers_passes_through() -> None:
    source = 'The tag <span class="tag">p_line</span> reads the line.\n'
    assert '<span class="tag">p_line</span>' in render_markdown(source, "inline")


def test_render_inline_drops_the_wrapping_paragraph() -> None:
    rendered = render_inline("Replace the **oil** filter.")
    assert rendered == "Replace the <strong>oil</strong> filter."


def test_render_inline_keeps_a_multi_block_field_valid() -> None:
    rendered = render_inline("First step.\n\nSecond step.")
    assert rendered.startswith("<p>First step.</p>")
    assert "<p>Second step.</p>" in rendered


def test_render_inline_folds_a_footnote_too() -> None:
    assert render_inline("Vent it[^a].\n\n[^a]: first\n") == "Vent it (first)."
