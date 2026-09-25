# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Assemble one HTML document per variant and wire ``fdp-manual-build build``.

The pipeline, from ``build.yaml`` to the string a renderer turns into a PDF:

``load_build_config`` → ``load_manual`` → ``read_chapters`` → ``numbering.scan``
→ :mod:`fdp_manual_build.templating` (the manual's namespace, the outline and
the fact tracker) → :mod:`fdp_manual_build.markdown` → ``base.html.j2``.

Rendering itself is ``render.py``, and this module treats the renderer as
optional: when it cannot be imported the run falls back to ``--html-only`` with
a warning instead of failing, and the page budget is simply not checked. The
HTML of every run lands in ``tools/manual-build/.build/<variant>.html``, which
is gitignored.

A run that is not given ``--no-catalog`` hands its result to
:mod:`fdp_manual_build.export`, which writes ``pdf.outputs.catalog``. The
page numbers in it come from the PDFs of the same run, so an HTML-only build
simply leaves them out. Last comes ``pdf.outputs.manifest``, the audit trail
of the build, written next to the PDFs — so the order is: clean, realistic,
``catalog.json``, ``build-manifest.json``.

The build itself is pure. It reads no clock, seeds no generator and consults no
environment variable; the only date in a PDF is ``build.yaml``'s
``source_date_epoch``, and the manifest's ``wall_time`` — the one field
excluded from every comparison — comes from
:func:`fdp_manual_build.manifest.wall_time_now`.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Final

from fdp_manual_build import manifest, numbering, templating
from fdp_manual_build.config import BuildConfig, VariantConfig, load_build_config
from fdp_manual_build.errors import BuildError
from fdp_manual_build.load import SPEC_KEYS, load_manual
from fdp_manual_build.manual_tools import Spec, find_repo_root, spec_loader
from fdp_manual_build.model import Manual
from fdp_manual_build.numbering import ChapterSource, SectionMap, SectionRef

__all__ = [
    "CHAPTER_TEMPLATES",
    "EXIT_PAGE_BUDGET",
    "HTML_DIR_RELATIVE",
    "BuildResult",
    "Options",
    "RenderedChapter",
    "VariantResult",
    "build_all",
    "build_variant",
    "main",
    "read_sources",
    "split_roots",
]

#: Chapter number → the template that lays it out. The name is fixed here and
#: not derived from ``build.yaml``'s slug, because the sources name chapter 8
#: ``troubleshooting`` while the printed manual calls it "Problem solving".
CHAPTER_TEMPLATES: Final[Mapping[int, str]] = {
    1: "01-safety.html.j2",
    2: "02-description.html.j2",
    3: "03-controller.html.j2",
    4: "04-settings.html.j2",
    5: "05-installation.html.j2",
    6: "06-operation.html.j2",
    7: "07-maintenance.html.j2",
    8: "08-problem-solving.html.j2",
    9: "09-technical-data.html.j2",
    10: "10-appendix.html.j2",
}

#: Where the intermediate HTML lands, relative to the checkout.
HTML_DIR_RELATIVE: Final = Path("tools") / "manual-build" / ".build"

#: Manual-tree globs of every input the loader does not already hash.
_INPUT_GLOBS: Final[tuple[str, ...]] = (
    "content/*.md",
    "figures/*.svg",
    "fonts/*.ttf",
    "fonts/fonts.json",
    "templates/**/*.j2",
    "templates/**/*.css",
)

#: Exit code of a rendered variant outside the page budget.
EXIT_PAGE_BUDGET: Final = 3
_EXIT_OK: Final = 0
_EXIT_ERROR: Final = 2

_RENDER_MODULE: Final = "fdp_manual_build.render"
_EXPORT_MODULE: Final = "fdp_manual_build.export"
_BUILD_YAML: Final = "build.yaml"
_TWO_COLUMNS: Final = 2


@dataclass(frozen=True)
class RenderedChapter:
    """One chapter as ``base.html.j2`` and the chapter templates see it."""

    number: int
    slug: str
    title: str
    template: str
    body: str
    columns: int
    sections: tuple[SectionRef, ...]


@dataclass(frozen=True)
class Options:
    """The switches of ``fdp-manual-build build``."""

    out_dir: Path
    html_only: bool = False
    variants: tuple[str, ...] = ()
    strict_pages: bool = True
    #: Where ``<variant>.html`` lands; the checkout's ``.build`` by default.
    html_dir: Path | None = None


@dataclass(frozen=True)
class VariantResult:
    """What one variant produced."""

    name: str
    html: str
    html_path: Path
    pdf_path: Path | None = None
    pages: int | None = None


