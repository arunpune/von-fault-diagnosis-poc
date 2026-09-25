# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""CommonMark → HTML for the manual partials.

The parser is the one ``manual/tools/context.py::md_to_html`` builds — CommonMark
with tables, ``attrs`` and ``footnote``, typographer off and raw HTML on — plus
the two passes the PDF needs and the preview does not:

* :func:`inline_footnotes`, the post-parse token pass that turns every footnote
  into either a parenthetical (``clean``) or a ``<span class="fn">`` that the
  realistic stylesheet floats into the page footnote area. A render rule on
  ``footnote_ref`` cannot do this: the footnote bodies are only known once the
  tail rule has run, so the reference would have nothing to inline.
* :func:`admonition_html`, reached from a paragraph that ends in ``{.note}``,
  ``{.warning}`` or ``{.caution}``. ``attrs_plugin`` attaches attributes to
  inline elements only, so the class is picked off the paragraph here, exactly
  as ``context.py`` picks a ``{#anchor}`` off a heading.

Headings keep the ``{#anchor}`` rule of the authoring contract, so an ``h2``
lands with ``id="sec-overview"``; ``tests/unit/test_markdown.py`` renders the
same source through ``context.md_to_html`` and asserts the two agree.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, MutableMapping, Sequence
from typing import Any, Final, Literal, cast

from markdown_it import MarkdownIt
from markdown_it.renderer import RendererHTML
from markdown_it.token import Token
from mdit_py_plugins.attrs import attrs_plugin
from mdit_py_plugins.footnote import footnote_plugin

__all__ = [
    "ADMONITIONS",
    "ADMONITION_CLOSE",
    "FootnoteMode",
    "admonition_html",
    "admonition_open",
    "inline_footnotes",
    "make_parser",
    "render_inline",
    "render_markdown",
]

#: ``inline`` puts the footnote body in parentheses where it was referenced;
#: ``float`` emits the span the realistic stylesheet floats to the page foot.
FootnoteMode = Literal["inline", "float"]

#: Paragraph class → the label printed above the admonition body.
ADMONITIONS: Final[Mapping[str, str]] = {
    "note": "Note",
    "warning": "Warning",
    "caution": "Caution",
}

#: The closing half of an admonition, opened by :func:`admonition_open`.
ADMONITION_CLOSE: Final = "</p></aside>"

_HEADING_ANCHOR: Final = re.compile(r"\s*\{#([a-z0-9:_-]+)\}\s*$")
_PARAGRAPH_CLASS: Final = re.compile(r"\s*\{\.([a-z][a-z0-9-]*)\}\s*$")
_ADMONITION_KEY: Final = "fdp_admonition"

#: Renders the footnote bodies of :func:`inline_footnotes`; the pass needs a
#: renderer of its own because it runs between parsing and rendering.
_BODY_RENDERER: Final = MarkdownIt("commonmark", {"html": True, "typographer": False})


def admonition_open(kind: str) -> str:
    """The opening markup of an admonition, up to the start of its body."""
    return f'<aside class="admonition {kind}"><p class="label">{ADMONITIONS[kind]}</p><p>'


def admonition_html(kind: str, body_html: str) -> str:
    """One complete admonition, the markup ``partials/admonition.html.j2`` emits."""
    return f"{admonition_open(kind)}{body_html}{ADMONITION_CLOSE}"


def make_parser() -> MarkdownIt:
    """Build the manual's Markdown parser."""
    parser = MarkdownIt("commonmark", {"html": True, "typographer": False}).enable("table")
    parser.use(attrs_plugin)
    parser.use(footnote_plugin)
    parser.core.ruler.after("inline", "fdp_heading_anchors", _heading_anchors)
    parser.core.ruler.after("fdp_heading_anchors", "fdp_admonitions", _admonitions)
    parser.add_render_rule("paragraph_open", _render_paragraph_open)
    parser.add_render_rule("paragraph_close", _render_paragraph_close)
    return parser


def render_markdown(source: str, mode: FootnoteMode = "inline") -> str:
    """Render a chapter partial to an HTML fragment."""
    parser = make_parser()
    env: dict[str, Any] = {}
    tokens = inline_footnotes(parser.parse(source, env), env, mode)
    rendered: str = parser.renderer.render(tokens, parser.options, env)
    return rendered


def render_inline(source: str, mode: FootnoteMode = "inline") -> str:
    """Render a one-paragraph text field without the wrapping ``<p>``.

    Anything longer than a single paragraph falls back to the block render, so
    a multi-paragraph YAML field still comes out as valid HTML.
    """
    parser = make_parser()
    env: dict[str, Any] = {}
    tokens = inline_footnotes(parser.parse(source, env), env, mode)
    if len(tokens) == 3 and tokens[0].type == "paragraph_open" and tokens[1].type == "inline":
        return _render_inline_tokens(parser, tokens[1].children or [], env)
    rendered: str = parser.renderer.render(tokens, parser.options, env)
    return rendered.strip()


def inline_footnotes(
    tokens: Sequence[Token],
    env: MutableMapping[str, Any],
    mode: FootnoteMode,
) -> list[Token]:
    """Fold every footnote body into the place it is referenced from.

    Step 1 collects the inline tokens of every definition and drops the whole
    ``footnote_block_open … footnote_block_close`` range. Step 2 replaces each
    ``footnote_ref`` with raw HTML: a parenthetical in ``inline`` mode, a
    ``<span class="fn">`` in ``float`` mode, which ``realistic.css`` turns into
    a real page footnote. A reference without a definition is left alone.
    """
    bodies = _footnote_bodies(tokens, env)
    kept = _without_footnote_block(tokens)
    for token in kept:
        if token.type != "inline" or not token.children:
            continue
        token.children = [_inlined(child, bodies, mode) for child in token.children]
    return kept


def _footnote_bodies(
    tokens: Sequence[Token],
    env: MutableMapping[str, Any],
) -> dict[int, str]:
    """Render every footnote definition to inline HTML, keyed by its id."""
    parser = _BODY_RENDERER
    bodies: dict[int, str] = {}
    current: int | None = None
    parts: list[str] = []
    for token in tokens:
        if token.type == "footnote_open":
            current = int(token.meta["id"])
            parts = []
        elif token.type == "footnote_close" and current is not None:
            bodies[current] = " ".join(part for part in parts if part)
            current = None
        elif token.type == "inline" and current is not None:
            parts.append(_render_inline_tokens(parser, token.children or [], env))
    return bodies


def _without_footnote_block(tokens: Sequence[Token]) -> list[Token]:
    """Every token outside the footnote block the tail rule appended."""
    kept: list[Token] = []
    inside = False
    for token in tokens:
        if token.type == "footnote_block_open":
            inside = True
            continue
        if token.type == "footnote_block_close":
            inside = False
            continue
        if not inside:
            kept.append(token)
    return kept


def _inlined(child: Token, bodies: Mapping[int, str], mode: FootnoteMode) -> Token:
    """Replace one ``footnote_ref`` with the HTML its variant asks for."""
    if child.type != "footnote_ref":
        return child
    body = bodies.get(int(child.meta["id"]))
    if body is None:
        return child
    replacement = Token("html_inline", "", 0)
    replacement.content = f" ({body})" if mode == "inline" else f'<span class="fn">{body}</span>'
    return replacement


def _render_inline_tokens(
    parser: MarkdownIt,
    tokens: Sequence[Token],
    env: MutableMapping[str, Any],
) -> str:
    """Render inline tokens to HTML without wrapping them in a paragraph."""
    renderer = cast("RendererHTML", parser.renderer)
    return renderer.renderInline(list(tokens), parser.options, env)


def _heading_anchors(state: Any) -> None:
    """Move a trailing ``{#anchor}`` onto the heading token as its HTML id.

    The rule of ``manual/tools/context.py``: ``attrs_plugin`` parses attributes
    after inline elements only, so the Pandoc-style heading attribute of the
    authoring contract needs a core rule. The id is the anchor with ``:``
    replaced by ``-``, matching ``context.Reference.element_id``.
    """
    tokens: list[Token] = list(state.tokens)
    for index, token in enumerate(tokens):
        if token.type != "heading_open" or index + 1 >= len(tokens):
            continue
        inline = tokens[index + 1]
        if inline.type != "inline":
            continue
        match = _HEADING_ANCHOR.search(inline.content)
        if match is None:
            continue
        inline.content = inline.content[: match.start()]
        _strip_last_text(inline, _HEADING_ANCHOR)
        token.attrSet("id", match.group(1).replace(":", "-"))


def _admonitions(state: Any) -> None:
    """Mark a paragraph that ends in ``{.note}``/``{.warning}``/``{.caution}``."""
    tokens: list[Token] = list(state.tokens)
    for index, token in enumerate(tokens):
        if token.type != "paragraph_open" or index + 2 >= len(tokens):
            continue
        inline = tokens[index + 1]
        closing = tokens[index + 2]
        if inline.type != "inline" or closing.type != "paragraph_close":
            continue
        match = _PARAGRAPH_CLASS.search(inline.content)
        if match is None or match.group(1) not in ADMONITIONS:
            continue
        inline.content = inline.content[: match.start()]
        _strip_last_text(inline, _PARAGRAPH_CLASS)
        token.meta[_ADMONITION_KEY] = match.group(1)
        closing.meta[_ADMONITION_KEY] = match.group(1)


def _strip_last_text(inline: Token, pattern: re.Pattern[str]) -> None:
    """Remove the trailing attribute from the last text child of ``inline``."""
    for child in reversed(inline.children or []):
        if child.type == "text":
            child.content = pattern.sub("", child.content)
            return


def _render_paragraph_open(
    self: Any,
    tokens: Sequence[Token],
    index: int,
    options: Any,
    env: Any,
) -> str:
    kind = tokens[index].meta.get(_ADMONITION_KEY)
    if kind is None:
        opened: str = self.renderToken(tokens, index, options, env)
        return opened
    return admonition_open(str(kind))


def _render_paragraph_close(
    self: Any,
    tokens: Sequence[Token],
    index: int,
    options: Any,
    env: Any,
) -> str:
    if tokens[index].meta.get(_ADMONITION_KEY) is None:
        closed: str = self.renderToken(tokens, index, options, env)
        return closed
    return f"{ADMONITION_CLOSE}\n"
