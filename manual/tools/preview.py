#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Render the manual partials to one HTML page per variant, for eyeballing.

This is a review aid, not the PDF: it runs the same Jinja environment,
outline numbering and Markdown conversion that ``manual/tools/context.py``
gives the PDF build, so a writer can see the numbers, the cross-references, the
generated tables and the variant differences without a PDF toolchain.

Usage::

    uv run --no-project --with-requirements manual/tools/requirements.txt \\
        python manual/tools/preview.py --spec manual --out build/manual-preview

Writes ``<out>/<variant>.html`` for every selected variant. The output is
deterministic: it holds no timestamp and no absolute path, the only path it
embeds being the relative route from ``--out`` to the figures directory.
"""

from __future__ import annotations

import argparse
import html
import os
import re
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

if __package__ in (None, ""):  # running as a script
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from content_checks import read_partials
from context import (
    ManualEnvironment,
    Outline,
    build_outline,
    make_env,
    md_to_html,
    render_partial,
    variant_knobs,
)
from load import Spec, SpecError, load_spec

__all__ = ["STYLESHEET", "Renderer", "build_document", "main"]

_HEADING = re.compile(r"^(#{2,3})\s+(.+?)\s+\{#([a-z0-9:_-]+)\}\s*$", re.MULTILINE)
_FIGURE_SRC = re.compile(r'src="figures/')

#: Minimal inline stylesheet: enough to read the structure, nothing branded.
STYLESHEET = """
:root { color-scheme: light dark; }
body { margin: 0 auto; max-width: 46rem; padding: 2rem 1rem;
       font-family: "IBM Plex Sans", system-ui, sans-serif; line-height: 1.55; }