@dataclass(frozen=True)
class BuildResult:
    """Everything one ``build`` run produced, for the manifest and the catalog."""

    cfg: BuildConfig
    manual: Manual
    sections: SectionMap
    variants: tuple[VariantResult, ...]
    html_only: bool
    warnings: tuple[str, ...] = ()

    def variant(self, name: str) -> VariantResult:
        """The result of one variant by name."""
        for result in self.variants:
            if result.name == name:
                return result
        raise KeyError(f"variant {name!r} was not built")

    def out_of_budget(self) -> tuple[str, ...]:
        """Messages for every rendered variant outside ``pdf.page_budget``."""
        budget = self.cfg.pdf.page_budget
        return tuple(
            f"{result.name}: {result.pages} pages, outside the budget {budget.min}-{budget.max}"
            for result in self.variants
            if result.pages is not None and not budget.min <= result.pages <= budget.max
        )


def read_sources(cfg: BuildConfig, repo_root: Path) -> templating.Sources:
    """Read the partials and the raw manual spec once for every variant of a run."""
    return templating.Sources(
        repo_root=repo_root,
        spec=_load_spec(repo_root, cfg),
        chapters=numbering.read_chapters(cfg),
    )


def build_variant(
    cfg: BuildConfig,
    variant: VariantConfig,
    manual: Manual,
    sections: SectionMap,
    sources: templating.Sources,
) -> str:
    """Return the complete HTML document of one variant.

    Args:
        cfg: the parsed ``build.yaml``.
        variant: the resolved variant knobs to branch on.
        manual: the loaded model; a resolved copy is put in the namespace.
        sections: the outline as :func:`fdp_manual_build.numbering.scan` built it.
        sources: the checkout, the manual's raw spec and the ten partials.

    Raises:
        BuildError: when a partial does not render, a figure breaks the figure
            rules or a ``prose_only`` fact never reached the prose.
    """
    rendering = templating.make_templating(cfg, variant, manual, sections, sources)
    rendering.resolve(manual)
    rendered = tuple(
        _chapter(rendering, chapter, variant, sections) for chapter in sources.chapters
    )
    rendering.check_fact_placement()
    document: str = rendering.pages.get_template("base.html.j2").render(chapters=rendered)
    return document


def build_all(cfg: BuildConfig, repo_root: Path, options: Options) -> BuildResult:
    """Build every selected variant, and render it when a renderer is available.

    ``options.variants`` defaults to the enabled variants of ``build.yaml`` in
    ``clean``-before-``realistic`` order. When ``fdp_manual_build.render`` is
    not importable the run is forced to HTML and says so in ``warnings``, so
    the build works without the renderer.

    Raises:
        BuildError: on any loading, numbering or rendering problem.
    """
    manual = load_manual(repo_root, cfg)
    sources = read_sources(cfg, repo_root)
    sections = numbering.scan(sources.chapters, numbering.generated_sections(manual))
    names = options.variants or _enabled_variants(cfg)

    renderer = None if options.html_only else _renderer()
    html_only = options.html_only or renderer is None
    warnings: list[str] = []
    if not options.html_only and renderer is None:
        warnings.append(
            f"{_RENDER_MODULE} is not available; writing HTML only and skipping the page budget"
        )

    target = options.html_dir if options.html_dir is not None else repo_root / HTML_DIR_RELATIVE
    target.mkdir(parents=True, exist_ok=True)
    results: list[VariantResult] = []
    for name in names:
        variant = cfg.variant(name)
        html = build_variant(cfg, variant, manual, sections, sources)
        html_path = target / f"{name}.html"
        html_path.write_text(html, encoding="utf-8")
        plain = VariantResult(name=name, html=html, html_path=html_path)
        results.append(
            plain if renderer is None else _rendered(cfg, variant, plain, options.out_dir, renderer)
        )

    result = BuildResult(
        cfg=cfg,
        manual=manual,
        sections=sections,
        variants=tuple(results),
        html_only=html_only,
        warnings=tuple(warnings),
    )
    if options.strict_pages and not html_only:
        _check_budget(result)
    return result


def main(argv: Sequence[str], repo_root: Path) -> int:
    """``fdp-manual-build build``; see :mod:`fdp_manual_build.cli` for the codes."""
    parser = _parser()
    args = parser.parse_args(list(argv))
    try:
        manual_root, checkout = split_roots(args.repo_root, repo_root)
        cfg = load_build_config(checkout, manual_root)
        options = Options(
            out_dir=Path(args.out_dir) if args.out_dir else checkout / cfg.outputs.dir,
            html_only=args.html_only,
            variants=(args.variant,) if args.variant else (),
            strict_pages=args.strict_pages,
        )
        result = build_all(cfg, checkout, options)
    except _PageBudgetError as error:
        print(f"fdp-manual-build build: {error}", file=sys.stderr)
        return EXIT_PAGE_BUDGET
    except BuildError as error:
        print(f"fdp-manual-build build: {error}", file=sys.stderr)
        return _EXIT_ERROR
    for warning in result.warnings:
        print(f"fdp-manual-build build: warning: {warning}", file=sys.stderr)
    for variant in result.variants:
        print(f"build: {variant.name} -> {variant.html_path}")
    catalog: Path | None = None
    try:
        if not args.no_catalog:
            catalog = _export_catalog(result, checkout, manual_root or checkout)
            print(f"build: catalog -> {catalog}")
        written = _write_manifest(result, checkout, options.out_dir, catalog)
    except BuildError as error:
        print(f"fdp-manual-build build: {error}", file=sys.stderr)
        return _EXIT_ERROR
    if written is not None:
        print(f"build: manifest -> {written}")
    return _EXIT_OK


# --- internals -------------------------------------------------------------


class _PageBudgetError(BuildError):
    """A rendered variant fell outside ``pdf.page_budget`` (exit code 3)."""


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fdp-manual-build build",
        description="Assemble the manual variants into HTML and, when a renderer "
        "is available, into PDF.",
    )
    parser.add_argument(
        "--repo-root",
        default=None,
        help="checkout, or a manual tree holding build.yaml (default: search upwards)",
    )
    parser.add_argument("--variant", default=None, help="build this variant only")
    parser.add_argument(
        "--html-only", action="store_true", help="write .build/<variant>.html and stop"
    )
    parser.add_argument("--out-dir", default=None, help="where the PDFs go (default: outputs.dir)")
    parser.add_argument(
        "--no-catalog", action="store_true", help="do not export tools/eval/fixtures/catalog.json"
    )
    parser.add_argument(
        "--strict-pages",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="fail with exit code 3 outside pdf.page_budget (default: strict)",
    )
    return parser


def split_roots(given: str | None, fallback: Path) -> tuple[Path | None, Path]:
    """Split ``--repo-root`` into the manual tree to build and the checkout.

    A checkout is a directory holding ``manual/build.yaml``; a bare manual tree
    — the mini fixture, for instance — holds ``build.yaml`` itself and borrows
    the manual's loader, contract and templates from the checkout above it.
    """
    if given is None:
        return None, fallback
    root = Path(given).resolve()
    if (root / "manual" / _BUILD_YAML).is_file():
        return None, root
    if not (root / _BUILD_YAML).is_file():
        raise BuildError(f"{root}: holds neither {_BUILD_YAML} nor manual/{_BUILD_YAML}")
    checkout = find_repo_root(root)
    if checkout is None:
        raise BuildError(f"{root}: no checkout with manual/tools above this manual tree")
    return root, checkout


def _load_spec(repo_root: Path, cfg: BuildConfig) -> Spec:
    """Load the manual's spec again, this time for the authoring contract.

    ``load_manual`` maps the documents onto the frozen model and drops the raw
    ``Spec``; ``context.py`` works on that raw shape, so the six small YAML
    files are read once more rather than widening the loader's contract.
    """
    loader = spec_loader(repo_root)
    try:
        return loader.load_spec(root=cfg.manual_root, only=set(SPEC_KEYS) | {"build"})
    except loader.SpecError as error:  # pragma: no cover - load_manual validated already
        raise BuildError(
            f"{cfg.manual_root}: the manual spec does not validate: {error}"
        ) from error


def _enabled_variants(cfg: BuildConfig) -> tuple[str, ...]:
    """Every enabled variant, ``clean`` first so the easy document is built first."""
    names = [name for name, variant in cfg.variants.items() if variant.enabled]
    return tuple(sorted(names, key=lambda name: (name != "clean", name)))


def _chapter(
    rendering: templating.Templating,
    chapter: ChapterSource,
    variant: VariantConfig,
    sections: SectionMap,
) -> RenderedChapter:
    template = CHAPTER_TEMPLATES.get(chapter.number)
    if template is None:  # pragma: no cover - config.py fixes the ten chapters
        raise BuildError(f"chapter {chapter.number} has no template")
    return RenderedChapter(
        number=chapter.number,
        slug=chapter.slug,
        title=chapter.title,
        template=template,
        body=rendering.chapter_body(chapter),
        columns=_TWO_COLUMNS if variant.is_two_column(chapter.number) else 1,
        sections=_level_two(sections, chapter.number),
    )


def _level_two(sections: SectionMap, chapter: int) -> tuple[SectionRef, ...]:
    """The level-2 sections of one chapter, in document order."""
    return tuple(
        section
        for section in sections.values()
        if section.chapter == chapter and section.number.count(".") == 1
    )