h1 { font-size: 1.6rem; border-bottom: 2px solid currentColor; padding-bottom: .3rem; }
h2 { font-size: 1.25rem; margin-top: 2rem; }
h3 { font-size: 1.05rem; margin-top: 1.4rem; }
section.chapter { margin-bottom: 3.5rem; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .9rem; }
th, td { border: 1px solid #8884; padding: .3rem .5rem; text-align: left; vertical-align: top; }
thead th { background: #8882; }
a.xref { text-decoration: none; border-bottom: 1px dotted currentColor; }
figure { margin: 1.5rem 0; }
figure img { max-width: 100%; border: 1px solid #8884; }
figcaption { font-size: .85rem; margin-top: .4rem; }
.footnotes { font-size: .85rem; border-top: 1px solid #8884; margin-top: 2rem; }
.variant-banner { font-size: .85rem; padding: .5rem .75rem; border: 1px solid #8884; }
""".strip()


def _number_headings(text: str, outline: Outline) -> str:
    """Prefix every authored heading with the number the outline gave it."""

    def replace(match: re.Match[str]) -> str:
        anchor = match.group(3)
        if not outline.has(anchor):
            return match.group(0)
        return f"{match.group(1)} {outline.number_of(anchor)} {match.group(2)} {{#{anchor}}}"

    return _HEADING.sub(replace, text)


@dataclass(frozen=True, slots=True)
class Renderer:
    """Everything one variant's page is rendered from."""

    spec: Spec
    variant: str
    outline: Outline
    figures_prefix: str
    knobs: Mapping[str, Any]
    environment: ManualEnvironment

    @classmethod
    def create(cls, spec: Spec, variant: str, outline: Outline, figures_prefix: str) -> Renderer:
        """Bind the Jinja environment and the variant knobs of one page."""
        return cls(
            spec=spec,
            variant=variant,
            outline=outline,
            figures_prefix=figures_prefix,
            knobs=variant_knobs(spec.build or {}, variant),
            environment=make_env(spec, variant, outline),
        )

    def chapter(self, number: int, title: str, text: str) -> str:
        """Render one partial into its ``<section>``."""
        rendered = _number_headings(render_partial(self.environment, number, text), self.outline)
        body = md_to_html(rendered, footnotes=bool(self.knobs.get("footnotes")))
        body = _FIGURE_SRC.sub(f'src="{self.figures_prefix}', body)
        heading = f"<h1>{number} {html.escape(title)}</h1>"
        return f'<section class="chapter" id="ch-{number}">\n{heading}\n{body}</section>'

    def banner(self) -> str:
        """The one-line header that names the variant and its knobs."""
        document = (self.spec.build or {}).get("document") or {}
        return (
            f"variant <strong>{html.escape(self.variant)}</strong> · "
            f"units {html.escape(str(self.knobs.get('units', '')))} · "
            f"cross-references {html.escape(str(self.knobs.get('xref_style', '')))} · "
            f"document {html.escape(str(document.get('number', '')))} "
            f"revision {html.escape(str(document.get('revision', '')))}"
        )


def build_document(renderer: Renderer, partials: Mapping[int, str], chapters: Sequence[int]) -> str:
    """Return the complete HTML page of one variant."""
    build = renderer.spec.build or {}
    document = build.get("document") or {}
    titles = {int(entry["number"]): str(entry["title"]) for entry in build.get("chapters") or []}
    sections = [
        renderer.chapter(chapter, titles.get(chapter, f"Chapter {chapter}"), partials[chapter])
        for chapter in chapters
    ]
    title = f"{document.get('title', 'Manual')} — {renderer.variant}"
    return (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{html.escape(title)}</title>\n"
        f"<style>\n{STYLESHEET}\n</style>\n</head>\n<body>\n"
        f'<p class="variant-banner">{renderer.banner()}</p>\n'
        + "\n".join(sections)
        + "\n</body>\n</html>\n"
    )


def _figures_prefix(out_dir: Path, figures_dir: Path) -> str:
    """The ``<img src>`` prefix that reaches ``figures_dir`` from ``out_dir``."""
    relative = os.path.relpath(figures_dir.resolve(), out_dir.resolve())
    return Path(relative).as_posix().rstrip("/") + "/"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="preview.py",
        description="Render the manual partials to one HTML page per variant.",
    )
    parser.add_argument("--spec", default="manual", help="spec root holding build.yaml and spec/")
    parser.add_argument("--out", required=True, help="directory the HTML pages are written to")
    parser.add_argument(
        "--content", default=None, help="partials directory (default <spec>/content)"
    )
    parser.add_argument(
        "--figures", default=None, help="figures directory (default <spec>/figures)"
    )
    parser.add_argument(
        "--variant",
        choices=("clean", "realistic", "both"),
        default="both",
        help="variant(s) to render",
    )
    parser.add_argument(
        "--chapters",
        default=None,
        help="limit the preview to these chapters, e.g. 2,3,8",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Write one HTML page per variant; return the process exit code."""
    args = build_parser().parse_args(argv)
    spec_root = Path(args.spec)
    content_dir = Path(args.content) if args.content else spec_root / "content"
    figures_dir = Path(args.figures) if args.figures else spec_root / "figures"
    out_dir = Path(args.out)
    variants = ("clean", "realistic") if args.variant == "both" else (args.variant,)

    try:
        spec = load_spec(spec_root)
    except SpecError as error:
        for message in error.messages:
            print(f"preview: {message}", file=sys.stderr)
        return 1

    partials, _ = read_partials(content_dir)
    if not partials:
        print(f"preview: {content_dir.as_posix()} holds no NN-<slug>.md partial", file=sys.stderr)
        return 1
    outline = build_outline(spec, partials)

    wanted = sorted(partials)
    if args.chapters:
        selected = {int(part.strip()) for part in args.chapters.split(",") if part.strip()}
        wanted = [chapter for chapter in wanted if chapter in selected]
    if not wanted:
        print("preview: --chapters selected no partial", file=sys.stderr)
        return 1

    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = _figures_prefix(out_dir, figures_dir)
    for variant in variants:
        renderer = Renderer.create(spec, variant, outline, prefix)
        page = build_document(renderer, partials, wanted)
        target = out_dir / f"{variant}.html"
        target.write_text(page, encoding="utf-8")
        print(f"preview: wrote {target.as_posix()} ({len(wanted)} chapter(s))")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