def _export_catalog(result: BuildResult, checkout: Path, out_root: Path) -> Path:
    """Write the reference catalog of a finished run.

    ``out_root`` is the tree ``pdf.outputs.catalog`` is relative to: the
    checkout for the real manual, and the manual tree itself when one was
    passed, so a fixture build writes into its own scratch directory.

    The exporter is imported here rather than at the top of the module because
    it imports this one: it reads a manual tree with :func:`read_sources` and
    :func:`split_roots`, so the dependency only closes at call time.
    """
    out_path = out_root / result.cfg.pdf.catalog
    export = importlib.import_module(_EXPORT_MODULE)
    export.catalog_from_build(result, checkout, out_path)
    return out_path


def _write_manifest(
    result: BuildResult, checkout: Path, out_dir: Path, catalog: Path | None
) -> Path | None:
    """Write ``build-manifest.json`` beside the PDFs, last of the run.

    A run that produced no PDF — ``--html-only``, or a checkout without
    WeasyPrint — has no outputs to record and writes nothing.

    Args:
        result: the finished run; only its rendered variants are recorded.
        checkout: the tree every recorded path is spelled relative to.
        out_dir: where the PDFs went; the manifest lands next to them, so a
            ``--out-dir`` rebuild never overwrites the committed one.
        catalog: the exported catalog, or ``None`` under ``--no-catalog``.

    Raises:
        BuildError: when a tool version the manifest records cannot be read.
    """
    if result.html_only:
        return None
    cfg = result.cfg
    outputs: dict[str, manifest.Output] = {
        variant.name: manifest.PdfOutput.of(
            _relative(variant.pdf_path, checkout), variant.pdf_path.read_bytes()
        )
        for variant in result.variants
        if variant.pdf_path is not None
    }
    if not outputs:
        return None
    if catalog is not None:
        outputs["catalog"] = manifest.FileOutput.of(
            _relative(catalog, checkout), catalog.read_bytes()
        )
    record = manifest.BuildRecord(
        source_date_epoch=cfg.source_date_epoch,
        inputs=_manifest_inputs(result, checkout),
        outputs=outputs,
        wall_time=manifest.wall_time_now(),
    )
    path = out_dir / Path(cfg.pdf.manifest).name
    manifest.refresh_manifest(path, record)
    return path


def _manifest_inputs(result: BuildResult, checkout: Path) -> dict[str, str]:
    """Every file this build read, checkout-relative, with its SHA-256.

    ``Manual.source_hashes`` already carries ``build.yaml`` and the six spec
    documents; the chapters, the figures, the fonts and the templates are
    hashed here, so that acceptance check #9 also sees a stylesheet or a
    partial edited without a ``make manual``.
    """
    root = result.cfg.manual_root
    known: dict[Path, str | None] = {
        root / relative: digest for relative, digest in result.manual.source_hashes.items()
    }
    for pattern in _INPUT_GLOBS:
        for path in root.glob(pattern):
            known.setdefault(path, None)
    return {
        _relative(path, checkout): digest if digest is not None else manifest.hash_file(path)
        for path, digest in sorted(known.items())
    }


def _relative(path: Path, checkout: Path) -> str:
    """``path`` as the manifest spells it: POSIX, relative to the checkout."""
    try:
        return path.resolve().relative_to(checkout.resolve()).as_posix()
    except ValueError:  # pragma: no cover - only for an out-dir outside the tree
        return path.as_posix()


def _renderer() -> Any | None:
    """``fdp_manual_build.render`` when it is importable, else ``None``."""
    if importlib.util.find_spec(_RENDER_MODULE) is None:
        return None
    module = importlib.import_module(_RENDER_MODULE)
    return module if hasattr(module, "to_pdf") else None


def _rendered(
    cfg: BuildConfig,
    variant: VariantConfig,
    built: VariantResult,
    out_dir: Path,
    renderer: Any,
) -> VariantResult:
    """Render one variant to PDF and count its pages (the ``render.to_pdf`` contract)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = out_dir / cfg.outputs.pdf_name(variant.name)
    pdf = renderer.to_pdf(
        built.html,
        base_url=cfg.manual_root,
        variant=variant,
        cfg=cfg,
        font_dir=Path(cfg.fonts.dir),
    )
    pdf_path.write_bytes(pdf)
    return replace(built, pdf_path=pdf_path, pages=_page_count(pdf_path))


def _page_count(pdf_path: Path) -> int | None:
    """Pages of a rendered PDF, or ``None`` when pdfplumber is unavailable."""
    if importlib.util.find_spec("pdfplumber") is None:  # pragma: no cover - a pinned dependency
        return None
    pdfplumber = importlib.import_module("pdfplumber")
    with pdfplumber.open(pdf_path) as document:
        return len(document.pages)


def _check_budget(result: BuildResult) -> None:
    problems = result.out_of_budget()
    if problems:
        raise _PageBudgetError("; ".join(problems))
